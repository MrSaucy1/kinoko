// Fase 8: loudness, lyrics, radio, mixes, scrobbling, Kinoko Connect.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, mkUser, call, tmp } from './helpers.js';

const { db, settings, now } = await import('../src/db.js');
const { default: authRoutes, sessionId } = await import('../src/auth.js');
const { default: musicRoutes } = await import('../src/musicapi.js');
const { default: extraRoutes, parseEbur128, gainFor, albumGain, measure, parseLrc, radio, lastfmSign, scrobbleWorthy } = await import('../src/musicextra.js');
const { artistId, albumId, norm } = await import('../src/music.js');
const { register } = await import('../src/events.js');
const { scopeFor } = await import('../src/access.js');
const { run, ffmpegAvailable } = await import('../src/ffmpeg.js');
const { config } = await import('../src/config.js');

const app = await makeApp(authRoutes, musicRoutes, extraRoutes);
test.after(() => app.close());
const admin = mkUser('admin'), ann = mkUser('user', 'Ann'), bob = mkUser('user', 'Bob');
const hasFfmpeg = !!(await ffmpegAvailable());
const lib = Number(db.prepare("INSERT INTO libraries (name, type, paths, created_at) VALUES ('Muziek', 'music', '[]', 1)").run().lastInsertRowid);
let seq = 0;
/** A track straight into the database. */
function mk(artist, album, title, { genre = null, file = null, duration = 200, library = lib } = {}) {
  const ar = artistId(artist), al = albumId(album, ar);
  const id = Number(db.prepare('INSERT INTO tracks (library_id, album_id, artist_id, title, norm, duration, path, added_at) VALUES (?,?,?,?,?,?,?,?)').run(library, al, ar, title, norm(title), duration, file || `/geen/${++seq}.mp3`, now()).lastInsertRowid);
  if (genre) { db.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)').run(genre); db.prepare('INSERT INTO track_genres (track_id, genre_id) SELECT ?, id FROM genres WHERE name = ?').run(id, genre); }
  return id;
}

test('loudness: the ebur128 summary becomes ReplayGain values', async () => {
  const log = `[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -23.4 LUFS\n    Threshold: -33.5 LUFS\n\n  Loudness range:\n    LRA:         6.1 LU\n\n  True peak:\n    Peak:       -1.0 dBFS\n`;
  assert.deepEqual(parseEbur128(log), { lufs: -23.4, peak: 0.8913 });
  assert.equal(gainFor(-23.4), 5.4); assert.equal(gainFor(-9), -9);
  assert.equal(parseEbur128('niets'), null);
  assert.equal(parseEbur128('Summary:\n    I:         -70.0 LUFS\n    Peak:       -inf dBFS'), null, 'silence has no loudness');
  // An album of one loud and one quiet track sits nearer the loud one.
  const g = albumGain([{ duration: 100, gain: -8 }, { duration: 100, gain: 2 }]);
  assert.ok(g < -5 && g > -8, String(g));
  assert.equal(albumGain([{ duration: 100, gain: -8 }, { duration: 100, gain: null }]), null);
  if (hasFfmpeg) {
    const file = path.join(tmp('loud-'), 'toon.flac');
    await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40', '-c:a', 'flac', '-y', file], { timeout: 60_000 });
    const m = await measure({ path: file });
    assert.ok(m && m.lufs < -10 && m.lufs > -40, JSON.stringify(m));   // a 40 s file: the summary must survive the log
    assert.ok(m.peak > 0 && m.peak <= 1);
  }
});

