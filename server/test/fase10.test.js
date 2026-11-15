// Fase 10: recording live tv, archiving with yt-dlp, casting to DLNA.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, mkUser, call, tmp } from './helpers.js';

const { db, settings, now } = await import('../src/db.js');
const { default: authRoutes } = await import('../src/auth.js');
const { default: libraryRoutes, scanState } = await import('../src/library.js');
const { default: dvrRoutes, fileName, schedule, applyRules, tick, cleanup, usage, dvrDir } = await import('../src/dvr.js');
const { run, ffmpegAvailable } = await import('../src/ffmpeg.js');
const { config } = await import('../src/config.js');

const app = await makeApp(authRoutes, libraryRoutes, dvrRoutes);
test.after(() => app.close());
const admin = mkUser('admin'), ann = mkUser('user', 'Ann');
const hasFfmpeg = !!(await ffmpegAvailable());
const idle = async () => { for (let i = 0; i < 400 && scanState.running; i++) await new Promise((r) => setTimeout(r, 25)); };
const src = Number(db.prepare("INSERT INTO iptv_sources (name, kind, url) VALUES ('P', 'm3u', 'http://p.invalid/x.m3u')").run().lastInsertRowid);
const channel = (name, url) => Number(db.prepare('INSERT INTO iptv_channels (source_id, ext_id, name, url) VALUES (?,?,?,?)').run(src, name, name, url).lastInsertRowid);

test('DVR: planning is validated and admin only', async () => {
  assert.equal(fileName('Het Journaal: 20/1 <live>', Math.floor(new Date(2026, 0, 5, 20, 0).getTime() / 1000)), 'Het Journaal 20 1 live - 2026-01-05 20.00.mkv');
  assert.equal(fileName('../../etc/passwd', 0).includes('/'), false);
  const ch = channel('NPO 1', 'http://p.invalid/1.ts'), t = now();
  const ok = { channelId: ch, title: 'Journaal', start: t + 3600, end: t + 5400 };
  assert.equal((await call(app, ann, 'POST', '/api/admin/dvr', ok)).statusCode, 403);
  assert.equal((await call(app, null, 'GET', '/api/admin/dvr')).statusCode, 401);
  for (const bad of [{ ...ok, end: t + 3000 }, { ...ok, start: t - 7200, end: t - 3600 }, { ...ok, end: t + 3600 + 9 * 3600 }, { ...ok, title: ' ' }]) assert.equal((await call(app, admin, 'POST', '/api/admin/dvr', bad)).statusCode, 400);
  assert.equal((await call(app, admin, 'POST', '/api/admin/dvr', { ...ok, channelId: 999999 })).statusCode, 404);
  const id = (await call(app, admin, 'POST', '/api/admin/dvr', ok)).json().id;
  assert.equal((await call(app, admin, 'POST', '/api/admin/dvr', ok)).statusCode, 409, 'the same programme twice');
  const list = (await call(app, admin, 'GET', '/api/admin/dvr')).json();
  assert.deepEqual(list.recordings.map((r) => [r.title, r.channel, r.status]), [['Journaal', 'NPO 1', 'scheduled']]);
  assert.equal((await call(app, admin, 'DELETE', `/api/admin/dvr/${id}`)).statusCode, 200);
  assert.equal(db.prepare('SELECT status FROM recordings WHERE id = ?').get(id).status, 'cancelled');
  // A programme that was missed (server was off) is marked, not recorded late.
  const missed = Number(db.prepare("INSERT INTO recordings (channel_id, channel_name, title, start_at, end_at, created_at) VALUES (?, 'NPO 1', 'Gemist', ?, ?, 1)").run(ch, t - 7200, t - 3600).lastInsertRowid);
  tick();
  assert.equal(db.prepare('SELECT status FROM recordings WHERE id = ?').get(missed).status, 'failed');
});

