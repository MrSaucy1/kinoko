// Database backups: a consistent copy made with VACUUM INTO, daily, keeping
// the last N. A backup holds everything in the database (accounts, password
// hashes, sessions), so listing and downloading is for admins only.
import fs from 'node:fs';
import path from 'node:path';
import { db, settings, now, HttpError } from './db.js';
import { dataPath } from './config.js';
import { requireAdmin } from './auth.js';

const NAME = /^kinoko-\d{8}-\d{6}\.db$/;
const dir = () => dataPath('backups');
const keep = () => { const n = Number(settings.get('backup_keep', 7)); return Number.isInteger(n) && n >= 1 && n <= 365 ? n : 7; };

export function listBackups() {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((n) => NAME.test(n)); } catch { /* no directory yet */ }
  return names.sort().reverse().map((name) => {
    const st = fs.statSync(path.join(dir(), name));
    return { name, size: st.size, created_at: Math.floor(st.mtimeMs / 1000) };
  });
}

export function createBackup(date = new Date()) {
  fs.mkdirSync(dir(), { recursive: true });
  const p = (n) => String(n).padStart(2, '0');
  const name = `kinoko-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.db`;
  const file = path.join(dir(), name);
  if (fs.existsSync(file)) return name;   // VACUUM INTO refuses to overwrite
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  settings.set('backup_last', now());
  // Keep the newest N; older ones are removed.
  for (const old of listBackups().slice(keep())) { try { fs.unlinkSync(path.join(dir(), old.name)); } catch { /* already gone */ } }
  return name;
}

/** Called on a timer: makes a backup when the last one is a day old. */
export function backupIfDue() {
  if (settings.get('backup_daily', true) === false) return null;
  if (now() - Number(settings.get('backup_last', 0)) < 86400) return null;
  try { return createBackup(); } catch (e) { console.error('[backup] mislukt:', e.message); return null; }
}

export default async function routes(app) {
  app.get('/api/admin/backups', { preHandler: requireAdmin }, async () => ({
    backups: listBackups(), keep: keep(), daily: settings.get('backup_daily', true) !== false, last: settings.get('backup_last', 0),
  }));
  app.post('/api/admin/backups', { preHandler: requireAdmin }, async () => {
    try { return { name: createBackup() }; } catch (e) { throw new HttpError(500, `Back-up maken is mislukt: ${e.message}`); }
  });
  app.put('/api/admin/backups', { preHandler: requireAdmin }, async (req) => {
    const b = req.body || {};
    if (b.keep !== undefined) {
      const n = Number(b.keep);
      if (!Number.isInteger(n) || n < 1 || n > 365) throw new HttpError(400, 'Kies een aantal tussen 1 en 365.');
      settings.set('backup_keep', n);
    }
    if (typeof b.daily === 'boolean') settings.set('backup_daily', b.daily);
    return { ok: true };
  });
  app.get('/api/admin/backups/:name', { preHandler: requireAdmin }, async (req, reply) => {
    const name = String(req.params.name);
    // The pattern allows no slashes or dots beyond the extension, so the name cannot leave the directory.
    if (!NAME.test(name)) throw new HttpError(400, 'Ongeldige naam.');
    const file = path.join(dir(), name);
    if (!fs.existsSync(file)) throw new HttpError(404, 'Deze back-up bestaat niet (meer).');
    return reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename="${name}"`)
      .header('Content-Length', fs.statSync(file).size).header('Cache-Control', 'no-store').send(fs.createReadStream(file));
  });
  app.delete('/api/admin/backups/:name', { preHandler: requireAdmin }, async (req) => {
    const name = String(req.params.name);
    if (!NAME.test(name)) throw new HttpError(400, 'Ongeldige naam.');
    try { fs.unlinkSync(path.join(dir(), name)); } catch { throw new HttpError(404, 'Deze back-up bestaat niet (meer).'); }
    return { ok: true };
  });
}
