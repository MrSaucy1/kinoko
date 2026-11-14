// Seek previews: sheets of small thumbnails (one every 10 seconds, 100 per
// sheet) made in the background after a scan, at the lowest CPU priority.
// Per library on or off; off by default.
import fs from 'node:fs';
import path from 'node:path';
import { db, json, HttpError } from './db.js';
import { config, dataPath } from './config.js';
import { run, ffmpegAvailable } from './ffmpeg.js';
import { onScanFinished, onTrickplayEnabled } from './library.js';
import { ticketFile } from './stream.js';

export const TRICK = { interval: 10, width: 240, cols: 10, rows: 10 };
export const trickState = { running: false, done: 0, total: 0 };
const dirOf = (fileId) => dataPath('trickplay', String(fileId));

/** What a player needs to show the right thumbnail for a position. */
export function trickInfo(file, base) {
  const t = file.trickplay && file.trickplay !== 'none' ? json(file.trickplay, null) : null;
  return t ? { ...t, base } : null;
}

export async function generate(file) {
  const dir = dirOf(file.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const ratio = file.width > 0 && file.height > 0 ? file.height / file.width : 9 / 16;
  const height = Math.max(2, Math.round((TRICK.width * ratio) / 2) * 2);
  // Only keyframes are decoded, which makes this minutes instead of hours for a long film.
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-skip_frame', 'nokey', '-i', file.path, '-an', '-sn', '-dn',
    '-vf', `fps=1/${TRICK.interval},scale=${TRICK.width}:${height},tile=${TRICK.cols}x${TRICK.rows}`, '-q:v', '6', path.join(dir, '%03d.jpg')];
  let r = await run('nice', ['-n', '19', config.ffmpeg, ...args], { timeout: 45 * 60_000 });
  if (r.code === -1) r = await run(config.ffmpeg, args, { timeout: 45 * 60_000 });   // no `nice` on this system
  const sheets = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^\d{3}\.jpg$/.test(n)).length : 0;
  if (r.code !== 0 || !sheets) {
    fs.rmSync(dir, { recursive: true, force: true });
    db.prepare("UPDATE files SET trickplay = 'none' WHERE id = ?").run(file.id);
    return null;
  }
  const info = { interval: TRICK.interval, width: TRICK.width, height, cols: TRICK.cols, rows: TRICK.rows, count: Math.max(1, Math.ceil((file.duration || 0) / TRICK.interval)), sheets };
  db.prepare('UPDATE files SET trickplay = ? WHERE id = ?').run(JSON.stringify(info), file.id);
  return info;
}

/** Works through every file that still needs previews, one at a time. */
export async function generatePending() {
  if (trickState.running || !(await ffmpegAvailable())) return;
  const rows = db.prepare('SELECT f.* FROM files f JOIN libraries l ON l.id = f.library_id WHERE f.peer_id IS NULL AND l.trickplay = 1 AND f.trickplay IS NULL ORDER BY f.added_at DESC').all();
  Object.assign(trickState, { running: true, done: 0, total: rows.length });
  try {
    for (const f of rows) {
      // The library may have been switched off, or the file removed, while we were busy.
      if (db.prepare('SELECT 1 FROM files f JOIN libraries l ON l.id = f.library_id WHERE f.id = ? AND l.trickplay = 1').get(f.id)) {
        try { await generate(f); } catch (e) { console.error('[trickplay]', path.basename(f.path), e.message); }
      }
      trickState.done++;
    }
    // Sheets of files that no longer exist are removed.
    const alive = new Set(db.prepare('SELECT id FROM files WHERE trickplay IS NOT NULL').all().map((r) => String(r.id)));
    try { for (const d of fs.readdirSync(dataPath('trickplay'))) if (!alive.has(d)) fs.rmSync(dataPath('trickplay', d), { recursive: true, force: true }); } catch { /* nothing there */ }
  } finally { trickState.running = false; }
}

// Not awaited by the scan: previews may take a long time and are never urgent.
const kick = () => { generatePending().catch((e) => console.error('[trickplay]', e.message)); };
onScanFinished(kick);
onTrickplayEnabled(kick);

export default async function routes(app) {
  // Same ticket as the stream: whoever may play the file may see its previews.
  app.get('/api/trickplay/:ticket/:n.jpg', async (req, reply) => {
    const fileId = ticketFile(req.params.ticket);
    const n = Number(req.params.n);
    if (!fileId || !Number.isInteger(n) || n < 1 || n > 999) throw new HttpError(404, 'Niet gevonden.');
    const file = path.join(dirOf(fileId), `${String(n).padStart(3, '0')}.jpg`);
    if (!fs.existsSync(file)) throw new HttpError(404, 'Niet gevonden.');
    return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'private, max-age=86400').send(fs.createReadStream(file));
  });
}
