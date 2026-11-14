// Libraries, the title model and the scanner.
import fs from 'node:fs';
import path from 'node:path';
import { db, now, json, HttpError } from './db.js';
import { probe, ffmpegAvailable } from './ffmpeg.js';
import { VIDEO_EXT, parseMovie, parseEpisode, normKey } from './parse.js';
import { requireAdmin } from './auth.js';
import { emit } from './webhooks.js';

const SKIP_DIRS = /^(sample|samples|\..*|@eadir|#recycle|lost\+found)$/i;
// Bonus material: lives in one of these folders, or carries one of these
// suffixes ("Film-trailer.mkv"). It is shown on the title's page, never as a title.
const EXTRA_DIRS = [
  [/^trailers?$/i, 'trailer'], [/^featurettes?$/i, 'featurette'], [/^behind[ ._-]?the[ ._-]?scenes$/i, 'behind'],
  [/^deleted[ ._-]?scenes?$/i, 'deleted'], [/^interviews?$/i, 'interview'], [/^(extras?|specials?|shorts?|scenes?|other|bonus)$/i, 'extra'],
];
const EXTRA_SUFFIX = /[-_. ](trailer|featurette|behindthescenes|deleted|interview|scene|short|other|extra)$/i;
const SUFFIX_KIND = { trailer: 'trailer', featurette: 'featurette', behindthescenes: 'behind', deleted: 'deleted', interview: 'interview' };
export const EXTRA_LABEL = { trailer: 'Trailer', featurette: 'Featurette', behind: 'Achter de schermen', deleted: 'Verwijderde scène', interview: 'Interview', extra: 'Extra' };
const extraDirKind = (name) => { for (const [re, kind] of EXTRA_DIRS) if (re.test(name)) return kind; return null; };

/** Is this file bonus material? Returns { kind, name, base } or null. `inExtraDir` = kind of the enclosing extras folder. */
export function classifyExtra(file, inExtraDir = null) {
  const stem = path.basename(file, path.extname(file));
  const m = stem.match(EXTRA_SUFFIX);
  if (inExtraDir) return { kind: m ? (SUFFIX_KIND[m[1].toLowerCase()] || inExtraDir) : inExtraDir, name: (m ? stem.slice(0, m.index) : stem).replace(/[._]/g, ' ').trim() || stem, main: null };
  if (m && stem.slice(0, m.index).trim()) return { kind: SUFFIX_KIND[m[1].toLowerCase()] || 'extra', name: EXTRA_LABEL[SUFFIX_KIND[m[1].toLowerCase()] || 'extra'], main: stem.slice(0, m.index) };
  return null;
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

/**
 * Finds the title a file belongs to, or creates it. Matching goes by IMDb id
 * first and falls back to the normalised name, so the same film arriving from
 * the local disk and from a linked server ends up as one title.
 */
export function findOrCreateTitle({ kind, title, year = null, imdb_id = null }) {
  if (imdb_id) {
    const byImdb = db.prepare('SELECT * FROM titles WHERE kind = ? AND imdb_id = ?').get(kind, imdb_id);
    if (byImdb) return byImdb;
  }
  // Shows are keyed without a year: folder names rarely carry one consistently.
  const key = kind === 'show' ? normKey(title, null) : normKey(title, year);
  let row = db.prepare('SELECT * FROM titles WHERE kind = ? AND norm_key = ? AND (imdb_id IS NULL OR ? IS NULL OR imdb_id = ?)').get(kind, key, imdb_id, imdb_id);
  if (!row && kind === 'movie' && !year) {
    const rows = db.prepare("SELECT * FROM titles WHERE kind = 'movie' AND norm_key LIKE ? ESCAPE '\\'").all(key.replace(/[\\%_]/g, '\\$&') + '|%');
    if (rows.length === 1) row = rows[0];
  }
  if (row) return row;
  const info = db.prepare('INSERT INTO titles (kind, title, year, norm_key, imdb_id, added_at) VALUES (?,?,?,?,?,?)')
    .run(kind, title, year, key, imdb_id, now());
  return db.prepare('SELECT * FROM titles WHERE id = ?').get(info.lastInsertRowid);
}

export function findOrCreateEpisode(titleId, season, episode, name = '') {
  db.prepare('INSERT INTO episodes (title_id, season, episode, name) VALUES (?,?,?,?) ON CONFLICT(title_id, season, episode) DO NOTHING')
    .run(titleId, season, episode, name);
  return db.prepare('SELECT * FROM episodes WHERE title_id = ? AND season = ? AND episode = ?').get(titleId, season, episode);
}

/** Folds title `fromId` into `intoId` (same film discovered twice). */
export const mergeTitles = db.transaction((fromId, intoId) => {
  if (fromId === intoId) return;
  for (const ep of db.prepare('SELECT * FROM episodes WHERE title_id = ?').all(fromId)) {
    const target = findOrCreateEpisode(intoId, ep.season, ep.episode, ep.name);
    db.prepare('UPDATE files SET episode_id = ?, title_id = ? WHERE episode_id = ?').run(target.id, intoId, ep.id);
    db.prepare('UPDATE OR IGNORE progress SET episode_id = ?, title_id = ? WHERE episode_id = ? AND title_id = ?').run(target.id, intoId, ep.id, fromId);
  }
  db.prepare('UPDATE files SET title_id = ? WHERE title_id = ?').run(intoId, fromId);
  db.prepare('UPDATE OR IGNORE progress SET title_id = ? WHERE title_id = ?').run(intoId, fromId);
  db.prepare('UPDATE OR IGNORE mylist SET title_id = ? WHERE title_id = ?').run(intoId, fromId);
  db.prepare('DELETE FROM titles WHERE id = ?').run(fromId);
});

/** Removes episodes and titles that no longer have a single file behind them. */
export function pruneOrphans() {
  db.prepare('DELETE FROM episodes WHERE id NOT IN (SELECT episode_id FROM files WHERE episode_id IS NOT NULL)').run();
  db.prepare('DELETE FROM titles WHERE id NOT IN (SELECT title_id FROM files)').run();
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export const scanState = { running: false, phase: 'idle', library: '', done: 0, total: 0, startedAt: 0, finishedAt: 0, error: null };
const afterScan = [];
/** Other modules (metadata, markers, collections) hook in here. */
export const onScanFinished = (fn) => afterScan.push(fn);

async function walk(dir, out, extras = [], extraKind = null, extraBase = null) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory(), isFile = e.isFile();
    if (e.isSymbolicLink()) {
      try { const st = await fs.promises.stat(full); isDir = st.isDirectory(); isFile = st.isFile(); } catch { continue; }
    }
    if (isDir) {
      if (SKIP_DIRS.test(e.name)) continue;
      const kind = extraKind || extraDirKind(e.name);
      // `base` is the folder the extras belong to: the one that holds the Extras folder.
      await walk(full, out, extras, kind, kind ? (extraBase || dir) : null);
    } else if (isFile && VIDEO_EXT.has(path.extname(e.name).toLowerCase()) && !/[\s._-]sample\./i.test(e.name) && !e.name.startsWith('.')) {
      let x = classifyExtra(full, extraKind);
      // A suffix alone proves nothing ("The Other.mkv" is a film): the main file must sit next to it.
      if (x && x.main && !entries.some((o) => o.name !== e.name && VIDEO_EXT.has(path.extname(o.name).toLowerCase()) && path.basename(o.name, path.extname(o.name)) === x.main)) x = null;
      if (x) extras.push({ file: full, ...x, base: extraBase || dir });
      else out.push(full);
    }
  }
}

/** Links bonus files to the title they sit next to. Runs after the main files of the library are in. */
async function scanExtras(lib, roots, found) {
  const like = (dir) => dir.replace(/[\\%_]/g, '\\$&') + path.sep + '%';
  const existing = new Map(db.prepare('SELECT id, path, size, mtime FROM extras WHERE library_id = ?').all(lib.id).map((r) => [r.path, r]));
  const seen = new Set();
  for (const x of found) {
    let st; try { st = await fs.promises.stat(x.file); } catch { continue; }
    const mtime = Math.floor(st.mtimeMs / 1000);
    let titleId = null;
    if (x.main) {
      // "Film-trailer.mkv" next to "Film.mkv".
      const sib = db.prepare("SELECT title_id, path FROM files WHERE peer_id IS NULL AND library_id = ? AND path LIKE ? ESCAPE '\\'").all(lib.id, like(x.base))
        .find((f) => path.dirname(f.path) === x.base && path.basename(f.path, path.extname(f.path)) === x.main);
      if (sib) titleId = sib.title_id;
    }
    if (!titleId && !roots.includes(x.base)) {
      // Everything under the folder must be one title, otherwise we would be guessing.
      const ids = db.prepare("SELECT DISTINCT title_id FROM files WHERE peer_id IS NULL AND library_id = ? AND path LIKE ? ESCAPE '\\' LIMIT 2").all(lib.id, like(x.base));
      if (ids.length === 1) titleId = ids[0].title_id;
    }
    if (!titleId) continue;
    seen.add(x.file);
    const prev = existing.get(x.file);
    if (prev && prev.size === st.size && prev.mtime === mtime) { db.prepare('UPDATE extras SET title_id = ?, name = ?, kind = ? WHERE id = ?').run(titleId, x.name, x.kind, prev.id); continue; }
    const info = (await probe(x.file)) || {};
    const cols = { library_id: lib.id, title_id: titleId, path: x.file, name: x.name, kind: x.kind, size: st.size, mtime, duration: info.duration || 0,
      width: info.width || 0, height: info.height || 0, vcodec: info.vcodec || '', acodec: info.acodec || '', container: info.container || path.extname(x.file).slice(1) };
    if (prev) db.prepare('UPDATE extras SET title_id=@title_id, name=@name, kind=@kind, size=@size, mtime=@mtime, duration=@duration, width=@width, height=@height, vcodec=@vcodec, acodec=@acodec, container=@container WHERE id=@id').run({ title_id: cols.title_id, name: cols.name, kind: cols.kind, size: cols.size, mtime: cols.mtime, duration: cols.duration, width: cols.width, height: cols.height, vcodec: cols.vcodec, acodec: cols.acodec, container: cols.container, id: prev.id });
    else db.prepare('INSERT INTO extras (library_id, title_id, path, name, kind, size, mtime, duration, width, height, vcodec, acodec, container, added_at) VALUES (@library_id, @title_id, @path, @name, @kind, @size, @mtime, @duration, @width, @height, @vcodec, @acodec, @container, @added_at)').run({ ...cols, added_at: now() });
  }
  const reachable = roots.filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
  for (const [p, row] of existing) {
    if (seen.has(p)) continue;
    // Same rule as for files: an unreachable share must not wipe what we know.
    if (reachable.some((r) => p.startsWith(r + path.sep)) || !roots.some((r) => p.startsWith(r + path.sep))) db.prepare('DELETE FROM extras WHERE id = ?').run(row.id);
  }
}

async function scanLibrary(lib) {
  const roots = json(lib.paths, []);
  const found = [], extras = [];
  for (const root of roots) {
    const list = [];
    await walk(root, list, extras);
    for (const f of list) found.push({ file: f, root });
  }
  // A root that is unreachable (unmounted share) must not wipe its files.
  const reachable = roots.filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
  scanState.library = lib.name; scanState.total += found.length;

  const existing = new Map(db.prepare('SELECT id, path, size, mtime FROM files WHERE peer_id IS NULL AND library_id = ?').all(lib.id).map((r) => [r.path, r]));
  const seen = new Set();
  for (const { file, root } of found) {
    seen.add(file);
    scanState.done++;
    let st; try { st = await fs.promises.stat(file); } catch { continue; }
    const prev = existing.get(file);
    const mtime = Math.floor(st.mtimeMs / 1000);
    if (prev && prev.size === st.size && prev.mtime === mtime) continue;

    const info = (await probe(file)) || {};
    let title, episode = null;
    if (lib.type === 'movies') {
      const p = parseMovie(file);
      if (!p.title) continue;
      title = findOrCreateTitle({ kind: 'movie', title: p.title, year: p.year });
    } else {
      const p = parseEpisode(file, root);
      if (!p) continue;
      title = findOrCreateTitle({ kind: 'show', title: p.title, year: p.year });
      episode = findOrCreateEpisode(title.id, p.season, p.episode, p.name);
    }
    const cols = {
      library_id: lib.id, title_id: title.id, episode_id: episode ? episode.id : null, path: file, size: st.size, mtime,
      duration: info.duration || 0, bitrate: info.bitrate || 0, width: info.width || 0, height: info.height || 0,
      vcodec: info.vcodec || '', acodec: info.acodec || '', container: info.container || path.extname(file).slice(1),
      hdr: info.hdr || 0, streams: JSON.stringify({ ...(info.streams || { audio: [], subs: [] }), chapters: info.chapters || [], fps: info.fps || 0 }),
    };
    if (prev) {
      db.prepare(`UPDATE files SET library_id=@library_id, title_id=@title_id, episode_id=@episode_id, size=@size, mtime=@mtime, duration=@duration,
        bitrate=@bitrate, width=@width, height=@height, vcodec=@vcodec, acodec=@acodec, container=@container, hdr=@hdr, streams=@streams, markers_done=0 WHERE id=@id`)
        .run({ ...cols, id: prev.id });
    } else {
      db.prepare(`INSERT INTO files (library_id, title_id, episode_id, path, size, mtime, duration, bitrate, width, height, vcodec, acodec, container, hdr, streams, added_at)
        VALUES (@library_id, @title_id, @episode_id, @path, @size, @mtime, @duration, @bitrate, @width, @height, @vcodec, @acodec, @container, @hdr, @streams, @added_at)`)
        .run({ ...cols, added_at: now() });
    }
  }
  for (const [p, row] of existing) {
    if (seen.has(p)) continue;
    if (reachable.some((r) => p.startsWith(r + path.sep))) db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
    else if (!roots.some((r) => p.startsWith(r + path.sep))) db.prepare('DELETE FROM files WHERE id = ?').run(row.id); // path removed from library
  }  await scanExtras(lib, roots, extras);
}

/** Tells the webhooks what a scan brought in. */
function announce(since) {
  const added = db.prepare('SELECT title, year, kind FROM titles WHERE added_at >= ? AND id IN (SELECT title_id FROM files WHERE peer_id IS NULL) ORDER BY id').all(since);
  for (const t of added.slice(0, 10)) emit('title.added', { text: `${t.kind === 'show' ? 'Serie' : 'Film'}: ${t.title}${t.year ? ` (${t.year})` : ''}`, fields: { title: t.title, year: t.year, kind: t.kind } });
  if (added.length > 10) emit('title.added', { text: `…en nog ${added.length - 10} andere nieuwe titels.` });
  emit('scan.finished', { text: `Scan klaar: ${scanState.total} bestanden bekeken, ${added.length} nieuwe ${added.length === 1 ? 'titel' : 'titels'}.`, fields: { files: scanState.total, added: added.length } });
}

/** Set by index.js: called whenever the set of library folders changes. */
let onLibrariesChanged = () => {};
export const setLibrariesChanged = (fn) => { onLibrariesChanged = fn; };

let rescan = false;
export async function scanAll() {
  // A request during a running scan (e.g. a second library was just added) queues one more pass.
  if (scanState.running) { rescan = true; return false; }
  Object.assign(scanState, { running: true, phase: 'scan', library: '', done: 0, total: 0, startedAt: now(), error: null });
  try {
    if (!(await ffmpegAvailable())) scanState.error = 'ffmpeg/ffprobe niet gevonden — bestanden worden zonder technische details toegevoegd.';
    for (const lib of db.prepare('SELECT * FROM libraries ORDER BY id').all()) await scanLibrary(lib);
    pruneOrphans();
    for (const fn of afterScan) {
      try { await fn(scanState); } catch (e) { console.error('[scan] na-stap mislukt:', e); }
    }
    announce(scanState.startedAt);
  } catch (e) {
    console.error('[scan]', e);
    scanState.error = String(e.message || e);
    emit('error', { text: `Scannen is mislukt: ${scanState.error}` });
  } finally {
    Object.assign(scanState, { running: false, phase: 'idle', finishedAt: now() });
  }
  if (rescan) { rescan = false; return scanAll(); }
  return true;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function cleanPaths(paths) {
  if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'Kies minstens één map.');
  return paths.map((p) => {
    const abs = path.resolve(String(p));
    let st; try { st = fs.statSync(abs); } catch { throw new HttpError(400, `Map bestaat niet: ${abs}`); }
    if (!st.isDirectory()) throw new HttpError(400, `Geen map: ${abs}`);
    return abs;
  });
}

export default async function routes(app) {
  app.get('/api/admin/libraries', { preHandler: requireAdmin }, async () => ({
    libraries: db.prepare('SELECT * FROM libraries ORDER BY id').all().map((l) => ({
      ...l, paths: json(l.paths, []), shared: !!l.shared,
      files: db.prepare('SELECT COUNT(*) c FROM files WHERE library_id = ?').get(l.id).c,
      titles: db.prepare('SELECT COUNT(DISTINCT title_id) c FROM files WHERE library_id = ?').get(l.id).c,
    })),
    scan: scanState,
  }));

  app.post('/api/admin/libraries', { preHandler: requireAdmin }, async (req) => {
    const { name, type, paths, shared = true } = req.body || {};
    if (!String(name || '').trim()) throw new HttpError(400, 'Geef de bibliotheek een naam.');
    if (!['movies', 'shows'].includes(type)) throw new HttpError(400, 'Kies films of series.');
    const info = db.prepare('INSERT INTO libraries (name, type, paths, shared, created_at) VALUES (?,?,?,?,?)')
      .run(String(name).trim(), type, JSON.stringify(cleanPaths(paths)), shared ? 1 : 0, now());
    onLibrariesChanged(); scanAll();
    return { id: info.lastInsertRowid };
  });

  app.put('/api/admin/libraries/:id', { preHandler: requireAdmin }, async (req) => {
    const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
    if (!lib) throw new HttpError(404, 'Bibliotheek niet gevonden.');
    const { name = lib.name, paths, shared = !!lib.shared } = req.body || {};
    db.prepare('UPDATE libraries SET name = ?, paths = ?, shared = ? WHERE id = ?')
      .run(String(name).trim() || lib.name, paths ? JSON.stringify(cleanPaths(paths)) : lib.paths, shared ? 1 : 0, lib.id);
    if (paths) { onLibrariesChanged(); scanAll(); }
    return { ok: true };
  });

  app.delete('/api/admin/libraries/:id', { preHandler: requireAdmin }, async (req) => {
    db.prepare('DELETE FROM libraries WHERE id = ?').run(req.params.id);
    pruneOrphans(); onLibrariesChanged();
    return { ok: true };
  });

  app.post('/api/admin/scan', { preHandler: requireAdmin }, async () => ({ started: (scanAll(), true) }));
  app.get('/api/admin/scan', { preHandler: requireAdmin }, async () => scanState);

  // Folder picker for the admin GUI.
  app.get('/api/admin/browse', { preHandler: requireAdmin }, async (req) => {
    const dir = path.resolve(String(req.query.path || '/'));
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { throw new HttpError(400, 'Kan deze map niet lezen.'); }
    const dirs = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) { try { isDir = fs.statSync(path.join(dir, e.name)).isDirectory(); } catch { isDir = false; } }
      if (isDir) dirs.push(e.name);
    }
    dirs.sort((a, b) => a.localeCompare(b));
    return { path: dir, parent: dir === '/' ? null : path.dirname(dir), dirs };
  });
}
