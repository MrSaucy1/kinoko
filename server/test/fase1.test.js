// Fase 1: watcher, backups, series preferences, subtitle offset, resume on
// another device, extras, per-user quality limit, webhooks.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, mkUser, mkFile, call, tmp } from './helpers.js';

const { db, settings } = await import('../src/db.js');
const { default: authRoutes } = await import('../src/auth.js');
const { default: libraryRoutes, scanAll, classifyExtra } = await import('../src/library.js');
const { default: streamRoutes, applyLimit } = await import('../src/stream.js');
const { default: catalogRoutes, titleDetail } = await import('../src/catalog.js');
const { default: backupRoutes, createBackup, listBackups } = await import('../src/backup.js');
const { default: webhookRoutes, payload, maskUrl, emit } = await import('../src/webhooks.js');
const { register } = await import('../src/events.js');
const { debounce, watchLibraries, stopWatching } = await import('../src/watcher.js');

const app = await makeApp(authRoutes, libraryRoutes, streamRoutes, catalogRoutes, backupRoutes, webhookRoutes);
const admin = mkUser('admin'), ann = mkUser(), bob = mkUser();
test.after(() => { stopWatching(); return app.close(); });

test('the migration added the fase 1 tables and columns', () => {
  assert.ok(db.pragma('user_version', { simple: true }) >= 1);
  assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'max_quality'").get());
  for (const t of ['series_prefs', 'sub_offsets', 'extras', 'webhooks']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t), t);
});

test('extras are attached to their title and never become titles', async () => {
  assert.equal(classifyExtra('/m/Up (2009)/Up (2009)-trailer.mkv').kind, 'trailer');
  assert.equal(classifyExtra('/m/Up (2009)/Extras/Making of.mkv', 'extra').name, 'Making of');
  assert.equal(classifyExtra('/m/Up (2009)/Up (2009).mkv'), null);

  const root = tmp('lib-');
  const mk = (p) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), 'x'); };
  mk('Up (2009)/Up (2009).mkv'); mk('Up (2009)/Up (2009)-trailer.mkv'); mk('Up (2009)/Extras/Making of.mkv');
  mk('Up (2009)/Behind The Scenes/Pixar.mkv'); mk('The Other (2001)/The.Other.mkv'); mk('Trailers/Los.mkv');
  const lib = db.prepare('INSERT INTO libraries (name, type, paths, created_at) VALUES (?,?,?,?)').run('Films', 'movies', JSON.stringify([root]), 1).lastInsertRowid;
  await scanAll();
  const titles = db.prepare('SELECT title FROM titles WHERE id IN (SELECT title_id FROM files WHERE library_id = ?) ORDER BY title').all(lib).map((t) => t.title);
  assert.deepEqual(titles, ['The Other', 'Up']);
  const up = db.prepare("SELECT id FROM titles WHERE title = 'Up'").get().id;
  const extras = titleDetail(up, ann.id).extras;
  assert.deepEqual(extras.map((x) => [x.label, x.name]).sort(), [['Achter de schermen', 'Pixar'], ['Extra', 'Making of'], ['Trailer', 'Trailer']]);

  const r = await call(app, ann, 'POST', `/api/extras/${extras[0].id}/play`, {});
  assert.equal(r.statusCode, 200);
  assert.match(r.json().url, /^\/api\/stream\//);
  assert.equal((await app.inject({ url: r.json().url })).statusCode, 200);
  assert.equal((await call(app, null, 'POST', `/api/extras/${extras[0].id}/play`, {})).statusCode, 401);

  // Removing the file removes the extra on the next scan.
  fs.unlinkSync(path.join(root, 'Up (2009)/Extras/Making of.mkv'));
  await scanAll();
  assert.equal(titleDetail(up, ann.id).extras.length, 2);
});

