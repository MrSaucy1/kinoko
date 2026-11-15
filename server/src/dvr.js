// Recording live tv. The admin picks a programme from the guide (once, or
// every episode of a series); ffmpeg copies the channel's stream to a file for
// that time, and the result appears in the "Opnames" library.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db, now, json, settings, HttpError } from './db.js';
import { config, dataPath } from './config.js';
import { requireAdmin } from './auth.js';
import { guide } from './iptv.js';
import { scanPath } from './library.js';
import { emit } from './webhooks.js';
import { audit } from './audit.js';

export const PAD_BEFORE = 60, PAD_AFTER = 180;       // start a minute early, run three minutes over
const MAX_LENGTH = 8 * 3600;
export const dvrDir = () => path.resolve(settings.get('dvr_dir', '') || dataPath('recordings'));
const limitBytes = () => Math.max(1, Number(settings.get('dvr_limit_gb', 50)) || 50) * 1024 ** 3;
const keepDays = () => Math.max(0, Number(settings.get('dvr_keep_days', 0)) || 0);

/** A file name that is safe on every file system and still readable. */
export function fileName(title, startAt) {
  const d = new Date(startAt * 1000), p = (n) => String(n).padStart(2, '0');
  const clean = String(title).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/^\.+/, '').trim().slice(0, 80) || 'Opname';
  return `${clean} - ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.mkv`;
}

/** The library the recordings show up in; made the first time something is recorded. */
function ensureLibrary() {
  const dir = dvrDir();
  fs.mkdirSync(dir, { recursive: true });
  const have = db.prepare('SELECT id, paths FROM libraries').all().find((l) => json(l.paths, []).includes(dir));
  if (!have) db.prepare("INSERT INTO libraries (name, type, paths, shared, created_at) VALUES ('Opnames', 'movies', ?, 0, ?)").run(JSON.stringify([dir]), now());
  return dir;
}

