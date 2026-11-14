// Playback: direct streaming with Range support, and on-demand HLS
// transcoding (hardware accelerated where the box allows it).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db, now, json, randomToken, HttpError, settings } from './db.js';
import { config, dataPath } from './config.js';
import { activeBackend } from './ffmpeg.js';
import { requireUser, requireAdmin, tokenFromRequest, sessionId } from './auth.js';
import { notifyUser } from './events.js';
import { emit } from './webhooks.js';

export const SEG = 4; // seconds per HLS segment
export const QUALITIES = {
  1080: { height: 1080, video: 8_000_000, label: '1080p · 8 Mbps' },
  720: { height: 720, video: 4_000_000, label: '720p · 4 Mbps' },
  480: { height: 480, video: 1_500_000, label: '480p · 1,5 Mbps' },
  360: { height: 360, video: 700_000, label: '360p · 0,7 Mbps' },
};

// ---------------------------------------------------------------------------
// Tickets: an unguessable, expiring handle to one file. Players and download
// managers can't always send headers, so the ticket in the URL is the credential.
// ---------------------------------------------------------------------------
const tickets = new Map();
export function issueTicket(fileId, hours = 12) {
  const t = randomToken(24);
  tickets.set(t, { fileId, expires: Date.now() + hours * 3600_000 });
  return t;
}
/** A ticket for a bonus file (extras table) instead of a library file. */
export function issueExtraTicket(extraId, hours = 12) {
  const t = randomToken(24);
  tickets.set(t, { extraId, expires: Date.now() + hours * 3600_000 });
  return t;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of tickets) if (v.expires < n) tickets.delete(k); }, 600_000).unref();

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.ts': 'video/mp2t' };

