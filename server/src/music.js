// Music: scanning tagged audio files into artists, albums and tracks, and
// streaming them — the original with Range support, or converted to Opus/AAC.
// The API for browsing lives in musicapi.js.
import fs from 'node:fs';
import path from 'node:path';
import { db, now, json, sha256, randomToken, settings, HttpError } from './db.js';
import { config, dataPath } from './config.js';
import { run } from './ffmpeg.js';
import { registerScanner } from './library.js';

export const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.wma', '.aiff', '.aif', '.ape', '.wv', '.dsf', '.alac']);
const COVER_NAMES = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'front.jpg', 'front.png', 'album.jpg', 'albumart.jpg', 'cover.jpeg', 'folder.jpeg'];
const VARIOUS = 'Diverse artiesten', UNKNOWN_ARTIST = 'Onbekende artiest', UNKNOWN_ALBUM = 'Onbekend album';

/** Name → key for matching: lower case, no accents, no punctuation. */
export const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// ---------------------------------------------------------------------------
// Reading tags
// ---------------------------------------------------------------------------
const firstInt = (v) => { const m = String(v ?? '').match(/\d+/); return m ? Number(m[0]) : 0; };
const gain = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) && Math.abs(n) < 60 ? n : null; };
// Opus files carry R128 gain: Q7.8 dB relative to -23 LUFS; ReplayGain's reference is 5 dB louder.
const r128 = (v) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) / 256 + 5 : null);
const uuid = (v) => { const m = String(v ?? '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); return m ? m[0].toLowerCase() : null; };

/** Turns ffprobe's JSON for one audio file into the fields we store. Pure, so it can be tested without files. */
export function readTags(probe, file) {
  const streams = probe.streams || [];
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!a) return null;
  // Tags sit on the container for most formats and on the stream for Ogg/Opus; keys vary in case.
  const tags = {};
  for (const src of [a.tags || {}, probe.format?.tags || {}]) for (const [k, v] of Object.entries(src)) tags[k.toLowerCase().replace(/[\s_]/g, '')] = String(v);
  const t = (...keys) => { for (const k of keys) if (tags[k] && tags[k].trim()) return tags[k].trim(); return ''; };
  const base = path.basename(file, path.extname(file));
  const dir = path.basename(path.dirname(file)), up = path.basename(path.dirname(path.dirname(file)));
  const fromName = base.replace(/^\s*(?:\d{1,2}[-.]\d{1,3}|\d{1,3})\s*[-._ ]\s*/, '').replace(/_/g, ' ').trim() || base;
  const artist = t('artist', 'albumartist', 'album_artist') || (up && !/^(music|muziek)$/i.test(up) ? up : UNKNOWN_ARTIST);
  let albumArtist = t('albumartist', 'album_artist') || artist;
  if (/^(various artists?|various|va|diverse artiesten)$/i.test(albumArtist) || t('compilation') === '1') albumArtist = VARIOUS;
  const duration = Number(probe.format?.duration) || Number(a.duration) || 0;
  let bitrate = Number(a.bit_rate) || Number(probe.format?.bit_rate) || 0;
  if (!bitrate && duration > 0 && Number(probe.format?.size) > 0) bitrate = Math.round(Number(probe.format.size) * 8 / duration);
  const year = Number((t('date', 'year', 'originaldate', 'originalyear').match(/\d{4}/) || [])[0]) || null;
  return {
    title: t('title') || fromName, artist, albumArtist, album: t('album') || (dir || UNKNOWN_ALBUM),
    trackNo: firstInt(t('track', 'tracknumber')) || firstInt((base.match(/^\s*(?:\d{1,2}[-.])?(\d{1,3})\b/) || [])[1]), discNo: firstInt(t('disc', 'discnumber')) || 1,
    year, genres: [...new Set(t('genre').split(/\s*[;/|,]\s*|\s*\\\\\s*/).map((g) => g.trim()).filter((g) => g && g.length <= 40))].slice(0, 6),
    duration, bitrate, codec: a.codec_name || '', sampleRate: Number(a.sample_rate) || 0, channels: a.channels || 2,
    container: (probe.format?.format_name || '').split(',')[0] || path.extname(file).slice(1),
    explicit: /^(1|explicit|yes|true)$/i.test(t('itunesadvisory', 'explicit', 'rtng')) ? 1 : 0,
    mbTrack: uuid(t('musicbrainzreleasetrackid', 'musicbrainztrackid')), mbAlbum: uuid(t('musicbrainzalbumid')), mbArtist: uuid(t('musicbrainzartistid')), mbAlbumArtist: uuid(t('musicbrainzalbumartistid')),
    rgTrackGain: t('replaygaintrackgain') ? gain(t('replaygaintrackgain')) : r128(tags.r128trackgain), rgTrackPeak: gain(t('replaygaintrackpeak')),
    rgAlbumGain: t('replaygainalbumgain') ? gain(t('replaygainalbumgain')) : r128(tags.r128albumgain), rgAlbumPeak: gain(t('replaygainalbumpeak')),
    hasCover: streams.some((s) => s.codec_type === 'video' && s.disposition?.attached_pic) ? 1 : 0,
    lyrics: t('lyrics', 'unsyncedlyrics', 'lyrics-eng', 'lyricseng') || '',
  };
}

export async function probeAudio(file) {
  const r = await run(config.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 30_000 });
  if (r.code !== 0) return null;
  try { return readTags(JSON.parse(r.stdout), file); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Artists and albums
// ---------------------------------------------------------------------------
export function artistId(name, mbid = null) {
  const n = String(name || '').trim().slice(0, 200) || UNKNOWN_ARTIST, key = norm(n) || n.toLowerCase();
  const row = db.prepare('SELECT id, mbid FROM artists WHERE norm = ?').get(key);
  if (row) { if (mbid && !row.mbid) db.prepare('UPDATE artists SET mbid = ? WHERE id = ?').run(mbid, row.id); return row.id; }
  return Number(db.prepare('INSERT INTO artists (name, norm, mbid) VALUES (?,?,?)').run(n, key, mbid).lastInsertRowid);
}
export function albumId(title, artist, { year = null, mbid = null, cover = null } = {}) {
  const t = String(title || '').trim().slice(0, 300) || UNKNOWN_ALBUM, key = norm(t) || t.toLowerCase();
  const row = db.prepare('SELECT * FROM albums WHERE artist_id = ? AND norm = ?').get(artist, key);
  if (row) {
    if ((year && !row.year) || (mbid && !row.mbid) || (cover && !row.cover)) db.prepare('UPDATE albums SET year = COALESCE(year, ?), mbid = COALESCE(mbid, ?), cover = COALESCE(cover, ?) WHERE id = ?').run(year, mbid, cover, row.id);
    return row.id;
  }
  const id = Number(db.prepare('INSERT INTO albums (title, norm, artist_id, year, mbid, cover, added_at) VALUES (?,?,?,?,?,?,?)').run(t, key, artist, year, mbid, cover, now()).lastInsertRowid);
  db.prepare('INSERT OR IGNORE INTO album_artists (album_id, artist_id) VALUES (?,?)').run(id, artist);
  return id;
}
function setGenres(trackId, names) {
  db.prepare('DELETE FROM track_genres WHERE track_id = ?').run(trackId);
  for (const g of names) {
    db.prepare('INSERT OR IGNORE INTO genres (name) VALUES (?)').run(g);
    db.prepare('INSERT OR IGNORE INTO track_genres (track_id, genre_id) SELECT ?, id FROM genres WHERE name = ?').run(trackId, g);
  }
}
/** Albums, artists and genres that nothing points at any more. */
export function pruneMusic() {
  db.prepare('DELETE FROM albums WHERE id NOT IN (SELECT album_id FROM tracks)').run();
  db.prepare('DELETE FROM artists WHERE id NOT IN (SELECT artist_id FROM tracks) AND id NOT IN (SELECT artist_id FROM albums)').run();
  db.prepare('DELETE FROM genres WHERE id NOT IN (SELECT genre_id FROM track_genres)').run();
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------
export const musicState = { running: false, done: 0, total: 0 };
const afterMusicScan = [];
/** Background work that follows a music scan (online metadata, loudness). */
export const onMusicScanned = (fn) => afterMusicScan.push(fn);

async function walk(dir, out) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || /^(@eadir|#recycle|lost\+found)$/i.test(e.name)) continue;
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory(), isFile = e.isFile();
    if (e.isSymbolicLink()) { try { const st = await fs.promises.stat(full); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; } }
    if (isDir) await walk(full, out);
    else if (isFile && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
}
const coverIn = (dir) => { for (const n of COVER_NAMES) { const p = path.join(dir, n); if (fs.existsSync(p)) return `file:${p}`; } try { const any = fs.readdirSync(dir).find((n) => COVER_NAMES.includes(n.toLowerCase())); if (any) return `file:${path.join(dir, any)}`; } catch { /* unreadable */ } return null; };

export async function scanMusicLibrary(lib, only = null, state = null) {
  const roots = json(lib.paths, []);
  const found = [];
  for (const root of roots) { if (only && only !== root && !only.startsWith(root + path.sep)) continue; await walk(only || root, found); }
  const reachable = roots.filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
  if (state) { state.library = lib.name; state.total += found.length; }
  const existing = new Map(db.prepare('SELECT id, path, size, mtime FROM tracks WHERE peer_id IS NULL AND library_id = ?').all(lib.id).filter((r) => !only || r.path.startsWith(only + path.sep)).map((r) => [r.path, r]));
  const seen = new Set(), dirCover = new Map();
  for (const file of found) {
    seen.add(file);
    if (state) state.done++;
    let st; try { st = await fs.promises.stat(file); } catch { continue; }
    const prev = existing.get(file), mtime = Math.floor(st.mtimeMs / 1000);
    if (prev && prev.size === st.size && prev.mtime === mtime) continue;
    const t = await probeAudio(file);
    if (!t) continue;   // not audio after all, or unreadable
    const dir = path.dirname(file);
    if (!dirCover.has(dir)) dirCover.set(dir, coverIn(dir));
    const cover = dirCover.get(dir) || (t.hasCover ? `embedded:${file}` : null);
    const artist = artistId(t.artist, t.mbArtist), albumArtist = t.albumArtist === t.artist ? artist : artistId(t.albumArtist, t.mbAlbumArtist);
    const album = albumId(t.album, albumArtist, { year: t.year, mbid: t.mbAlbum, cover });
    const cols = {
      library_id: lib.id, album_id: album, artist_id: artist, title: t.title.slice(0, 300), norm: norm(t.title), track_no: t.trackNo, disc_no: t.discNo, duration: t.duration, path: file, size: st.size, mtime,
      codec: t.codec, container: t.container, bitrate: t.bitrate, sample_rate: t.sampleRate, channels: t.channels, year: t.year, explicit: t.explicit, mb_track_id: t.mbTrack,
      rg_track_gain: t.rgTrackGain, rg_track_peak: t.rgTrackPeak, rg_album_gain: t.rgAlbumGain, rg_album_peak: t.rgAlbumPeak, has_cover: t.hasCover,
    };
    let id;
    if (prev) {
      id = prev.id;
      db.prepare(`UPDATE tracks SET album_id=@album_id, artist_id=@artist_id, title=@title, norm=@norm, track_no=@track_no, disc_no=@disc_no, duration=@duration, size=@size, mtime=@mtime, codec=@codec, container=@container,
        bitrate=@bitrate, sample_rate=@sample_rate, channels=@channels, year=@year, explicit=@explicit, mb_track_id=@mb_track_id, rg_track_gain=COALESCE(@rg_track_gain, rg_track_gain), rg_track_peak=COALESCE(@rg_track_peak, rg_track_peak),
        rg_album_gain=COALESCE(@rg_album_gain, rg_album_gain), rg_album_peak=COALESCE(@rg_album_peak, rg_album_peak), has_cover=@has_cover WHERE id=@id`).run((({ library_id, path: _p, ...rest }) => ({ ...rest, id }))(cols));
    } else {
      id = Number(db.prepare(`INSERT INTO tracks (library_id, album_id, artist_id, title, norm, track_no, disc_no, duration, path, size, mtime, codec, container, bitrate, sample_rate, channels, year, explicit, mb_track_id,
        rg_track_gain, rg_track_peak, rg_album_gain, rg_album_peak, has_cover, added_at) VALUES (@library_id, @album_id, @artist_id, @title, @norm, @track_no, @disc_no, @duration, @path, @size, @mtime, @codec, @container, @bitrate,
        @sample_rate, @channels, @year, @explicit, @mb_track_id, @rg_track_gain, @rg_track_peak, @rg_album_gain, @rg_album_peak, @has_cover, @added_at)`).run({ ...cols, added_at: now() }).lastInsertRowid);
    }
    setGenres(id, t.genres);
    if (t.lyrics) embeddedLyrics.set(id, t.lyrics);
  }
  for (const [p, row] of existing) {
    if (seen.has(p)) continue;
    // Same rule as for films: an unreachable share must not wipe what we know.
    if (reachable.some((r) => p.startsWith(r + path.sep)) || !roots.some((r) => p.startsWith(r + path.sep))) db.prepare('DELETE FROM tracks WHERE id = ?').run(row.id);
  }
  pruneMusic();
  for (const fn of afterMusicScan) { try { fn(lib); } catch (e) { console.error('[muziek]', e.message); } }
}
/** Lyrics found in tags during a scan; picked up by the lyrics module (a later phase) and otherwise ignored. */
export const embeddedLyrics = new Map();
registerScanner('music', scanMusicLibrary);

// ---------------------------------------------------------------------------
// Covers
// ---------------------------------------------------------------------------
/** Resolves a cover source to a file on disk, extracting embedded art on first use. */
export async function coverFile(source) {
  if (!source) return null;
  if (source.startsWith('embedded:')) {
    const src = source.slice(9), out = dataPath('music', `cover-${sha256(src).slice(0, 24)}.jpg`);
    if (fs.existsSync(out)) return out;
    const r = await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', src, '-an', '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=min(800\\,iw):-2', '-q:v', '3', '-y', out], { timeout: 30_000 });
    return r.code === 0 && fs.existsSync(out) ? out : null;
  }
  const { cachedImage } = await import('./metadata.js');
  const img = await cachedImage(source);
  return img ? img.file : null;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------
export const AUDIO_QUALITIES = { 320: 320, 160: 160, 96: 96 };
const AUDIO_MIME = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.wma': 'audio/x-ms-wma' };
export const audioMime = (file) => AUDIO_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

const tickets = new Map();
export function issueTrackTicket(trackId, hours = 12) { const t = randomToken(24); tickets.set(t, { trackId, expires: Date.now() + hours * 3600_000 }); return t; }
export function ticketTrack(ticket) { const t = tickets.get(ticket); return t && t.expires > Date.now() ? t.trackId : null; }
setInterval(() => { const n = Date.now(); for (const [k, v] of tickets) if (v.expires < n) tickets.delete(k); }, 600_000).unref();

const converting = new Map();
/**
 * A converted copy of a track (Opus in Ogg, or AAC in MP4), made once and kept
 * in a cache. Being a real file, it can be served with Range requests, so
 * seeking is instant. Returns the path, or throws.
 */
export async function converted(track, quality, format = 'opus') {
  const kbps = AUDIO_QUALITIES[quality];
  if (!kbps) throw new HttpError(400, 'Onbekende kwaliteit.');
  const fmt = format === 'aac' ? 'aac' : 'opus';
  const out = dataPath('music', `t${track.id}-${track.mtime}-${kbps}.${fmt === 'aac' ? 'm4a' : 'ogg'}`);
  if (fs.existsSync(out)) { const t = new Date(); fs.utimes(out, t, t, () => {}); return out; }
  if (!converting.has(out)) {
    converting.set(out, (async () => {
      const tmp = `${out}.part`;
      const codec = fmt === 'aac' ? ['-c:a', 'aac', '-b:a', `${kbps}k`, '-movflags', '+faststart', '-f', 'mp4'] : ['-c:a', 'libopus', '-b:a', `${kbps}k`, '-vbr', 'on', '-f', 'ogg'];
      const r = await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', track.path, '-vn', '-sn', '-dn', '-map', '0:a:0', '-map_metadata', '-1', '-ac', '2', ...codec, '-y', tmp], { timeout: 10 * 60_000 });
      if (r.code !== 0 || !fs.existsSync(tmp)) { fs.rm(tmp, { force: true }, () => {}); throw new HttpError(500, 'Omzetten van dit nummer is mislukt.'); }
      fs.renameSync(tmp, out);
      return out;
    })().finally(() => converting.delete(out)));
  }
  return converting.get(out);
}

/** Keeps the cache of converted tracks under its size limit: least recently used go first. */
export function trimMusicCache(limitBytes = Number(settings.get('music_cache_mb', 2048)) * 1024 * 1024) {
  let files;
  try { files = fs.readdirSync(dataPath('music')).filter((n) => /^t\d+-\d+-\d+\.(ogg|m4a)$/.test(n)).map((n) => { const st = fs.statSync(dataPath('music', n)); return { n, size: st.size, at: st.mtimeMs }; }); } catch { return 0; }
  let total = files.reduce((s, f) => s + f.size, 0), removed = 0;
  for (const f of files.sort((a, b) => a.at - b.at)) { if (total <= limitBytes) break; try { fs.unlinkSync(dataPath('music', f.n)); total -= f.size; removed++; } catch { /* in use */ } }
  return removed;
}
setInterval(() => trimMusicCache(), 3600_000).unref();
