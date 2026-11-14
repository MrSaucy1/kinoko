// Unit tests for the pure logic. Run with: npm test
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KINOKO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoko-test-'));

const { parseMovie, parseEpisode, normKey } = await import('../src/parse.js');
const { buildGroups, franchiseBase } = await import('../src/collections.js');
const { longestCommon } = await import('../src/markers.js');
const { toVtt } = await import('../src/subtitles.js');
const { parseM3u } = await import('../src/iptv.js');
const { themeFor, resolutionLabel, versions } = await import('../src/catalog.js');
const { parseNfo } = await import('../src/metadata.js');
const { hashPassword, verifyPassword } = await import('../src/auth.js');

test('movie names: folder with year wins, scene names are cleaned', () => {
  assert.deepEqual(parseMovie('/m/Spider-Man Homecoming (2017)/whatever.1080p.mkv'), { title: 'Spider-Man Homecoming', year: 2017 });
  assert.deepEqual(parseMovie('/m/Blade.Runner.2049.2017.2160p.UHD.BluRay.x265-GRP.mkv'), { title: 'Blade Runner 2049', year: 2017 });
  assert.deepEqual(parseMovie('/m/1917.2019.1080p.mkv'), { title: '1917', year: 2019 });
  assert.deepEqual(parseMovie('/m/Up.mkv'), { title: 'Up', year: null });
});

test('episode names: SxxEyy, 1x02, season folders, Dutch folder names', () => {
  assert.deepEqual(parseEpisode('/s/Breaking Bad/Season 01/Breaking Bad - S01E02 - Cat\'s in the Bag.mkv', '/s'), { title: 'Breaking Bad', year: null, season: 1, episode: 2, name: "Cat's in the Bag" });
  assert.equal(parseEpisode('/s/The.Office.US.S03E12.720p.HDTV.mkv', '/s').title, 'The Office US');
  assert.deepEqual(parseEpisode('/s/Dark (2017)/Seizoen 2/05 - Lost and Found.mkv', '/s'), { title: 'Dark', year: 2017, season: 2, episode: 5, name: 'Lost and Found' });
  assert.equal(parseEpisode('/s/Arcane/arcane.1x03.mkv', '/s').episode, 3);
});

test('normKey ignores articles, accents and punctuation', () => {
  assert.equal(normKey('The Avengers: Endgame', 2019), 'avengers endgame|2019');
  assert.equal(normKey('Amélie', null), 'amelie');
});

test('smart collections: database series first, title heuristic as fallback, no duplicates', () => {
  const t = (id, title, extra = {}) => ({ id, title, tmdb_collection: null, series_json: '[]', ...extra });
  const mcu = JSON.stringify([{ id: 'Q1', name: 'Marvel Cinematic Universe' }, { id: 'Q9', name: 'Marvel Cinematic Universe Phase Three' }]);
  const groups = buildGroups([
    t(1, 'Iron Man', { series_json: mcu }), t(2, 'The Avengers', { series_json: mcu }),
    t(3, 'Toy Story'), t(4, 'Toy Story 2'), t(5, 'Up'),
    t(6, 'Dune: Part One'), t(7, 'Dune: Part Two'),
  ]);
  const names = groups.map((g) => g.name).sort();
  assert.deepEqual(names, ['Dune collectie', 'Marvel Cinematic Universe', 'Toy Story collectie']);
  assert.equal(franchiseBase('Toy Story 3'), 'toy story');
});

test('intro detection finds the shared stretch at different offsets', () => {
  const rnd = (seed) => { let x = seed; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x; }; };
  const shared = Uint32Array.from({ length: 240 }, rnd(7));
  const mk = (seed, before, after) => Uint32Array.from([...Array.from({ length: before }, rnd(seed)), ...shared, ...Array.from({ length: after }, rnd(seed + 99))]);
  const m = longestCommon(mk(1, 80, 300), mk(2, 180, 250));
  assert.ok(Math.abs(m.aStart - 80) <= 2 && Math.abs(m.bStart - 180) <= 2, JSON.stringify(m));
  assert.ok(Math.abs(m.len - 240) <= 4);
});

test('srt becomes webvtt', () => {
  const vtt = toVtt('﻿1\r\n00:00:01,000 --> 00:00:05,500\r\nHallo\r\n');
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.ok(vtt.includes('00:00:01.000 --> 00:00:05.500'));
});

