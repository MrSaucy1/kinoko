// Intro and credits markers.
//  1. Chapter names in the file ("Intro", "Opening", "Credits", ...).
//  2. Audio fingerprints: episodes of one season share their intro/outro
//     music, so the longest stretch two episodes have in common is the intro
//     (start of the file) or the credits (end of the file).
//  3. Credits fallback: the final seconds, so "next episode" always appears.
import { db, json, HttpError } from './db.js';
import { config } from './config.js';
import { run, detectHardware } from './ffmpeg.js';
import { onScanFinished } from './library.js';
import { requireAdmin } from './auth.js';

const INTRO_RE = /^(intro|opening|op|opening credits|title sequence|generiek|leader)\b/i;
const CREDITS_RE = /^(credits|end credits|ending|ed|outro|closing|aftiteling|eindcredits)\b/i;
const POINT = 1365 / 11025; // seconds per chromaprint point at ffmpeg's defaults (~0.124 s)

const put = db.prepare('INSERT INTO markers (file_id, kind, start, end, source) VALUES (?,?,?,?,?) ON CONFLICT(file_id, kind) DO UPDATE SET start = excluded.start, end = excluded.end, source = excluded.source WHERE markers.source != \'manual\' OR excluded.source = \'manual\'');

function fromChapters(file) {
  const chapters = json(file.streams, {}).chapters || [];
  let found = 0;
  for (const c of chapters) {
    const len = c.end - c.start;
    if (INTRO_RE.test(c.title.trim()) && len >= 5 && len <= 300 && c.start < file.duration * 0.5) { put.run(file.id, 'intro', c.start, c.end, 'chapter'); found |= 1; }
    else if (CREDITS_RE.test(c.title.trim()) && c.start > file.duration * 0.5) { put.run(file.id, 'credits', c.start, file.duration, 'chapter'); found |= 2; }
  }
  return found;
}

async function fingerprint(file, start, length) {
  const r = await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(start), '-t', String(length), '-i', file.path,
    '-map', '0:a:0', '-ac', '1', '-ar', '11025', '-f', 'chromaprint', '-fp_format', 'raw', '-'], { timeout: 180_000, binary: true });
  if (r.code !== 0 || r.stdout.length < 400) return null;
  const buf = r.stdout;
  return new Uint32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)).slice();
}

function popcount(x) { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; }

/**
 * Longest stretch that fingerprints `a` and `b` have in common, allowing the
 * stretch to sit at a different offset in each. Returns point indexes.
 *
 * A point "hits" when the two fingerprints differ in at most `maxBits` bits.
 * Steady sound (room tone, rain, silence) produces scattered chance hits, so a
 * stretch only counts while a sliding window of ~2 s stays almost all hits.
 */
export function longestCommon(a, b, { maxBits = 5, window = 16, density = 0.8 } = {}) {
  let best = null;
  const need = Math.ceil(window * density);
  const hitsBuf = new Uint8Array(Math.max(a.length, b.length));
  for (let shift = -(b.length - 1); shift < a.length; shift++) {
    const from = Math.max(0, shift), to = Math.min(a.length, b.length + shift);
    if (to - from < window) continue;
    let inWindow = 0, runStart = -1;
    for (let i = from; i < to; i++) {
      const hit = popcount(a[i] ^ b[i - shift]) <= maxBits ? 1 : 0;
      hitsBuf[i] = hit; inWindow += hit;
      if (i - from >= window) inWindow -= hitsBuf[i - window];
      const good = i - from >= window - 1 && inWindow >= need;
      if (good && runStart < 0) runStart = i - window + 1;
      if ((!good || i === to - 1) && runStart >= 0) {
        let end = good ? i : i - 1;
        // The window lets a few chance hits in at both edges; trim to where hits are solid.
        const solid = (k) => hitsBuf[k] + hitsBuf[k + 1] + hitsBuf[k + 2] + hitsBuf[k + 3] >= 4;
        while (end - runStart > window && !solid(runStart)) runStart++;
        while (end - runStart > window && !solid(end - 3)) end--;
        const len = end - runStart + 1;
        if (!best || len > best.len) best = { aStart: runStart, bStart: runStart - shift, len };
        runStart = -1;
      }
    }
  }
  return best;
}

async function fingerprintSeason(files) {
  const INTRO_WINDOW = 600, OUTRO_WINDOW = 420;
  const fps = [];
  for (const f of files) {
    const introLen = Math.min(INTRO_WINDOW, f.duration * 0.4);
    const outroStart = Math.max(f.duration * 0.6, f.duration - OUTRO_WINDOW);
    fps.push({
      f,
      intro: f.needIntro ? await fingerprint(f, 0, introLen) : null,
      outro: f.needCredits ? await fingerprint(f, outroStart, f.duration - outroStart) : null,
      outroStart,
    });
  }
  for (let i = 0; i < fps.length; i++) {
    const cur = fps[i];
    for (const kind of ['intro', 'outro']) {
      if (!cur[kind]) continue;
      let best = null;
      // Compare with neighbours; the longest sensible match wins.
      for (const j of [i + 1, i - 1, i + 2, i - 2]) {
        const other = fps[j];
        if (!other) continue;
        const otherFp = other[kind] || (other.f[kind === 'intro' ? 'needIntro' : 'needCredits'] ? null : await fingerprint(other.f, kind === 'intro' ? 0 : other.outroStart, kind === 'intro' ? Math.min(INTRO_WINDOW, other.f.duration * 0.4) : other.f.duration - other.outroStart));
        if (!otherFp) continue;
        other[kind] = other[kind] || otherFp;
        const m = longestCommon(cur[kind], otherFp);
        if (m && (!best || m.len > best.len)) best = m;
        if (best && best.len * POINT >= 20) break;
      }
      if (!best) continue;
      const seconds = best.len * POINT;
      if (kind === 'intro') {
        if (seconds >= 12 && seconds <= 200) put.run(cur.f.id, 'intro', Math.max(0, best.aStart * POINT), best.aStart * POINT + seconds, 'audio');
      } else if (seconds >= 8) {
        put.run(cur.f.id, 'credits', cur.outroStart + best.aStart * POINT, cur.f.duration, 'audio');
      }
    }
  }
}

