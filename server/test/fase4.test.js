// Fase 4: chat limits and voting in Watch Together, shared lists, Wrapped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { makeApp, mkUser, mkFile, call } from './helpers.js';

const { db, now } = await import('../src/db.js');
const { default: authRoutes } = await import('../src/auth.js');
const { default: catalogRoutes } = await import('../src/catalog.js');
const { default: streamRoutes } = await import('../src/stream.js');
const { default: watchRoutes, allow, pickWinner } = await import('../src/watch.js');
const { default: listRoutes } = await import('../src/lists.js');
const { default: wrappedRoutes, wrapped, logWatch } = await import('../src/wrapped.js');
const { default: WebSocket } = await import('ws');

const app = await makeApp(authRoutes, catalogRoutes, streamRoutes, watchRoutes, listRoutes, wrappedRoutes);
await app.listen({ port: 0, host: '127.0.0.1' });
const port = app.server.address().port;
test.after(() => app.close());
const admin = mkUser('admin'), ann = mkUser('user', 'Ann'), bob = mkUser('user', 'Bob'), eve = mkUser('user', 'Eve');

/** Opens a room socket and collects what arrives. */
async function join(code, query) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/watch/${code}/ws?${query}`);
  const got = []; ws.on('message', (d) => got.push(JSON.parse(String(d))));
  await once(ws, 'open');
  const wait = async (pred, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { const m = got.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 15)); } return null; };
  await wait((m) => m.t === 'hello');
  return { ws, got, wait, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

test('the message limiter refills over time', () => {
  const b = {};
  const results = Array.from({ length: 7 }, () => allow(b, 5, 10_000, 1000));
  assert.deepEqual(results, [true, true, true, true, true, false, false]);
  assert.equal(allow(b, 5, 10_000, 1000 + 2000), true, 'two seconds later one more is allowed');
  assert.equal(allow(b, 5, 10_000, 1000 + 2000), false);
});

test('chat and reactions: for guests too, rate limited, kept in memory for late joiners', async () => {
  const f = mkFile();
  const code = (await call(app, ann, 'POST', '/api/watch', { fileId: f.fileId })).json().code;
  const guest = (await app.inject({ method: 'POST', url: `/api/watch/${code}/guest`, payload: { name: 'Gast' } })).json().guest;
  const a = await join(code, `token=${ann.token}`), g = await join(code, `guest=${guest}`);
  g.send({ t: 'chat', text: '  hoi allemaal  ' }); g.send({ t: 'react', emoji: '😂' }); g.send({ t: 'react', emoji: '<img>' });
  assert.equal((await a.wait((m) => m.t === 'chat')).text, 'hoi allemaal');
  assert.equal((await a.wait((m) => m.t === 'react')).emoji, '😂');
  for (let i = 0; i < 8; i++) g.send({ t: 'chat', text: `spam ${i}` });
  assert.ok(await g.wait((m) => m.t === 'slow'), 'the sender is told to slow down');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(a.got.filter((m) => m.t === 'chat').length, 5, 'five per ten seconds get through');
  assert.equal(a.got.filter((m) => m.t === 'react').length, 1, 'markup is not an emoji');
  g.ws.send('x'.repeat(5000)); g.ws.send('niet json'); g.ws.send('null');
  const late = await join(code, `token=${bob.token}`);
  assert.equal(late.got.find((m) => m.t === 'hello').chat.length, 5);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name LIKE '%chat%'").get().c, 0, 'nothing is stored');
  a.close(); g.close(); late.close();
});

test('Watch Night vote: a majority starts the winner for everyone', async () => {
  const films = [mkFile({ title: 'Optie Een' }), mkFile({ title: 'Optie Twee' }), mkFile({ title: 'Optie Drie' })];
  assert.equal(pickWinner([{ id: 1 }, { id: 2 }], new Map([['a', 2], ['b', 2], ['c', 1]])).id, 2);
  assert.equal(pickWinner([{ id: 1 }, { id: 2 }], new Map(), () => 0.99).id, 2, 'no votes: a random option');
  assert.equal((await call(app, ann, 'POST', '/api/watch/vote', { titleIds: [films[0].titleId] })).statusCode, 400);
  assert.equal((await call(app, null, 'POST', '/api/watch/vote', { titleIds: films.map((f) => f.titleId) })).statusCode, 401);
  const code = (await call(app, ann, 'POST', '/api/watch/vote', { titleIds: films.map((f) => f.titleId) })).json().code;
  const info = (await call(app, bob, 'GET', `/api/watch/${code}`)).json();
  assert.deepEqual([info.fileId, info.vote.options.length, info.vote.voted], [null, 3, 0]);
  assert.equal((await call(app, bob, 'POST', `/api/watch/${code}/play`, {})).statusCode, 409);

  const guest = (await app.inject({ method: 'POST', url: `/api/watch/${code}/guest`, payload: { name: 'Gast' } })).json().guest;
  const a = await join(code, `token=${ann.token}`), b = await join(code, `token=${bob.token}`), g = await join(code, `guest=${guest}`);
  a.send({ t: 'play', position: 10 }); a.send({ t: 'vote', titleId: 999999 });
  a.send({ t: 'vote', titleId: films[1].titleId });
  const v = await b.wait((m) => m.t === 'vote');
  assert.equal(v.vote.counts[films[1].titleId], 1);
  assert.equal(b.got.filter((m) => m.t === 'state').length, 0, 'no playback control while voting');
  g.send({ t: 'vote', titleId: films[1].titleId });   // 2 of 3: majority
  const load = await b.wait((m) => m.t === 'load');
  assert.equal(load.room.fileId, films[1].fileId); assert.equal(load.winner, 'Optie Twee');
  assert.equal((await call(app, bob, 'POST', `/api/watch/${code}/play`, {})).json().fileId, films[1].fileId);
  a.close(); b.close(); g.close();
});

test('a vote on something a restricted account may not see keeps that account out', async () => {
  const lib = Number(db.prepare("INSERT INTO libraries (name, type, paths, created_at) VALUES ('Dicht', 'movies', '[]', 1)").run().lastInsertRowid);
  const hid = mkFile({ title: 'Verborgen Optie', libraryId: lib }), open = mkFile({ title: 'Open Optie' });
  await call(app, admin, 'PUT', `/api/admin/users/${eve.id}`, { allLibraries: false, libraries: [] });
  assert.equal((await call(app, eve, 'POST', '/api/watch/vote', { titleIds: [hid.titleId, open.titleId] })).statusCode, 404);
  const code = (await call(app, ann, 'POST', '/api/watch/vote', { titleIds: [hid.titleId, open.titleId] })).json().code;
  const r = await call(app, eve, 'GET', `/api/watch/${code}`);
  assert.equal(r.statusCode, 403); assert.ok(!r.body.includes('Verborgen'));
  await call(app, admin, 'PUT', `/api/admin/users/${eve.id}`, { allLibraries: true });
});

test('shared lists: read or edit, never someone else\'s list by id', async () => {
  const f1 = mkFile({ title: 'Lijstfilm A' }), f2 = mkFile({ title: 'Lijstfilm B' });
  const id = (await call(app, ann, 'POST', '/api/lists', { name: '  Filmavond  ' })).json().id;
  assert.equal((await call(app, ann, 'POST', '/api/lists', { name: ' ' })).statusCode, 400);
  assert.equal((await call(app, ann, 'PUT', `/api/lists/${id}/items/${f1.titleId}`)).statusCode, 200);
  assert.equal((await call(app, ann, 'PUT', `/api/lists/${id}/items/999999`)).statusCode, 404);

  // Not shared: every route says "not found" to Bob.
  for (const [m, u, b] of [['GET', `/api/lists/${id}`], ['PUT', `/api/lists/${id}`, { name: 'Gekaapt' }], ['DELETE', `/api/lists/${id}`], ['PUT', `/api/lists/${id}/items/${f2.titleId}`],
    ['DELETE', `/api/lists/${id}/items/${f1.titleId}`], ['PUT', `/api/lists/${id}/shares`, { users: [{ id: bob.id, edit: true }] }]]) {
    assert.equal((await call(app, bob, m, u, b)).statusCode, 404, `${m} ${u}`);
  }
  assert.equal((await call(app, bob, 'GET', '/api/lists')).json().lists.length, 0);
  assert.equal((await call(app, null, 'GET', '/api/lists')).statusCode, 401);

  // Read-only share.
  await call(app, ann, 'PUT', `/api/lists/${id}/shares`, { users: [{ id: bob.id, edit: false }, { id: ann.id, edit: true }, { id: 424242 }] });
  const seen = (await call(app, bob, 'GET', `/api/lists/${id}`)).json();
  assert.deepEqual([seen.name, seen.mine, seen.canEdit, seen.items.length, seen.shares], ['Filmavond', false, false, 1, undefined]);
  assert.equal((await call(app, bob, 'PUT', `/api/lists/${id}/items/${f2.titleId}`)).statusCode, 403);
  assert.equal((await call(app, bob, 'PUT', `/api/lists/${id}`, { name: 'x' })).statusCode, 403);
  assert.equal((await call(app, bob, 'PUT', `/api/lists/${id}/shares`, { users: [] })).statusCode, 403);
  assert.equal((await call(app, eve, 'GET', `/api/lists/${id}`)).statusCode, 404);
  // Editable share.
  await call(app, ann, 'PUT', `/api/lists/${id}/shares`, { users: [{ id: bob.id, edit: true }] });
  assert.equal((await call(app, bob, 'PUT', `/api/lists/${id}/items/${f2.titleId}`)).statusCode, 200);
  const mine = (await call(app, ann, 'GET', `/api/lists/${id}`)).json();
  assert.deepEqual(mine.items.map((i) => [i.title, i.addedBy]), [['Lijstfilm A', 'Ann'], ['Lijstfilm B', 'Bob']]);
  assert.deepEqual(mine.shares.map((s) => [s.name, s.edit]), [['Bob', true]]);
  assert.equal((await call(app, bob, 'GET', `/api/lists?title=${f2.titleId}`)).json().lists[0].has, true);

  // A title the viewer may not see is simply absent from the list for them.
  db.prepare('UPDATE titles SET age = 16 WHERE id = ?').run(f2.titleId); db.prepare('UPDATE titles SET age = 6 WHERE id = ?').run(f1.titleId);
  await call(app, admin, 'PUT', `/api/admin/users/${bob.id}`, { maxAge: 9 });
  const kid = (await call(app, bob, 'GET', `/api/lists/${id}`));
  assert.deepEqual(kid.json().items.map((i) => i.title), ['Lijstfilm A']); assert.ok(!kid.body.includes('Lijstfilm B'));
  await call(app, admin, 'PUT', `/api/admin/users/${bob.id}`, { maxAge: null });
  // Bob "deleting" only leaves; Ann deleting removes it.
  assert.equal((await call(app, bob, 'DELETE', `/api/lists/${id}`)).statusCode, 200);
  assert.equal((await call(app, ann, 'GET', `/api/lists/${id}`)).statusCode, 200);
  assert.equal((await call(app, ann, 'DELETE', `/api/lists/${id}`)).statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM list_items WHERE list_id = ?').get(id).c, 0);
  assert.ok(!(await call(app, bob, 'GET', '/api/users/directory')).body.includes('pass'));
});

test('Wrapped: viewing time is counted, private, and shareable on request', async () => {
  const drama = mkFile({ title: 'Lange Film' }), show = mkFile({ title: 'Serie', kind: 'show', episode: [1, 1] });
  db.prepare("UPDATE titles SET genres = '[\"Drama\"]' WHERE id = ?").run(drama.titleId); db.prepare("UPDATE titles SET genres = '[\"Comedy\"]' WHERE id = ?").run(show.titleId);
  const year = 2025;
  logWatch(ann.id, drama.titleId, 0, 7200, new Date(2025, 2, 8, 20));    // a Saturday
  logWatch(ann.id, drama.titleId, 0, 600, new Date(2025, 2, 8, 23));
  logWatch(ann.id, show.titleId, show.episodeId, 1800, new Date(2025, 5, 3, 20));
  logWatch(ann.id, show.titleId, show.episodeId, 900, new Date(2024, 5, 3, 20)); // another year
  logWatch(bob.id, drama.titleId, 0, 99999, new Date(2025, 2, 9, 20));
  const w = wrapped(ann.id, year);
  assert.deepEqual([w.seconds, w.hours, w.days, w.movies, w.shows], [9600, 2.7, 2, 1, 1]);
  assert.deepEqual(w.topTitles.map((t) => [t.title, t.seconds]), [['Lange Film', 7800], ['Serie', 1800]]);
  assert.deepEqual(w.topGenres.map((g) => [g.name, g.share]), [['Drama', 81], ['Komedie', 19]]);
  assert.deepEqual([w.longestSession.title, w.longestSession.seconds, w.longestSession.day, w.favoriteDay.name], ['Lange Film', 7800, '2025-03-08', 'zaterdag']);
  assert.equal(wrapped(eve.id, year).empty, true);

  // Progress reports add time only for forward steps that match the clock.
  const live = mkFile({ title: 'Nu Bezig' });
  const today = new Date().getFullYear();
  await call(app, eve, 'POST', '/api/progress', { titleId: live.titleId, position: 100, duration: 6000 });
  await call(app, eve, 'POST', '/api/progress', { titleId: live.titleId, position: 110, duration: 6000 });
  await call(app, eve, 'POST', '/api/progress', { titleId: live.titleId, position: 3000, duration: 6000 });   // a seek, not viewing
  const sec = wrapped(eve.id, today).seconds;
  assert.ok(sec >= 1 && sec <= 10, `expected a few seconds, got ${sec}`);

  // Own overview only; sharing is explicit and can be undone.
  const own = (await call(app, ann, 'GET', `/api/wrapped?year=${year}`)).json();
  assert.equal(own.seconds, 9600); assert.equal(own.sharePath, null);
  assert.equal((await call(app, null, 'GET', `/api/wrapped?year=${year}`)).statusCode, 401);
  assert.equal((await call(app, bob, 'GET', `/api/wrapped?year=${year}&user=${ann.id}`)).json().seconds, 99999, 'there is no way to ask for someone else');
  assert.equal((await call(app, ann, 'GET', '/api/wrapped?year=abc')).statusCode, 200);
  assert.equal((await call(app, ann, 'GET', '/api/wrapped?year=99999')).statusCode, 400);
  const path = (await call(app, ann, 'POST', '/api/wrapped/share', { year })).json().sharePath;
  assert.equal((await call(app, ann, 'POST', '/api/wrapped/share', { year })).json().sharePath, path);
  const pub = await app.inject({ url: `/api${path.replace('/wrapped/', '/wrapped/shared/')}` });
  assert.equal(pub.statusCode, 200); assert.equal(pub.json().name, 'Ann'); assert.equal(pub.json().topTitles[0].id, undefined);
  assert.equal((await app.inject({ url: '/api/wrapped/shared/bestaat-niet' })).statusCode, 404);
  await call(app, bob, 'DELETE', `/api/wrapped/share?year=${year}`);
  assert.equal((await app.inject({ url: `/api${path.replace('/wrapped/', '/wrapped/shared/')}` })).statusCode, 200, 'someone else cannot unshare it');
  await call(app, ann, 'DELETE', `/api/wrapped/share?year=${year}`);
  assert.equal((await app.inject({ url: `/api${path.replace('/wrapped/', '/wrapped/shared/')}` })).statusCode, 404);
});
