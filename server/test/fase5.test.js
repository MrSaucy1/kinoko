// Fase 5: activity dashboard, Sonarr/Radarr webhook, requests.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, mkUser, mkFile, call, tmp } from './helpers.js';

const { db, settings } = await import('../src/db.js');
const { default: authRoutes, sessionId } = await import('../src/auth.js');
const { default: streamRoutes } = await import('../src/stream.js');
const { default: catalogRoutes } = await import('../src/catalog.js');
const { default: libraryRoutes, scanAll, scanState } = await import('../src/library.js');
const { default: activityRoutes } = await import('../src/activity.js');
const { default: requestRoutes, arrPath } = await import('../src/requests.js');
const { register } = await import('../src/events.js');

const app = await makeApp(authRoutes, streamRoutes, catalogRoutes, libraryRoutes, activityRoutes, requestRoutes);
test.after(() => app.close());
const admin = mkUser('admin'), ann = mkUser('user', 'Ann'), bob = mkUser('user', 'Bob');
const idle = async () => { for (let i = 0; i < 200 && scanState.running; i++) await new Promise((r) => setTimeout(r, 25)); };

test('activity: streams are listed for the admin and can be stopped for real', async () => {
  const f = mkFile({ title: 'Lopende Film' });
  const direct = (await call(app, ann, 'POST', '/api/play', { fileId: f.fileId })).json();
  const hls = (await call(app, bob, 'POST', '/api/play', { fileId: f.fileId, quality: '480' })).json();
  await call(app, ann, 'POST', '/api/play', { fileId: f.fileId, track: false });   // only fetching a download link
  await call(app, ann, 'POST', '/api/progress', { titleId: f.titleId, position: 120, duration: 6000 });

  assert.equal((await call(app, ann, 'GET', '/api/admin/activity')).statusCode, 403);
  assert.equal((await call(app, null, 'GET', '/api/admin/activity')).statusCode, 401);
  const act = await call(app, admin, 'GET', '/api/admin/activity');
  const streams = act.json().streams;
  assert.deepEqual(streams.map((s) => [s.user, s.title, s.mode, s.quality, s.transcoding, s.device]).sort(), [['Ann', 'Lopende Film', 'direct', 'original', false, 'Test'], ['Bob', 'Lopende Film', 'hls', '480', true, 'Test']]);
  assert.equal(streams.find((s) => s.user === 'Ann').position, 120);
  assert.ok(!act.body.includes(direct.url.split('/').pop()), 'stream links are not shown on the dashboard');
  assert.ok(act.json().system.cores >= 1 && act.json().system.memTotal > 0);
  assert.equal(act.json().transcodes.length, 1);

  // Stop Ann: her link dies, only her device is told, Bob keeps watching.
  const heard = { ann: [], annOther: [], bob: [] };
  const sock = (list) => ({ readyState: 1, send: (d) => list.push(JSON.parse(d)) });
  const drops = [register(ann.id, { socket: sock(heard.ann), session: sessionId(ann.token) }), register(ann.id, { socket: sock(heard.annOther), session: 'other' }), register(bob.id, { socket: sock(heard.bob), session: sessionId(bob.token) })];
  assert.equal((await app.inject({ url: direct.url })).statusCode, 200);
  const annStream = streams.find((s) => s.user === 'Ann');
  assert.equal((await call(app, ann, 'POST', `/api/admin/activity/${annStream.id}/stop`, {})).statusCode, 403);
  assert.equal((await call(app, admin, 'POST', `/api/admin/activity/${annStream.id}/stop`, { message: 'Even onderhoud' })).statusCode, 200);
  assert.equal((await app.inject({ url: direct.url })).statusCode, 403);
  assert.deepEqual(heard.ann, [{ t: 'stopped', titleId: f.titleId, message: 'Even onderhoud' }]);
  assert.deepEqual([heard.annOther.length, heard.bob.length], [0, 0]);
  // Stopping a transcode ends its session.
  assert.equal((await app.inject({ url: hls.url })).statusCode, 200);
  const bobStream = (await call(app, admin, 'GET', '/api/admin/activity')).json().streams.find((s) => s.user === 'Bob');
  await call(app, admin, 'POST', `/api/admin/activity/${bobStream.id}/stop`, {});
  assert.equal((await app.inject({ url: hls.url })).statusCode, 404);
  assert.equal((await call(app, admin, 'POST', `/api/admin/activity/${bobStream.id}/stop`, {})).statusCode, 404);
  assert.equal((await call(app, admin, 'GET', '/api/admin/activity')).json().streams.length, 0);
  drops.forEach((d) => d());
});