export function usage() {
  return db.prepare("SELECT COALESCE(SUM(size), 0) n FROM recordings WHERE status = 'done' AND path IS NOT NULL").get().n;
}
/** Makes room: recordings past their keep time go, then the oldest until the limit fits. Returns how many were removed. */
export function cleanup(extra = 0) {
  let removed = 0;
  const drop = (r) => { try { if (r.path) fs.unlinkSync(r.path); } catch { /* already gone */ } db.prepare('DELETE FROM recordings WHERE id = ?').run(r.id); removed++; };
  const days = keepDays();
  if (days > 0) for (const r of db.prepare("SELECT * FROM recordings WHERE status = 'done' AND end_at < ?").all(now() - days * 86400)) drop(r);
  const limit = limitBytes();
  for (const r of db.prepare("SELECT * FROM recordings WHERE status = 'done' ORDER BY end_at").all()) { if (usage() + extra <= limit) break; drop(r); }
  if (removed) scanPath(dvrDir());
  return removed;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------
export function schedule({ userId = null, channelId, title, start, end, ruleId = null }) {
  const ch = db.prepare('SELECT id, name FROM iptv_channels WHERE id = ?').get(Number(channelId));
  if (!ch) throw new HttpError(404, 'Zender niet gevonden.');
  const s = Math.trunc(Number(start)), e = Math.trunc(Number(end));
  const name = String(title || '').trim().slice(0, 200);
  if (!name) throw new HttpError(400, 'Geef de opname een titel.');
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw new HttpError(400, 'De eindtijd moet na de begintijd liggen.');
  if (e <= now()) throw new HttpError(400, 'Dit programma is al afgelopen.');
  if (e - s > MAX_LENGTH) throw new HttpError(400, 'Een opname kan hooguit acht uur duren.');
  if (db.prepare("SELECT 1 FROM recordings WHERE channel_id = ? AND start_at = ? AND status IN ('scheduled','recording','done')").get(ch.id, s)) throw new HttpError(409, 'Dit programma staat al ingepland.');
  return Number(db.prepare('INSERT INTO recordings (user_id, channel_id, rule_id, channel_name, title, start_at, end_at, created_at) VALUES (?,?,?,?,?,?,?,?)').run(userId, ch.id, ruleId, ch.name, name, s, e, now()).lastInsertRowid);
}

/** Series rules: every programme on the rule's channel whose title contains the text gets scheduled. */
export async function applyRules(fetchGuide = guide) {
  let added = 0;
  for (const rule of db.prepare('SELECT * FROM record_rules').all()) {
    const needle = rule.match.toLowerCase();
    for (const p of await fetchGuide(rule.channel_id, 40)) {
      if (!p.title.toLowerCase().includes(needle) || p.end <= now()) continue;
      try { schedule({ userId: rule.user_id, channelId: rule.channel_id, title: p.title, start: p.start, end: p.end, ruleId: rule.id }); added++; } catch { /* already planned, or too long */ }
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
const running = new Map();   // recording id -> child process

function finish(rec, file, code, stopped) {
  running.delete(rec.id);
  let size = 0; try { size = fs.statSync(file).size; } catch { /* nothing written */ }
  if (size > 0) {
    db.prepare("UPDATE recordings SET status = 'done', size = ?, path = ?, error = ? WHERE id = ?").run(size, file, code === 0 || stopped ? '' : 'De opname is eerder gestopt dan gepland.', rec.id);
    scanPath(path.dirname(file));
    cleanup();
  } else {
    try { fs.unlinkSync(file); } catch { /* no file */ }
    db.prepare("UPDATE recordings SET status = 'failed', error = ? WHERE id = ?").run('De zender gaf geen beeld (abonnement verlopen of te veel gelijktijdige kijkers?).', rec.id);
    emit('error', { text: `Opname mislukt: ${rec.title} (${rec.channel_name})` });
  }
}

export function startRecording(rec) {
  const ch = rec.channel_id && db.prepare('SELECT url FROM iptv_channels WHERE id = ?').get(rec.channel_id);
  if (!ch) { db.prepare("UPDATE recordings SET status = 'failed', error = 'De zender bestaat niet meer.' WHERE id = ?").run(rec.id); return null; }
  const dir = ensureLibrary(), file = path.join(dir, fileName(rec.title, rec.start_at));
  cleanup(0);
  const seconds = Math.max(30, rec.end_at + PAD_AFTER - now());
  // Stream copy: no transcoding, so recording costs almost no CPU.
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
    '-i', ch.url, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-t', String(seconds), '-f', 'matroska', '-y', file];
  const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'ignore'] });
  running.set(rec.id, proc);
  db.prepare("UPDATE recordings SET status = 'recording', path = ? WHERE id = ?").run(file, rec.id);
  let stopped = false;
  proc.stoppedByUs = () => { stopped = true; };
  proc.on('error', () => finish(rec, file, -1, stopped));
  proc.on('close', (code) => { if (running.get(rec.id) === proc) finish(rec, file, code, stopped); });
  return proc;
}

export function stopRecording(id) {
  const proc = running.get(id);
  if (!proc) return false;
  proc.stoppedByUs();
  try { proc.kill('SIGINT'); } catch { /* already gone */ }   // SIGINT lets ffmpeg close the file properly
  return true;
}

/** Called on a timer: starts what is due, gives up on what was missed. */
export function tick() {
  const t = now();
  for (const r of db.prepare("SELECT * FROM recordings WHERE status = 'scheduled' AND start_at - ? <= ?").all(PAD_BEFORE, t)) {
    if (r.end_at <= t) { db.prepare("UPDATE recordings SET status = 'failed', error = 'Gemist: de server stond uit of was bezet.' WHERE id = ?").run(r.id); continue; }
    if (!running.has(r.id)) startRecording(r);
  }
}
/** After a restart: a recording that was running is picked up again if its programme is still on. */
export function resume() {
  for (const r of db.prepare("SELECT * FROM recordings WHERE status = 'recording'").all()) {
    if (running.has(r.id)) continue;
    let size = 0; try { size = fs.statSync(r.path).size; } catch { /* no file */ }
    if (size > 0) db.prepare("UPDATE recordings SET status = 'done', size = ?, error = 'Onderbroken door een herstart van de server.' WHERE id = ?").run(size, r.id);
    else db.prepare("UPDATE recordings SET status = 'failed', error = 'Onderbroken door een herstart van de server.' WHERE id = ?").run(r.id);
  }
}
export function stopAll() { for (const id of [...running.keys()]) stopRecording(id); }

const out = (r) => ({ id: r.id, title: r.title, channel: r.channel_name, channelId: r.channel_id, start: r.start_at, end: r.end_at, status: r.status, size: r.size, error: r.error, series: !!r.rule_id });

export default async function routes(app) {
  app.get('/api/admin/dvr', { preHandler: requireAdmin }, async () => ({
    recordings: db.prepare("SELECT * FROM recordings ORDER BY (status IN ('recording','scheduled')) DESC, start_at DESC LIMIT 300").all().map(out),
    rules: db.prepare('SELECT r.id, r.match, r.channel_id channelId, c.name channel FROM record_rules r JOIN iptv_channels c ON c.id = r.channel_id ORDER BY r.id').all(),
    used: usage(), limitGb: Number(settings.get('dvr_limit_gb', 50)) || 50, keepDays: keepDays(), dir: dvrDir(),
  }));
  // The guide of one channel, to pick a programme from.
  app.get('/api/admin/dvr/guide/:channelId', { preHandler: requireAdmin }, async (req) => ({ programs: (await guide(Number(req.params.channelId), 40)).filter((p) => p.end > now()) }));
  app.get('/api/admin/dvr/channels', { preHandler: requireAdmin }, async (req) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return { channels: [] };
    return { channels: db.prepare("SELECT id, name, category FROM iptv_channels WHERE name LIKE ? ESCAPE '\\' ORDER BY ord LIMIT 40").all(`%${q.replace(/[\\%_]/g, '\\$&')}%`) };
  });

  app.post('/api/admin/dvr', { preHandler: requireAdmin }, async (req) => {
    const b = req.body || {};
    const id = schedule({ userId: req.user.id, channelId: b.channelId, title: b.title, start: b.start, end: b.end });
    audit('settings.change', { user: req.user, ip: req.ip, detail: `Opname ingepland: ${String(b.title).slice(0, 80)}` });
    tick();
    return { id };
  });
  // Cancels a planned recording, stops a running one (what was recorded is kept), or removes a finished one with its file.
  app.delete('/api/admin/dvr/:id', { preHandler: requireAdmin }, async (req) => {
    const r = db.prepare('SELECT * FROM recordings WHERE id = ?').get(Number(req.params.id));
    if (!r) throw new HttpError(404, 'Opname niet gevonden.');
    if (r.status === 'recording') { stopRecording(r.id); return { ok: true, stopped: true }; }
    if (r.status === 'scheduled') db.prepare("UPDATE recordings SET status = 'cancelled' WHERE id = ?").run(r.id);
    else {
      // Only ever a file inside the recordings folder, whatever the row says.
      if (r.path && path.resolve(r.path).startsWith(dvrDir() + path.sep)) { try { fs.unlinkSync(r.path); } catch { /* already gone */ } scanPath(dvrDir()); }
      db.prepare('DELETE FROM recordings WHERE id = ?').run(r.id);
    }
    return { ok: true };
  });

  app.post('/api/admin/dvr/rules', { preHandler: requireAdmin }, async (req) => {
    const match = String(req.body?.match || '').trim().slice(0, 100), channelId = Number(req.body?.channelId);
    if (match.length < 2) throw new HttpError(400, 'Vul (een deel van) de titel in.');
    if (!db.prepare('SELECT 1 FROM iptv_channels WHERE id = ?').get(channelId)) throw new HttpError(404, 'Zender niet gevonden.');
    const id = Number(db.prepare('INSERT INTO record_rules (user_id, channel_id, match, created_at) VALUES (?,?,?,?)').run(req.user.id, channelId, match, now()).lastInsertRowid);
    return { id, scheduled: await applyRules() };
  });
  app.delete('/api/admin/dvr/rules/:id', { preHandler: requireAdmin }, async (req) => {
    db.prepare('DELETE FROM record_rules WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });
  app.put('/api/admin/dvr', { preHandler: requireAdmin }, async (req) => {
    const b = req.body || {};
    if (b.limitGb !== undefined) { const n = Number(b.limitGb); if (!(n >= 1 && n <= 100000)) throw new HttpError(400, 'Kies een limiet tussen 1 en 100000 GB.'); settings.set('dvr_limit_gb', n); }
    if (b.keepDays !== undefined) { const n = Number(b.keepDays); if (!Number.isInteger(n) || n < 0 || n > 3650) throw new HttpError(400, 'Kies een aantal dagen tussen 0 en 3650.'); settings.set('dvr_keep_days', n); }
    if (typeof b.dir === 'string') {
      const dir = b.dir.trim();
      if (dir) { const abs = path.resolve(dir); try { fs.mkdirSync(abs, { recursive: true }); fs.accessSync(abs, fs.constants.W_OK); } catch { throw new HttpError(400, 'In deze map kan Kinoko niet schrijven.'); } settings.set('dvr_dir', abs); }
      else settings.set('dvr_dir', '');
    }
    cleanup();
    return { ok: true };
  });
}
