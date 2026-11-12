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