test('lyrics: .lrc next to the file, cached; LRCLIB when allowed; nothing found is remembered', async () => {
  assert.deepEqual(parseLrc('[ar: X]\n[00:12.50]Eerste regel\n[01:02.5][01:30]Refrein\nzonder tijd\n[00:05]Intro'), [{ t: 5, text: 'Intro' }, { t: 12.5, text: 'Eerste regel' }, { t: 62.5, text: 'Refrein' }, { t: 90, text: 'Refrein' }]);
  const dir = tmp('lrc-');
  fs.writeFileSync(path.join(dir, 'lied.mp3'), 'x'); fs.writeFileSync(path.join(dir, 'lied.lrc'), '[00:01.00]Hallo\n[00:04.00]Wereld');
  const local = mk('Zanger', 'Plaat', 'Lied', { file: path.join(dir, 'lied.mp3') });
  const r = (await call(app, ann, 'GET', `/api/music/tracks/${local}/lyrics`)).json();
  assert.deepEqual([r.synced, r.source, r.lines], [true, 'lrc', [{ t: 1, text: 'Hallo' }, { t: 4, text: 'Wereld' }]]);
  assert.equal((await call(app, null, 'GET', `/api/music/tracks/${local}/lyrics`)).statusCode, 401);

  const online = mk('Online Band', 'Album', 'Zoek Mij', { duration: 187 });
  const real = globalThis.fetch; const asked = [];
  globalThis.fetch = async (url) => { asked.push(String(url)); return String(url).includes('track_name=Zoek+Mij') ? new Response(JSON.stringify({ syncedLyrics: '[00:10.00]Gevonden', plainLyrics: 'Gevonden' })) : new Response('{}', { status: 404 }); };
  try {
    const o = (await call(app, ann, 'GET', `/api/music/tracks/${online}/lyrics`)).json();
    assert.deepEqual([o.synced, o.source, o.lines[0].text], [true, 'lrclib', 'Gevonden']);
    assert.match(asked[0], /lrclib\.net\/api\/get\?artist_name=Online\+Band&track_name=Zoek\+Mij&album_name=Album&duration=187/);
    await call(app, ann, 'GET', `/api/music/tracks/${online}/lyrics`);
    assert.equal(asked.length, 1, 'the second time comes from the cache');
    const none = mk('Online Band', 'Album', 'Onvindbaar');
    assert.deepEqual((await call(app, ann, 'GET', `/api/music/tracks/${none}/lyrics`)).json(), { synced: false, lines: [], plain: '', source: null });
    await call(app, ann, 'GET', `/api/music/tracks/${none}/lyrics`);
    assert.equal(asked.length, 2, '"nothing found" is remembered too');
    // Switched off by the admin: the service is not contacted at all.
    assert.equal((await call(app, ann, 'PUT', '/api/admin/music/extras', { lyricsOnline: false })).statusCode, 403);
    await call(app, admin, 'PUT', '/api/admin/music/extras', { lyricsOnline: false });
    await call(app, ann, 'GET', `/api/music/tracks/${mk('Online Band', 'Album', 'Derde')}/lyrics`);
    assert.equal(asked.length, 2);
  } finally { globalThis.fetch = real; settings.set('lyrics_online', true); }
});

test('radio: same artist, same genre and what others played with it, never the seeds or hidden tracks', async () => {
  const seed = mk('Radio Band', 'Een', 'Startnummer', { genre: 'Shoegaze' });
  const same = [mk('Radio Band', 'Een', 'Tweede', { genre: 'Shoegaze' }), mk('Radio Band', 'Twee', 'Derde')];
  const genre = mk('Andere Band', 'X', 'Zelfde Genre', { genre: 'Shoegaze' });
  const co = mk('Heel Anders', 'Y', 'Samen Geluisterd', { genre: 'Polka' });
  const unrelated = mk('Los', 'Z', 'Los Nummer', { genre: 'Klassiek' });
  const closed = Number(db.prepare("INSERT INTO libraries (name, type, paths, created_at) VALUES ('Dicht', 'music', '[]', 1)").run().lastInsertRowid);
  const hidden = mk('Radio Band', 'Geheim', 'Verborgen Nummer', { genre: 'Shoegaze', library: closed });
  for (const t of [seed, co]) db.prepare('INSERT INTO music_plays (user_id, track_id, at, seconds) VALUES (?,?,?,?)').run(bob.id, t, now(), 120);

  const all = { all: true, libs: null, peers: true, maxAge: null };
  const ids = radio(all, { trackIds: [seed], rnd: () => 0 });
  assert.ok(!ids.includes(seed));
  for (const id of [...same, genre, co, hidden]) assert.ok(ids.includes(id), `mist ${id}`);
  assert.ok(!ids.includes(unrelated));
  assert.ok(!radio(all, { trackIds: [seed], exclude: [genre], rnd: () => 0 }).includes(genre));
  // Never more than four of one artist.
  for (let i = 0; i < 10; i++) mk('Radio Band', 'Veel', `Extra ${i}`, { genre: 'Shoegaze' });
  const many = radio(all, { trackIds: [seed], rnd: () => 0 });
  const perArtist = db.prepare(`SELECT COUNT(*) c FROM tracks WHERE id IN (${many.join(',')}) AND artist_id = (SELECT artist_id FROM tracks WHERE id = ?)`).get(seed).c;
  assert.equal(perArtist, 4);

  await call(app, admin, 'PUT', `/api/admin/users/${ann.id}`, { allLibraries: false, libraries: [lib] });
  const r = await call(app, ann, 'GET', `/api/music/radio?track=${seed}`);
  assert.equal(r.statusCode, 200); assert.ok(r.json().items.length >= 3); assert.ok(!r.body.includes('Verborgen Nummer'));
  assert.equal((await call(app, ann, 'GET', `/api/music/radio?track=${hidden}`)).statusCode, 404, 'a hidden seed is not a seed');
  assert.ok(!radio(scopeFor(db.prepare('SELECT * FROM users WHERE id = ?').get(ann.id)), { trackIds: [seed], rnd: () => 0 }).includes(hidden));
  await call(app, admin, 'PUT', `/api/admin/users/${ann.id}`, { allLibraries: true });
  assert.equal((await call(app, ann, 'GET', '/api/music/radio')).statusCode, 404);
});

