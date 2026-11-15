// Archiving with yt-dlp: the admin adds channels or playlists (YouTube,
// podcasts, …) and Kinoko fetches what is new now and then, into libraries of
// its own. yt-dlp itself is installed and updated through the root helper.
import fs from 'node:fs';
import path from 'node:path';
import { db, now, json, settings, HttpError } from './db.js';
import { config, dataPath } from './config.js';
import { run, which } from './ffmpeg.js';
import { requireAdmin } from './auth.js';
import { scanPath } from './library.js';
import { helper } from './remote.js';
import { audit } from './audit.js';
import { emit } from './webhooks.js';

export const archiveDir = (kind) => path.join(path.resolve(settings.get('archive_dir', '') || dataPath('archive')), kind === 'audio' ? 'audio' : 'video');
const ytdlp = () => (path.isAbsolute(config.ytdlp) ? (fs.existsSync(config.ytdlp) ? config.ytdlp : null) : (which(config.ytdlp) ? config.ytdlp : null));

/** Only a plain https address ever reaches yt-dlp; anything else (options, files, other schemes) is refused here. */
export function cleanUrl(raw) {
  const s = String(raw || '').trim();
  let u; try { u = new URL(s); } catch { throw new HttpError(400, 'Vul een volledig adres in dat begint met https://'); }
  if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) throw new HttpError(400, 'Vul een volledig adres in dat begint met https://');
  if (/[\s\u0000-\u001f]/.test(s) || s.length > 500) throw new HttpError(400, 'Dit adres is niet geldig.');
  return u.href;
}

/** The arguments for one run. Everything fixed is ours; the address comes last, after "--". */
export function ytdlpArgs(source) {
  const dir = archiveDir(source.kind);
  const common = ['--ignore-config', '--no-progress', '--no-colors', '--ignore-errors', '--no-overwrites', '--restrict-filenames', '--no-exec',
    '--download-archive', path.join(dir, '.gedownload.txt'), '--playlist-end', String(Math.max(1, Math.min(200, source.max_items || 20))),
    '--write-info-json', '--no-write-playlist-metafiles', '--write-thumbnail', '--convert-thumbnails', 'jpg', '--ffmpeg-location', path.dirname(config.ffmpeg) === '.' ? config.ffmpeg : path.dirname(config.ffmpeg)];
  const kind = source.kind === 'audio'
    ? ['-f', 'bestaudio/best', '-x', '--embed-metadata', '--embed-thumbnail', '--parse-metadata', '%(playlist_title,uploader)s:%(album)s', '-o', path.join(dir, '%(uploader,channel|Onbekend)s', '%(playlist_title,uploader|Losse afleveringen)s', '%(title)s.%(ext)s')]
    : ['-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mkv', '-o', path.join(dir, '%(uploader,channel|Onbekend)s', '%(title)s (%(upload_date>%Y|0000)s)', '%(title)s.%(ext)s')];
  return [...common, ...kind, '--', source.url];
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/**
 * yt-dlp leaves a .info.json and a thumbnail next to every video. They become
 * a movie.nfo and a poster.jpg, which is what the scanner reads, marked so no
 * film database is asked about a YouTube video.
 */
export function writeSidecars(dir) {
  let made = 0;
  const walk = (d) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.info.json')) continue;
      const nfo = path.join(d, 'movie.nfo');
      if (fs.existsSync(nfo)) continue;
      let info; try { info = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
      const year = /^\d{4}/.test(String(info.upload_date || '')) ? String(info.upload_date).slice(0, 4) : '';
      fs.writeFileSync(nfo, `<?xml version="1.0" encoding="UTF-8"?>\n<movie>\n  <kinoko>local</kinoko>\n  <title>${esc(info.title)}</title>\n  ${year ? `<year>${year}</year>\n  ` : ''}<plot>${esc(String(info.description || '').slice(0, 4000))}</plot>\n  <director>${esc(info.uploader || info.channel || '')}</director>\n  <genre>${esc(info.extractor_key || 'Archief')}</genre>\n</movie>\n`);
      const thumb = path.join(d, e.name.replace(/\.info\.json$/, '.jpg'));
      if (fs.existsSync(thumb) && !fs.existsSync(path.join(d, 'poster.jpg'))) fs.copyFileSync(thumb, path.join(d, 'poster.jpg'));
      made++;
    }
  };
  walk(dir);
  return made;
}

function ensureLibrary(kind) {
  const dir = archiveDir(kind);
  fs.mkdirSync(dir, { recursive: true });
  if (!db.prepare('SELECT id, paths FROM libraries').all().some((l) => json(l.paths, []).includes(dir))) {
    db.prepare('INSERT INTO libraries (name, type, paths, shared, created_at) VALUES (?,?,?,0,?)').run(kind === 'audio' ? 'Archief (audio)' : 'Archief', kind === 'audio' ? 'music' : 'movies', JSON.stringify([dir]), now());
  }
  return dir;
}

export const archiveState = { running: false, source: '', done: 0, total: 0 };
const count = (dir) => { let n = 0; const walk = (d) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (/\.(mkv|mp4|webm|opus|m4a|mp3|ogg)$/i.test(e.name)) n++; } } catch { /* unreadable */ } }; walk(dir); return n; };