export function sendFile(req, reply, file, { download = false, type = null } = {}) {
  let st; try { st = fs.statSync(file); } catch { throw new HttpError(404, 'Bestand niet gevonden op schijf.'); }
  const total = st.size;
  reply.header('Accept-Ranges', 'bytes').header('Content-Type', type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  if (download) reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (start >= total || start > end) return reply.code(416).header('Content-Range', `bytes */${total}`).send();
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${total}`).header('Content-Length', end - start + 1);
    return reply.send(fs.createReadStream(file, { start, end }));
  }
  reply.header('Content-Length', total);
  return reply.send(fs.createReadStream(file));
}

// ---------------------------------------------------------------------------
// HLS transcode sessions
// ---------------------------------------------------------------------------
const sessions = new Map();
const segPath = (s, n) => path.join(s.dir, `${String(n).padStart(5, '0')}.ts`);

/** ffmpeg argument sets to try in order: full hardware → hardware encode → software. */
function pipelines(backend, s) {
  const h = s.height;
  const sw = { name: 'software', pre: [], vf: `scale=-2:${h},format=yuv420p`, enc: ['-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-sc_threshold', '0'] };
  const dev = backend.device || '/dev/dri/renderD128';
  switch (backend.id) {
    case 'vaapi': return [
      { name: 'vaapi', pre: ['-hwaccel', 'vaapi', '-hwaccel_device', dev, '-hwaccel_output_format', 'vaapi'], vf: `scale_vaapi=w=-2:h=${h}:format=nv12`, enc: ['-c:v', 'h264_vaapi'] },
      { name: 'vaapi-encode', pre: ['-vaapi_device', dev], vf: `scale=-2:${h},format=nv12,hwupload`, enc: ['-c:v', 'h264_vaapi'] },
      sw];
    case 'qsv': return [
      { name: 'qsv', pre: ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv'], vf: `scale_qsv=w=-1:h=${h}:format=nv12`, enc: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-forced_idr', '1'] },
      { name: 'qsv-encode', pre: [], vf: `scale=-2:${h},format=nv12`, enc: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-forced_idr', '1'] },
      sw];
    case 'nvenc': return [
      { name: 'nvenc', pre: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'], vf: `scale_cuda=-2:${h}:format=yuv420p`, enc: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-forced-idr', '1'] },
      { name: 'nvenc-encode', pre: [], vf: `scale=-2:${h},format=yuv420p`, enc: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-forced-idr', '1'] },
      sw];
    case 'v4l2m2m': return [{ name: 'v4l2m2m', pre: [], vf: `scale=-2:${h},format=yuv420p`, enc: ['-c:v', 'h264_v4l2m2m'] }, sw];
    default: return [sw];
  }
}

function ffArgs(s, pipe, startSeg) {
  const t = startSeg * SEG;
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...pipe.pre, '-ss', String(t), '-i', s.file,
    '-map', '0:v:0', '-map', `0:a:${s.audio}?`, '-sn', '-dn',
    '-vf', pipe.vf, ...pipe.enc,
    '-b:v', String(s.video), '-maxrate', String(s.video), '-bufsize', String(s.video * 2),
    '-g', '9999', '-force_key_frames', `expr:gte(t,n_forced*${SEG})`,
    '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '160k',
    '-max_muxing_queue_size', '2048', '-output_ts_offset', String(t),
    '-f', 'hls', '-hls_time', String(SEG), '-hls_list_size', '0', '-hls_segment_type', 'mpegts',
    '-hls_flags', 'temp_file+independent_segments', '-start_number', String(startSeg),
    '-hls_segment_filename', path.join(s.dir, '%05d.ts'), path.join(s.dir, 'ff.m3u8'),
  ];
}

function stopProc(s) {
  if (s.proc) { const p = s.proc; s.proc = null; try { p.kill('SIGCONT'); p.kill('SIGKILL'); } catch { /* already gone */ } }
  s.paused = false;
}

async function startProc(s, startSeg) {
  stopProc(s);
  const list = pipelines(await activeBackend(), s);
  const pipe = list[Math.min(s.pipeIndex, list.length - 1)];
  s.pipeline = pipe.name; s.procStart = startSeg; s.head = startSeg - 1; s.exited = false; s.stderr = '';
  const proc = spawn(config.ffmpeg, ffArgs(s, pipe, startSeg), { stdio: ['ignore', 'ignore', 'pipe'] });
  s.proc = proc;
  proc.stderr.on('data', (d) => { if (s.stderr.length < 4000) s.stderr += d; });
  proc.on('error', (e) => { if (s.proc === proc) { s.proc = null; s.exited = true; s.exitCode = -1; s.stderr += String(e); } });
  proc.on('close', (code) => { if (s.proc === proc) { s.proc = null; s.exited = true; s.exitCode = code; } });
}

function advanceHead(s) { while (fs.existsSync(segPath(s, s.head + 1))) s.head++; }

async function ensureSegment(s, n) {
  s.lastAccess = Date.now(); s.lastRequested = n;
  const file = segPath(s, n);
  if (fs.existsSync(file)) return file;
  advanceHead(s);
  const near = (s.proc || s.exited) && n >= s.procStart && n <= s.head + 8;
  if (!near || (!s.proc && !(s.exited && s.exitCode === 0))) await startProc(s, n);
  else if (s.paused) { try { s.proc.kill('SIGCONT'); } catch { /* gone */ } s.paused = false; }
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return file;
    if (s.closed) break;
    if (s.exited && !s.proc) {
      if (fs.existsSync(file)) return file;
      if (s.exitCode === 0) break; // finished cleanly but the segment is past the end
      // The pipeline failed: fall back to the next one (hardware → software).
      const list = pipelines(await activeBackend(), s);
      if (s.pipeIndex < list.length - 1) {
        console.warn(`[transcode] pipeline "${s.pipeline}" faalde, val terug. ${s.stderr.trim().split('\n').slice(-2).join(' | ')}`);
        s.pipeIndex++;
        await startProc(s, n);
        continue;
      }
      throw new HttpError(500, 'Transcoderen is mislukt: ' + (s.stderr.trim().split('\n').pop() || 'onbekende fout'));
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new HttpError(404, 'Segment niet beschikbaar.');
}

export function createHlsSession(file, { quality = 720, audio = 0 } = {}) {
  const q = QUALITIES[quality] || QUALITIES[720];
  const srcH = file.height || q.height;
  const height = Math.max(144, Math.min(q.height, srcH) & ~1);
  const id = randomToken(18);
  const s = {
    id, file: file.path, dir: dataPath('transcode', id), duration: file.duration, height,
    video: Math.round(q.video * Math.min(1, (height / q.height) ** 1.5)), audio: Number(audio) || 0,
    segCount: Math.max(1, Math.ceil(file.duration / SEG)), proc: null, procStart: 0, head: -1, pipeIndex: 0,
    lastAccess: Date.now(), lastRequested: 0, paused: false, exited: false, stderr: '', pipeline: '',
  };
  fs.mkdirSync(s.dir, { recursive: true });
  sessions.set(id, s);
  return s;
}

function playlist(s) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (let i = 0; i < s.segCount; i++) {
    const d = i === s.segCount - 1 ? Math.max(0.1, s.duration - i * SEG) : SEG;
    lines.push(`#EXTINF:${d.toFixed(3)},`, `${String(i).padStart(5, '0')}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

function closeSession(s) {
  s.closed = true;
  stopProc(s);
  sessions.delete(s.id);
  fs.rm(s.dir, { recursive: true, force: true }, () => {});
}

// Housekeeping: pause encoders that run far ahead, stop idle ones, drop dead sessions.
setInterval(() => {
  const t = Date.now();
  for (const s of sessions.values()) {
    const idle = t - s.lastAccess;
    if (idle > 15 * 60_000) { closeSession(s); continue; }
    if (!s.proc) continue;
    if (idle > 90_000) { stopProc(s); continue; }
    advanceHead(s);
    const ahead = s.head - s.lastRequested;
    try {
      if (!s.paused && ahead > 45) { s.proc.kill('SIGSTOP'); s.paused = true; }
      else if (s.paused && ahead < 20) { s.proc.kill('SIGCONT'); s.paused = false; }
    } catch { /* process gone */ }
  }
}, 3000).unref();

export function cleanupTranscodes() {
  for (const s of [...sessions.values()]) closeSession(s);
  try { for (const d of fs.readdirSync(dataPath('transcode'))) fs.rmSync(dataPath('transcode', d), { recursive: true, force: true }); } catch { /* nothing to clean */ }
}

// ---------------------------------------------------------------------------
// Deciding how to play a file
// ---------------------------------------------------------------------------
let remotePlayer = null;
/** federation.js registers how to play a file that lives on a linked server. */
export const setRemotePlayer = (fn) => { remotePlayer = fn; };

function canDirect(file, caps) {
  if (!caps || caps === 'any') return true;
  const has = (list, v) => !Array.isArray(list) || list.includes(v);
  return has(caps.containers, file.container) && has(caps.vcodecs, file.vcodec) && (!file.acodec || has(caps.acodecs, file.acodec));
}

export function markersFor(fileId) {
  const out = {};
  for (const m of db.prepare('SELECT kind, start, end, source FROM markers WHERE file_id = ?').all(fileId)) out[m.kind] = { start: m.start, end: m.end, source: m.source };
  return out;
}

/** Builds the play response for a local file. Paths are relative to this server. */
export function playLocal(file, { quality = 'original', audio = 0, caps = 'any' } = {}) {
  if (!fs.existsSync(file.path)) throw new HttpError(404, 'Het bestand staat niet meer op schijf. Scan de bibliotheek opnieuw.');
  const streams = json(file.streams, { audio: [], subs: [] });
  const base = {
    fileId: file.id, duration: file.duration, markers: markersFor(file.id), audio: streams.audio || [],
    subtitles: db.prepare('SELECT id, lang, label, source FROM subtitles WHERE file_id = ? ORDER BY lang, id').all(file.id)
      .map((s) => ({ id: s.id, lang: s.lang, label: s.label, source: s.source, url: `/api/subs/${s.id}/${issueTicket(file.id)}.vtt` })),
    download: `/api/stream/${issueTicket(file.id, 48)}?download=1`,
  };
  const wantsOriginal = quality === 'original' || !QUALITIES[quality];
  if (wantsOriginal && canDirect(file, caps)) {
    return { ...base, mode: 'direct', quality: 'original', url: `/api/stream/${issueTicket(file.id)}` };
  }
  // "original" on a client that can't play the container/codec: transcode at source size.
  const q = wantsOriginal ? (file.height > 720 ? 1080 : file.height > 480 ? 720 : 480) : Number(quality);
  const s = createHlsSession(file, { quality: q, audio });
  return { ...base, mode: 'hls', quality: String(q), url: `/api/hls/${s.id}/index.m3u8`, sessionId: s.id };
}

// ---------------------------------------------------------------------------
// Per-user quality limit (set by the admin)
// ---------------------------------------------------------------------------
export const limitFor = (user) => (QUALITIES[user?.max_quality] ? Number(user.max_quality) : 0);

/**
 * Applies a user's limit to a play request. The original may still be played
 * when it is itself within the limit; anything above is transcoded down.
 * Returns the request to use and whether the original is off limits.
 */
export function applyLimit(file, body, limit) {
  if (!limit) return { body, capped: false };
  const cap = QUALITIES[limit];
  const fits = file.height > 0 && file.height <= cap.height && file.bitrate > 0 && file.bitrate <= cap.video * 1.25;
  const want = body.quality;
  if (QUALITIES[want] && Number(want) <= limit) return { body, capped: !fits };
  if (fits && (want === undefined || want === 'original' || !QUALITIES[want])) return { body, capped: false };
  return { body: { ...body, quality: String(limit) }, capped: true };
}
/** A capped user gets no link to the original file. */
export const stripOriginal = (play, capped) => { if (capped && play) { delete play.download; play.limited = true; } return play; };

/** Bonus material plays directly when the client can, otherwise as a transcode. */
export function playExtra(x, { caps = 'any' } = {}, limit = 0) {
  if (!fs.existsSync(x.path)) throw new HttpError(404, 'Het bestand staat niet meer op schijf. Scan de bibliotheek opnieuw.');
  const fits = !limit || (x.height > 0 && x.height <= QUALITIES[limit].height);
  if (fits && canDirect(x, caps)) return { mode: 'direct', quality: 'original', duration: x.duration, url: `/api/stream/${issueExtraTicket(x.id)}`, audio: [], subtitles: [], markers: {} };
  const q = limit || (x.height > 720 ? 1080 : x.height > 480 ? 720 : 480);
  const s = createHlsSession(x, { quality: q });
  return { mode: 'hls', quality: String(q), duration: x.duration, url: `/api/hls/${s.id}/index.m3u8`, sessionId: s.id, audio: [], subtitles: [], markers: {} };
}

const announced = new Map();   // "user:title" -> time, so a quality switch is not a new "started watching"
function announcePlayback(user, file) {
  const key = `${user.id}:${file.title_id}:${file.episode_id || 0}`;
  if (Date.now() - (announced.get(key) || 0) < 15 * 60_000) return;
  announced.set(key, Date.now());
  if (announced.size > 500) for (const [k, v] of announced) if (Date.now() - v > 15 * 60_000) announced.delete(k);
  const t = db.prepare('SELECT title FROM titles WHERE id = ?').get(file.title_id);
  const e = file.episode_id ? db.prepare('SELECT season, episode FROM episodes WHERE id = ?').get(file.episode_id) : null;
  if (t) emit('playback.started', { text: `${user.name} kijkt ${t.title}${e ? ` (S${e.season}A${e.episode})` : ''}`, fields: { user: user.name, title: t.title, season: e?.season, episode: e?.episode } });
}

export default async function routes(app) {
  app.get('/api/stream/:ticket', async (req, reply) => {
    const t = tickets.get(req.params.ticket);
    if (!t || t.expires < Date.now()) throw new HttpError(403, 'Deze link is verlopen.');
    const file = t.extraId ? db.prepare('SELECT path FROM extras WHERE id = ?').get(t.extraId)
      : db.prepare('SELECT path FROM files WHERE id = ? AND peer_id IS NULL').get(t.fileId);
    if (!file) throw new HttpError(404, 'Bestand niet gevonden.');
    return sendFile(req, reply, file.path, { download: req.query.download === '1' });
  });

  app.get('/api/hls/:id/index.m3u8', async (req, reply) => {
    const s = sessions.get(req.params.id);
    if (!s) throw new HttpError(404, 'Afspeelsessie verlopen.');
    s.lastAccess = Date.now();
    return reply.header('Content-Type', 'application/vnd.apple.mpegurl').header('Cache-Control', 'no-store').send(playlist(s));
  });
  app.get('/api/hls/:id/:seg.ts', async (req, reply) => {
    const s = sessions.get(req.params.id);
    if (!s) throw new HttpError(404, 'Afspeelsessie verlopen.');
    const n = Number(req.params.seg);
    if (!Number.isInteger(n) || n < 0 || n >= s.segCount) throw new HttpError(404, 'Segment bestaat niet.');
    const file = await ensureSegment(s, n);
    return reply.header('Content-Type', 'video/mp2t').header('Cache-Control', 'no-store').send(fs.createReadStream(file));
  });
  app.delete('/api/hls/:id', async (req) => {
    const s = sessions.get(req.params.id);
    if (s) closeSession(s);
    return { ok: true };
  });

  app.post('/api/play', { preHandler: requireUser }, async (req) => {
    const body = req.body || {};
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(body.fileId));
    if (!file) throw new HttpError(404, 'Deze versie bestaat niet meer.');
    const lim = applyLimit(file, body, limitFor(req.user));
    let play;
    if (file.peer_id) {
      if (!remotePlayer) throw new HttpError(500, 'Gekoppelde servers zijn niet beschikbaar.');
      play = await remotePlayer(file, lim.body);
    } else play = playLocal(file, lim.body);
    announcePlayback(req.user, file);
    const off = db.prepare('SELECT offset_ms FROM sub_offsets WHERE user_id = ? AND file_id = ?').get(req.user.id, file.id);
    return { ...stripOriginal(play, lim.capped), subOffsetMs: off ? off.offset_ms : 0 };
  });

  app.post('/api/extras/:id/play', { preHandler: requireUser }, async (req) => {
    const x = db.prepare('SELECT * FROM extras WHERE id = ?').get(Number(req.params.id));
    if (!x) throw new HttpError(404, 'Dit extra bestaat niet meer.');
    return playExtra(x, req.body || {}, limitFor(req.user));
  });

  // Subtitle timing correction, remembered per user and file.
  app.put('/api/files/:id/sub-offset', { preHandler: requireUser }, async (req) => {
    const fileId = Number(req.params.id), ms = Math.round(Number(req.body?.offsetMs));
    if (!db.prepare('SELECT 1 FROM files WHERE id = ?').get(fileId)) throw new HttpError(404, 'Deze versie bestaat niet meer.');
    if (!Number.isFinite(ms) || Math.abs(ms) > 600_000) throw new HttpError(400, 'Ongeldige verschuiving.');
    if (ms === 0) db.prepare('DELETE FROM sub_offsets WHERE user_id = ? AND file_id = ?').run(req.user.id, fileId);
    else db.prepare('INSERT INTO sub_offsets (user_id, file_id, offset_ms) VALUES (?,?,?) ON CONFLICT(user_id, file_id) DO UPDATE SET offset_ms = excluded.offset_ms').run(req.user.id, fileId, ms);
    return { offsetMs: ms };
  });

  app.post('/api/progress', { preHandler: requireUser }, async (req) => {
    const { titleId, episodeId = 0, position = 0, duration = 0, watched, paused } = req.body || {};
    if (!db.prepare('SELECT 1 FROM titles WHERE id = ?').get(Number(titleId))) throw new HttpError(404, 'Titel niet gevonden.');
    const key = [req.user.id, Number(titleId), Number(episodeId) || 0];
    const prev = db.prepare('SELECT watched FROM progress WHERE user_id = ? AND title_id = ? AND episode_id = ?').get(...key);
    // Explicit true/false marks (un)watched; otherwise it follows the position.
    const finished = watched === true || (watched === undefined && duration > 0 && position / duration > 0.92);
    const flag = watched === false ? 0 : finished ? 1 : (prev ? prev.watched : 0);
    const pos = finished || watched === false ? 0 : Number(position) || 0;
    db.prepare(`INSERT INTO progress (user_id, title_id, episode_id, position, duration, watched, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(user_id, title_id, episode_id) DO UPDATE SET position = excluded.position, duration = excluded.duration,
      watched = excluded.watched, updated_at = excluded.updated_at`).run(...key, pos, Number(duration) || 0, flag, now());
    // Paused here: offer to continue on the user's other open devices.
    if (paused === true && !flag && pos > 30) {
      const t = db.prepare('SELECT id, kind, title FROM titles WHERE id = ?').get(Number(titleId));
      const e = key[2] ? db.prepare('SELECT season, episode FROM episodes WHERE id = ?').get(key[2]) : null;
      notifyUser(req.user.id, { t: 'resume', titleId: t.id, kind: t.kind, title: t.title, episodeId: key[2], season: e?.season, episode: e?.episode, position: pos },
        { exceptSession: sessionId(tokenFromRequest(req) || '') });
    }
    return { ok: true, watched: !!flag };
  });

  app.get('/api/admin/transcoding', { preHandler: requireAdmin }, async () => {
    const { detectHardware } = await import('./ffmpeg.js');
    return {
      hardware: await detectHardware(), choice: settings.get('hwaccel', 'auto'), active: (await activeBackend()).id,
      sessions: [...sessions.values()].map((s) => ({ id: s.id.slice(0, 6), file: path.basename(s.file), height: s.height, pipeline: s.pipeline, running: !!s.proc, paused: s.paused })),
    };
  });
  app.put('/api/admin/transcoding', { preHandler: requireAdmin }, async (req) => {
    const { choice, redetect } = req.body || {};
    const { detectHardware, HW_BACKENDS } = await import('./ffmpeg.js');
    if (choice) {
      if (!['auto', 'none', ...Object.keys(HW_BACKENDS)].includes(choice)) throw new HttpError(400, 'Onbekende keuze.');
      settings.set('hwaccel', choice);
    }
    if (redetect) await detectHardware(true);
    return { ok: true };
  });
}