test('Sonarr/Radarr webhook: secret token, path translation, scans the folder at once', async () => {
  assert.equal(arrPath({ movie: { folderPath: '/movies/Up (2009)' }, movieFile: { relativePath: 'Up.mkv', path: '/movies/Up (2009)/Up.mkv' } }, '/movies = /mnt/media/films'), '/mnt/media/films/Up (2009)');
  assert.equal(arrPath({ series: { path: '/tv/Dark' }, episodeFile: { relativePath: 'S01/x.mkv' } }, ''), '/tv/Dark');
  assert.equal(arrPath({ eventType: 'Health' }, ''), '');
  assert.equal(arrPath({ movie: { folderPath: '/moviesX/Up' } }, '/movies=/mnt'), '/moviesX/Up', 'a prefix must end at a folder boundary');

  // No token configured: the endpoint does not exist.
  assert.equal((await app.inject({ method: 'POST', url: '/api/hooks/arr/', payload: {} })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/hooks/arr/raad-maar', payload: { eventType: 'Test' } })).statusCode, 404);
  assert.equal((await call(app, ann, 'PUT', '/api/admin/requests/settings', { newHook: true })).statusCode, 403);
  await call(app, admin, 'PUT', '/api/admin/requests/settings', { newHook: true });
  const hook = (await call(app, admin, 'GET', '/api/admin/requests')).json().hookPath;
  assert.match(hook, /^\/api\/hooks\/arr\/[\w-]{20,}$/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/hooks/arr/raad-maar', payload: { eventType: 'Test' } })).statusCode, 404);
  assert.deepEqual((await app.inject({ method: 'POST', url: hook, payload: { eventType: 'Test' } })).json(), { ok: true, test: true });

  const root = tmp('arr-');
  db.prepare('INSERT INTO libraries (name, type, paths, created_at) VALUES (?,?,?,?)').run('Arr', 'movies', JSON.stringify([root]), 1);
  fs.mkdirSync(path.join(root, 'Oud (2001)')); fs.writeFileSync(path.join(root, 'Oud (2001)', 'Oud.mkv'), 'x');
  await scanAll(); await idle();
  // Radarr imports a new film; only its folder is scanned, the other one is left alone.
  fs.mkdirSync(path.join(root, 'Nieuw Binnen (2024)')); fs.writeFileSync(path.join(root, 'Nieuw Binnen (2024)', 'Nieuw.Binnen.2024.mkv'), 'x');
  fs.rmSync(path.join(root, 'Oud (2001)'), { recursive: true });
  const r = await app.inject({ method: 'POST', url: hook, payload: { eventType: 'Download', movie: { folderPath: path.join(root, 'Nieuw Binnen (2024)') }, movieFile: { relativePath: 'Nieuw.Binnen.2024.mkv' } } });
  assert.deepEqual(r.json(), { ok: true, scanned: 'path' });
  await idle();
  assert.ok(db.prepare("SELECT 1 FROM titles WHERE title = 'Nieuw Binnen'").get());
  assert.ok(db.prepare("SELECT 1 FROM titles WHERE title = 'Oud'").get(), 'a folder scan does not touch the rest of the library');
  assert.equal((await app.inject({ method: 'POST', url: hook, payload: { eventType: 'Download', movie: { folderPath: '/ergens/anders' } } })).json().scanned, 'full');
  await idle();
  await call(app, admin, 'PUT', '/api/admin/requests/settings', { removeHook: true });
  assert.equal((await app.inject({ method: 'POST', url: hook, payload: { eventType: 'Test' } })).statusCode, 404);
});

test('requests: search, ask, approve with Radarr, and nobody touches another user\'s request', async () => {
  // The film database is stubbed; everything else is the real code.
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).includes('v3-cinemeta.strem.io')
    ? new Response(JSON.stringify({ metas: [{ id: 'tt0111161', name: 'The Shawshank Redemption', releaseInfo: '1994', poster: 'https://images.metahub.space/poster/small/tt0111161/img' }, { id: 'tt9999999', name: 'Al Aanwezig', releaseInfo: '2020' }] }))
    : real(url, opts));
  test.after(() => { globalThis.fetch = real; });
  const have = mkFile({ title: 'Al Aanwezig' }); db.prepare("UPDATE titles SET imdb_id = 'tt9999999' WHERE id = ?").run(have.titleId);

  const found = (await call(app, ann, 'GET', '/api/requests/search?q=shawshank')).json().results;
  assert.deepEqual(found.map((r) => [r.title, r.year, r.available, r.requested]), [['The Shawshank Redemption', 1994, false, false], ['Al Aanwezig', 2020, true, false]]);
  assert.equal((await call(app, null, 'GET', '/api/requests/search?q=x')).statusCode, 401);

  const body = { kind: 'movie', title: 'The Shawshank Redemption', year: 1994, imdbId: 'tt0111161', poster: found[0].poster };
  const id = (await call(app, ann, 'POST', '/api/requests', body)).json().id;
  assert.equal((await call(app, bob, 'POST', '/api/requests', body)).statusCode, 409, 'already requested');
  assert.equal((await call(app, ann, 'POST', '/api/requests', { kind: 'movie', title: 'Al Aanwezig', year: 2020, imdbId: 'tt9999999' })).statusCode, 409, 'already in the library');
  const evil = (await call(app, bob, 'POST', '/api/requests', { kind: 'movie', title: 'Poster Test', poster: 'javascript:alert(1)' })).json().id;
  assert.equal(db.prepare('SELECT poster FROM requests WHERE id = ?').get(evil).poster, null);

  // Own requests only.
  assert.deepEqual((await call(app, ann, 'GET', '/api/requests')).json().requests.map((r) => r.title), ['The Shawshank Redemption']);
  assert.ok(!(await call(app, bob, 'GET', '/api/requests')).body.includes('Shawshank'));
  assert.equal((await call(app, bob, 'DELETE', `/api/requests/${id}`)).statusCode, 404);
  assert.equal((await call(app, bob, 'PUT', `/api/admin/requests/${id}`, { status: 'approved' })).statusCode, 403);
  assert.equal((await call(app, ann, 'GET', '/api/admin/requests')).statusCode, 403);
  // Children cannot request.
  await call(app, admin, 'PUT', `/api/admin/users/${bob.id}`, { maxAge: 9 });
  assert.equal((await call(app, bob, 'POST', '/api/requests', { kind: 'movie', title: 'Iets' })).statusCode, 403);
  assert.equal((await call(app, bob, 'GET', '/api/requests/search?q=iets')).statusCode, 403);
  await call(app, admin, 'PUT', `/api/admin/users/${bob.id}`, { maxAge: null });

  // A stand-in Radarr.
  const calls = [];
  const radarr = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body: b ? JSON.parse(b) : null });
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-api-key'] !== 'radarr-geheim') { res.statusCode = 401; return res.end('{}'); }
      if (req.url.startsWith('/api/v3/movie/lookup')) return res.end(JSON.stringify([{ title: 'The Shawshank Redemption', tmdbId: 278, year: 1994 }]));
      if (req.url === '/api/v3/rootfolder') return res.end(JSON.stringify([{ path: '/movies' }]));
      if (req.url === '/api/v3/qualityprofile') return res.end(JSON.stringify([{ id: 4, name: 'HD' }]));
      if (req.method === 'POST' && req.url === '/api/v3/movie') { res.statusCode = 201; return res.end('{"id":1}'); }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => radarr.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${radarr.address().port}`;
  assert.equal((await call(app, admin, 'PUT', '/api/admin/requests/settings', { radarr: { url: 'geen-adres', key: 'x' } })).statusCode, 400);
  await call(app, admin, 'PUT', '/api/admin/requests/settings', { radarr: { url: `${url}/`, key: 'radarr-geheim' } });
  const shown = await call(app, admin, 'GET', '/api/admin/requests');
  assert.ok(!shown.body.includes('radarr-geheim'), 'the API key is never sent back');
  assert.deepEqual(shown.json().radarr, { url, key: '••••heim' });
  await call(app, admin, 'PUT', '/api/admin/requests/settings', { radarr: { url, key: '••••heim' } });   // saving the form again keeps the key
  assert.equal(settings.get('radarr_key'), 'radarr-geheim');

  const told = []; const drop = register(ann.id, { socket: { readyState: 1, send: (d) => told.push(JSON.parse(d)) }, session: 'x' });
  const done = (await call(app, admin, 'PUT', `/api/admin/requests/${id}`, { status: 'approved', note: 'Komt eraan' })).json();
  assert.deepEqual([done.status, done.forwarded, done.forwardError, done.note], ['approved', 'radarr', '', 'Komt eraan']);
  const post = calls.find((c) => c.method === 'POST');
  assert.deepEqual([post.body.tmdbId, post.body.rootFolderPath, post.body.qualityProfileId, post.body.monitored, post.body.addOptions.searchForMovie], [278, '/movies', 4, true, true]);
  assert.ok(calls[0].url.includes('term=imdb%3Att0111161'));
  assert.deepEqual(told.map((m) => [m.t, m.status, m.note]), [['request', 'approved', 'Komt eraan']]);
  assert.equal((await call(app, ann, 'DELETE', `/api/requests/${id}`)).statusCode, 404, 'a decided request cannot be withdrawn');
  // A wrong key is reported, the approval itself stands.
  const second = (await call(app, ann, 'POST', '/api/requests', { kind: 'movie', title: 'Tweede Wens', year: 2001 })).json().id;
  settings.set('radarr_key', 'fout');
  const bad = (await call(app, admin, 'PUT', `/api/admin/requests/${second}`, { status: 'approved' })).json();
  assert.deepEqual([bad.status, bad.forwarded, bad.forwardError], ['approved', '', 'API-sleutel geweigerd']);
  radarr.close();
  // Declining, and "available" once the film is in the library after a scan.
  assert.equal((await call(app, admin, 'PUT', `/api/admin/requests/${evil}`, { status: 'declined' })).json().status, 'declined');
  const arrived = mkFile({ title: 'The Shawshank Redemption' });
  db.prepare("UPDATE titles SET imdb_id = 'tt0111161', norm_key = 'shawshank redemption|1994' WHERE id = ?").run(arrived.titleId);
  db.prepare('DELETE FROM libraries').run();
  await scanAll(); await idle();
  assert.equal(db.prepare('SELECT status FROM requests WHERE id = ?').get(id).status, 'available');
  assert.equal(told.at(-1).status, 'available');
  drop();
});