test('the quality limit is enforced on /api/play', async () => {
  const big = { height: 1080, bitrate: 9_000_000 }, small = { height: 480, bitrate: 1_200_000 };
  assert.deepEqual(applyLimit(big, { quality: 'original' }, 0), { body: { quality: 'original' }, capped: false });
  assert.equal(applyLimit(big, { quality: 'original' }, 720).body.quality, '720');
  assert.equal(applyLimit(big, { quality: '1080' }, 720).body.quality, '720');
  assert.equal(applyLimit(big, { quality: '480' }, 720).body.quality, '480');
  assert.equal(applyLimit(big, {}, 720).body.quality, '720');
  assert.deepEqual(applyLimit(small, { quality: 'original' }, 720), { body: { quality: 'original' }, capped: false });

  const f = mkFile({ height: 1080, bitrate: 9_000_000 });
  const free = (await call(app, ann, 'POST', '/api/play', { fileId: f.fileId })).json();
  assert.equal(free.mode, 'direct'); assert.ok(free.download);

  assert.equal((await call(app, ann, 'PUT', `/api/admin/users/${bob.id}`, { maxQuality: '720' })).statusCode, 403);
  assert.equal((await call(app, admin, 'PUT', `/api/admin/users/${bob.id}`, { maxQuality: '4000' })).statusCode, 400);
  assert.equal((await call(app, admin, 'PUT', `/api/admin/users/${bob.id}`, { maxQuality: '720' })).statusCode, 200);
  for (const quality of ['original', '1080', undefined]) {
    const p = (await call(app, bob, 'POST', '/api/play', { fileId: f.fileId, quality })).json();
    assert.equal(p.mode, 'hls'); assert.equal(p.quality, '720'); assert.equal(p.download, undefined); assert.equal(p.limited, true);
  }
  await call(app, admin, 'PUT', `/api/admin/users/${bob.id}`, { maxQuality: '' });
  assert.equal((await call(app, bob, 'POST', '/api/play', { fileId: f.fileId })).json().mode, 'direct');
});

test('subtitle offset and series preferences are stored per user', async () => {
  const f = mkFile({ kind: 'show', episode: [1, 1] });
  assert.equal((await call(app, ann, 'PUT', `/api/files/${f.fileId}/sub-offset`, { offsetMs: -300 })).json().offsetMs, -300);
  assert.equal((await call(app, ann, 'POST', '/api/play', { fileId: f.fileId })).json().subOffsetMs, -300);
  assert.equal((await call(app, bob, 'POST', '/api/play', { fileId: f.fileId })).json().subOffsetMs, 0);
  assert.equal((await call(app, ann, 'PUT', `/api/files/${f.fileId}/sub-offset`, { offsetMs: 9e9 })).statusCode, 400);
  assert.equal((await call(app, null, 'PUT', `/api/files/${f.fileId}/sub-offset`, { offsetMs: 100 })).statusCode, 401);

  assert.deepEqual((await call(app, ann, 'PUT', `/api/titles/${f.titleId}/prefs`, { audioLang: 'ja', subLang: 'nl' })).json(), { audioLang: 'ja', subLang: 'nl' });
  assert.deepEqual((await call(app, ann, 'PUT', `/api/titles/${f.titleId}/prefs`, { subLang: 'off' })).json(), { audioLang: 'ja', subLang: 'off' });
  assert.deepEqual((await call(app, ann, 'GET', `/api/titles/${f.titleId}`)).json().prefs, { audioLang: 'ja', subLang: 'off' });
  assert.deepEqual((await call(app, bob, 'GET', `/api/titles/${f.titleId}`)).json().prefs, { audioLang: '', subLang: '' });
  assert.equal((await call(app, ann, 'PUT', `/api/titles/${f.titleId}/prefs`, { audioLang: "x'; DROP" })).statusCode, 400);
});

test('pausing offers to continue on the same user\'s other devices only', async () => {
  const f = mkFile();
  const got = { other: [], same: [], bob: [] };
  const sock = (list) => ({ readyState: 1, send: (d) => list.push(JSON.parse(d)) });
  const { sessionId } = await import('../src/auth.js');
  const drops = [register(ann.id, { socket: sock(got.other), session: 'another-device' }), register(ann.id, { socket: sock(got.same), session: sessionId(ann.token) }), register(bob.id, { socket: sock(got.bob), session: 'bob' })];
  await call(app, ann, 'POST', '/api/progress', { titleId: f.titleId, position: 600, duration: 6000 });
  assert.equal(got.other.length, 0, 'no offer without a pause');
  await call(app, ann, 'POST', '/api/progress', { titleId: f.titleId, position: 600, duration: 6000, paused: true });
  assert.equal(got.other.length, 1);
  assert.deepEqual([got.other[0].t, got.other[0].titleId, got.other[0].position], ['resume', f.titleId, 600]);
  assert.equal(got.same.length, 0);
  assert.equal(got.bob.length, 0);
  drops.forEach((d) => d());
});

