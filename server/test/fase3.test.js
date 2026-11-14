// Fase 3: age ratings, kids mode, trickplay, HDR → SDR.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, mkUser, mkFile, call, tmp } from './helpers.js';

const { db } = await import('../src/db.js');
const { default: authRoutes } = await import('../src/auth.js');
const { default: catalogRoutes } = await import('../src/catalog.js');
const { default: streamRoutes, pipelines, SW_TONEMAP } = await import('../src/stream.js');
const { default: watchRoutes } = await import('../src/watch.js');
const { default: iptvRoutes } = await import('../src/iptv.js');
const { default: metadataRoutes, parseNfo, tmdbAge } = await import('../src/metadata.js');
const { default: trickRoutes, generate } = await import('../src/trickplay.js');
const { normalizeAge, pickAge, wikidataAges, ageLabel } = await import('../src/ratings.js');
const { run, probe, ffmpegAvailable } = await import('../src/ffmpeg.js');
const { config } = await import('../src/config.js');

const app = await makeApp(authRoutes, catalogRoutes, streamRoutes, watchRoutes, iptvRoutes, metadataRoutes, trickRoutes);
test.after(() => app.close());
const admin = mkUser('admin');
const hasFfmpeg = !!(await ffmpegAvailable());

test('certifications from every source land on the Kijkwijzer scale', () => {
  const cases = { AL: 0, '6': 6, '9': 9, '12': 12, '14': 14, '16': 16, '18': 18, 'NL:12': 12, 'Rated PG-13': 12, 'PG': 9, G: 0, R: 16, 'NC-17': 18,
    'FSK 0': 0, 'FSK 12': 12, 'FSK 16': 16, 'TV-Y': 0, 'TV-Y7': 6, 'TV-PG': 9, 'TV-14': 14, 'TV-MA': 18, '15': 16, '7': 9, '13+': 14, '12A': 12, U: 0, 'Kijkwijzer 16': 16 };
  for (const [raw, age] of Object.entries(cases)) assert.equal(normalizeAge(raw), age, raw);
  for (const raw of ['', null, 'Not Rated', 'NR', 'Unrated', 'banaan', '2024']) assert.equal(normalizeAge(raw), null, String(raw));
  assert.equal(pickAge({ US: ['R'], NL: ['', '12'] }), 12, 'the Dutch rating wins');
  assert.equal(pickAge({ US: ['PG-13'], JP: ['G'] }), 12);
  assert.equal(pickAge({ XX: ['???'] }), null);
  assert.equal(ageLabel(0), 'AL'); assert.equal(ageLabel(null), null);
  assert.equal(parseNfo('<movie><title>X</title><mpaa>Rated PG-13 / NL:12</mpaa></movie>').age, 12);
  assert.equal(parseNfo('<movie><title>X</title><mpaa>Not Rated</mpaa></movie>').age, undefined);
  assert.equal(tmdbAge({ release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R' }] }, { iso_3166_1: 'NL', release_dates: [{ certification: '' }, { certification: '16' }] }] } }, 'movie'), 16);
  assert.equal(tmdbAge({ content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-14' }] } }, 'show'), 14);
});

test('Wikidata ratings: Kijkwijzer first, then FSK, then MPAA; unreachable gives null', async () => {
  const b = (imdb, o) => ({ imdb: { value: imdb }, ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }])) });
  const fake = async () => ({ results: { bindings: [
    b('tt1', { kLabel: '16', mLabel: 'PG-13', fLabel: 'FSK 12' }), b('tt2', { k: 'http://www.wikidata.org/entity/Q23649981', kLabel: 'Q23649981', mLabel: 'G' }),
    b('tt3', { mLabel: 'R' }), b('tt4', {}), b('tt5', { fLabel: 'FSK 6', mLabel: 'PG' }),
  ] } });
  const ages = await wikidataAges(['tt1', 'tt2', 'tt3', 'tt4', 'tt5', "x'; DROP"], fake);
  assert.deepEqual([...ages], [['tt1', 16], ['tt2', 0], ['tt3', 16], ['tt5', 6]]);
  assert.equal(await wikidataAges(['tt1'], async () => null), null);
});

test('kids mode hides everything above the limit, as strictly as library permissions', async () => {
  const mk = (title, age) => { const f = mkFile({ title }); db.prepare("UPDATE titles SET age = ?, rating = 8, genres = '[\"Family\"]', backdrop = 'x', overview = 'y' WHERE id = ?").run(age, f.titleId); return f; };
  const small = mk('Kinderfilm Zes', 6), teen = mk('Tienerfilm Twaalf', 12), adult = mk('Griezel Zestien', 16), unknown = mk('Onbekend Beoordeeld', null);
  const kid = mkUser('user', 'Kind');
  assert.equal((await call(app, kid, 'PUT', `/api/admin/users/${kid.id}`, { maxAge: null })).statusCode, 403);
  assert.equal((await call(app, admin, 'PUT', `/api/admin/users/${kid.id}`, { maxAge: 7 })).statusCode, 400);
  assert.equal((await call(app, admin, 'PUT', `/api/admin/users/${kid.id}`, { maxAge: 9, kidsHome: true })).statusCode, 200);
  assert.deepEqual((({ kids, kidsHome }) => ({ kids, kidsHome }))((await call(app, kid, 'GET', '/api/auth/me')).json().user), { kids: true, kidsHome: true });

  const secret = /Tienerfilm|Griezel|Onbekend Beoordeeld/;
  for (const url of ['/api/home', '/api/browse', '/api/browse?q=film', '/api/browse?genre=Familie', '/api/watchnight', '/api/collections']) {
    const r = await call(app, kid, 'GET', url);
    assert.equal(r.statusCode, 200, url); assert.ok(!secret.test(r.body), `${url} lekt`);
  }
  const home = (await call(app, kid, 'GET', '/api/home')).json();
  assert.equal(home.kids, true);
  assert.ok(JSON.stringify(home).includes('Kinderfilm Zes'));
  assert.equal(home.rows.find((r) => r.id === 'top'), undefined, 'the simple home has no "top rated" row');
  for (const f of [teen, adult, unknown]) {
    for (const [method, url, body] of [['GET', `/api/titles/${f.titleId}`], ['POST', '/api/play', { fileId: f.fileId }], ['PUT', `/api/mylist/${f.titleId}`], ['POST', '/api/watch', { fileId: f.fileId }],
      ['POST', '/api/progress', { titleId: f.titleId, position: 50, duration: 100 }]]) {
      assert.equal((await call(app, kid, method, url, body)).statusCode, 404, `${method} ${url}`);
    }
  }
  assert.equal((await call(app, kid, 'POST', '/api/play', { fileId: small.fileId })).statusCode, 200);
  assert.equal((await call(app, kid, 'GET', `/api/titles/${small.titleId}`)).json().age, '6');
  const code = (await call(app, admin, 'POST', '/api/watch', { fileId: adult.fileId })).json().code;
  assert.equal((await call(app, kid, 'POST', `/api/watch/${code}/play`, {})).statusCode, 403);

  // Unrated titles can be allowed per child; a manual rating by the admin counts.
  await call(app, admin, 'PUT', `/api/admin/users/${kid.id}`, { hideUnrated: false });
  assert.equal((await call(app, kid, 'GET', `/api/titles/${unknown.titleId}`)).statusCode, 200);
  assert.equal((await call(app, kid, 'GET', `/api/titles/${teen.titleId}`)).statusCode, 404);
  assert.equal((await call(app, kid, 'PUT', `/api/admin/titles/${teen.titleId}/age`, { age: 6 })).statusCode, 403);
  assert.equal((await call(app, admin, 'PUT', `/api/admin/titles/${teen.titleId}/age`, { age: 6 })).statusCode, 200);
  assert.equal((await call(app, kid, 'GET', `/api/titles/${teen.titleId}`)).statusCode, 200);

  // No live tv for an account with an age limit.
  const src = db.prepare("INSERT INTO iptv_sources (name, kind, url) VALUES ('P', 'm3u', 'http://p.invalid/x.m3u')").run().lastInsertRowid;
  const ch = db.prepare("INSERT INTO iptv_channels (source_id, ext_id, name, category, url) VALUES (?, '1', 'Zender Voor Groten', 'NL | Algemeen', 'http://p.invalid/1.ts')").run(src).lastInsertRowid;
  const list = await call(app, kid, 'GET', '/api/iptv?category=NL%20%7C%20Algemeen');
  assert.deepEqual([list.json().enabled, list.json().channels.length], [false, 0]); assert.ok(!list.body.includes('Zender'));
  assert.equal((await call(app, kid, 'POST', `/api/iptv/${ch}/live`)).statusCode, 403);
  assert.equal((await call(app, admin, 'GET', '/api/iptv')).json().enabled, true);
  // Lifting the limit restores everything.
  await call(app, admin, 'PUT', `/api/admin/users/${kid.id}`, { maxAge: null });
  assert.equal((await call(app, kid, 'GET', `/api/titles/${adult.titleId}`)).statusCode, 200);
});

test('HDR sources get a tone-mapping pipeline, with a plain fallback', () => {
  const all = { zscale: true, tonemap: true, tonemap_vaapi: true };
  const sdr = pipelines({ id: 'none' }, { height: 720, hdr: false }, all);
  assert.deepEqual(sdr.map((p) => p.name), ['software']); assert.ok(!sdr[0].vf.includes('tonemap'));
  const hdr = pipelines({ id: 'none' }, { height: 720, hdr: true }, all);
  assert.deepEqual(hdr.map((p) => p.name), ['software+tonemap', 'software']); assert.ok(hdr[0].vf.startsWith(SW_TONEMAP));
  assert.deepEqual(pipelines({ id: 'none' }, { height: 720, hdr: true }, {}).map((p) => p.name), ['software'], 'no libzimg: unchanged behaviour');
  const va = pipelines({ id: 'vaapi', device: '/dev/dri/renderD128' }, { height: 1080, hdr: true }, all);
  assert.deepEqual(va.map((p) => p.name), ['vaapi+tonemap', 'vaapi-encode', 'software+tonemap', 'software']);
  assert.ok(va[0].vf.startsWith('tonemap_vaapi=')); assert.ok(va[1].vf.includes('tonemap=tonemap=hable'));
  assert.deepEqual(pipelines({ id: 'vaapi' }, { height: 1080, hdr: true }, { zscale: true, tonemap: true }).map((p) => p.name), ['vaapi-encode', 'software+tonemap', 'software']);
  assert.deepEqual(pipelines({ id: 'nvenc' }, { height: 1080, hdr: true }, all).map((p) => p.name), ['nvenc-encode', 'software+tonemap', 'software']);
  assert.deepEqual(pipelines({ id: 'qsv' }, { height: 1080, hdr: false }, all).map((p) => p.name), ['qsv', 'qsv-encode', 'software']);
});

test('with ffmpeg: an HDR clip is detected and tone-mapped; previews are generated and served', { skip: !hasFfmpeg && 'ffmpeg is niet geïnstalleerd' }, async () => {
  const dir = tmp('media-');
  // A short HDR10 (PQ, BT.2020, 10 bit) clip.
  const hdrFile = path.join(dir, 'hdr.mkv');
  const enc = await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '2', '-pix_fmt', 'yuv420p10le',
    '-c:v', 'libx265', '-x265-params', 'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', hdrFile], { timeout: 120_000 });
  if (enc.code === 0) {
    assert.equal((await probe(hdrFile)).hdr, 1);
    const { detectHardware } = await import('../src/ffmpeg.js');
    const filters = (await detectHardware()).filters;
    const pipe = pipelines({ id: 'none' }, { height: 180, hdr: true }, filters)[0];
    if (pipe.name === 'software+tonemap') {
      const out = path.join(dir, 'sdr.mp4');
      const r = await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', hdrFile, '-vf', pipe.vf, ...pipe.enc, out], { timeout: 120_000 });
      assert.equal(r.code, 0, r.stderr);
      const p = await probe(out);
      assert.equal(p.hdr, 0); assert.equal(p.pixFmt, 'yuv420p');
    }
  }

  // Previews: 65 seconds → 7 thumbnails on one sheet.
  const video = path.join(dir, 'film.mkv');
  const mk = await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '65', '-g', '10', '-c:v', 'libx264', '-preset', 'ultrafast', video], { timeout: 120_000 });
  assert.equal(mk.code, 0, mk.stderr);
  const f = mkFile({ file: video, height: 180 });
  db.prepare('UPDATE files SET duration = 65, width = 320 WHERE id = ?').run(f.fileId);
  const info = await generate(db.prepare('SELECT * FROM files WHERE id = ?').get(f.fileId));
  assert.deepEqual([info.interval, info.width, info.height, info.cols, info.rows, info.count, info.sheets], [10, 240, 136, 10, 10, 7, 1]);
  const play = (await call(app, admin, 'POST', '/api/play', { fileId: f.fileId })).json();
  assert.match(play.trickplay.base, /^\/api\/trickplay\/[\w-]+\/$/);
  const img = await app.inject({ url: `${play.trickplay.base}1.jpg` });
  assert.equal(img.statusCode, 200); assert.equal(img.headers['content-type'], 'image/jpeg'); assert.equal(img.rawPayload.readUInt16BE(0), 0xffd8);
  for (const bad of [`${play.trickplay.base}2.jpg`, `${play.trickplay.base}0.jpg`, '/api/trickplay/geen-ticket/1.jpg', `${play.trickplay.base}..%2F1.jpg`]) assert.equal((await app.inject({ url: bad })).statusCode, 404, bad);
  // A file that cannot be read is marked so it is not retried forever.
  const broken = mkFile();
  assert.equal(await generate(db.prepare('SELECT * FROM files WHERE id = ?').get(broken.fileId)), null);
  assert.equal(db.prepare('SELECT trickplay FROM files WHERE id = ?').get(broken.fileId).trickplay, 'none');
});
