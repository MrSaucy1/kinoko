// Fase 6: music — migration, tags, scanning, API, playlists, streaming, permissions, linked servers.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, mkUser, call, tmp } from './helpers.js';

const { db, migrate, MIGRATIONS } = await import('../src/db.js');
const { default: authRoutes } = await import('../src/auth.js');
const { default: libraryRoutes, scanAll, scanState } = await import('../src/library.js');
const { readTags, norm, converted, trimMusicCache } = await import('../src/music.js');
const { default: musicRoutes, matchScore, importMusic } = await import('../src/musicapi.js');
const { throttled, findCover, findArtist } = await import('../src/musicmeta.js');
const { run, ffmpegAvailable } = await import('../src/ffmpeg.js');
const { config, dataPath } = await import('../src/config.js');

const app = await makeApp(authRoutes, libraryRoutes, musicRoutes);
test.after(() => app.close());
const admin = mkUser('admin'), ann = mkUser('user', 'Ann'), bob = mkUser('user', 'Bob');
const hasFfmpeg = !!(await ffmpegAvailable());
const idle = async () => { for (let i = 0; i < 400 && scanState.running; i++) await new Promise((r) => setTimeout(r, 25)); };

test('migration 6 rebuilds the libraries table without losing a row or a reference', async () => {
  const { default: Database } = await import('better-sqlite3');
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  // The schema as it was before migrations existed, then everything up to fase 5.
  d.exec(fs.readFileSync(new URL('../src/db.js', import.meta.url), 'utf8').match(/db\.exec\(`([\s\S]*?)`\);/)[1]);
  migrate(d, MIGRATIONS.slice(0, 5));
  assert.equal(d.pragma('user_version', { simple: true }), 5);
  d.exec(`INSERT INTO libraries (id, name, type, paths, shared, created_at, trickplay) VALUES (7, 'Films', 'movies', '["/m"]', 0, 111, 1), (9, 'Series', 'shows', '["/s"]', 1, 222, 0);
    INSERT INTO users (id, name, pass, created_at) VALUES (1, 'x', 'y', 1);
    INSERT INTO titles (id, kind, title, norm_key, added_at) VALUES (1, 'movie', 'Up', 'up', 1);
    INSERT INTO files (id, library_id, title_id, path, added_at) VALUES (1, 7, 1, '/m/up.mkv', 1);
    INSERT INTO extras (library_id, title_id, path, name, added_at) VALUES (7, 1, '/m/x.mkv', 'x', 1);
    INSERT INTO library_access (user_id, library_id) VALUES (1, 9);`);
  assert.throws(() => d.prepare("INSERT INTO libraries (name, type, created_at) VALUES ('M', 'music', 1)").run(), /CHECK/);
  assert.equal(migrate(d), MIGRATIONS.length);
  assert.deepEqual(d.prepare('SELECT id, name, type, paths, shared, created_at, trickplay FROM libraries ORDER BY id').all(),
    [{ id: 7, name: 'Films', type: 'movies', paths: '["/m"]', shared: 0, created_at: 111, trickplay: 1 }, { id: 9, name: 'Series', type: 'shows', paths: '["/s"]', shared: 1, created_at: 222, trickplay: 0 }]);
  assert.deepEqual([d.prepare('SELECT library_id FROM files').get().library_id, d.prepare('SELECT COUNT(*) c FROM extras').get().c, d.prepare('SELECT library_id FROM library_access').get().library_id], [7, 1, 9]);
  assert.equal(d.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(d.pragma('foreign_key_check').length, 0);
  d.prepare("INSERT INTO libraries (name, type, created_at) VALUES ('Muziek', 'music', 1)").run();
  // The references still work: removing a library removes its files, as before.
  d.prepare('DELETE FROM libraries WHERE id = 7').run();
  assert.equal(d.prepare('SELECT COUNT(*) c FROM files').get().c, 0);
  assert.throws(() => d.prepare("INSERT INTO files (library_id, title_id, path, added_at) VALUES (12345, 1, '/q', 1)").run(), /FOREIGN KEY/);
});

test('tags are read from every container, with sensible fallbacks', () => {
  const t = readTags({ format: { duration: '201.5', bit_rate: '320000', format_name: 'mp3', tags: { TITLE: 'Song 2', artist: 'Blur', ALBUM_ARTIST: 'Blur', album: 'Blur', track: '2/14', disc: '1/1', date: '1997-02-10', genre: 'Britpop; Rock',
    MUSICBRAINZ_ALBUMID: 'B1E1F3A0-1111-2222-3333-444455556666', REPLAYGAIN_TRACK_GAIN: '-9.52 dB', replaygain_track_peak: '0.988', ITUNESADVISORY: '1' } },
    streams: [{ codec_type: 'audio', codec_name: 'mp3', sample_rate: '44100', channels: 2 }, { codec_type: 'video', disposition: { attached_pic: 1 } }] }, '/m/Blur/Blur/02 - Song 2.mp3');
  assert.deepEqual([t.title, t.artist, t.album, t.trackNo, t.discNo, t.year, t.genres, t.duration, t.bitrate, t.codec, t.explicit, t.hasCover, t.mbAlbum, t.rgTrackGain, t.rgTrackPeak],
    ['Song 2', 'Blur', 'Blur', 2, 1, 1997, ['Britpop', 'Rock'], 201.5, 320000, 'mp3', 1, 1, 'b1e1f3a0-1111-2222-3333-444455556666', -9.52, 0.988]);
  // Ogg/Opus: tags on the stream, R128 gain.
  const o = readTags({ format: { duration: '100' }, streams: [{ codec_type: 'audio', codec_name: 'opus', tags: { title: 'Lied', ARTIST: 'Zanger', R128_TRACK_GAIN: '-1280' } }] }, '/m/x.opus');
  assert.deepEqual([o.title, o.artist, o.rgTrackGain], ['Lied', 'Zanger', 0]);
  // No tags at all: file and folder names.
  const n = readTags({ format: { duration: '10' }, streams: [{ codec_type: 'audio', codec_name: 'flac' }] }, '/muziek/Radiohead/OK Computer/03 - Subterranean Homesick Alien.flac');
  assert.deepEqual([n.title, n.artist, n.album, n.trackNo], ['Subterranean Homesick Alien', 'Radiohead', 'OK Computer', 3]);
  assert.equal(readTags({ format: {}, streams: [{ codec_type: 'audio', tags: { album_artist: 'Various Artists', artist: 'A' } }] }, '/m/a.mp3').albumArtist, 'Diverse artiesten');
  assert.equal(readTags({ format: {}, streams: [{ codec_type: 'video' }] }, '/m/a.mp4'), null);
  assert.equal(norm('Beyoncé & JAY-Z — “Crazy” (Live!)'), 'beyonce and jay z crazy live');
});

test('search scoring: exact beats prefix beats typo, nonsense scores nothing', () => {
  assert.ok(matchScore('queen', 'queen') > matchScore('queen', 'queens of the stone age'));
  assert.ok(matchScore('stone', 'queens of the stone age') > matchScore('ston', 'winston'));
  assert.ok(matchScore('radiohaed', 'radiohead') > 0, 'a typo still matches');
  assert.ok(matchScore('bohemian rapsody', 'bohemian rhapsody') > 0);
  assert.equal(matchScore('xyzzy', 'radiohead'), 0);
});

test('with ffmpeg: scan, browse, search, playlists, likes, queue, history, streaming and permissions', { skip: !hasFfmpeg && 'ffmpeg is niet geïnstalleerd' }, async () => {
  const root = tmp('music-');
  const make = async (rel, tags, seconds = 3) => {
    const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true });
    const meta = Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
    const r = await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, ...meta, '-c:a', rel.endsWith('.flac') ? 'flac' : 'libmp3lame', '-y', file], { timeout: 60_000 });
    assert.equal(r.code, 0, r.stderr);
  };
  await make('Queen/A Night at the Opera/11 - Bohemian Rhapsody.flac', { title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', track: '11', date: '1975', genre: 'Rock' }, 40);
  await make('Queen/A Night at the Opera/01 - Death on Two Legs.flac', { title: 'Death on Two Legs', artist: 'Queen', album: 'A Night at the Opera', track: '1', date: '1975', genre: 'Rock' });
  await make('Queen/Jazz/Bicycle Race.mp3', { title: 'Bicycle Race', artist: 'Queen', album: 'Jazz', track: '4', date: '1978', genre: 'Rock;Pop' });
  await make('Mix/Hits/01.mp3', { title: 'Vies Liedje', artist: 'Rapper', album: 'Hits', album_artist: 'Various Artists', track: '1', ITUNESADVISORY: '1', genre: 'Hiphop' });
  await make('Mix/Hits/02.mp3', { title: 'Net Liedje', artist: 'Zangeres', album: 'Hits', album_artist: 'Various Artists', track: '2' });
  fs.writeFileSync(path.join(root, 'Queen/Jazz/cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
  fs.writeFileSync(path.join(root, 'Queen/notes.txt'), 'geen audio');

  assert.equal((await call(app, ann, 'POST', '/api/admin/libraries', { name: 'Muziek', type: 'music', paths: [root] })).statusCode, 403);
  const lib = (await call(app, admin, 'POST', '/api/admin/libraries', { name: 'Muziek', type: 'music', paths: [root] })).json().id;
  await idle(); await scanAll(); await idle();
  assert.deepEqual(db.prepare('SELECT name FROM artists ORDER BY name').all().map((a) => a.name), ['Diverse artiesten', 'Queen', 'Rapper', 'Zangeres']);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM titles').get().c, 0, 'music never becomes a film title');
  const listed = (await call(app, admin, 'GET', '/api/admin/libraries')).json().libraries.find((l) => l.id === lib);
  assert.deepEqual([listed.type, listed.files, listed.titles], ['music', 5, 3]);

  // Browse.
  const albums = (await call(app, ann, 'GET', '/api/music/albums?sort=year')).json();
  assert.deepEqual(albums.items.map((a) => [a.title, a.artist, a.year, a.tracks]), [['Jazz', 'Queen', 1978, 1], ['A Night at the Opera', 'Queen', 1975, 2], ['Hits', 'Diverse artiesten', null, 2]]);
  const jazz = albums.items[0], opera = albums.items[1];
  assert.equal((await app.inject({ url: jazz.cover })).statusCode, 200);
  const album = (await call(app, ann, 'GET', `/api/music/albums/${opera.id}`)).json();
  assert.deepEqual(album.items.map((t) => [t.trackNo, t.title]), [[1, 'Death on Two Legs'], [11, 'Bohemian Rhapsody']]);
  const queen = (await call(app, ann, 'GET', '/api/music/artists')).json().items.find((a) => a.name === 'Queen');
  assert.deepEqual([queen.albums, queen.tracks], [2, 3]);
  assert.equal((await call(app, ann, 'GET', `/api/music/artists/${queen.id}`)).json().albums.length, 2);
  assert.deepEqual((await call(app, ann, 'GET', '/api/music/genres')).json().items.map((g) => [g.name, g.tracks]), [['Rock', 3], ['Hiphop', 1], ['Pop', 1]]);
  assert.equal((await call(app, ann, 'GET', '/api/music/tracks?limit=2&offset=1')).json().total, 5);
  assert.equal((await call(app, null, 'GET', '/api/music/albums')).statusCode, 401);

  // Search, typo included.
  const s = (await call(app, ann, 'GET', '/api/music/search?q=bohemian%20rapsody')).json();
  assert.equal(s.tracks[0].title, 'Bohemian Rhapsody');
  assert.equal((await call(app, ann, 'GET', '/api/music/search?q=quen')).json().artists[0].name, 'Queen');
  assert.equal((await call(app, ann, 'GET', '/api/music/search?q=queen%20bicycle')).json().tracks[0].title, 'Bicycle Race');
  const bohemian = s.tracks[0], bike = db.prepare("SELECT id FROM tracks WHERE title = 'Bicycle Race'").get().id, dirty = db.prepare("SELECT id FROM tracks WHERE title = 'Vies Liedje'").get().id;

  // Likes, queue, history.
  assert.equal((await call(app, ann, 'PUT', `/api/music/likes/${bohemian.id}`)).json().liked, true);
  assert.equal((await call(app, ann, 'PUT', '/api/music/likes/999999')).statusCode, 404);
  assert.deepEqual((await call(app, ann, 'GET', '/api/music/likes')).json().items.map((t) => [t.title, t.liked]), [['Bohemian Rhapsody', true]]);
  assert.equal((await call(app, bob, 'GET', '/api/music/likes')).json().total, 0);
  await call(app, ann, 'PUT', '/api/music/queue', { trackIds: [bike, bohemian.id, 999999, 'x'], index: 1, position: 12.5 });
  const q = (await call(app, ann, 'GET', '/api/music/queue')).json();
  assert.deepEqual([q.items.map((t) => t.title), q.index, q.position], [['Bicycle Race', 'Bohemian Rhapsody'], 1, 12.5]);
  assert.equal((await call(app, bob, 'GET', '/api/music/queue')).json().items.length, 0);
  assert.equal((await call(app, ann, 'POST', '/api/music/plays', { trackId: bohemian.id, seconds: 38 })).json().counted, true);
  assert.equal((await call(app, ann, 'POST', '/api/music/plays', { trackId: bike, seconds: 2 })).json().counted, false);
  assert.deepEqual((await call(app, ann, 'GET', '/api/music/history')).json().items.map((t) => t.title), ['Bohemian Rhapsody']);
  const home = (await call(app, ann, 'GET', '/api/music/home')).json();
  assert.deepEqual(home.rows.map((r) => r.id), ['recent-played', 'new', 'top']); assert.equal(home.liked, 1);

  // Playlists: order, sharing, and nobody else's by id.
  const pl = (await call(app, ann, 'POST', '/api/music/playlists', { name: 'Onderweg' })).json().id;
  assert.equal((await call(app, ann, 'POST', `/api/music/playlists/${pl}/items`, { trackIds: [bohemian.id, bike, dirty] })).json().added, 3);
  let p = (await call(app, ann, 'GET', `/api/music/playlists/${pl}`)).json();
  assert.deepEqual(p.items.map((t) => t.title), ['Bohemian Rhapsody', 'Bicycle Race', 'Vies Liedje']);
  await call(app, ann, 'PUT', `/api/music/playlists/${pl}/order`, { itemIds: [p.items[2].itemId, p.items[0].itemId, 424242] });
  p = (await call(app, ann, 'GET', `/api/music/playlists/${pl}`)).json();
  assert.deepEqual(p.items.map((t) => t.title), ['Vies Liedje', 'Bohemian Rhapsody', 'Bicycle Race']);
  for (const [m, u, b] of [['GET', `/api/music/playlists/${pl}`], ['PUT', `/api/music/playlists/${pl}`, { name: 'x' }], ['DELETE', `/api/music/playlists/${pl}`], ['POST', `/api/music/playlists/${pl}/items`, { trackIds: [bike] }],
    ['DELETE', `/api/music/playlists/${pl}/items/${p.items[0].itemId}`], ['PUT', `/api/music/playlists/${pl}/order`, { itemIds: [] }], ['PUT', `/api/music/playlists/${pl}/shares`, { users: [] }]]) {
    assert.equal((await call(app, bob, m, u, b)).statusCode, 404, `${m} ${u}`);
  }
  assert.equal((await call(app, bob, 'GET', '/api/music/playlists')).json().items.length, 0);
  await call(app, ann, 'PUT', `/api/music/playlists/${pl}/shares`, { users: [{ id: bob.id, edit: false }] });
  assert.equal((await call(app, bob, 'GET', `/api/music/playlists/${pl}`)).json().items.length, 3);
  assert.equal((await call(app, bob, 'POST', `/api/music/playlists/${pl}/items`, { trackIds: [bike] })).statusCode, 403);
  assert.equal((await call(app, bob, 'GET', `/api/music/playlists/${pl}`)).json().shares, undefined);
  await call(app, ann, 'DELETE', `/api/music/playlists/${pl}/items/${p.items[0].itemId}`);
  assert.equal((await call(app, ann, 'GET', `/api/music/playlists/${pl}`)).json().count, 2);

  // Streaming: the original with Range, a converted copy with Range, and no ticket no audio.
  const direct = (await call(app, ann, 'POST', `/api/music/tracks/${bohemian.id}/play`, {})).json();
  assert.deepEqual([direct.quality, direct.mime], ['original', 'audio/flac']);
  const part = await app.inject({ url: direct.url, headers: { range: 'bytes=0-99' } });
  assert.deepEqual([part.statusCode, part.rawPayload.length, part.rawPayload.subarray(0, 4).toString()], [206, 100, 'fLaC']);
  const enc = await run(config.ffmpeg, ['-hide_banner', '-encoders'], { timeout: 8000 });
  if (/libopus/.test(enc.stdout)) {
    const low = (await call(app, ann, 'POST', `/api/music/tracks/${bohemian.id}/play`, { quality: '96' })).json();
    assert.deepEqual([low.quality, low.mime], ['96', 'audio/ogg']);
    const ogg = await app.inject({ url: low.url, headers: { range: 'bytes=0-3' } });
    assert.deepEqual([ogg.statusCode, ogg.rawPayload.toString()], [206, 'OggS']);
    assert.match(ogg.headers['content-range'], /^bytes 0-3\/\d+$/);
    assert.ok(Number(ogg.headers['content-range'].split('/')[1]) > 1000);
    assert.equal(trimMusicCache(0), 1, 'the cache can be emptied');
  }
  const aac = (await call(app, ann, 'POST', `/api/music/tracks/${bike}/play`, { quality: '320', format: 'aac' })).json();
  assert.equal(aac.quality, 'original', 'a low-bitrate MP3 is not converted upwards');
  assert.equal((await app.inject({ url: '/api/music/stream/geen-ticket' })).statusCode, 403);
  // The apps ask for a whole queue at once.
  const batch = (await call(app, ann, 'POST', '/api/music/play', { trackIds: [bike, bohemian.id, 999999], quality: '160' })).json().items;
  assert.deepEqual(batch.map((b) => b.id), [bike, bohemian.id]);
  assert.ok(!batch[0].url.includes('?'), 'the MP3 plays as it is'); assert.match(batch[1].url, /\?q=160&f=opus$/);
  assert.equal((await app.inject({ url: batch[0].url, headers: { range: 'bytes=0-9' } })).statusCode, 206);
  assert.equal((await call(app, null, 'POST', '/api/music/play', { trackIds: [bike] })).statusCode, 401);
  assert.equal((await call(app, null, 'POST', `/api/music/tracks/${bike}/play`, {})).statusCode, 401);

  // Permissions: a library the user may not see does not exist for them; a child gets no explicit tracks.
  await call(app, admin, 'PUT', `/api/admin/users/${bob.id}`, { allLibraries: false, libraries: [] });
  for (const u of ['/api/music/albums', '/api/music/artists', '/api/music/tracks', '/api/music/genres', '/api/music/search?q=queen', '/api/music/home', `/api/music/playlists/${pl}`]) {
    const r = await call(app, bob, 'GET', u);
    assert.equal(r.statusCode, 200, u); assert.ok(!/Queen|Bohemian|Bicycle/.test(r.body), `${u} lekt`);
  }
  for (const [m, u, b] of [['GET', `/api/music/albums/${opera.id}`], ['GET', `/api/music/artists/${queen.id}`], ['POST', `/api/music/tracks/${bike}/play`, {}], ['PUT', `/api/music/likes/${bike}`], ['POST', '/api/music/plays', { trackId: bike, seconds: 60 }]]) {
    assert.equal((await call(app, bob, m, u, b)).statusCode, 404, `${m} ${u}`);
  }
  await call(app, admin, 'PUT', `/api/admin/users/${bob.id}`, { allLibraries: true, maxAge: 9, hideUnrated: false });
  const kid = (await call(app, bob, 'GET', '/api/music/tracks')).json();
  assert.equal(kid.total, 4); assert.ok(!kid.items.some((t) => t.title === 'Vies Liedje'));
  assert.equal((await call(app, bob, 'POST', `/api/music/tracks/${dirty}/play`, {})).statusCode, 404);
  await call(app, admin, 'PUT', `/api/admin/users/${bob.id}`, { maxAge: null });

  // A removed file disappears, and with it the album that is now empty.
  fs.rmSync(path.join(root, 'Queen/Jazz'), { recursive: true });
  await scanAll(); await idle();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM albums WHERE title = 'Jazz'").get().c, 0);
  assert.equal((await call(app, ann, 'GET', `/api/music/playlists/${pl}`)).json().count, 1);
});

test('music from a linked server is imported, updated and removed with it', () => {
  const peer = { id: Number(db.prepare("INSERT INTO peers (name, url, created_at) VALUES ('Vriend', 'http://vriend.invalid', 1)").run().lastInsertRowid) };
  const t = (id, title, extra = {}) => ({ id, title, artist: 'Verre Band', album: 'Ver Album', year: 2001, trackNo: id, duration: 200, codec: 'flac', bitrate: 900000, genres: ['Indie'], gain: [-7, 0.9, null, null], cover: 'https://vriend.invalid/api/music/cover/album/1', ...extra });
  assert.equal(importMusic(peer, [t(1, 'Eerste'), t(2, 'Tweede'), { id: 'x' }, null]), 2);
  const rows = db.prepare('SELECT title, remote_id, library_id, rg_track_gain, path FROM tracks WHERE peer_id = ? ORDER BY remote_id').all(peer.id);
  assert.deepEqual(rows.map((r) => [r.title, r.remote_id, r.library_id, r.rg_track_gain]), [['Eerste', 1, null, -7], ['Tweede', 2, null, -7]]);
  assert.equal(importMusic(peer, [t(2, 'Tweede (remaster)')]), 1);
  assert.deepEqual(db.prepare('SELECT title FROM tracks WHERE peer_id = ?').all(peer.id).map((r) => r.title), ['Tweede (remaster)']);
  db.prepare('DELETE FROM peers WHERE id = ?').run(peer.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM tracks WHERE path LIKE 'peer:%'").get().c, 0);
});

test('online lookups: one request per second to MusicBrainz, and a missing service is not a failure', async () => {
  const times = [];
  await Promise.all([1, 2, 3].map(() => throttled(async () => { times.push(Date.now()); }, 120)));
  assert.ok(times[1] - times[0] >= 110 && times[2] - times[1] >= 110, `gaps: ${times[1] - times[0]}, ${times[2] - times[1]}`);

  const artist = Number(db.prepare("INSERT INTO artists (name, norm) VALUES ('Zoekband', 'zoekband')").run().lastInsertRowid);
  const album = Number(db.prepare("INSERT INTO albums (title, norm, artist_id, added_at) VALUES ('Zoekalbum', 'zoekalbum', ?, 1)").run(artist).lastInsertRowid);
  const real = globalThis.fetch, seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), ua: opts.headers['User-Agent'] });
    const u = String(url);
    if (u.includes('musicbrainz.org/ws/2/release/')) return new Response(JSON.stringify({ releases: [{ id: 'aaaaaaaa-1111-2222-3333-444444444444', score: 100 }] }));
    if (u.includes('coverartarchive.org')) return new Response(JSON.stringify({ images: [{ front: true, image: 'http://caa.invalid/full.jpg', thumbnails: { 500: 'http://caa.invalid/500.jpg' } }] }));
    if (u.includes('musicbrainz.org/ws/2/artist/?')) return new Response(JSON.stringify({ artists: [{ id: 'bbbbbbbb-1111-2222-3333-444444444444', score: 100 }] }));
    if (u.includes('musicbrainz.org/ws/2/artist/bbbb')) return new Response(JSON.stringify({ relations: [{ url: { resource: 'https://www.wikidata.org/wiki/Q42' } }] }));
    if (u.includes('wikidata.org')) return new Response(JSON.stringify({ entities: { Q42: { claims: { P18: [{ mainsnak: { datavalue: { value: 'Band foto.jpg' } } }] }, descriptions: { nl: { value: 'Nederlandse band' } } } } }));
    return new Response('', { status: 500 });
  };
  try {
    assert.equal(await findCover(db.prepare('SELECT * FROM albums WHERE id = ?').get(album)), true);
    assert.equal(db.prepare('SELECT cover FROM albums WHERE id = ?').get(album).cover, 'https://caa.invalid/500.jpg');
    assert.equal(await findArtist(db.prepare('SELECT * FROM artists WHERE id = ?').get(artist)), true);
    assert.deepEqual(db.prepare('SELECT image, bio FROM artists WHERE id = ?').get(artist), { image: 'https://commons.wikimedia.org/wiki/Special:FilePath/Band_foto.jpg?width=600', bio: 'Nederlandse band' });
    assert.ok(seen.every((s) => /^Kinoko\/\d/.test(s.ua)), 'every request identifies itself');
    globalThis.fetch = async () => { throw new Error('offline'); };
    db.prepare('UPDATE albums SET cover = NULL, mbid = NULL WHERE id = ?').run(album);
    assert.equal(await findCover(db.prepare('SELECT * FROM albums WHERE id = ?').get(album)), null, 'no answer means: try again later');
  } finally { globalThis.fetch = real; }
  assert.equal((await call(app, ann, 'PUT', '/api/admin/music', { online: false })).statusCode, 403);
  assert.equal((await call(app, admin, 'PUT', '/api/admin/music', { online: false })).statusCode, 200);
  assert.equal((await call(app, admin, 'GET', '/api/admin/music')).json().online, false);
  void converted; void dataPath;
});
