import crypto from 'node:crypto';
import { db, now, randomToken, sha256, HttpError, settings } from './db.js';

const AVATARS = ['violet', 'orchid', 'plum', 'lilac', 'grape', 'iris'];

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `s1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export const userCount = () => db.prepare('SELECT COUNT(*) c FROM users').get().c;
export const needsSetup = () => userCount() === 0;

export function createUser({ name, password, role = 'user' }) {
  name = String(name || '').trim();
  if (name.length < 2 || name.length > 32) throw new HttpError(400, 'Naam moet 2 tot 32 tekens zijn.');
  if (String(password || '').length < 6) throw new HttpError(400, 'Wachtwoord moet minstens 6 tekens zijn.');
  if (db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) throw new HttpError(409, 'Die naam is al in gebruik.');
  const avatar = AVATARS[userCount() % AVATARS.length];
  const info = db.prepare('INSERT INTO users (name, pass, role, avatar, created_at) VALUES (?,?,?,?,?)')
    .run(name, hashPassword(password), role, avatar, now());
  return info.lastInsertRowid;
}

export function createSession(userId, device = '') {
  const token = randomToken(32);
  db.prepare('INSERT INTO sessions (token, user_id, device, created_at, last_seen) VALUES (?,?,?,?,?)')
    .run(token, userId, String(device).slice(0, 80), now(), now());
  return token;
}

export const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, avatar: u.avatar });

// Failed-login throttle, per client address. Small and in-memory on purpose:
// it only has to make online guessing impractical.
const fails = new Map();
function throttle(ip) {
  const f = fails.get(ip);
  if (f && f.count >= 8 && Date.now() - f.at < 5 * 60_000) throw new HttpError(429, 'Te veel pogingen. Probeer het over een paar minuten opnieuw.');
}
function failed(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.at > 5 * 60_000) fails.set(ip, { count: 1, at: Date.now() });
  else f.count++;
}

export function login(name, password, device, ip) {
  throttle(ip);
  const u = db.prepare('SELECT * FROM users WHERE name = ?').get(String(name || '').trim());
  if (!u || !verifyPassword(String(password || ''), u.pass)) { failed(ip); throw new HttpError(401, 'Naam of wachtwoord klopt niet.'); }
  fails.delete(ip);
  return { token: createSession(u.id, device), user: publicUser(u) };
}

const sessionStmt = db.prepare('SELECT u.*, s.last_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?');
const touchStmt = db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?');
const dropStmt = db.prepare('DELETE FROM sessions WHERE token = ?');

/** Seconds a session may stay unused before it stops working (setting `session_idle_days`). */
export function sessionIdleSeconds() {
  const days = Number(settings.get('session_idle_days', 90));
  return (days >= 1 && days <= 3650 ? days : 90) * 86400;
}

/** Removes every session that has been idle for too long. */
export const purgeSessions = () => db.prepare('DELETE FROM sessions WHERE last_seen < ?').run(now() - sessionIdleSeconds()).changes;

/** What the client sees instead of the token: enough to tell sessions apart, useless for signing in. */
export const sessionId = (token) => sha256(token).slice(0, 12);

export function listSessions(userId, currentToken) {
  return db.prepare('SELECT token, device, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(userId)
    .filter((s) => now() - s.last_seen <= sessionIdleSeconds())
    .map((s) => ({ id: sessionId(s.token), device: s.device, created_at: s.created_at, last_seen: s.last_seen, current: s.token === currentToken }));
}

/** Signs out one of the user's own sessions; false when there is no such session. */
export function revokeSession(userId, id) {
  let n = 0;
  for (const s of db.prepare('SELECT token FROM sessions WHERE user_id = ?').all(userId)) {
    if (sessionId(s.token) === id) n += dropStmt.run(s.token).changes;
  }
  return n > 0;
}

export const revokeOtherSessions = (userId, keepToken) =>
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, keepToken || '').changes;

export function userFromToken(token) {
  if (!token) return null;
  const u = sessionStmt.get(token);
  if (!u) return null;
  if (now() - u.last_seen > sessionIdleSeconds()) { dropStmt.run(token); return null; }
  if (now() - u.last_seen > 300) touchStmt.run(now(), token);
  return u;
}

export function tokenFromRequest(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

/** Fastify preHandler: any signed-in user. */
export async function requireUser(req) {
  const u = userFromToken(tokenFromRequest(req));
  if (!u) throw new HttpError(401, 'Niet ingelogd.');
  req.user = u;
}

/** Fastify preHandler: admins only. */
export async function requireAdmin(req) {
  await requireUser(req);
  if (req.user.role !== 'admin') throw new HttpError(403, 'Alleen voor beheerders.');
}

export default async function routes(app) {
  app.get('/api/info', async () => ({
    name: settings.get('server_name'),
    id: settings.get('server_id'),
    version: (await import('./config.js')).config.version,
    needsSetup: needsSetup(),
    product: 'kinoko',
  }));

  app.post('/api/auth/login', async (req) => {
    const { name, password, device } = req.body || {};
    return login(name, password, device, req.ip);
  });

  app.post('/api/auth/logout', { preHandler: requireUser }, async (req) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenFromRequest(req));
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => ({ user: publicUser(req.user) }));

  // Join with an account invite created by the admin.
  app.get('/api/auth/invite/:code', async (req) => {
    const inv = db.prepare('SELECT * FROM user_invites WHERE code = ?').get(req.params.code);
    return { valid: !!inv && !inv.used_by && inv.expires_at > now(), server: settings.get('server_name') };
  });
  app.post('/api/auth/register', async (req) => {
    const { code, name, password, device } = req.body || {};
    const inv = db.prepare('SELECT * FROM user_invites WHERE code = ?').get(String(code || ''));
    if (!inv || inv.used_by || inv.expires_at < now()) throw new HttpError(403, 'Deze uitnodiging is niet (meer) geldig.');
    const id = createUser({ name, password });
    db.prepare('UPDATE user_invites SET used_by = ? WHERE code = ?').run(id, inv.code);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return { token: createSession(id, device), user: publicUser(u) };
  });

  app.post('/api/auth/password', { preHandler: requireUser }, async (req) => {
    const { current, next } = req.body || {};
    if (!verifyPassword(String(current || ''), req.user.pass)) throw new HttpError(403, 'Huidig wachtwoord klopt niet.');
    if (String(next || '').length < 6) throw new HttpError(400, 'Wachtwoord moet minstens 6 tekens zijn.');
    db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    revokeOtherSessions(req.user.id, tokenFromRequest(req));
    return { ok: true };
  });

  // --- own sessions ("Apparaten") -----------------------------------------
  app.get('/api/auth/sessions', { preHandler: requireUser }, async (req) => ({
    sessions: listSessions(req.user.id, tokenFromRequest(req)), idleDays: sessionIdleSeconds() / 86400,
  }));
  app.post('/api/auth/sessions/revoke-others', { preHandler: requireUser }, async (req) => ({
    ok: true, revoked: revokeOtherSessions(req.user.id, tokenFromRequest(req)),
  }));
  app.delete('/api/auth/sessions/:id', { preHandler: requireUser }, async (req) => {
    if (!revokeSession(req.user.id, String(req.params.id))) throw new HttpError(404, 'Dit apparaat is al uitgelogd.');
    return { ok: true };
  });

  // --- admin: users -------------------------------------------------------
  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => ({
    users: db.prepare('SELECT id, name, role, avatar, created_at FROM users ORDER BY id').all(),
    invites: db.prepare('SELECT code, expires_at FROM user_invites WHERE used_by IS NULL AND expires_at > ? ORDER BY created_at DESC').all(now()),
  }));
  app.post('/api/admin/users', { preHandler: requireAdmin }, async (req) => {
    const { name, password, role } = req.body || {};
    return { id: createUser({ name, password, role: role === 'admin' ? 'admin' : 'user' }) };
  });
  app.delete('/api/admin/users/:id', { preHandler: requireAdmin }, async (req) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw new HttpError(400, 'Je kunt je eigen account niet verwijderen.');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  });
  app.post('/api/admin/users/invite', { preHandler: requireAdmin }, async () => {
    const code = randomToken(9);
    db.prepare('INSERT INTO user_invites (code, created_at, expires_at) VALUES (?,?,?)').run(code, now(), now() + 7 * 86400);
    return { code };
  });
  app.delete('/api/admin/users/invite/:code', { preHandler: requireAdmin }, async (req) => {
    db.prepare('DELETE FROM user_invites WHERE code = ?').run(req.params.code);
    return { ok: true };
  });
}