test('m3u playlists are parsed with group, logo and url', () => {
  const list = parseM3u('#EXTM3U\n#EXTINF:-1 tvg-id="npo1" tvg-logo="http://x/l.png" group-title="Nederland",NPO 1\nhttp://x/1.ts\n#EXTINF:-1,Zonder groep\nhttp://x/2.m3u8\n');
  assert.equal(list.length, 2);
  assert.deepEqual({ ...list[0] }, { name: 'NPO 1', logo: 'http://x/l.png', category: 'Nederland', ext_id: 'npo1', url: 'http://x/1.ts' });
  assert.equal(list[1].category, 'Overig');
});

test('watch night follows the calendar', () => {
  assert.equal(themeFor(new Date(2026, 11, 20)), 'kerst');
  assert.equal(themeFor(new Date(2026, 9, 30)), 'halloween');
  assert.equal(themeFor(new Date(2026, 1, 12)), 'valentijn');
  assert.equal(themeFor(new Date(2026, 0, 15)), 'winter');
  assert.equal(themeFor(new Date(2026, 6, 1)), 'zomer');
  assert.equal(themeFor(new Date(2026, 10, 12)), 'herfst');
});

test('the best version is the one with the highest bitrate; local wins a tie', () => {
  const f = (id, bitrate, peer_id, height = 1080) => ({ id, bitrate, peer_id, height, width: 1920, size: 1, duration: 1, vcodec: 'h264', acodec: 'aac', container: 'mkv', hdr: 0, streams: '{}' });
  const v = versions([f(1, 4_000_000, null), f(2, 9_000_000, 5), f(3, 9_000_000, null)], new Map([[5, 'Vriend']]));
  assert.deepEqual(v.map((x) => x.fileId), [3, 2, 1]);
  assert.equal(v[0].best, true);
  assert.equal(v[1].server.name, 'Vriend');
  assert.equal(resolutionLabel({ width: 3840, height: 1600 }), '4K');
});

test('nfo files give ids, plot and cast', () => {
  const n = parseNfo('<movie><title>Up</title><year>2009</year><plot>Een huis &amp; ballonnen</plot><uniqueid type="imdb">tt1049413</uniqueid><genre>Animation</genre><actor><name>Ed Asner</name><role>Carl</role></actor></movie>');
  assert.equal(n.imdb_id, 'tt1049413');
  assert.equal(n.overview, 'Een huis & ballonnen');
  assert.deepEqual(n.cast, [{ name: 'Ed Asner', role: 'Carl', photo: null }]);
});

test('passwords are hashed and verified', () => {
  const h = hashPassword('geheim123');
  assert.ok(verifyPassword('geheim123', h));
  assert.ok(!verifyPassword('anders', h));
});

test('iptv categories are grouped per country', async () => {
  const { splitCategory, groupCategories } = await import('../src/iptv.js');
  assert.deepEqual(splitCategory('NL | SPORT'), { code: 'NL', country: 'Nederland', label: 'SPORT' });
  assert.equal(splitCategory('[UK] Kids').code, 'UK');
  assert.equal(splitCategory('Germany | Sport').country, 'Duitsland');
  assert.equal(splitCategory('US').label, 'Algemeen');
  // Not a country: ordinary words and quality tags stay where they are.
  assert.equal(splitCategory('NO SIGNAL').code, '');
  assert.equal(splitCategory('4K Channels').label, '4K Channels');
  const groups = groupCategories([{ name: 'Sport', count: 2 }, { name: 'NL | Sport', count: 5 }, { name: 'NL | Kids', count: 3 }]);
  assert.deepEqual(groups.map((g) => [g.name, g.count]), [['Nederland', 8], ['Overig', 2]]);
});

// ---- sessions ---------------------------------------------------------------
const { default: Fastify } = await import('fastify');
const { default: authRoutes, createUser, createSession, userFromToken, purgeSessions, sessionId } = await import('../src/auth.js');
const { db, settings, now, HttpError } = await import('../src/db.js');

async function authApp() {
  const app = Fastify();
  app.setErrorHandler((err, req, reply) => reply.code(err instanceof HttpError ? err.status : 500).send({ error: err.message }));
  await app.register(authRoutes);
  return app;
}
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const age = (token, days) => db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(now() - days * 86400, token);

