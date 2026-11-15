// Audit log: who did what on this server, and from where. Never holds
// passwords, tokens or other secrets — only what happened.
import { db, now, settings } from './db.js';

export const ACTIONS = {
  'login.ok': 'Ingelogd', 'login.fail': 'Mislukte inlogpoging', 'user.create': 'Gebruiker aangemaakt', 'user.delete': 'Gebruiker verwijderd',
  'user.update': 'Gebruiker gewijzigd', 'user.password': 'Wachtwoord gewijzigd', 'settings.change': 'Instelling gewijzigd', 'peer.link': 'Server gekoppeld',
  'peer.unlink': 'Server ontkoppeld', update: 'Kinoko bijgewerkt', '2fa.enable': 'Tweestapsverificatie aangezet', '2fa.disable': 'Tweestapsverificatie uitgezet',
  '2fa.reset': 'Tweestapsverificatie gereset door beheerder', 'stream.stop': 'Stream gestopt', 'request.decide': 'Verzoek beoordeeld', 'backup.create': 'Back-up gemaakt', 'backup.download': 'Back-up gedownload',
};

/** Anything that could carry line breaks or control characters is flattened before it is stored or logged. */
export const flat = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);

/** `who` is a user row, or null for something nobody was signed in for. */
export function audit(action, { user = null, ip = '', detail = '' } = {}) {
  try {
    db.prepare('INSERT INTO audit_log (at, user_id, user_name, ip, action, detail) VALUES (?,?,?,?,?,?)')
      .run(now(), user ? user.id : null, flat(user ? user.name : '', 40), flat(ip, 60), action, flat(detail));
  } catch (e) { console.error('[audit]', e.message); }
}

export const auditDays = () => { const n = Number(settings.get('audit_days', 90)); return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : 90; };
export const purgeAudit = () => db.prepare('DELETE FROM audit_log WHERE at < ?').run(now() - auditDays() * 86400).changes;

export function queryAudit({ action = '', q = '', before = 0, limit = 100 } = {}) {
  const where = [], args = [];
  if (action && ACTIONS[action]) { where.push('action = ?'); args.push(action); }
  if (q) { where.push("(user_name LIKE ? ESCAPE '\\' OR ip LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')"); const like = `%${String(q).replace(/[\\%_]/g, '\\$&')}%`; args.push(like, like, like); }
  if (Number(before) > 0) { where.push('id < ?'); args.push(Number(before)); }
  const n = Math.max(1, Math.min(200, Number(limit) || 100));
  return db.prepare(`SELECT id, at, user_name AS user, ip, action, detail FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, n)
    .map((r) => ({ ...r, label: ACTIONS[r.action] || r.action }));
}

/**
 * One fixed line per failed sign-in, for fail2ban / CrowdSec:
 *   kinoko: auth failure ip=203.0.113.7 reason=password
 * Nothing the client typed ends up in it, so the line cannot be forged from outside.
 */
export function logAuthFailure(ip, reason) {
  console.warn(`kinoko: auth failure ip=${String(ip || '').replace(/[^0-9a-fA-F.:]/g, '') || 'unknown'} reason=${reason}`);
}