export const markerState = { running: false, done: 0, total: 0 };

export async function detectPending() {
  if (markerState.running) return;
  const pending = db.prepare(`SELECT f.*, e.season, e.episode, t.kind FROM files f JOIN titles t ON t.id = f.title_id LEFT JOIN episodes e ON e.id = f.episode_id
    WHERE f.peer_id IS NULL AND f.markers_done = 0 AND f.duration > 0 ORDER BY f.title_id, e.season, e.episode`).all();
  Object.assign(markerState, { running: true, done: 0, total: pending.length });
  try {
    const hw = await detectHardware();
    const seasons = new Map();
    for (const f of pending) {
      const found = fromChapters(f);
      f.needIntro = !(found & 1); f.needCredits = !(found & 2);
      if (f.kind === 'show' && (f.needIntro || f.needCredits)) {
        const key = `${f.title_id}:${f.season}`;
        if (!seasons.has(key)) seasons.set(key, true);
      }
    }
    if (hw.chromaprint && settings_fingerprint()) {
      for (const key of seasons.keys()) {
        const [titleId, season] = key.split(':').map(Number);
        // One file per episode (the best local one), the whole season so new episodes have neighbours.
        const all = db.prepare(`SELECT f.*, e.episode FROM files f JOIN episodes e ON e.id = f.episode_id
          WHERE f.title_id = ? AND e.season = ? AND f.peer_id IS NULL AND f.duration > 120 GROUP BY e.id ORDER BY e.episode`).all(titleId, season);
        if (all.length < 2) continue;
        const todo = new Map(pending.map((p) => [p.id, p]));
        for (const f of all) { const p = todo.get(f.id); f.needIntro = p ? p.needIntro : false; f.needCredits = p ? p.needCredits : false; }
        try { await fingerprintSeason(all); } catch (e) { console.error('[markers]', key, e.message); }
      }
    }
    const done = db.prepare('UPDATE files SET markers_done = 1 WHERE id = ?');
    for (const f of pending) {
      // Episodes always get a credits marker so "next episode" can count down.
      if (f.kind === 'show' && !db.prepare("SELECT 1 FROM markers WHERE file_id = ? AND kind = 'credits'").get(f.id)) {
        put.run(f.id, 'credits', Math.max(0, f.duration - Math.min(40, f.duration * 0.05)), f.duration, 'default');
      }
      done.run(f.id); markerState.done++;
    }
  } finally { markerState.running = false; }
}

function settings_fingerprint() { return db.prepare("SELECT value FROM settings WHERE key = 'fingerprint'").get()?.value !== 'false'; }

onScanFinished(async (state) => { state.phase = 'intro-detectie'; await detectPending(); });

export default async function routes(app) {
  app.get('/api/admin/markers', { preHandler: requireAdmin }, async () => ({
    state: markerState,
    chromaprint: !!(await detectHardware()).chromaprint,
    counts: db.prepare('SELECT kind, source, COUNT(*) n FROM markers GROUP BY kind, source').all(),
  }));
  app.post('/api/admin/markers/redetect', { preHandler: requireAdmin }, async () => {
    db.prepare("DELETE FROM markers WHERE source != 'manual'").run();
    db.prepare('UPDATE files SET markers_done = 0 WHERE peer_id IS NULL').run();
    detectPending();
    return { started: true };
  });
  // Manual markers; with season=true the same times apply to every episode of that season.
  app.put('/api/admin/files/:id/markers', { preHandler: requireAdmin }, async (req) => {
    const file = db.prepare('SELECT f.*, e.season FROM files f LEFT JOIN episodes e ON e.id = f.episode_id WHERE f.id = ? AND f.peer_id IS NULL').get(req.params.id);
    if (!file) throw new HttpError(404, 'Bestand niet gevonden.');
    const { kind, start, end, season } = req.body || {};
    if (!['intro', 'credits'].includes(kind) || !(Number(start) >= 0) || !(Number(end) > Number(start))) throw new HttpError(400, 'Ongeldige tijden.');
    const targets = season && file.episode_id
      ? db.prepare('SELECT f.id, f.duration FROM files f JOIN episodes e ON e.id = f.episode_id WHERE f.title_id = ? AND e.season = ? AND f.peer_id IS NULL').all(file.title_id, file.season)
      : [file];
    // Credits are stored relative to the end, so a season-wide value fits episodes of different lengths.
    const fromEnd = file.duration - Number(start);
    for (const f of targets) {
      if (kind === 'credits') put.run(f.id, kind, Math.max(0, f.duration - fromEnd), f.duration, 'manual');
      else put.run(f.id, kind, Number(start), Number(end), 'manual');
    }
    return { ok: true, files: targets.length };
  });
}
