// Watches the library folders so new or removed files show up within about a
// minute. inotify does not see changes on every network share (NFS/SMB), so
// the periodic scan in index.js stays as the safety net.
import fs from 'node:fs';
import { db, json } from './db.js';

/** Collapses a burst of calls into one, `wait` ms after the last. */
export function debounce(fn, wait) {
  let timer = null;
  const d = () => { clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(); }, wait); timer.unref?.(); };
  d.cancel = () => { clearTimeout(timer); timer = null; };
  d.pending = () => timer !== null;
  return d;
}

const watchers = new Map();   // root -> FSWatcher
export const watchState = { roots: [], failed: [] };

/** (Re)starts watching the current library roots. Safe to call any time libraries change. */
export function watchLibraries(onChange, { wait = 30_000 } = {}) {
  const trigger = debounce(onChange, wait);
  const roots = new Set();
  for (const lib of db.prepare('SELECT paths FROM libraries').all()) for (const r of json(lib.paths, [])) roots.add(r);
  for (const [root, w] of watchers) if (!roots.has(root)) { w.close(); watchers.delete(root); }
  watchState.failed = [];
  for (const root of roots) {
    if (watchers.has(root)) continue;
    try {
      const w = fs.watch(root, { recursive: true, persistent: false }, (event, name) => {
        // Hidden and temporary files (downloads in progress, Synology metadata) are not worth a scan.
        if (name && /(^|\/)(\.|@eaDir)|\.(part|tmp|!qB|crdownload)$/i.test(String(name))) return;
        trigger();
      });
      w.on('error', () => { try { w.close(); } catch { /* gone */ } watchers.delete(root); });
      watchers.set(root, w);
    } catch { watchState.failed.push(root); }
  }
  watchState.roots = [...watchers.keys()];
  return trigger;
}

export function stopWatching() { for (const w of watchers.values()) { try { w.close(); } catch { /* gone */ } } watchers.clear(); watchState.roots = []; }
