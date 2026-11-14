// One WebSocket per open client, so the server can tell a signed-in user
// something right now: "continue on this device?", a stopped stream, …
// Messages only ever go to sockets of the user they are meant for.
import { userFromToken, tokenFromRequest, sessionId } from './auth.js';

const sockets = new Map();   // userId -> Set<{ socket, session, device }>

export function register(userId, entry) {
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(entry);
  return () => { const set = sockets.get(userId); if (set) { set.delete(entry); if (!set.size) sockets.delete(userId); } };
}

/** Sends to every open client of this user, optionally skipping the session that caused it. Returns how many got it. */
export function notifyUser(userId, msg, { exceptSession = null } = {}) {
  let n = 0;
  const data = JSON.stringify(msg);
  for (const e of sockets.get(userId) || []) {
    if (exceptSession && e.session === exceptSession) continue;
    try { if (e.socket.readyState === 1) { e.socket.send(data); n++; } } catch { /* socket is closing */ }
  }
  return n;
}

export const openClients = (userId) => [...(sockets.get(userId) || [])].map((e) => ({ session: e.session, device: e.device }));

export default async function routes(app) {
  // Browsers cannot set headers on a WebSocket, so the token may come as ?token=.
  app.get('/api/events/ws', { websocket: true }, (socket, req) => {
    const token = tokenFromRequest(req) || String(req.query.token || '');
    const user = userFromToken(token);
    if (!user) { socket.close(4001, 'unauthorized'); return; }
    const entry = { socket, session: sessionId(token), device: String(req.query.device || '').slice(0, 40) };
    const drop = register(user.id, entry);
    socket.send(JSON.stringify({ t: 'hello' }));
    socket.on('message', (raw) => { if (String(raw).length < 64 && String(raw).includes('ping')) { try { socket.send('{"t":"pong"}'); } catch { /* closing */ } } });
    socket.on('close', drop);
    socket.on('error', drop);
  });
}
