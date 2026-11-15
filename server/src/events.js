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
export function notifyUser(userId, msg, { exceptSession = null, onlySession = null } = {}) {
  let n = 0;
  const data = JSON.stringify(msg);
  for (const e of sockets.get(userId) || []) {
    if (exceptSession && e.session === exceptSession) continue;
    if (onlySession && e.session !== onlySession) continue;
    try { if (e.socket.readyState === 1) { e.socket.send(data); n++; } } catch { /* socket is closing */ }
  }
  return n;
}

export const openClients = (userId) => [...(sockets.get(userId) || [])].map((e) => ({ session: e.session, device: e.device }));
/** The user's open music players. */
export const players = (userId) => [...(sockets.get(userId) || [])].filter((e) => e.player);
/** Sends to one socket of this user, by its connection id. */
export function sendTo(userId, id, msg) { const e = [...(sockets.get(userId) || [])].find((x) => x.id === id); if (!e || e.socket.readyState !== 1) return false; try { e.socket.send(JSON.stringify(msg)); return true; } catch { return false; } }

export default async function routes(app) {
  // Browsers cannot set headers on a WebSocket, so the token may come as ?token=.
  app.get('/api/events/ws', { websocket: true }, (socket, req) => {
    const token = tokenFromRequest(req) || String(req.query.token || '');
    const user = userFromToken(token);
    if (!user) { socket.close(4001, 'unauthorized'); return; }
    // A client that can play music says so (?player=1); it then appears under "Apparaten" in Kinoko Connect.
    const entry = { socket, session: sessionId(token), device: String(req.query.device || '').slice(0, 40), player: req.query.player === '1', state: null, id: Math.random().toString(36).slice(2, 10) };
    const drop = register(user.id, entry);
    socket.send(JSON.stringify({ t: 'hello', id: entry.id }));
    socket.on('message', (raw) => {
      const text = String(raw);
      if (text.length > 4000) return;
      if (text === 'ping') { try { socket.send('{"t":"pong"}'); } catch { /* closing */ } return; }
      // A player reports what it is doing, so the user's other devices can show and control it.
      let m; try { m = JSON.parse(text); } catch { return; }
      if (m && m.t === 'player' && entry.player && m.state && typeof m.state === 'object') {
        const s = m.state;
        entry.state = { trackId: Number(s.trackId) || null, title: String(s.title || '').slice(0, 200), artist: String(s.artist || '').slice(0, 200), cover: typeof s.cover === 'string' ? s.cover.slice(0, 300) : null,
          playing: s.playing === true, position: Number(s.position) || 0, duration: Number(s.duration) || 0, at: Date.now() };
        notifyUser(user.id, { t: 'devices' }, { exceptSession: null });
      }
    });
    const gone = () => { drop(); if (entry.player) notifyUser(user.id, { t: 'devices' }); };
    socket.on('close', gone);
    socket.on('error', gone);
  });
}
