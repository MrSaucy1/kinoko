// What is being watched right now, for the admin dashboard: who, what, how
// (direct or transcode), on which device and how far. Plus the load on the box.
import os from 'node:os';
import fs from 'node:fs';
import { db, randomToken, HttpError } from './db.js';
import { requireAdmin, sessionId } from './auth.js';
import { notifyUser } from './events.js';
import { run, which } from './ffmpeg.js';
import { audit } from './audit.js';

const plays = new Map();          // id -> stream
const STALE = 5 * 60_000;         // no sign of life for this long: gone
let stopper = () => {};
/** stream.js registers how to really cut a stream (close the transcode, revoke its links). */
export const setStopper = (fn) => { stopper = fn; };

/** Called when a play response is handed out. One stream per user + device + title. */
export function trackPlay(user, token, file, play, tickets = []) {
  const session = sessionId(token || '');
  for (const [id, p] of plays) if (p.userId === user.id && p.session === session) { stopper(p, false); plays.delete(id); }
  const t = db.prepare('SELECT title, kind FROM titles WHERE id = ?').get(file.title_id);
  const e = file.episode_id ? db.prepare('SELECT season, episode FROM episodes WHERE id = ?').get(file.episode_id) : null;
  const dev = db.prepare('SELECT device FROM sessions WHERE token = ?').get(token || '');
  const id = randomToken(9);
  plays.set(id, {
    id, userId: user.id, user: user.name, session, device: dev?.device || '', titleId: file.title_id, episodeId: file.episode_id || 0,
    title: t ? t.title : '', episode: e ? `S${e.season} A${e.episode}` : '', mode: play.mode, quality: play.quality, remote: !!file.peer_id,
    height: file.height, bitrate: file.bitrate, hlsId: play.sessionId || null, tickets, position: 0, duration: file.duration || 0,
    paused: false, startedAt: Date.now(), lastSeen: Date.now(),
  });
  return id;
}

/** Called on every progress report. */
export function touchPlay(userId, token, titleId, episodeId, position, duration, paused) {
  const session = sessionId(token || '');
  for (const p of plays.values()) {
    if (p.userId === userId && p.session === session && p.titleId === titleId && p.episodeId === (episodeId || 0)) {
      Object.assign(p, { position: Number(position) || 0, duration: Number(duration) || p.duration, paused: paused === true, lastSeen: Date.now() });
    }
  }
}

export function activeStreams() {
  const t = Date.now();
  for (const [id, p] of plays) if (t - p.lastSeen > STALE) plays.delete(id);
  return [...plays.values()].map(({ tickets, session, userId, hlsId, ...p }) => ({ ...p, transcoding: !!hlsId, idleSeconds: Math.round((t - p.lastSeen) / 1000) }));
}

export function stopStream(id, message) {
  const p = plays.get(id);
  if (!p) return false;
  stopper(p, true);
  plays.delete(id);
  // Only the device that was playing hears about it.
  notifyUser(p.userId, { t: 'stopped', titleId: p.titleId, message: message || 'De beheerder heeft deze stream gestopt.' }, { onlySession: p.session });
  return p;
}

// ---- load ---------------------------------------------------------------------
let lastCpu = null, cpuPercent = null;
function sampleCpu() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle; }
  if (lastCpu && total > lastCpu.total) cpuPercent = Math.round(100 * (1 - (idle - lastCpu.idle) / (total - lastCpu.total)));
  lastCpu = { idle, total };
}
sampleCpu();
setInterval(sampleCpu, 3000).unref();

/** GPU use where the system tells us; null when it does not. */
async function gpuPercent() {
  try {
    for (const card of fs.readdirSync('/sys/class/drm').filter((n) => /^card\d+$/.test(n))) {
      const f = `/sys/class/drm/${card}/device/gpu_busy_percent`;   // AMD
      if (fs.existsSync(f)) return Number(fs.readFileSync(f, 'utf8').trim());
    }
  } catch { /* no drm */ }
  if (which('nvidia-smi')) {
    const r = await run('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 4000 });
    const n = Number(r.stdout.trim().split('\n')[0]);
    if (r.code === 0 && Number.isFinite(n)) return n;
  }
  return null;
}

export default async function routes(app) {
  app.get('/api/admin/activity', { preHandler: requireAdmin }, async () => {
    const { transcodeSessions } = await import('./stream.js');
    return {
      streams: activeStreams(), transcodes: transcodeSessions(),
      system: { cpu: cpuPercent, cores: os.cpus().length, load: os.loadavg().map((n) => Math.round(n * 100) / 100), memUsed: os.totalmem() - os.freemem(), memTotal: os.totalmem(), gpu: await gpuPercent() },
    };
  });
  app.post('/api/admin/activity/:id/stop', { preHandler: requireAdmin }, async (req) => {
    const p = stopStream(String(req.params.id), String(req.body?.message || '').trim().slice(0, 200));
    if (!p) throw new HttpError(404, 'Deze stream loopt niet meer.');
    audit('stream.stop', { user: req.user, ip: req.ip, detail: `${p.user}: ${p.title}` });
    return { ok: true };
  });
}