test('home mixes: rediscover and a daily mix per favourite genre, stable within a day', async () => {
  const u = mkUser('user', 'Mixer');
  const ids = Array.from({ length: 12 }, (_, i) => mk(`Mixband ${i % 3}`, 'Mixalbum', `Mixnummer ${i}`, { genre: 'Synthpop' }));
  for (const id of ids.slice(0, 6)) for (let n = 0; n < 2; n++) db.prepare('INSERT INTO music_plays (user_id, track_id, at, seconds) VALUES (?,?,?,?)').run(u.id, id, now() - 90 * 86400, 100);
  for (const id of ids.slice(6, 9)) db.prepare('INSERT INTO music_plays (user_id, track_id, at, seconds) VALUES (?,?,?,?)').run(u.id, id, now() - 3600, 100);
  const a = (await call(app, u, 'GET', '/api/music/home')).json(), b = (await call(app, u, 'GET', '/api/music/home')).json();
  const row = (d, id) => d.rows.find((r) => r.id === id);
  assert.equal(row(a, 'rediscover').items.length, 6);
  const mix = a.rows.find((r) => r.id.startsWith('mix:'));
  assert.equal(mix.title, 'Dagmix Synthpop'); assert.ok(mix.items.length >= 8);
  assert.deepEqual(mix.items.map((t) => t.id), b.rows.find((r) => r.id === mix.id).items.map((t) => t.id), 'the same mix all day');
  assert.equal((await call(app, bob, 'GET', '/api/music/home')).json().rows.find((r) => r.id === 'rediscover'), undefined);
});

test('scrobbling: per user, tokens never come back, a play must be long enough', async () => {
  assert.equal(scrobbleWorthy(100, 190), true); assert.equal(scrobbleWorthy(60, 190), false); assert.equal(scrobbleWorthy(250, 900), true); assert.equal(scrobbleWorthy(20, 25), false);
  assert.equal(lastfmSign({ method: 'auth.getSession', token: 'abc', api_key: 'KEY' }, 'SECRET'), (await import('node:crypto')).createHash('md5').update('api_keyKEYmethodauth.getSessiontokenabcSECRET').digest('hex'));

  const real = globalThis.fetch; const sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('validate-token')) return new Response(JSON.stringify({ valid: opts.headers.Authorization === 'Token 11111111-2222-3333-4444-555555555555' }));
    if (u.includes('submit-listens')) { sent.push({ auth: opts.headers.Authorization, body: JSON.parse(opts.body) }); return new Response('{"status":"ok"}'); }
    return real(url, opts);
  };
  try {
    assert.equal((await call(app, ann, 'PUT', '/api/music/scrobble/listenbrainz', { token: 'kort' })).statusCode, 400);
    assert.equal((await call(app, ann, 'PUT', '/api/music/scrobble/listenbrainz', { token: '99999999-2222-3333-4444-555555555555' })).statusCode, 400);
    assert.equal((await call(app, ann, 'PUT', '/api/music/scrobble/listenbrainz', { token: '11111111-2222-3333-4444-555555555555' })).json().listenbrainz, true);
    const state = await call(app, ann, 'GET', '/api/music/scrobble');
    assert.deepEqual(state.json(), { listenbrainz: true, lastfm: false, lastfmName: '', lastfmAvailable: false });
    assert.ok(!state.body.includes('11111111'));
    assert.ok(!(await call(app, ann, 'GET', '/api/auth/me')).body.includes('11111111'));
    assert.equal((await call(app, bob, 'GET', '/api/music/scrobble')).json().listenbrainz, false);
    assert.equal((await call(app, ann, 'POST', '/api/music/scrobble/lastfm/start')).statusCode, 501, 'Last.fm needs a key from the admin');

    const t = mk('Scrobble Band', 'Plaat', 'Gescrobbeld', { duration: 200 });
    await call(app, ann, 'POST', '/api/music/plays', { trackId: t, seconds: 40 });    // too short
    await call(app, bob, 'POST', '/api/music/plays', { trackId: t, seconds: 150 });   // not connected
    await call(app, ann, 'POST', '/api/music/plays', { trackId: t, seconds: 150 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 1);
    assert.deepEqual([sent[0].auth, sent[0].body.listen_type, sent[0].body.payload[0].track_metadata.artist_name, sent[0].body.payload[0].track_metadata.track_name], ['Token 11111111-2222-3333-4444-555555555555', 'single', 'Scrobble Band', 'Gescrobbeld']);
    await call(app, ann, 'PUT', '/api/music/scrobble/listenbrainz', { token: '' });
    assert.equal((await call(app, ann, 'GET', '/api/music/scrobble')).json().listenbrainz, false);
  } finally { globalThis.fetch = real; }
  await call(app, admin, 'PUT', '/api/admin/music/extras', { lastfmKey: 'abcdef123456', lastfmSecret: 'geheim-secret' });
  const ex = await call(app, admin, 'GET', '/api/admin/music/extras');
  assert.deepEqual([ex.json().lastfmKey, ex.json().lastfmSecret], ['••••3456', true]); assert.ok(!ex.body.includes('geheim-secret') && !ex.body.includes('abcdef'));
});