test('DVR: a series rule plans every matching programme once', async () => {
  const ch = channel('RTL 4', 'http://p.invalid/4.ts'), t = now();
  const fake = async () => [{ title: 'Goede Tijden, Slechte Tijden', start: t + 1000, end: t + 2800 }, { title: 'Nieuws', start: t + 2800, end: t + 4000 }, { title: 'GOEDE TIJDEN, slechte tijden', start: t + 90000, end: t + 91800 }, { title: 'Goede tijden (oud)', start: t - 5000, end: t - 3000 }];
  db.prepare('INSERT INTO record_rules (channel_id, match, created_at) VALUES (?,?,?)').run(ch, 'goede tijden', t);
  assert.equal(await applyRules(fake), 2);
  assert.equal(await applyRules(fake), 0, 'nothing is planned twice');
  assert.deepEqual(db.prepare("SELECT title FROM recordings WHERE channel_id = ? ORDER BY start_at").all(ch).map((r) => r.title), ['Goede Tijden, Slechte Tijden', 'GOEDE TIJDEN, slechte tijden']);
  assert.equal((await call(app, admin, 'POST', '/api/admin/dvr/rules', { channelId: ch, match: 'x' })).statusCode, 400);
  assert.equal((await call(app, ann, 'POST', '/api/admin/dvr/rules', { channelId: ch, match: 'nieuws' })).statusCode, 403);
});

