// The things that make music feel finished: loudness for normalisation,
// lyrics, radio, home mixes, scrobbling and Kinoko Connect.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db, now, settings, HttpError } from './db.js';
import { config } from './config.js';
import { run, ffmpegAvailable } from './ffmpeg.js';
import { requireUser, requireAdmin } from './auth.js';
import { scopeFor, trackSql } from './access.js';
import { onMusicScanned, embeddedLyrics, norm } from './music.js';
import { requireTrack, tracksByIds, addHomeRows, onPlay } from './musicapi.js';
import { players, sendTo } from './events.js';
import { addWrappedSection } from './wrapped.js';

const UA = `Kinoko/${config.version} ( https://github.com/MrSaucy1/kinoko )`;

// ---------------------------------------------------------------------------
// Loudness: ReplayGain values for files that came without them
// ---------------------------------------------------------------------------
/** Parses ffmpeg's ebur128 summary: integrated loudness (LUFS) and true peak (dBFS). */
export function parseEbur128(text) {
  const tail = text.slice(text.lastIndexOf('Summary:'));
  const i = tail.match(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/), p = tail.match(/Peak:\s*(-?\d+(?:\.\d+)?|-inf)\s*dBFS/);
  if (!i) return null;
  const lufs = Number(i[1]);
  if (!Number.isFinite(lufs) || lufs <= -70) return null;   // silence
  return { lufs, peak: p && p[1] !== '-inf' ? Math.round(10 ** (Number(p[1]) / 20) * 1e4) / 1e4 : null };
}
/** ReplayGain 2: how much to turn a track up or down to land on -18 LUFS. */
export const gainFor = (lufs) => Math.round((-18 - lufs) * 100) / 100;
/** Loudness of an album from its tracks: the average of their energy, weighted by length. */
export function albumGain(tracks) {
  const total = tracks.reduce((s, t) => s + t.duration, 0);
  if (!total || tracks.some((t) => t.gain === null || t.gain === undefined)) return null;
  const energy = tracks.reduce((s, t) => s + t.duration * 10 ** ((-18 - t.gain) / 10), 0) / total;
  return gainFor(10 * Math.log10(energy));
}