test('Kinoko Connect: your own players only, commands reach one device', async () => {
  const t = mk('Connect Band', 'Plaat', 'Overzetten');
  const got = { phone: [], web: [], bob: [] };
  const sock = (list) => ({ readyState: 1, send: (d) => list.push(JSON.parse(d)) });
  const drops = [register(ann.id, { socket: sock(got.phone), session: sessionId(ann.token), device: 'Kinoko Music', player: true, id: 'phone1', state: { trackId: t, title: 'Overzetten', artist: 'Connect Band', playing: true, position: 12, duration: 200, at: Date.now() } }),
    register(ann.id, { socket: sock(got.web), session: 'web', device: 'Web', player: true, id: 'web1', state: null }),
    register(ann.id, { socket: sock([]), session: 'tv', device: 'Android TV', player: false, id: 'tv1', state: null }),
    register(bob.id, { socket: sock(got.bob), session: 'b', device: 'Kinoko Music', player: true, id: 'bob1', state: null })];
  const list = (await call(app, ann, 'GET', '/api/music/devices')).json().devices;
  assert.deepEqual(list.map((d) => [d.id, d.name, d.state?.title ?? null]), [['phone1', 'Kinoko Music', 'Overzetten'], ['web1', 'Web', null]]);
  assert.equal((await call(app, null, 'GET', '/api/music/devices')).statusCode, 401);

  assert.equal((await call(app, ann, 'POST', '/api/music/devices/web1/command', { cmd: 'load', trackIds: [t, 999999], index: 0, position: 12, play: true })).statusCode, 200);
  assert.deepEqual([got.web[0].t, got.web[0].cmd, got.web[0].items.map((i) => i.title), got.web[0].position], ['control', 'load', ['Overzetten'], 12]);
  await call(app, ann, 'POST', '/api/music/devices/phone1/command', { cmd: 'pause' });
  assert.deepEqual(got.phone, [{ t: 'control', cmd: 'pause' }]);
  // Someone else's device is not reachable, whatever id is used.
  assert.equal((await call(app, ann, 'POST', '/api/music/devices/bob1/command', { cmd: 'pause' })).statusCode, 404);
  assert.equal((await call(app, bob, 'POST', '/api/music/devices/phone1/command', { cmd: 'next' })).statusCode, 404);
  assert.equal(got.bob.length, 0);
  assert.equal((await call(app, ann, 'POST', '/api/music/devices/web1/command', { cmd: 'rm -rf' })).statusCode, 400);
  assert.equal((await call(app, ann, 'POST', '/api/music/devices/web1/command', { cmd: 'volume', volume: 7 })).statusCode, 200);
  assert.equal(got.web.at(-1).volume, 1);
  drops.forEach((d) => d());
  assert.equal((await call(app, ann, 'GET', '/api/music/devices')).json().devices.length, 0);
});