test('an idle session is refused and removed; the limit is a setting', () => {
  const id = createUser({ name: 'Verlopen', password: 'geheim123' });
  const fresh = createSession(id, 'Telefoon'), stale = createSession(id, 'Oude tv'), swept = createSession(id, 'Tablet');
  age(stale, 91); age(swept, 200); age(fresh, 89);
  assert.equal(userFromToken(fresh).id, id);
  assert.equal(userFromToken(stale), null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE token = ?').get(stale).c, 0);
  assert.equal(purgeSessions(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE token = ?').get(swept).c, 0);

  settings.set('session_idle_days', 7);
  try {
    const week = createSession(id, 'Laptop'); age(week, 8);
    assert.equal(userFromToken(week), null);
  } finally { settings.set('session_idle_days', 90); }
});

test('session endpoints list own sessions without leaking a token', async () => {
  const app = await authApp();
  const me = createUser({ name: 'Lijst', password: 'geheim123' }), other = createUser({ name: 'Buur', password: 'geheim123' });
  const mine = createSession(me, 'Web'), second = createSession(me, 'Android TV'), theirs = createSession(other, 'Web');
  const r = await app.inject({ method: 'GET', url: '/api/auth/sessions', headers: bearer(mine) });
  assert.equal(r.statusCode, 200);
  for (const t of [mine, second, theirs]) assert.ok(!r.body.includes(t), 'response contains a session token');
  const { sessions } = r.json();
  assert.deepEqual(sessions.map((s) => s.device).sort(), ['Android TV', 'Web']);
  assert.deepEqual(Object.keys(sessions[0]).sort(), ['created_at', 'current', 'device', 'id', 'last_seen']);
  assert.equal(sessions.find((s) => s.current).id, sessionId(mine));
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/sessions' })).statusCode, 401);
  await app.close();
});

test('a session can be revoked, but only by its owner', async () => {
  const app = await authApp();
  const me = createUser({ name: 'Intrekker', password: 'geheim123' }), other = createUser({ name: 'Vreemde', password: 'geheim123' });
  const a = createSession(me, 'A'), b = createSession(me, 'B'), c = createSession(me, 'C'), theirs = createSession(other, 'X');

  const foreign = await app.inject({ method: 'DELETE', url: `/api/auth/sessions/${sessionId(theirs)}`, headers: bearer(a) });
  assert.equal(foreign.statusCode, 404);
  assert.ok(userFromToken(theirs));

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/auth/sessions/${sessionId(b)}`, headers: bearer(a) })).statusCode, 200);
  assert.equal(userFromToken(b), null);
  assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(b) })).statusCode, 401);

  const rest = await app.inject({ method: 'POST', url: '/api/auth/sessions/revoke-others', headers: bearer(a) });
  assert.equal(rest.json().revoked, 1);
  assert.equal(userFromToken(c), null);
  assert.ok(userFromToken(a));
  assert.ok(userFromToken(theirs));
  await app.close();
});

test('changing the password signs out every other session', async () => {
  const app = await authApp();
  const me = createUser({ name: 'Wisselaar', password: 'geheim123' });
  const here = createSession(me, 'Web'), there = createSession(me, 'Android');
  const bad = await app.inject({ method: 'POST', url: '/api/auth/password', headers: bearer(here), payload: { current: 'fout', next: 'nieuw12345' } });
  assert.equal(bad.statusCode, 403);
  assert.ok(userFromToken(there));
  const ok = await app.inject({ method: 'POST', url: '/api/auth/password', headers: bearer(here), payload: { current: 'geheim123', next: 'nieuw12345' } });
  assert.equal(ok.statusCode, 200);
  assert.ok(userFromToken(here));
  assert.equal(userFromToken(there), null);
  await app.close();
});

test('deleting a user removes their sessions', () => {
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  const id = createUser({ name: 'Weg', password: 'geheim123' });
  const t = createSession(id, 'Web');
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  assert.equal(userFromToken(t), null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE token = ?').get(t).c, 0);
});

test('which() finds programs without a shell', async () => {
  const { which } = await import('../src/remote.js');
  assert.equal(which('sh'), true);
  assert.equal(which('bestaat-niet-kinoko'), false);
  assert.equal(which('sh; touch /tmp/kinoko-injectie'), false);
  assert.equal(which('../bin/sh'), false);
});