test('DVR with ffmpeg: a programme is recorded, lands in the Opnames library, and the limit makes room', { skip: !hasFfmpeg && 'ffmpeg is niet geïnstalleerd' }, async () => {
  // A "channel": a short MPEG-TS clip served over HTTP.
  const clip = path.join(tmp('tv-'), 'zender.ts');
  const mk = await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'mpegts', '-y', clip], { timeout: 60_000 });
  assert.equal(mk.code, 0, mk.stderr);
  const srv = http.createServer((req, res) => { if (req.url === '/dood.ts') { res.statusCode = 403; return res.end(); } res.setHeader('content-type', 'video/mp2t'); fs.createReadStream(clip).pipe(res); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`, t = now();
  const good = channel('Testzender', `${base}/live.ts`), dead = channel('Dode zender', `${base}/dood.ts`);
  const id = schedule({ channelId: good, title: 'Testprogramma', start: t - 10, end: t + 2 });
  const bad = schedule({ channelId: dead, title: 'Geen beeld', start: t - 10, end: t + 2 });
  tick();
  const wait = async (rid) => { for (let i = 0; i < 400; i++) { const s = db.prepare('SELECT status FROM recordings WHERE id = ?').get(rid).status; if (s !== 'recording' && s !== 'scheduled') return s; await new Promise((r) => setTimeout(r, 50)); } return 'timeout'; };
  assert.equal(await wait(id), 'done');
  assert.equal(await wait(bad), 'failed');
  const rec = db.prepare('SELECT * FROM recordings WHERE id = ?').get(id);
  assert.ok(rec.size > 1000 && fs.existsSync(rec.path)); assert.ok(rec.path.startsWith(dvrDir() + path.sep));
  assert.match(db.prepare('SELECT error FROM recordings WHERE id = ?').get(bad).error, /geen beeld/);
  await idle(); await new Promise((r) => setTimeout(r, 200)); await idle();
  const lib = db.prepare("SELECT id FROM libraries WHERE name = 'Opnames'").get();
  assert.ok(lib, 'the Opnames library was made');
  assert.ok(db.prepare("SELECT 1 FROM titles t JOIN files f ON f.title_id = t.id WHERE f.library_id = ? AND t.title = 'Testprogramma'").get(lib.id), 'the recording is a title in the library');
  // The limit: with room for nothing, the oldest finished recording goes.
  assert.equal(usage(), rec.size);
  settings.set('dvr_limit_gb', 1); assert.equal(cleanup(), 0);
  assert.equal(cleanup(2 * 1024 ** 3), 1);
  assert.equal(fs.existsSync(rec.path), false);
  // Removing through the API never touches a file outside the recordings folder.
  const outside = path.join(tmp('x-'), 'belangrijk.txt'); fs.writeFileSync(outside, 'x');
  const evil = Number(db.prepare("INSERT INTO recordings (channel_name, title, start_at, end_at, status, path, created_at) VALUES ('x', 'x', 1, 2, 'done', ?, 1)").run(outside).lastInsertRowid);
  await call(app, admin, 'DELETE', `/api/admin/dvr/${evil}`);
  assert.equal(fs.existsSync(outside), true);
  srv.close();
});

test('archive: only a plain https address reaches yt-dlp, with fixed options before "--"', async () => {
  const { default: archiveRoutes, cleanUrl, ytdlpArgs, writeSidecars, fetchSource, archiveDir } = await import('../src/archive.js');
  const { parseNfo } = await import('../src/metadata.js');
  const a = await makeApp(authRoutes, archiveRoutes);
  for (const bad of ['--exec=rm -rf /', 'file:///etc/passwd', 'http://youtube.com/x', 'https://user:pass@youtube.com/x', 'ytsearch:iets', 'https://localhost/x', 'https://youtube.com/x\n--exec']) assert.throws(() => cleanUrl(bad), /adres/, bad);
  assert.equal(cleanUrl(' https://www.youtube.com/@kanaal/videos '), 'https://www.youtube.com/@kanaal/videos');
  const args = ytdlpArgs({ kind: 'video', url: 'https://www.youtube.com/@kanaal', max_items: 5 });
  assert.deepEqual(args.slice(-2), ['--', 'https://www.youtube.com/@kanaal']);
  assert.ok(args.includes('--ignore-config') && args.includes('--no-exec') && args[args.indexOf('--playlist-end') + 1] === '5');
  assert.ok(ytdlpArgs({ kind: 'audio', url: 'https://x.nl/feed', max_items: 999 }).includes('-x'));

  assert.equal((await call(a, ann, 'POST', '/api/admin/archive', { url: 'https://www.youtube.com/@kanaal' })).statusCode, 403);
  assert.equal((await call(a, admin, 'POST', '/api/admin/archive', { url: '--exec=id' })).statusCode, 400);
  const id = (await call(a, admin, 'POST', '/api/admin/archive', { url: 'https://www.youtube.com/@kanaal', name: 'Mijn kanaal', maxItems: 3 })).json().id;
  assert.equal((await call(a, admin, 'POST', '/api/admin/archive', { url: 'https://www.youtube.com/@kanaal' })).statusCode, 409);

  // A stand-in yt-dlp: notes what it was asked and leaves a video with its sidecar files.
  const bin = path.join(tmp('yt-'), 'yt-dlp'), log = `${bin}.args`;
  const out = path.join(archiveDir('video'), 'Kanaal', 'Eerste_video (2024)');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n[ "$1" = "--version" ] && { echo 2099.01.01; exit 0; }\nmkdir -p '${out}'\necho x > '${out}/Eerste_video.mkv'\necho '{"title":"Eerste <video> & meer","description":"Uitleg","upload_date":"20240315","uploader":"Kanaal","extractor_key":"Youtube"}' > '${out}/Eerste_video.info.json'\necho j > '${out}/Eerste_video.jpg'\n`, { mode: 0o755 });
  config.ytdlp = bin;
  try {
    const state = (await call(a, admin, 'GET', '/api/admin/archive')).json();
    assert.deepEqual([state.installed, state.version, state.sources[0].name], [true, '2099.01.01', 'Mijn kanaal']);
    const r = await fetchSource(db.prepare('SELECT * FROM archive_sources WHERE id = ?').get(id));
    assert.deepEqual(r, { added: 1, error: '' });
    const passed = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(passed.slice(-2), ['--', 'https://www.youtube.com/@kanaal']);
    const nfo = parseNfo(fs.readFileSync(path.join(out, 'movie.nfo'), 'utf8'));
    assert.deepEqual([nfo.title, nfo.year, nfo.overview, nfo.localOnly], ['Eerste <video> & meer', 2024, 'Uitleg', true]);
    assert.ok(fs.existsSync(path.join(out, 'poster.jpg')));
    assert.equal(writeSidecars(archiveDir('video')), 0, 'sidecars are written once');
    assert.ok(db.prepare("SELECT 1 FROM libraries WHERE name = 'Archief' AND type = 'movies'").get());
    assert.equal(db.prepare('SELECT items FROM archive_sources WHERE id = ?').get(id).items, 1);
  } finally { config.ytdlp = 'yt-dlp-bestaat-niet'; }
  assert.equal((await call(a, admin, 'POST', '/api/admin/archive/run')).statusCode, 501);
  await a.close();
});
