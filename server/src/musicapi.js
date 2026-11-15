// The music API: browsing, search, playlists, likes, queue, history and
// playback. Everything is scoped to what the signed-in user may see.
import fs from 'node:fs';
import { db, now, json, sha256, settings, HttpError } from './db.js';
import { requireUser, requireAdmin } from './auth.js';
import { enabled as musicOnline, musicMetaState, enrichMusic } from './musicmeta.js';
import { scopeFor, trackSql } from './access.js';
import { sendFile } from './stream.js';
import { norm, coverFile, converted, audioMime, issueTrackTicket, ticketTrack, AUDIO_QUALITIES, artistId, albumId, pruneMusic } from './music.js';
import { peerFetch, requirePeer, relay, onPeerSync, publicUrl } from './federation.js';
import { sniff } from './metadata.js';

const page = (q) => ({ limit: Math.max(1, Math.min(200, Number(q.limit) || 50)), offset: Math.max(0, Number(q.offset) || 0) });
const coverUrl = (kind, id, source) => (source ? `/api/music/cover/${kind}/${id}?v=${sha256(source).slice(0, 8)}` : null);

const TRACK_COLS = `t.id, t.title, t.track_no, t.disc_no, t.duration, t.codec, t.bitrate, t.year, t.explicit, t.album_id, t.artist_id, t.peer_id,
  t.rg_track_gain, t.rg_track_peak, t.rg_album_gain, t.rg_album_peak, ar.name artist, al.title album, al.cover cover`;
const TRACK_FROM = 'tracks t JOIN artists ar ON ar.id = t.artist_id JOIN albums al ON al.id = t.album_id';
export function trackOut(r, liked = null) {
  return {
    id: r.id, title: r.title, artist: r.artist, artistId: r.artist_id, album: r.album, albumId: r.album_id, trackNo: r.track_no, discNo: r.disc_no,
    duration: r.duration, codec: r.codec, bitrate: r.bitrate, year: r.year, explicit: !!r.explicit, remote: !!r.peer_id, cover: coverUrl('album', r.album_id, r.cover),
    gain: { track: r.rg_track_gain, trackPeak: r.rg_track_peak, album: r.rg_album_gain, albumPeak: r.rg_album_peak },
    ...(liked && { liked: liked.has(r.id) }),
  };
}
const likedSet = (userId) => new Set(db.prepare('SELECT track_id FROM music_likes WHERE user_id = ?').all(userId).map((r) => r.track_id));
const albumOut = (a) => ({ id: a.id, title: a.title, artist: a.artist, artistId: a.artist_id, year: a.year, cover: coverUrl('album', a.id, a.cover), tracks: a.n });
const artistOut = (a) => ({ id: a.id, name: a.name, image: coverUrl('artist', a.id, a.image), albums: a.albums, tracks: a.n });

/** Tracks by id, in the order given, limited to what the scope allows. */
export function tracksByIds(ids, scope, liked = null) {
  const clean = [...new Set(ids.map(Number).filter(Number.isInteger))].slice(0, 2000);
  if (!clean.length) return [];
  const rows = new Map(db.prepare(`SELECT ${TRACK_COLS} FROM ${TRACK_FROM} WHERE t.id IN (${clean.join(',')}) AND ${trackSql(scope)}`).all().map((r) => [r.id, r]));
  return ids.map(Number).filter((id) => rows.has(id)).map((id) => trackOut(rows.get(id), liked));
}
export function requireTrack(user, id) {
  const t = db.prepare(`SELECT t.* FROM tracks t WHERE t.id = ? AND ${trackSql(scopeFor(user))}`).get(Number(id));
  if (!t) throw new HttpError(404, 'Nummer niet gevonden.');
  return t;
}
const albumsSql = (scope, where = '1', order = 'al.title COLLATE NOCASE') => `SELECT al.*, ar.name artist, (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id AND ${trackSql(scope)}) n
  FROM albums al JOIN artists ar ON ar.id = al.artist_id WHERE ${where} AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND ${trackSql(scope)}) ORDER BY ${order}`;

