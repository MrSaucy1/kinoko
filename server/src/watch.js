// Watch Together: a room keeps one shared playback state; whoever presses
// play, pause or seeks moves everyone. Guests join through the invite link
// without needing an account on this server.
import { db, now, randomToken, HttpError, settings } from './db.js';
import { requireUser, userFromToken, tokenFromRequest } from './auth.js';
import { card } from './catalog.js';
import { playLocal } from './stream.js';
import { remotePlay } from './federation.js';

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

function describe(room) {
  const t = db.prepare('SELECT * FROM titles WHERE id = ?').get(room.titleId);
  const e = room.episodeId ? db.prepare('SELECT * FROM episodes WHERE id = ?').get(room.episodeId) : null;
  return {
    code: room.code, host: room.hostName, server: settings.get('server_name'),
    title: t ? card(t) : null,
    episode: e ? { id: e.id, season: e.season, episode: e.episode, name: e.name } : null,
    fileId: room.fileId, members: members(room),
  };
}
const members = (room) => [...room.clients.values()].map((c) => ({ id: c.id, name: c.name, avatar: c.avatar, guest: c.guest }));

function currentState(room) {
  const s = room.state;
  // Report where playback is *now*, so late joiners land in sync.
  const position = s.playing ? s.position + (Date.now() - s.at) / 1000 : s.position;
  return { playing: s.playing, position, fileId: room.fileId, titleId: room.titleId, episodeId: room.episodeId };
}

function broadcast(room, msg, except = null) {
  const data = JSON.stringify({ ...msg, now: Date.now() });
  for (const [sock] of room.clients) { if (sock !== except && sock.readyState === 1) sock.send(data); }
}

function identify(room, req) {
  const user = userFromToken(tokenFromRequest(req) || req.query.token);
  if (user) return { id: `u${user.id}`, name: user.name, avatar: user.avatar, guest: false, user };
  const g = room.guests.get(String(req.headers['x-guest'] || req.query.guest || ''));
  if (g) return { id: `g${g.n}`, name: g.name, avatar: 'lilac', guest: true };
  return null;
}

const getRoom = (code) => {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) throw new HttpError(404, 'Deze kijksessie bestaat niet (meer).');
  return room;
};

setInterval(() => {
  for (const [code, room] of rooms) if (!room.clients.size && Date.now() - room.emptySince > 30 * 60_000) rooms.delete(code);
}, 60_000).unref();

export default async function routes(app) {
  app.post('/api/watch', { preHandler: requireUser }, async (req) => {
    const { fileId, position = 0 } = req.body || {};
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(fileId));
    if (!file) throw new HttpError(404, 'Deze versie bestaat niet meer.');
    let code; do { code = newCode(); } while (rooms.has(code));
    rooms.set(code, {
      code, hostName: req.user.name, titleId: file.title_id, episodeId: file.episode_id || 0, fileId: file.id,
      state: { playing: false, position: Number(position) || 0, at: Date.now() },
      clients: new Map(), guests: new Map(), guestSeq: 0, emptySince: Date.now(), createdAt: now(),
    });
    return { code, path: `/w/${code}` };
  });

  app.get('/api/watch/:code', async (req) => describe(getRoom(req.params.code)));

  app.post('/api/watch/:code/guest', async (req) => {
    const room = getRoom(req.params.code);
    const name = String(req.body?.name || '').trim().slice(0, 24);
    if (name.length < 2) throw new HttpError(400, 'Vul een naam in van minstens 2 tekens.');
    if (room.guests.size >= 20) throw new HttpError(429, 'Deze kijksessie zit vol.');
    const token = randomToken(18);
    room.guests.set(token, { name, n: ++room.guestSeq });
    return { guest: token, name };
  });

  // Members (guests included) get a stream for whatever the room is watching.
  app.post('/api/watch/:code/play', async (req) => {
    const room = getRoom(req.params.code);
    if (!identify(room, req)) throw new HttpError(401, 'Doe eerst mee met de kijksessie.');
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(room.fileId);
    if (!file) throw new HttpError(404, 'Deze versie bestaat niet meer.');
    const play = file.peer_id ? await remotePlay(file, req.body || {}) : playLocal(file, req.body || {});
    return { ...play, room: describe(room), state: currentState(room) };
  });

  app.get('/api/watch/:code/ws', { websocket: true }, (socket, req) => {
    const room = rooms.get(String(req.params.code || '').toUpperCase());
    const me = room && identify(room, req);
    if (!me) { socket.close(4001, 'unauthorized'); return; }
    room.clients.set(socket, me);
    socket.send(JSON.stringify({ t: 'hello', you: me.id, room: describe(room), state: currentState(room), now: Date.now() }));
    broadcast(room, { t: 'members', members: members(room), joined: me.name }, socket);

    socket.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      const pos = Math.max(0, Number(m.position) || 0);
      switch (m.t) {
        case 'play': case 'pause': case 'seek': {
          const playing = m.t === 'seek' ? room.state.playing : m.t === 'play';
          room.state = { playing, position: pos, at: Date.now() };
          broadcast(room, { t: 'state', action: m.t, by: me.name, byId: me.id, state: currentState(room) });
          break;
        }
        case 'load': {
          // Switching episode/version is for account holders; guests follow.
          if (me.guest) return;
          const file = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(m.fileId));
          if (!file) return;
          Object.assign(room, { fileId: file.id, titleId: file.title_id, episodeId: file.episode_id || 0 });
          room.state = { playing: false, position: 0, at: Date.now() };
          broadcast(room, { t: 'load', by: me.name, byId: me.id, room: describe(room), state: currentState(room) });
          break;
        }
        case 'chat': {
          const text = String(m.text || '').trim().slice(0, 300);
          if (text) broadcast(room, { t: 'chat', from: me.name, fromId: me.id, text });
          break;
        }
        case 'react':
          if (typeof m.emoji === 'string' && m.emoji.length <= 8) broadcast(room, { t: 'react', from: me.name, fromId: me.id, emoji: m.emoji });
          break;
        case 'ping':
          socket.send(JSON.stringify({ t: 'pong', c: m.c, now: Date.now() }));
          break;
        default:
      }
    });
    socket.on('close', () => {
      room.clients.delete(socket);
      if (!room.clients.size) room.emptySince = Date.now();
      broadcast(room, { t: 'members', members: members(room), left: me.name });
    });
  });
}