export async function measure(track) {
  let r = await run('nice', ['-n', '19', config.ffmpeg, '-hide_banner', '-nostats', '-nostdin', '-i', track.path, '-vn', '-map', '0:a:0', '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { timeout: 10 * 60_000 });
  if (r.code === -1) r = await run(config.ffmpeg, ['-hide_banner', '-nostats', '-nostdin', '-i', track.path, '-vn', '-map', '0:a:0', '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { timeout: 10 * 60_000 });
  // framelog=verbose keeps the per-frame lines out of the log, so only the summary comes back.
  return r.code === 0 ? parseEbur128(r.stderr) : null;
}

export const loudnessState = { running: false, done: 0, total: 0 };
export async function measurePending() {
  if (loudnessState.running || settings.get('music_loudness', true) === false || !(await ffmpegAvailable())) return;
  const rows = db.prepare('SELECT * FROM tracks WHERE peer_id IS NULL AND loudness_done = 0 AND rg_track_gain IS NULL ORDER BY added_at DESC').all();
  Object.assign(loudnessState, { running: true, done: 0, total: rows.length });
  const albums = new Set();
  try {
    for (const t of rows) {
      if (settings.get('music_loudness', true) === false) break;
      const m = fs.existsSync(t.path) ? await measure(t).catch(() => null) : null;
      if (m) { db.prepare('UPDATE tracks SET rg_track_gain = ?, rg_track_peak = COALESCE(?, rg_track_peak), loudness_done = 1 WHERE id = ?').run(gainFor(m.lufs), m.peak, t.id); albums.add(t.album_id); }
      else db.prepare('UPDATE tracks SET loudness_done = 1 WHERE id = ?').run(t.id);
      loudnessState.done++;
    }
    // Album values for albums whose files did not bring their own.
    for (const id of albums) {
      const ts = db.prepare('SELECT duration, rg_track_gain gain, rg_album_gain FROM tracks WHERE album_id = ? AND peer_id IS NULL').all(id);
      if (ts.some((t) => t.rg_album_gain !== null)) continue;
      const g = albumGain(ts);
      if (g !== null) db.prepare('UPDATE tracks SET rg_album_gain = ? WHERE album_id = ? AND peer_id IS NULL').run(g, id);
    }
  } finally { loudnessState.running = false; }
}
onMusicScanned(() => { measurePending().catch((e) => console.error('[loudness]', e.message)); });

// ---------------------------------------------------------------------------
// Lyrics: a .lrc next to the file, the file's own tags, or LRCLIB (free, no key)
// ---------------------------------------------------------------------------
/** "[01:02.50]tekst" lines → [{ t: seconds, text }]. Lines without a time are dropped. */
export function parseLrc(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const words = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) out.push({ t: Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0), text: words });
  }
  return out.sort((a, b) => a.t - b.t);
}
const isSynced = (text) => /\[\d{1,3}:\d{1,2}/.test(text || '');
const store = (id, synced, plain, source) => db.prepare(`INSERT INTO lyrics (track_id, synced, plain, source, fetched_at) VALUES (?,?,?,?,?)
  ON CONFLICT(track_id) DO UPDATE SET synced = excluded.synced, plain = excluded.plain, source = excluded.source, fetched_at = excluded.fetched_at`).run(id, synced || '', plain || '', source, now());

// Lyrics found in tags during a scan go straight into the cache.
onMusicScanned(() => { for (const [id, text] of embeddedLyrics) { try { if (db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(id)) store(id, isSynced(text) ? text : '', isSynced(text) ? '' : text, 'tags'); } catch { /* track gone */ } } embeddedLyrics.clear(); });

export async function lyricsFor(track) {
  const have = db.prepare('SELECT * FROM lyrics WHERE track_id = ?').get(track.id);
  // "Nothing found" is remembered for a week, so an obscure track does not ask the service on every play.
  if (have && (have.source !== 'none' || now() - have.fetched_at < 7 * 86400)) return have;
  if (!track.peer_id) {
    const lrc = track.path.replace(/\.[^.]+$/, '.lrc');
    try { if (fs.existsSync(lrc)) { const text = fs.readFileSync(lrc, 'utf8').slice(0, 200_000); store(track.id, isSynced(text) ? text : '', isSynced(text) ? '' : text, 'lrc'); return db.prepare('SELECT * FROM lyrics WHERE track_id = ?').get(track.id); } } catch { /* unreadable */ }
  }
  if (settings.get('lyrics_online', true) !== false) {
    const meta = db.prepare('SELECT ar.name artist, al.title album FROM artists ar, albums al WHERE ar.id = ? AND al.id = ?').get(track.artist_id, track.album_id);
    const q = new URLSearchParams({ artist_name: meta?.artist || '', track_name: track.title, album_name: meta?.album || '', duration: String(Math.round(track.duration)) });
    try {
      const r = await fetch(`https://lrclib.net/api/get?${q}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
      if (r.ok) { const j = await r.json(); if (j && !j.instrumental && (j.syncedLyrics || j.plainLyrics)) { store(track.id, String(j.syncedLyrics || '').slice(0, 200_000), String(j.plainLyrics || '').slice(0, 200_000), 'lrclib'); return db.prepare('SELECT * FROM lyrics WHERE track_id = ?').get(track.id); } }
      else if (r.status !== 404) return have || null;   // service trouble: do not remember "nothing"
    } catch { return have || null; }
  }
  store(track.id, '', '', 'none');
  return db.prepare('SELECT * FROM lyrics WHERE track_id = ?').get(track.id);
}

// ---------------------------------------------------------------------------
// Radio: more like this, from what this server itself knows
// ---------------------------------------------------------------------------
function seeded(seed) { let x = seed | 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 100000) / 100000; }; }
const shuffle = (list, rnd) => { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

async function lastfmSimilar(artist) {
  const key = settings.get('lastfm_key', '');
  if (!key) return [];
  try {
    const r = await fetch(`https://ws.audioscrobbler.com/2.0/?method=artist.getsimilar&format=json&limit=20&api_key=${encodeURIComponent(key)}&artist=${encodeURIComponent(artist)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    const j = r.ok ? await r.json() : null;
    return (j?.similarartists?.artist || []).map((a) => norm(a.name)).filter(Boolean);
  } catch { return []; }
}

/**
 * Tracks that go with the seeds: the same artists, the same genres, and what
 * people who played the seeds also played. `similar` (optional) are artist
 * names from Last.fm.
 */
export function radio(scope, { trackIds = [], artistIds = [], exclude = [], limit = 30, similar = [], rnd = Math.random } = {}) {
  const TV = trackSql(scope);
  const seeds = trackIds.length ? db.prepare(`SELECT id, artist_id, album_id FROM tracks WHERE id IN (${trackIds.map(Number).filter(Number.isInteger).join(',') || 0})`).all() : [];
  const artists = new Set([...artistIds.map(Number), ...seeds.map((s) => s.artist_id)]);
  const skip = new Set([...exclude.map(Number), ...seeds.map((s) => s.id)]);
  const score = new Map();
  const add = (rows, pts) => { for (const r of rows) if (!skip.has(r.id)) score.set(r.id, (score.get(r.id) || 0) + pts); };
  const ints = (set) => [...set].filter(Number.isInteger).join(',') || '0';
  if (artists.size) add(db.prepare(`SELECT t.id FROM tracks t WHERE t.artist_id IN (${ints(artists)}) AND ${TV} LIMIT 400`).all(), 3);
  const genres = seeds.length || artists.size ? db.prepare(`SELECT DISTINCT tg.genre_id id FROM track_genres tg JOIN tracks t ON t.id = tg.track_id WHERE t.id IN (${ints(new Set(seeds.map((s) => s.id)))}) OR t.artist_id IN (${ints(artists)})`).all().map((g) => g.id) : [];
  if (genres.length) add(db.prepare(`SELECT DISTINCT t.id FROM tracks t JOIN track_genres tg ON tg.track_id = t.id WHERE tg.genre_id IN (${genres.join(',')}) AND ${TV} LIMIT 1500`).all(), 2);
  // Co-listening: users who played a seed (properly) also played…
  if (seeds.length) add(db.prepare(`SELECT p2.track_id id FROM music_plays p1 JOIN music_plays p2 ON p2.user_id = p1.user_id AND p2.track_id != p1.track_id JOIN tracks t ON t.id = p2.track_id
    WHERE p1.track_id IN (${ints(new Set(seeds.map((s) => s.id)))}) AND p1.seconds >= 30 AND p2.seconds >= 30 AND ${TV} GROUP BY p2.track_id ORDER BY COUNT(*) DESC LIMIT 200`).all(), 4);
  if (similar.length) add(db.prepare(`SELECT t.id FROM tracks t JOIN artists ar ON ar.id = t.artist_id WHERE ar.norm IN (${similar.map(() => '?').join(',')}) AND ${TV} LIMIT 600`).all(...similar), 3);
  // Enough variety: at most a few per artist, best scores first with some chance mixed in.
  const ranked = [...score.entries()].map(([id, s]) => ({ id, s: s + rnd() * 2 })).sort((a, b) => b.s - a.s).slice(0, 400);
  const byArtist = new Map(db.prepare(`SELECT id, artist_id FROM tracks WHERE id IN (${ranked.map((r) => r.id).join(',') || 0})`).all().map((r) => [r.id, r.artist_id]));
  const used = new Map(), out = [];
  for (const r of ranked) { const a = byArtist.get(r.id), n = used.get(a) || 0; if (n >= 4) continue; used.set(a, n + 1); out.push(r.id); if (out.length >= limit) break; }
  return out;
}

// ---------------------------------------------------------------------------
// Home mixes: the same for a whole day, different tomorrow
// ---------------------------------------------------------------------------
addHomeRows((user, scope, liked) => {
  const TV = trackSql(scope), day = Math.floor(Date.now() / 86400000), rnd = seeded(day * 131 + user.id), rows = [];
  // Opnieuw ontdekken: played a few times, but not for two months.
  const old = db.prepare(`SELECT p.track_id id FROM music_plays p JOIN tracks t ON t.id = p.track_id WHERE p.user_id = ? AND p.seconds >= 30 AND ${TV} GROUP BY p.track_id HAVING COUNT(*) >= 2 AND MAX(p.at) < ? ORDER BY COUNT(*) DESC LIMIT 60`).all(user.id, now() - 60 * 86400).map((r) => r.id);
  if (old.length >= 4) rows.push({ id: 'rediscover', title: 'Opnieuw ontdekken', kind: 'tracks', items: tracksByIds(shuffle(old, rnd).slice(0, 20), scope, liked) });
  // A mix per favourite genre.
  const fav = db.prepare(`SELECT g.id, g.name, COUNT(*) n FROM music_plays p JOIN track_genres tg ON tg.track_id = p.track_id JOIN genres g ON g.id = tg.genre_id WHERE p.user_id = ? AND p.seconds >= 30 AND p.at > ? GROUP BY g.id ORDER BY n DESC LIMIT 4`).all(user.id, now() - 180 * 86400);
  for (const g of fav) {
    const ids = db.prepare(`SELECT DISTINCT t.id FROM tracks t JOIN track_genres tg ON tg.track_id = t.id WHERE tg.genre_id = ? AND ${TV} LIMIT 2000`).all(g.id).map((r) => r.id);
    if (ids.length >= 8) rows.push({ id: `mix:${g.id}`, title: `Dagmix ${g.name}`, kind: 'tracks', items: tracksByIds(shuffle(ids, rnd).slice(0, 25), scope, liked) });
  }
  return rows;
});

// ---------------------------------------------------------------------------
// Scrobbling (optional, per user)
// ---------------------------------------------------------------------------
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
/** Last.fm wants every call signed: all parameters sorted and glued together, then the secret. */
export const lastfmSign = (params, secret) => md5(Object.keys(params).sort().map((k) => k + params[k]).join('') + secret);
async function lastfm(params, { sign = true } = {}) {
  const key = settings.get('lastfm_key', ''), secret = settings.get('lastfm_secret', '');
  if (!key || (sign && !secret)) throw new HttpError(501, 'Last.fm is niet ingesteld door de beheerder.');
  const p = { ...params, api_key: key };
  if (sign) p.api_sig = lastfmSign(p, secret);
  const r = await fetch('https://ws.audioscrobbler.com/2.0/', { method: 'POST', headers: { 'User-Agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...p, format: 'json' }), signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) throw new HttpError(502, `Last.fm gaf een fout${j?.message ? `: ${String(j.message).slice(0, 120)}` : ''}.`);
  return j;
}
/** A play counts for scrobbling like everywhere: half the track, or four minutes. */
export const scrobbleWorthy = (seconds, duration) => duration > 30 && (seconds >= 240 || seconds >= duration / 2);

onPlay((user, track, seconds) => {
  if (!scrobbleWorthy(seconds, track.duration)) return;
  const u = db.prepare('SELECT lb_token, lastfm_session FROM users WHERE id = ?').get(user.id);
  if (!u || (!u.lb_token && !u.lastfm_session)) return;
  const m = db.prepare('SELECT ar.name artist, al.title album FROM artists ar, albums al WHERE ar.id = ? AND al.id = ?').get(track.artist_id, track.album_id) || {};
  const at = now() - Math.round(seconds);
  if (u.lb_token) {
    fetch('https://api.listenbrainz.org/1/submit-listens', { method: 'POST', headers: { Authorization: `Token ${u.lb_token}`, 'content-type': 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ listen_type: 'single', payload: [{ listened_at: at, track_metadata: { artist_name: m.artist, track_name: track.title, release_name: m.album, additional_info: { duration: Math.round(track.duration), media_player: 'Kinoko', ...(track.mb_track_id && { track_mbid: track.mb_track_id }) } } }] }) }).catch(() => {});
  }
  if (u.lastfm_session) lastfm({ method: 'track.scrobble', sk: u.lastfm_session, artist: m.artist || '', track: track.title, album: m.album || '', timestamp: String(at), duration: String(Math.round(track.duration)) }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Wrapped: the music half of the yearly overview
// ---------------------------------------------------------------------------
export function musicWrapped(userId, year) {
  const from = Math.floor(new Date(year, 0, 1).getTime() / 1000), to = Math.floor(new Date(year + 1, 0, 1).getTime() / 1000);
  const rows = db.prepare(`SELECT p.track_id, p.seconds, t.title, t.artist_id, ar.name artist FROM music_plays p JOIN tracks t ON t.id = p.track_id JOIN artists ar ON ar.id = t.artist_id
    WHERE p.user_id = ? AND p.at >= ? AND p.at < ?`).all(userId, from, to);
  const total = rows.reduce((s, r) => s + r.seconds, 0);
  if (total < 60) return { music: { empty: true } };
  const artists = new Map(), tracks = new Map(), genres = new Map();
  const genreOf = db.prepare('SELECT g.name FROM track_genres tg JOIN genres g ON g.id = tg.genre_id WHERE tg.track_id = ?');
  const cache = new Map();
  for (const r of rows) {
    const a = artists.get(r.artist_id) || { name: r.artist, seconds: 0 }; a.seconds += r.seconds; artists.set(r.artist_id, a);
    const t = tracks.get(r.track_id) || { title: r.title, artist: r.artist, plays: 0, seconds: 0 }; t.seconds += r.seconds; if (r.seconds >= 30) t.plays++; tracks.set(r.track_id, t);
    if (!cache.has(r.track_id)) cache.set(r.track_id, genreOf.all(r.track_id).map((g) => g.name));
    for (const g of cache.get(r.track_id)) genres.set(g, (genres.get(g) || 0) + r.seconds);
  }
  const top = (map, key, n) => [...map.values()].sort((x, y) => y[key] - x[key]).slice(0, n);
  return { music: {
    empty: false, seconds: Math.round(total), tracks: tracks.size, artists: artists.size,
    topArtists: top(artists, 'seconds', 5).map((a) => ({ name: a.name, seconds: Math.round(a.seconds) })),
    topTracks: top(tracks, 'plays', 5).filter((t) => t.plays > 0).map((t) => ({ title: t.title, artist: t.artist, plays: t.plays })),
    topGenres: [...genres.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([name, sec]) => ({ name, share: Math.round((sec / total) * 100) })),
  } };
}
addWrappedSection(musicWrapped);

export default async function routes(app) {
  // ---- lyrics ----------------------------------------------------------------
  app.get('/api/music/tracks/:id/lyrics', { preHandler: requireUser }, async (req) => {
    const t = requireTrack(req.user, req.params.id);
    const l = await lyricsFor(t);
    if (!l || l.source === 'none') return { synced: false, lines: [], plain: '', source: null };
    const lines = l.synced ? parseLrc(l.synced) : [];
    return { synced: lines.length > 0, lines, plain: l.plain || (lines.length ? '' : l.synced), source: l.source };
  });

  // ---- radio -----------------------------------------------------------------
  app.get('/api/music/radio', { preHandler: requireUser }, async (req) => {
    const scope = scopeFor(req.user), ints = (v) => String(v || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
    let trackIds = ints(req.query.track), artistIds = ints(req.query.artist);
    if (req.query.album) trackIds = trackIds.concat(db.prepare(`SELECT t.id FROM tracks t WHERE t.album_id = ? AND ${trackSql(scope)}`).all(Number(req.query.album)).map((r) => r.id));
    // The seeds themselves must be something this user may see.
    trackIds = tracksByIds(trackIds, scope).map((t) => t.id);
    if (!trackIds.length && !artistIds.length) throw new HttpError(404, 'Niets om radio mee te starten.');
    const seedArtist = db.prepare('SELECT ar.name FROM artists ar WHERE ar.id = ?').get(artistIds[0] || db.prepare('SELECT artist_id FROM tracks WHERE id = ?').get(trackIds[0])?.artist_id);
    const similar = seedArtist ? await lastfmSimilar(seedArtist.name) : [];
    const ids = radio(scope, { trackIds, artistIds, exclude: ints(req.query.exclude), limit: Math.min(50, Number(req.query.limit) || 30), similar });
    const liked = new Set(db.prepare('SELECT track_id FROM music_likes WHERE user_id = ?').all(req.user.id).map((r) => r.track_id));
    return { items: tracksByIds(ids, scope, liked) };
  });

  // ---- scrobbling -------------------------------------------------------------
  app.get('/api/music/scrobble', { preHandler: requireUser }, async (req) => {
    const u = db.prepare('SELECT lb_token, lastfm_session, lastfm_name FROM users WHERE id = ?').get(req.user.id);
    return { listenbrainz: !!u.lb_token, lastfm: !!u.lastfm_session, lastfmName: u.lastfm_name || '', lastfmAvailable: !!(settings.get('lastfm_key', '') && settings.get('lastfm_secret', '')) };
  });
  app.put('/api/music/scrobble/listenbrainz', { preHandler: requireUser }, async (req) => {
    const token = String(req.body?.token || '').trim();
    if (!token) { db.prepare('UPDATE users SET lb_token = NULL WHERE id = ?').run(req.user.id); return { listenbrainz: false }; }
    if (!/^[0-9a-f-]{20,64}$/i.test(token)) throw new HttpError(400, 'Dit lijkt geen ListenBrainz-token.');
    let ok = false;
    try { const r = await fetch('https://api.listenbrainz.org/1/validate-token', { headers: { Authorization: `Token ${token}`, 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }); ok = r.ok && (await r.json()).valid === true; }
    catch { throw new HttpError(502, 'ListenBrainz is nu niet bereikbaar. Probeer het later opnieuw.'); }
    if (!ok) throw new HttpError(400, 'ListenBrainz herkent dit token niet.');
    db.prepare('UPDATE users SET lb_token = ? WHERE id = ?').run(token, req.user.id);
    return { listenbrainz: true };
  });
  // Last.fm: the user approves Kinoko on last.fm, then comes back to finish.
  app.post('/api/music/scrobble/lastfm/start', { preHandler: requireUser }, async () => {
    const j = await lastfm({ method: 'auth.getToken' });
    return { token: j.token, url: `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(settings.get('lastfm_key', ''))}&token=${encodeURIComponent(j.token)}` };
  });
  app.post('/api/music/scrobble/lastfm/finish', { preHandler: requireUser }, async (req) => {
    const token = String(req.body?.token || '');
    if (!/^[\w-]{10,64}$/.test(token)) throw new HttpError(400, 'Ongeldig token.');
    const j = await lastfm({ method: 'auth.getSession', token });
    db.prepare('UPDATE users SET lastfm_session = ?, lastfm_name = ? WHERE id = ?').run(j.session.key, String(j.session.name || '').slice(0, 60), req.user.id);
    return { lastfm: true, lastfmName: j.session.name };
  });
  app.delete('/api/music/scrobble/lastfm', { preHandler: requireUser }, async (req) => {
    db.prepare('UPDATE users SET lastfm_session = NULL, lastfm_name = NULL WHERE id = ?').run(req.user.id);
    return { lastfm: false };
  });

  // ---- admin: what the extras may do ---------------------------------------------
  app.get('/api/admin/music/extras', { preHandler: requireAdmin }, async () => ({
    loudness: settings.get('music_loudness', true) !== false, loudnessState, lyricsOnline: settings.get('lyrics_online', true) !== false,
    lastfmKey: settings.get('lastfm_key', '') ? `••••${String(settings.get('lastfm_key')).slice(-4)}` : '', lastfmSecret: !!settings.get('lastfm_secret', ''),
    unmeasured: db.prepare('SELECT COUNT(*) c FROM tracks WHERE peer_id IS NULL AND rg_track_gain IS NULL').get().c,
  }));
  app.put('/api/admin/music/extras', { preHandler: requireAdmin }, async (req) => {
    const b = req.body || {};
    if (typeof b.loudness === 'boolean') { settings.set('music_loudness', b.loudness); if (b.loudness) measurePending().catch(() => {}); }
    if (typeof b.lyricsOnline === 'boolean') settings.set('lyrics_online', b.lyricsOnline);
    if (typeof b.lastfmKey === 'string' && !b.lastfmKey.includes('•')) settings.set('lastfm_key', b.lastfmKey.trim().slice(0, 64));
    if (typeof b.lastfmSecret === 'string' && b.lastfmSecret.trim()) settings.set('lastfm_secret', b.lastfmSecret.trim().slice(0, 64));
    if (b.clearLastfm === true) { settings.set('lastfm_key', ''); settings.set('lastfm_secret', ''); }
    return { ok: true };
  });

  // ---- Kinoko Connect -------------------------------------------------------------
  // Every open player of this user, with what it is playing. A command goes to one of them.
  app.get('/api/music/devices', { preHandler: requireUser }, async (req) => ({
    devices: players(req.user.id).map((e) => ({ id: e.id, name: e.device || 'Onbekend apparaat', state: e.state && Date.now() - e.state.at < 5 * 60_000 ? e.state : null })),
  }));
  app.post('/api/music/devices/:id/command', { preHandler: requireUser }, async (req) => {
    const b = req.body || {}, cmd = String(b.cmd || '');
    if (!['play', 'pause', 'next', 'previous', 'seek', 'volume', 'load'].includes(cmd)) throw new HttpError(400, 'Onbekende opdracht.');
    const msg = { t: 'control', cmd };
    if (cmd === 'seek') msg.position = Math.max(0, Number(b.position) || 0);
    if (cmd === 'volume') msg.volume = Math.max(0, Math.min(1, Number(b.volume)));
    if (cmd === 'load') {
      // Only tracks this user may play travel to the other device.
      const items = tracksByIds((Array.isArray(b.trackIds) ? b.trackIds : []).slice(0, 2000), scopeFor(req.user));
      if (!items.length) throw new HttpError(404, 'Nummer niet gevonden.');
      Object.assign(msg, { items, index: Math.max(0, Math.min(items.length - 1, Math.trunc(Number(b.index) || 0))), position: Math.max(0, Number(b.position) || 0), play: b.play !== false });
    }
    // The id is looked up among this user's own connections only.
    if (!sendTo(req.user.id, String(req.params.id), msg)) throw new HttpError(404, 'Dit apparaat is niet meer verbonden.');
    return { ok: true };
  });
}