export async function fetchSource(source) {
  const bin = ytdlp();
  if (!bin) throw new HttpError(501, 'yt-dlp is niet geïnstalleerd. Installeer het eerst (knop hierboven).');
  const dir = ensureLibrary(source.kind), before = count(dir);
  const r = await run(bin, ytdlpArgs(source), { timeout: 2 * 3600_000 });
  const added = count(dir) - before;
  if (source.kind === 'video') writeSidecars(dir);
  // With --ignore-errors a run that fetched something but tripped over one item still counts.
  const error = r.code === 0 || added > 0 ? '' : (r.stderr.trim().split('\n').filter((l) => /ERROR/.test(l)).pop() || 'yt-dlp gaf een fout.').replace(/^ERROR:\s*/, '').slice(0, 300);
  db.prepare('UPDATE archive_sources SET last_run = ?, last_error = ?, items = items + ? WHERE id = ?').run(now(), error, Math.max(0, added), source.id);
  if (added > 0) scanPath(dir);
  if (error) emit('error', { text: `Archiveren van "${source.name}" is mislukt: ${error}` });
  return { added, error };
}

export async function fetchAll() {
  if (archiveState.running) return false;
  const sources = db.prepare('SELECT * FROM archive_sources ORDER BY id').all();
  Object.assign(archiveState, { running: true, done: 0, total: sources.length });
  try {
    for (const s of sources) { archiveState.source = s.name; try { await fetchSource(s); } catch (e) { db.prepare('UPDATE archive_sources SET last_run = ?, last_error = ? WHERE id = ?').run(now(), String(e.message).slice(0, 300), s.id); } archiveState.done++; }
  } finally { Object.assign(archiveState, { running: false, source: '' }); }
  return true;
}
/** Called on a timer: fetches when the last round is long enough ago. */
export function fetchIfDue() {
  const hours = Math.max(1, Number(settings.get('archive_hours', 12)) || 12);
  if (!db.prepare('SELECT 1 FROM archive_sources LIMIT 1').get() || now() - Number(settings.get('archive_last', 0)) < hours * 3600) return;
  settings.set('archive_last', now());
  fetchAll().catch((e) => console.error('[archief]', e.message));
}

export default async function routes(app) {
  app.get('/api/admin/archive', { preHandler: requireAdmin }, async () => {
    const bin = ytdlp();
    let version = null;
    if (bin) { const r = await run(bin, ['--version'], { timeout: 15_000 }); if (r.code === 0) version = r.stdout.trim().slice(0, 40); }
    return { installed: !!bin, version, helper: fs.existsSync(config.helper), state: archiveState, hours: Number(settings.get('archive_hours', 12)) || 12, dir: path.dirname(archiveDir('video')),
      sources: db.prepare('SELECT id, name, url, kind, max_items maxItems, last_run lastRun, last_error lastError, items FROM archive_sources ORDER BY id').all() };
  });
  app.post('/api/admin/archive/ytdlp', { preHandler: requireAdmin }, async (req) => {
    const out = await helper([req.body?.update === true ? 'ytdlp-update' : 'ytdlp-install'], 300_000);
    audit('settings.change', { user: req.user, ip: req.ip, detail: `yt-dlp geïnstalleerd/bijgewerkt (${out.split('\n').pop()})` });
    return { version: out.split('\n').pop() };
  });
  app.post('/api/admin/archive', { preHandler: requireAdmin }, async (req) => {
    const b = req.body || {}, url = cleanUrl(b.url);
    const name = String(b.name || '').trim().slice(0, 80) || new URL(url).hostname;
    const kind = b.kind === 'audio' ? 'audio' : 'video';
    const max = Math.max(1, Math.min(200, Math.trunc(Number(b.maxItems) || 20)));
    if (db.prepare('SELECT 1 FROM archive_sources WHERE url = ?').get(url)) throw new HttpError(409, 'Dit adres staat er al in.');
    const id = Number(db.prepare('INSERT INTO archive_sources (name, url, kind, max_items, created_at) VALUES (?,?,?,?,?)').run(name, url, kind, max, now()).lastInsertRowid);
    audit('settings.change', { user: req.user, ip: req.ip, detail: `Archiefbron toegevoegd: ${name}` });
    return { id };
  });
  app.delete('/api/admin/archive/:id', { preHandler: requireAdmin }, async (req) => {
    // What was already fetched stays in the library; only the subscription ends.
    db.prepare('DELETE FROM archive_sources WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });
  app.post('/api/admin/archive/run', { preHandler: requireAdmin }, async () => {
    if (!ytdlp()) throw new HttpError(501, 'yt-dlp is niet geïnstalleerd. Installeer het eerst.');
    settings.set('archive_last', now());
    fetchAll().catch((e) => console.error('[archief]', e.message));
    return { started: true };
  });
  app.put('/api/admin/archive', { preHandler: requireAdmin }, async (req) => {
    const h = Number(req.body?.hours);
    if (!Number.isInteger(h) || h < 1 || h > 720) throw new HttpError(400, 'Kies een aantal uren tussen 1 en 720.');
    settings.set('archive_hours', h);
    return { ok: true };
  });
}