test('backups: a usable copy, the newest N are kept, admin only', async () => {
  settings.set('backup_keep', 2);
  const names = [createBackup(new Date(2026, 0, 1, 3, 0, 0)), createBackup(new Date(2026, 0, 2, 3, 0, 0)), createBackup(new Date(2026, 0, 3, 3, 0, 0))];
  assert.deepEqual(listBackups().map((b) => b.name), [names[2], names[1]]);
  const { default: Database } = await import('better-sqlite3');
  const copy = new Database(path.join(process.env.KINOKO_DATA, 'backups', names[2]), { readonly: true });
  assert.ok(copy.prepare('SELECT COUNT(*) c FROM users').get().c >= 3);
  copy.close();

  assert.equal((await call(app, ann, 'GET', '/api/admin/backups')).statusCode, 403);
  assert.equal((await call(app, ann, 'GET', `/api/admin/backups/${names[2]}`)).statusCode, 403);
  assert.equal((await call(app, null, 'GET', `/api/admin/backups/${names[2]}`)).statusCode, 401);
  const dl = await call(app, admin, 'GET', `/api/admin/backups/${names[2]}`);
  assert.equal(dl.statusCode, 200);
  assert.equal(dl.rawPayload.subarray(0, 15).toString(), 'SQLite format 3');
  for (const bad of ['..%2Fkinoko.db', 'kinoko.db', 'kinoko-20260103-030000.db%2F..%2F..%2Fkinoko.db']) assert.equal((await call(app, admin, 'GET', `/api/admin/backups/${bad}`)).statusCode, 400, bad);
  assert.equal((await call(app, admin, 'PUT', '/api/admin/backups', { keep: 0 })).statusCode, 400);
});

test('webhooks: formats, masked address, delivery, admin only', async () => {
  assert.equal(payload('json', 'scan.finished', { text: 'klaar', fields: { files: 3 } }).data.files, 3);
  assert.equal(payload('discord', 'scan.finished', { text: 'klaar' }).embeds[0].description, 'klaar');
  assert.equal(maskUrl('https://discord.com/api/webhooks/123/geheimtoken'), 'https://discord.com/…oken');

  const received = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { received.push(JSON.parse(b)); res.end('ok'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/hook/geheim-abc`;

  assert.equal((await call(app, ann, 'POST', '/api/admin/webhooks', { name: 'x', url, events: ['scan.finished'] })).statusCode, 403);
  assert.equal((await call(app, admin, 'POST', '/api/admin/webhooks', { name: 'x', url: 'file:///etc/passwd', events: [] })).statusCode, 400);
  const id = (await call(app, admin, 'POST', '/api/admin/webhooks', { name: 'Test', url, format: 'json', events: ['scan.finished', 'bestaat-niet'] })).json().id;
  const list = await call(app, admin, 'GET', '/api/admin/webhooks');
  assert.ok(!list.body.includes('geheim-abc'), 'the list leaks the webhook address');
  assert.deepEqual(list.json().webhooks[0].events, ['scan.finished']);

  assert.equal((await call(app, admin, 'POST', `/api/admin/webhooks/${id}/test`)).statusCode, 200);
  emit('scan.finished', { text: 'echt' }); emit('playback.started', { text: 'niet geabonneerd' });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(received.map((p) => p.text), ['Dit is een testbericht van Kinoko.', 'echt']);
  // Renaming keeps the address; a dead address reports an error instead of throwing.
  await call(app, admin, 'PUT', `/api/admin/webhooks/${id}`, { name: 'Anders' });
  srv.close();
  assert.equal((await call(app, admin, 'POST', `/api/admin/webhooks/${id}/test`)).statusCode, 502);
  await call(app, admin, 'DELETE', `/api/admin/webhooks/${id}`);
});

test('the watcher debounces and notices a new file', async () => {
  let n = 0; const d = debounce(() => n++, 40);
  d(); d(); d();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(n, 1);

  const root = tmp('watch-');
  db.prepare('INSERT INTO libraries (name, type, paths, created_at) VALUES (?,?,?,?)').run('Kijk', 'movies', JSON.stringify([root]), 1);
  let hits = 0;
  watchLibraries(() => hits++, { wait: 60 });
  await new Promise((r) => setTimeout(r, 100));
  fs.writeFileSync(path.join(root, '.verborgen.part'), 'x');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(hits, 0, 'temporary files do not trigger a scan');
  fs.mkdirSync(path.join(root, 'Nieuw (2024)')); fs.writeFileSync(path.join(root, 'Nieuw (2024)', 'Nieuw.mkv'), 'x');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(hits, 1);
});