// ---------------------------------------------------------------------------
// Search: quick for the obvious, forgiving for typos
// ---------------------------------------------------------------------------
const grams = (s) => { const g = new Set(), p = ` ${s} `; for (let i = 0; i < p.length - 2; i++) g.add(p.slice(i, i + 3)); return g; };
/** 0..100: exact > starts with > a word starts with > contains > looks alike. */
export function matchScore(needle, hay) {
  if (!needle || !hay) return 0;
  if (hay === needle) return 100;
  if (hay.startsWith(needle)) return 85;
  if (hay.includes(` ${needle}`)) return 75;
  if (hay.includes(needle)) return 65;
  const a = grams(needle), b = grams(hay);
  let both = 0; for (const g of a) if (b.has(g)) both++;
  const sim = both / a.size;   // how much of what was typed is found, so a typo in a long title still matches
  return sim >= 0.5 ? Math.round(20 + sim * 35) : 0;
}
const best = (rows, key, needle, n) => rows.map((r) => ({ r, s: matchScore(needle, r[key]) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n);

// ---------------------------------------------------------------------------
// Playlists: private unless shared
// ---------------------------------------------------------------------------
function playlistAccess(id, user) {
  const p = db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(id));
  if (!p) throw new HttpError(404, 'Playlist niet gevonden.');
  if (p.owner_id === user.id) return { p, owner: true, edit: true };
  const s = db.prepare('SELECT can_edit FROM playlist_shares WHERE playlist_id = ? AND user_id = ?').get(p.id, user.id);
  if (!s) throw new HttpError(404, 'Playlist niet gevonden.');
  return { p, owner: false, edit: !!s.can_edit };
}
const playlistName = (v) => { const n = String(v || '').trim().slice(0, 80); if (!n) throw new HttpError(400, 'Geef de playlist een naam.'); return n; };
function playlistOut(p, user, scope) {
  const rows = db.prepare(`SELECT t.album_id, al.cover, t.duration FROM playlist_items i JOIN tracks t ON t.id = i.track_id JOIN albums al ON al.id = t.album_id WHERE i.playlist_id = ? AND ${trackSql(scope)} ORDER BY i.ord`).all(p.id);
  const covers = []; for (const r of rows) { const u = coverUrl('album', r.album_id, r.cover); if (u && !covers.includes(u)) covers.push(u); if (covers.length === 4) break; }
  const owner = db.prepare('SELECT name FROM users WHERE id = ?').get(p.owner_id);
  return { id: p.id, name: p.name, mine: p.owner_id === user.id, owner: owner ? owner.name : '', count: rows.length, duration: Math.round(rows.reduce((s, r) => s + r.duration, 0)), covers, updated_at: p.updated_at,
    canEdit: p.owner_id === user.id || !!db.prepare('SELECT 1 FROM playlist_shares WHERE playlist_id = ? AND user_id = ? AND can_edit = 1').get(p.id, user.id),
    shared: db.prepare('SELECT COUNT(*) c FROM playlist_shares WHERE playlist_id = ?').get(p.id).c };
}
export const myPlaylists = (user) => db.prepare('SELECT * FROM playlists WHERE owner_id = ? OR id IN (SELECT playlist_id FROM playlist_shares WHERE user_id = ?) ORDER BY updated_at DESC').all(user.id, user.id);

// ---------------------------------------------------------------------------
// Linked servers: their music appears here, streams run through this server
// ---------------------------------------------------------------------------
function exportMusic(base) {
  const rows = db.prepare(`SELECT t.*, ar.name artist, al.title album, al.year album_year, al.cover, aa.name album_artist FROM tracks t JOIN libraries l ON l.id = t.library_id
    JOIN artists ar ON ar.id = t.artist_id JOIN albums al ON al.id = t.album_id JOIN artists aa ON aa.id = al.artist_id WHERE t.peer_id IS NULL AND l.shared = 1`).all();
  return rows.map((t) => ({
    id: t.id, title: t.title, artist: t.artist, albumArtist: t.album_artist, album: t.album, year: t.album_year || t.year, trackNo: t.track_no, discNo: t.disc_no, duration: t.duration, codec: t.codec,
    container: t.container, bitrate: t.bitrate, sampleRate: t.sample_rate, explicit: !!t.explicit, size: t.size, gain: [t.rg_track_gain, t.rg_track_peak, t.rg_album_gain, t.rg_album_peak],
    genres: db.prepare('SELECT g.name FROM track_genres tg JOIN genres g ON g.id = tg.genre_id WHERE tg.track_id = ?').all(t.id).map((g) => g.name),
    cover: t.cover ? base + coverUrl('album', t.album_id, t.cover) : null,
  }));
}
const importMusic = db.transaction((peer, tracks) => {
  const seen = new Set();
  for (const r of tracks) {
    if (!Number.isInteger(r?.id) || !r.title) continue;
    const artist = artistId(r.artist), albumArtist = r.albumArtist && r.albumArtist !== r.artist ? artistId(r.albumArtist) : artist;
    const album = albumId(r.album, albumArtist, { year: Number.isInteger(r.year) ? r.year : null, cover: /^https?:\/\//.test(r.cover || '') ? r.cover : null });
    const g = Array.isArray(r.gain) ? r.gain.map((x) => (typeof x === 'number' ? x : null)) : [];
    const cols = [album, artist, String(r.title).slice(0, 300), norm(r.title), Number(r.trackNo) || 0, Number(r.discNo) || 1, Number(r.duration) || 0, Number(r.size) || 0, String(r.codec || ''), String(r.container || ''),
      Number(r.bitrate) || 0, Number(r.sampleRate) || 0, r.explicit ? 1 : 0, g[0] ?? null, g[1] ?? null, g[2] ?? null, g[3] ?? null];
    const prev = db.prepare('SELECT id FROM tracks WHERE peer_id = ? AND remote_id = ?').get(peer.id, r.id);
    let id;
    if (prev) { id = prev.id; db.prepare('UPDATE tracks SET album_id=?, artist_id=?, title=?, norm=?, track_no=?, disc_no=?, duration=?, size=?, codec=?, container=?, bitrate=?, sample_rate=?, explicit=?, rg_track_gain=?, rg_track_peak=?, rg_album_gain=?, rg_album_peak=? WHERE id=?').run(...cols, id); }
    else id = Number(db.prepare(`INSERT INTO tracks (peer_id, remote_id, path, album_id, artist_id, title, norm, track_no, disc_no, duration, size, codec, container, bitrate, sample_rate, explicit, rg_track_gain, rg_track_peak, rg_album_gain, rg_album_peak, added_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(peer.id, r.id, `peer:${peer.id}:${r.id}`, ...cols, now()).lastInsertRowid);
    db.prepare('DELETE FROM track_genres WHERE track_id = ?').run(id);
    for (const name of (Array.isArray(r.genres) ? r.genres : []).slice(0, 6)) { const n = String(name).slice(0, 40); db.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)').run(n); db.prepare('INSERT OR IGNORE INTO track_genres (track_id, genre_id) SELECT ?, id FROM genres WHERE name = ?').run(id, n); }
    seen.add(r.id);
  }
  for (const t of db.prepare('SELECT id, remote_id FROM tracks WHERE peer_id = ?').all(peer.id)) if (!seen.has(t.remote_id)) db.prepare('DELETE FROM tracks WHERE id = ?').run(t.id);
  pruneMusic();
  return seen.size;
});
export { importMusic };
onPeerSync(async (peer) => {
  let data;
  try { data = await peerFetch(peer, '/api/federation/music/catalog', { timeout: 120_000 }); }
  catch (e) { if (e.status === 404) return; throw e; }   // an older Kinoko without music
  importMusic(peer, data.tracks || []);
});

/** Where to fetch a track from: this server, or through it from a linked one. */
async function playUrl(track, quality, format) {
  if (track.peer_id) {
    const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(track.peer_id);
    if (!peer || !peer.out_key) throw new HttpError(502, 'De koppeling met deze server bestaat niet meer.');
    const r = await peerFetch(peer, '/api/federation/music/play', { method: 'POST', body: { trackId: track.remote_id, quality, format } });
    return { ...r, url: relay(peer, r.url) };
  }
  if (!fs.existsSync(track.path)) throw new HttpError(404, 'Het bestand staat niet meer op schijf. Scan de bibliotheek opnieuw.');
  const q = AUDIO_QUALITIES[quality] ? String(quality) : 'original', f = format === 'aac' ? 'aac' : 'opus';
  // No point converting to a higher bitrate than the file has.
  const direct = q === 'original' || (track.bitrate > 0 && track.bitrate <= Number(q) * 1000 * 1.1 && ['mp3', 'aac', 'opus', 'vorbis'].includes(track.codec));
  const ticket = issueTrackTicket(track.id);
  return direct ? { url: `/api/music/stream/${ticket}`, quality: 'original', mime: audioMime(track.path), bitrate: track.bitrate }
    : { url: `/api/music/stream/${ticket}?q=${q}&f=${f}`, quality: q, mime: f === 'aac' ? 'audio/mp4' : 'audio/ogg', bitrate: Number(q) * 1000 };
}

export default async function routes(app) {
  // ---- admin: online lookups on or off ---------------------------------------
  app.get('/api/admin/music', { preHandler: requireAdmin }, async () => ({
    online: musicOnline(), state: musicMetaState, cacheMb: Number(settings.get('music_cache_mb', 2048)),
    counts: { artists: db.prepare('SELECT COUNT(*) c FROM artists').get().c, albums: db.prepare('SELECT COUNT(*) c FROM albums').get().c, tracks: db.prepare('SELECT COUNT(*) c FROM tracks WHERE peer_id IS NULL').get().c,
      noCover: db.prepare('SELECT COUNT(*) c FROM albums WHERE cover IS NULL').get().c },
  }));
  app.put('/api/admin/music', { preHandler: requireAdmin }, async (req) => {
    if (typeof req.body?.online === 'boolean') settings.set('music_online', req.body.online);
    const mbs = Number(req.body?.cacheMb);
    if (req.body?.cacheMb !== undefined) { if (!Number.isInteger(mbs) || mbs < 100 || mbs > 500000) throw new HttpError(400, 'Kies een grootte tussen 100 en 500000 MB.'); settings.set('music_cache_mb', mbs); }
    if (req.body?.retry === true) { db.prepare('UPDATE albums SET meta_at = NULL WHERE cover IS NULL').run(); enrichMusic().catch(() => {}); }
    return { ok: true };
  });

  // ---- home ------------------------------------------------------------------
  app.get('/api/music/home', { preHandler: requireUser }, async (req) => {
    const scope = scopeFor(req.user), liked = likedSet(req.user.id), TV = trackSql(scope);
    const rows = [];
    const push = (id, title, kind, items) => { if (items.length) rows.push({ id, title, kind, items }); };
    const recentIds = db.prepare(`SELECT p.track_id id, MAX(p.at) at FROM music_plays p JOIN tracks t ON t.id = p.track_id WHERE p.user_id = ? AND ${TV} GROUP BY p.track_id ORDER BY at DESC LIMIT 20`).all(req.user.id).map((r) => r.id);
    push('recent-played', 'Recent gespeeld', 'tracks', tracksByIds(recentIds, scope, liked));
    push('new', 'Recent toegevoegd', 'albums', db.prepare(`${albumsSql(scope, '1', 'al.added_at DESC, al.id DESC')} LIMIT 20`).all().map(albumOut));
    const topIds = db.prepare(`SELECT p.track_id id, COUNT(*) n FROM music_plays p JOIN tracks t ON t.id = p.track_id WHERE p.user_id = ? AND p.at > ? AND p.seconds >= 30 AND ${TV} GROUP BY p.track_id ORDER BY n DESC LIMIT 20`).all(req.user.id, now() - 90 * 86400).map((r) => r.id);
    push('top', 'Veel gedraaid', 'tracks', tracksByIds(topIds, scope, liked));
    push('playlists', 'Jouw playlists', 'playlists', myPlaylists(req.user).slice(0, 20).map((p) => playlistOut(p, req.user, scope)));
    for (const fn of homeRows) { try { for (const r of fn(req.user, scope, liked)) push(r.id, r.title, r.kind, r.items); } catch (e) { console.error('[muziek-home]', e.message); } }
    const total = db.prepare(`SELECT COUNT(*) c FROM tracks t WHERE ${TV}`).get().c;
    return { rows, empty: total === 0, tracks: total, liked: db.prepare(`SELECT COUNT(*) c FROM music_likes l JOIN tracks t ON t.id = l.track_id WHERE l.user_id = ? AND ${TV}`).get(req.user.id).c };
  });

  // ---- artists ---------------------------------------------------------------
  app.get('/api/music/artists', { preHandler: requireUser }, async (req) => {
    const scope = scopeFor(req.user), { limit, offset } = page(req.query), TV = trackSql(scope);
    // An artist is listed when they have an album or a track the user may see.
    const base = `FROM artists a WHERE EXISTS (SELECT 1 FROM tracks t JOIN albums al ON al.id = t.album_id WHERE (al.artist_id = a.id OR t.artist_id = a.id) AND ${TV})`;
    return {
      total: db.prepare(`SELECT COUNT(*) c ${base}`).get().c,
      items: db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM albums al WHERE al.artist_id = a.id AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND ${TV})) albums,
        (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = a.id AND ${TV}) n ${base} ORDER BY a.name COLLATE NOCASE LIMIT ? OFFSET ?`).all(limit, offset).map(artistOut),
    };
  });
  app.get('/api/music/artists/:id', { preHandler: requireUser }, async (req) => {
    const scope = scopeFor(req.user), TV = trackSql(scope), id = Number(req.params.id);
    const a = db.prepare('SELECT * FROM artists WHERE id = ?').get(id);
    const albums = a ? db.prepare(albumsSql(scope, '(al.artist_id = ? OR al.id IN (SELECT album_id FROM tracks WHERE artist_id = ?))', 'al.year DESC, al.title COLLATE NOCASE')).all(id, id) : [];
    if (!a || !albums.length) throw new HttpError(404, 'Artiest niet gevonden.');
    const top = db.prepare(`SELECT ${TRACK_COLS}, (SELECT COUNT(*) FROM music_plays p WHERE p.track_id = t.id AND p.seconds >= 30) plays FROM ${TRACK_FROM} WHERE t.artist_id = ? AND ${TV} ORDER BY plays DESC, t.id LIMIT 10`).all(id);
    const liked = likedSet(req.user.id);
    return { id: a.id, name: a.name, image: coverUrl('artist', a.id, a.image), bio: a.bio, albums: albums.map(albumOut), topTracks: top.map((t) => trackOut(t, liked)) };
  });

  // ---- albums ----------------------------------------------------------------
  app.get('/api/music/albums', { preHandler: requireUser }, async (req) => {
    const scope = scopeFor(req.user), { limit, offset } = page(req.query);
    const order = { recent: 'al.added_at DESC, al.id DESC', year: 'al.year DESC, al.title COLLATE NOCASE', artist: 'ar.name COLLATE NOCASE, al.year' }[req.query.sort] || 'al.title COLLATE NOCASE';
    const genre = Number(req.query.genre) || 0;
    const where = genre ? `al.id IN (SELECT t2.album_id FROM tracks t2 JOIN track_genres tg ON tg.track_id = t2.id WHERE tg.genre_id = ${Math.trunc(genre)})` : '1';
    const sql = albumsSql(scope, where, order);
    return { total: db.prepare(`SELECT COUNT(*) c FROM (${sql})`).get().c, items: db.prepare(`${sql} LIMIT ? OFFSET ?`).all(limit, offset).map(albumOut) };
  });
  app.get('/api/music/albums/:id', { preHandler: requireUser }, async (req) => {
    const scope = scopeFor(req.user);
    const a = db.prepare(albumsSql(scope, 'al.id = ?')).get(Number(req.params.id));
    if (!a) throw new HttpError(404, 'Album niet gevonden.');
    const liked = likedSet(req.user.id);
    const tracks = db.prepare(`SELECT ${TRACK_COLS} FROM ${TRACK_FROM} WHERE t.album_id = ? AND ${trackSql(scope)} ORDER BY t.disc_no, t.track_no, t.title`).all(a.id).map((t) => trackOut(t, liked));
    return { ...albumOut(a), duration: Math.round(tracks.reduce((s, t) => s + t.duration, 0)), items: tracks,
      genres: db.prepare('SELECT DISTINCT g.id, g.name FROM genres g JOIN track_genres tg ON tg.genre_id = g.id JOIN tracks t ON t.id = tg.track_id WHERE t.album_id = ?').all(a.id) };
  });

  // ---- tracks, genres ---------------------------------------------------------
  app.get('/api/music/tracks', { preHandler: requireUser }, async (req) => {
    const scope = scopeFor(req.user), { limit, offset } = page(req.query), TV = trackSql(scope);
    const order = req.query.sort === 'recent' ? 't.added_at DESC, t.id DESC' : 't.title COLLATE NOCASE';
    const liked = likedSet(req.user.id);
    return { total: db.prepare(`SELECT COUNT(*) c FROM tracks t WHERE ${TV}`).get().c, items: db.prepare(`SELECT ${TRACK_COLS} FROM ${TRACK_FROM} WHERE ${TV} ORDER BY ${order} LIMIT ? OFFSET ?`).all(limit, offset).map((t) => trackOut(t, liked)) };
  });
  app.get('/api/music/genres', { preHandler: requireUser }, async (req) => ({
    items: db.prepare(`SELECT g.id, g.name, COUNT(*) n FROM genres g JOIN track_genres tg ON tg.genre_id = g.id JOIN tracks t ON t.id = tg.track_id WHERE ${trackSql(scopeFor(req.user))} GROUP BY g.id ORDER BY n DESC, g.name`).all().map((g) => ({ id: g.id, name: g.name, tracks: g.n })),
  }));
  app.get('/api/music/genres/:id', { preHandler: requireUser }, async (req) => {
    const scope = scopeFor(req.user), { limit, offset } = page(req.query), id = Number(req.params.id);
    const g = db.prepare('SELECT * FROM genres WHERE id = ?').get(id);
    if (!g) throw new HttpError(404, 'Genre niet gevonden.');
    const liked = likedSet(req.user.id);
    return { id: g.id, name: g.name, items: db.prepare(`SELECT ${TRACK_COLS} FROM ${TRACK_FROM} JOIN track_genres tg ON tg.track_id = t.id WHERE tg.genre_id = ? AND ${trackSql(scope)} ORDER BY ar.name COLLATE NOCASE, al.title, t.disc_no, t.track_no LIMIT ? OFFSET ?`).all(id, limit, offset).map((t) => trackOut(t, liked)) };
  });

  // ---- search ----------------------------------------------------------------
  app.get('/api/music/search', { preHandler: requireUser }, async (req) => {
    const needle = norm(String(req.query.q || '').slice(0, 80));
    if (needle.length < 2) return { artists: [], albums: [], tracks: [], playlists: [] };
    const scope = scopeFor(req.user), TV = trackSql(scope), liked = likedSet(req.user.id);
    const like = `%${needle.replace(/[\\%_]/g, '\\$&')}%`;
    // Artists and albums are few enough to score them all; that is what makes typos work.
    const artists = best(db.prepare(`SELECT a.*, 0 albums, (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = a.id AND ${TV}) n FROM artists a WHERE EXISTS (SELECT 1 FROM tracks t JOIN albums al ON al.id = t.album_id WHERE (al.artist_id = a.id OR t.artist_id = a.id) AND ${TV})`).all(), 'norm', needle, 8);
    const albums = best(db.prepare(albumsSql(scope)).all(), 'norm', needle, 12);
    // Tracks: the index first; only when that finds little, a pass over every title.
    let tracks = db.prepare(`SELECT ${TRACK_COLS}, t.norm FROM ${TRACK_FROM} WHERE (t.norm LIKE ? ESCAPE '\\' OR (ar.norm || ' ' || t.norm) LIKE ? ESCAPE '\\') AND ${TV} LIMIT 300`).all(like, like);
    if (tracks.length < 8) {
      const ids = best(db.prepare(`SELECT t.id, t.norm FROM tracks t WHERE ${TV} LIMIT 150000`).all(), 'norm', needle, 30).map((x) => x.r.id).filter((id) => !tracks.some((t) => t.id === id));
      if (ids.length) tracks = tracks.concat(db.prepare(`SELECT ${TRACK_COLS}, t.norm FROM ${TRACK_FROM} WHERE t.id IN (${ids.join(',')})`).all());
    }
    const scored = tracks.map((t) => ({ t, s: Math.max(matchScore(needle, t.norm), matchScore(needle, `${norm(t.artist)} ${t.norm}`) - 5) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 30);
    const playlists = best(myPlaylists(req.user).map((p) => ({ ...p, norm: norm(p.name) })), 'norm', needle, 8);
    return { artists: artists.map((x) => artistOut(x.r)), albums: albums.map((x) => albumOut(x.r)), tracks: scored.map((x) => trackOut(x.t, liked)), playlists: playlists.map((x) => playlistOut(x.r, req.user, scope)) };
  });

  // ---- likes -----------------------------------------------------------------
  app.get('/api/music/likes', { preHandler: requireUser }, async (req) => {
    const scope = scopeFor(req.user), { limit, offset } = page(req.query), liked = likedSet(req.user.id);
    const ids = db.prepare('SELECT track_id FROM music_likes WHERE user_id = ? ORDER BY at DESC, rowid DESC').all(req.user.id).map((r) => r.track_id);
    const all = tracksByIds(ids, scope, liked);
    return { total: all.length, items: all.slice(offset, offset + limit) };
  });
  app.put('/api/music/likes/:id', { preHandler: requireUser }, async (req) => {
    const t = requireTrack(req.user, req.params.id);
    db.prepare('INSERT OR IGNORE INTO music_likes (user_id, track_id, at) VALUES (?,?,?)').run(req.user.id, t.id, now());
    return { liked: true };
  });
  app.delete('/api/music/likes/:id', { preHandler: requireUser }, async (req) => {
    db.prepare('DELETE FROM music_likes WHERE user_id = ? AND track_id = ?').run(req.user.id, Number(req.params.id));
    return { liked: false };
  });

  // ---- playlists --------------------------------------------------------------
  app.get('/api/music/playlists', { preHandler: requireUser }, async (req) => {
    const scope = scopeFor(req.user), trackId = Number(req.query.track) || 0;
    return { items: myPlaylists(req.user).map((p) => ({ ...playlistOut(p, req.user, scope), ...(trackId && { has: !!db.prepare('SELECT 1 FROM playlist_items WHERE playlist_id = ? AND track_id = ?').get(p.id, trackId) }) })) };
  });
  app.post('/api/music/playlists', { preHandler: requireUser }, async (req) => {
    if (db.prepare('SELECT COUNT(*) c FROM playlists WHERE owner_id = ?').get(req.user.id).c >= 500) throw new HttpError(400, 'Je hebt het maximum aantal playlists bereikt.');
    const id = Number(db.prepare('INSERT INTO playlists (owner_id, name, created_at, updated_at) VALUES (?,?,?,?)').run(req.user.id, playlistName(req.body?.name), now(), now()).lastInsertRowid);
    return { id };
  });
  app.get('/api/music/playlists/:id', { preHandler: requireUser }, async (req) => {
    const a = playlistAccess(req.params.id, req.user), scope = scopeFor(req.user), liked = likedSet(req.user.id);
    const items = db.prepare(`SELECT i.id item_id, ${TRACK_COLS} FROM playlist_items i JOIN tracks t ON t.id = i.track_id JOIN artists ar ON ar.id = t.artist_id JOIN albums al ON al.id = t.album_id WHERE i.playlist_id = ? AND ${trackSql(scope)} ORDER BY i.ord, i.id`).all(a.p.id);
    return { ...playlistOut(a.p, req.user, scope), items: items.map((r) => ({ ...trackOut(r, liked), itemId: r.item_id })),
      shares: a.owner ? db.prepare('SELECT u.id, u.name, s.can_edit FROM playlist_shares s JOIN users u ON u.id = s.user_id WHERE s.playlist_id = ? ORDER BY u.name').all(a.p.id).map((s) => ({ id: s.id, name: s.name, edit: !!s.can_edit })) : undefined };
  });
  app.put('/api/music/playlists/:id', { preHandler: requireUser }, async (req) => {
    const a = playlistAccess(req.params.id, req.user);
    if (!a.owner) throw new HttpError(403, 'Alleen de eigenaar kan de playlist hernoemen.');
    db.prepare('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?').run(playlistName(req.body?.name), now(), a.p.id);
    return { ok: true };
  });
  app.delete('/api/music/playlists/:id', { preHandler: requireUser }, async (req) => {
    const a = playlistAccess(req.params.id, req.user);
    if (a.owner) db.prepare('DELETE FROM playlists WHERE id = ?').run(a.p.id);
    else db.prepare('DELETE FROM playlist_shares WHERE playlist_id = ? AND user_id = ?').run(a.p.id, req.user.id);
    return { ok: true };
  });
  app.post('/api/music/playlists/:id/items', { preHandler: requireUser }, async (req) => {
    const a = playlistAccess(req.params.id, req.user);
    if (!a.edit) throw new HttpError(403, 'Je kunt deze playlist alleen beluisteren.');
    const ids = (Array.isArray(req.body?.trackIds) ? req.body.trackIds : []).map(Number).filter(Number.isInteger).slice(0, 2000);
    const ok = new Set(tracksByIds(ids, scopeFor(req.user)).map((t) => t.id));
    if (!ok.size) throw new HttpError(404, 'Nummer niet gevonden.');
    if (db.prepare('SELECT COUNT(*) c FROM playlist_items WHERE playlist_id = ?').get(a.p.id).c + ok.size > 10000) throw new HttpError(400, 'Deze playlist zit vol.');
    let ord = db.prepare('SELECT COALESCE(MAX(ord), 0) n FROM playlist_items WHERE playlist_id = ?').get(a.p.id).n;
    db.transaction(() => { for (const id of ids) if (ok.has(id)) db.prepare('INSERT INTO playlist_items (playlist_id, track_id, ord, added_at) VALUES (?,?,?,?)').run(a.p.id, id, ++ord, now()); })();
    db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now(), a.p.id);
    return { ok: true, added: ids.filter((id) => ok.has(id)).length };
  });
  app.delete('/api/music/playlists/:id/items/:itemId', { preHandler: requireUser }, async (req) => {
    const a = playlistAccess(req.params.id, req.user);
    if (!a.edit) throw new HttpError(403, 'Je kunt deze playlist alleen beluisteren.');
    db.prepare('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?').run(Number(req.params.itemId), a.p.id);
    db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now(), a.p.id);
    return { ok: true };
  });
  // New order: the item ids as they should play. Items left out keep their place at the end.
  app.put('/api/music/playlists/:id/order', { preHandler: requireUser }, async (req) => {
    const a = playlistAccess(req.params.id, req.user);
    if (!a.edit) throw new HttpError(403, 'Je kunt deze playlist alleen beluisteren.');
    const want = (Array.isArray(req.body?.itemIds) ? req.body.itemIds : []).map(Number).filter(Number.isInteger);
    const have = db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ? ORDER BY ord, id').all(a.p.id).map((r) => r.id);
    const own = new Set(have), order = [...new Set(want.filter((id) => own.has(id)))];
    for (const id of have) if (!order.includes(id)) order.push(id);
    db.transaction(() => { order.forEach((id, i) => db.prepare('UPDATE playlist_items SET ord = ? WHERE id = ?').run(i + 1, id)); })();
    db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now(), a.p.id);
    return { ok: true };
  });
  app.put('/api/music/playlists/:id/shares', { preHandler: requireUser }, async (req) => {
    const a = playlistAccess(req.params.id, req.user);
    if (!a.owner) throw new HttpError(403, 'Alleen de eigenaar kan de playlist delen.');
    const users = Array.isArray(req.body?.users) ? req.body.users : [];
    db.transaction(() => {
      db.prepare('DELETE FROM playlist_shares WHERE playlist_id = ?').run(a.p.id);
      for (const u of users.slice(0, 200)) { const id = Number(u?.id); if (id !== req.user.id && db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) db.prepare('INSERT OR REPLACE INTO playlist_shares (playlist_id, user_id, can_edit) VALUES (?,?,?)').run(a.p.id, id, u.edit ? 1 : 0); }
    })();
    return { ok: true };
  });

  // ---- queue and history ---------------------------------------------------------
  app.get('/api/music/queue', { preHandler: requireUser }, async (req) => {
    const q = db.prepare('SELECT * FROM music_queue WHERE user_id = ?').get(req.user.id);
    if (!q) return { items: [], index: 0, position: 0 };
    const items = tracksByIds(json(q.items, []), scopeFor(req.user), likedSet(req.user.id));
    return { items, index: Math.min(q.idx, Math.max(0, items.length - 1)), position: q.position, updated_at: q.updated_at };
  });
  app.put('/api/music/queue', { preHandler: requireUser }, async (req) => {
    const ids = (Array.isArray(req.body?.trackIds) ? req.body.trackIds : []).map(Number).filter(Number.isInteger).slice(0, 2000);
    db.prepare('INSERT INTO music_queue (user_id, items, idx, position, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET items = excluded.items, idx = excluded.idx, position = excluded.position, updated_at = excluded.updated_at')
      .run(req.user.id, JSON.stringify(ids), Math.max(0, Math.trunc(Number(req.body?.index) || 0)), Math.max(0, Number(req.body?.position) || 0), now());
    return { ok: true };
  });
  app.post('/api/music/plays', { preHandler: requireUser }, async (req) => {
    const t = requireTrack(req.user, req.body?.trackId);
    const seconds = Math.max(0, Math.min(Number(req.body?.seconds) || 0, (t.duration || 3600) + 5));
    if (seconds < 5) return { ok: true, counted: false };
    db.prepare('INSERT INTO music_plays (user_id, track_id, at, seconds) VALUES (?,?,?,?)').run(req.user.id, t.id, now(), seconds);
    for (const fn of playHooks) { try { fn(req.user, t, seconds); } catch (e) { console.error('[muziek-play]', e.message); } }
    return { ok: true, counted: seconds >= 30 };
  });
  app.get('/api/music/history', { preHandler: requireUser }, async (req) => {
    const { limit, offset } = page(req.query), scope = scopeFor(req.user), liked = likedSet(req.user.id);
    const rows = db.prepare('SELECT track_id, at FROM music_plays WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ? OFFSET ?').all(req.user.id, limit, offset);
    const byId = new Map(tracksByIds(rows.map((r) => r.track_id), scope, liked).map((t) => [t.id, t]));
    return { items: rows.filter((r) => byId.has(r.track_id)).map((r) => ({ ...byId.get(r.track_id), playedAt: r.at })) };
  });

  // ---- playback ---------------------------------------------------------------
  app.post('/api/music/tracks/:id/play', { preHandler: requireUser }, async (req) => {
    const t = requireTrack(req.user, req.params.id);
    const r = await playUrl(t, req.body?.quality, req.body?.format);
    return { ...r, trackId: t.id, duration: t.duration, gain: { track: t.rg_track_gain, trackPeak: t.rg_track_peak, album: t.rg_album_gain, albumPeak: t.rg_album_peak } };
  });
  // A whole queue at once, for the apps: one link per track, valid for a day. Nothing is
  // converted or fetched from a linked server until a link is actually opened.
  app.post('/api/music/play', { preHandler: requireUser }, async (req) => {
    const scope = scopeFor(req.user);
    const ids = (Array.isArray(req.body?.trackIds) ? req.body.trackIds : []).map(Number).filter(Number.isInteger).slice(0, 2000);
    if (!ids.length) return { items: [] };
    const q = AUDIO_QUALITIES[req.body?.quality] ? String(req.body.quality) : 'original', f = req.body?.format === 'aac' ? 'aac' : 'opus';
    const rows = new Map(db.prepare(`SELECT t.id, t.peer_id, t.bitrate, t.codec FROM tracks t WHERE t.id IN (${[...new Set(ids)].join(',')}) AND ${trackSql(scope)}`).all().map((t) => [t.id, t]));
    return { items: ids.filter((id) => rows.has(id)).map((id) => {
      const t = rows.get(id);
      const direct = q === 'original' || (!t.peer_id && t.bitrate > 0 && t.bitrate <= Number(q) * 1000 * 1.1 && ['mp3', 'aac', 'opus', 'vorbis'].includes(t.codec));
      return { id, url: `/api/music/stream/${issueTrackTicket(id, 24)}${direct ? '' : `?q=${q}&f=${f}`}` };
    }) };
  });

  // The ticket in the path is the credential: audio players cannot send headers.
  app.get('/api/music/stream/:ticket', async (req, reply) => {
    const id = ticketTrack(req.params.ticket);
    const t = id && db.prepare('SELECT * FROM tracks WHERE id = ?').get(id);
    if (!t) throw new HttpError(403, 'Deze link is verlopen.');
    // A track on a linked server: ask that server for a link and send the player there (through our relay).
    if (t.peer_id) return reply.redirect((await playUrl(t, req.query.q, req.query.f)).url, 302);
    if (AUDIO_QUALITIES[req.query.q]) {
      const f = req.query.f === 'aac' ? 'aac' : 'opus';
      return sendFile(req, reply, await converted(t, req.query.q, f), { type: f === 'aac' ? 'audio/mp4' : 'audio/ogg', download: req.query.download === '1' });
    }
    return sendFile(req, reply, t.path, { type: audioMime(t.path), download: req.query.download === '1' });
  });

  // Covers are public for the same reason posters are: image loaders send no headers.
  const sendCover = async (reply, source) => {
    const file = await coverFile(source);
    let buf; try { buf = file && await fs.promises.readFile(file); } catch { buf = null; }
    if (!buf) return reply.code(404).send({ error: 'Geen afbeelding.' });
    return reply.header('Content-Type', sniff(buf)).header('Cache-Control', 'public, max-age=604800').send(buf);
  };
  app.get('/api/music/cover/album/:id', async (req, reply) => sendCover(reply, db.prepare('SELECT cover FROM albums WHERE id = ?').get(Number(req.params.id))?.cover));
  app.get('/api/music/cover/artist/:id', async (req, reply) => sendCover(reply, db.prepare('SELECT image FROM artists WHERE id = ?').get(Number(req.params.id))?.image));

  // ---- server to server ---------------------------------------------------------
  app.get('/api/federation/music/catalog', { preHandler: requirePeer }, async (req) => ({ tracks: exportMusic(publicUrl(req)) }));
  app.post('/api/federation/music/play', { preHandler: requirePeer }, async (req) => {
    const t = db.prepare('SELECT t.* FROM tracks t JOIN libraries l ON l.id = t.library_id WHERE t.id = ? AND t.peer_id IS NULL AND l.shared = 1').get(Number(req.body?.trackId));
    if (!t) throw new HttpError(404, 'Dit nummer wordt niet (meer) gedeeld.');
    return playUrl(t, req.body?.quality, req.body?.format);
  });
}

const homeRows = [];
/** Extra rows for the music home (mixes, in a later phase): fn(user, scope, liked) -> [{ id, title, kind, items }]. */
export const addHomeRows = (fn) => homeRows.push(fn);
const playHooks = [];
/** Called for every registered play (scrobbling, in a later phase). */
export const onPlay = (fn) => playHooks.push(fn);
