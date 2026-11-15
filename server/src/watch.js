// Watch Together: a room keeps one shared playback state; whoever presses
// play, pause or seeks moves everyone. Guests join through the invite link
// without needing an account on this server.
import { db, now, randomToken, HttpError, settings } from './db.js';
import { requireUser, userFromToken, tokenFromRequest } from './auth.js';
import { card } from './catalog.js';
import { playLocal, applyLimit, limitFor, stripOriginal } from './stream.js';
import { remotePlay } from './federation.js';
import { requireFile, requireTitle, canSeeFile, scopeFor } from './access.js';

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

function describe(room) {
  const t = room.titleId ? db.prepare('SELECT * FROM titles WHERE id = ?').get(room.titleId) : null;
  const e = room.episodeId ? db.prepare('SELECT * FROM episodes WHERE id = ?').get(room.episodeId) : null;
  return {
    code: room.code, host: room.hostName, server: settings.get('server_name'),
    title: t ? card(t) : null,
    episode: e ? { id: e.id, season: e.season, episode: e.episode, name: e.name } : null,
    fileId: room.fileId, members: members(room), vote: voteState(room),
  };
}
const members = (room) => [...room.clients.values()].map((c) => ({ id: c.id, name: c.name, avatar: c.avatar, guest: c.guest }));

// ---- chat --------------------------------------------------------------------
// Messages live in memory with the room and are gone when it closes: a chat
// next to a film is not something to keep.
const HISTORY = 50;
/** A small token bucket per participant: `max` messages, refilled over `perMs`. */
export function allow(bucket, max, perMs, t = Date.now()) {
  const b = bucket;
  if (b.tokens === undefined) { b.tokens = max; b.at = t; }
  b.tokens = Math.min(max, b.tokens + ((t - b.at) / perMs) * max); b.at = t;
  if (b.tokens < 1) return false;
  b.tokens -= 1; return true;
}

// ---- Watch Night vote ----------------------------------------------------------
// A room can start without a film: everyone votes on the three rolled picks and
// the winner starts for all. Decided by a majority of who is there, or by the timer.
const VOTE_SECONDS = 90;
function voteState(room) {
  const v = room.vote;
  if (!v) return null;
  const counts = Object.fromEntries(v.options.map((o) => [o.id, 0]));
  for (const id of v.votes.values()) counts[id]++;
  return { options: v.options, counts, voted: v.votes.size, endsAt: v.endsAt, winner: v.winner || null };
}
export function pickWinner(options, votes, rnd = Math.random) {
  const counts = new Map(options.map((o) => [o.id, 0]));
  for (const id of votes.values()) counts.set(id, counts.get(id) + 1);
  const best = Math.max(...counts.values());
  const top = options.filter((o) => counts.get(o.id) === best);
  return top[Math.floor(rnd() * top.length)];
}
function finishVote(room) {
  const v = room.vote;
  if (!v || v.winner) return;
  clearTimeout(v.timer);
  const win = pickWinner(v.options, v.votes);
  v.winner = win.id;
  Object.assign(room, { fileId: win.fileId, titleId: win.id, episodeId: 0 });
  room.state = { playing: false, position: 0, at: Date.now() };
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(win.fileId);
  for (const [sock, c] of room.clients) if (file && c.user && !canSeeFile(scopeFor(c.user), file)) { room.clients.delete(sock); try { sock.close(4003, 'forbidden'); } catch { /* closing */ } }
  broadcast(room, { t: 'load', by: 'De stemming', byId: '', room: describe(room), state: currentState(room), winner: win.title });
}
function castVote(room, me, titleId) {
  const v = room.vote;
  if (!v || v.winner || !v.options.some((o) => o.id === titleId)) return;
  v.votes.set(me.id, titleId);
  const present = new Set([...room.clients.values()].map((c) => c.id));
  const counts = new Map();
  for (const [who, id] of v.votes) if (present.has(who)) counts.set(id, (counts.get(id) || 0) + 1);
  // More than half of the people in the room agree: no need to wait for the timer.
  if (present.size >= 2 && Math.max(...counts.values()) > present.size / 2) return finishVote(room);
  broadcast(room, { t: 'vote', vote: voteState(room) });
}

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
  for (const [code, room] of rooms) if (!room.clients.size && Date.now() - room.emptySince > 30 * 60_000) { if (room.vote) clearTimeout(room.vote.timer); rooms.delete(code); }
}, 60_000).unref();

export default async function routes(app) {
  app.post('/api/watch', { preHandler: requireUser }, async (req) => {
    const { fileId, position = 0 } = req.body || {};
    const file = requireFile(req.user, fileId);
    let code; do { code = newCode(); } while (rooms.has(code));
    rooms.set(code, {
      code, hostName: req.user.name, hostLimit: limitFor(req.user), titleId: file.title_id, episodeId: file.episode_id || 0, fileId: file.id,
      state: { playing: false, position: Number(position) || 0, at: Date.now() },
      clients: new Map(), guests: new Map(), guestSeq: 0, emptySince: Date.now(), createdAt: now(), chat: [],
    });
    return { code, path: `/w/${code}` };
  });

  // An account that may not see what the room plays is turned away, even with the code.
  const allowedIn = (room, user) => {
    if (!user) return;
    const file = room.fileId ? db.prepare('SELECT * FROM files WHERE id = ?').get(room.fileId) : null;
    // While voting: every option must be something this account may see.
    if (!file && room.vote && room.vote.options.some((o) => { const f = db.prepare('SELECT * FROM files WHERE id = ?').get(o.fileId); return f && !canSeeFile(scopeFor(user), f); })) throw new HttpError(403, 'Je account heeft geen toegang tot wat hier wordt gekeken.');
    if (file && !canSeeFile(scopeFor(user), file)) throw new HttpError(403, 'Je account heeft geen toegang tot wat hier wordt gekeken.');
  };
  // Watch Night together: a room that starts with a vote instead of a film.
  app.post('/api/watch/vote', { preHandler: requireUser }, async (req) => {
    const ids = [...new Set((Array.isArray(req.body?.titleIds) ? req.body.titleIds : []).map(Number))].slice(0, 3);
    if (ids.length < 2) throw new HttpError(400, 'Kies minstens twee films om over te stemmen.');
    const scope = scopeFor(req.user);
    const options = ids.map((id) => {
      requireTitle(req.user, id);
      const t = db.prepare("SELECT * FROM titles WHERE id = ? AND kind = 'movie'").get(id);
      if (!t) throw new HttpError(400, 'Stemmen kan alleen over films.');
      // Same choice as the detail page makes: the highest bitrate the host may see, local first on a tie.
      const file = db.prepare('SELECT * FROM files WHERE title_id = ?').all(id).filter((f) => canSeeFile(scope, f)).sort((a, b) => b.bitrate - a.bitrate || (a.peer_id ? 1 : 0) - (b.peer_id ? 1 : 0))[0];
      if (!file) throw new HttpError(404, 'Titel niet gevonden.');
      const c = card(t);
      return { id: t.id, title: c.title, year: c.year, poster: c.poster, backdrop: c.backdrop, fileId: file.id };
    });
    let code; do { code = newCode(); } while (rooms.has(code));
    const room = {
      code, hostName: req.user.name, hostLimit: limitFor(req.user), titleId: 0, episodeId: 0, fileId: null,
      state: { playing: false, position: 0, at: Date.now() }, clients: new Map(), guests: new Map(), guestSeq: 0, emptySince: Date.now(), createdAt: now(), chat: [],
      vote: { options, votes: new Map(), endsAt: Date.now() + VOTE_SECONDS * 1000, winner: null, timer: null },
    };
    room.vote.timer = setTimeout(() => finishVote(room), VOTE_SECONDS * 1000); room.vote.timer.unref();
    rooms.set(code, room);
    return { code, path: `/w/${code}` };
  });

  app.get('/api/watch/:code', async (req) => {
    const room = getRoom(req.params.code);
    allowedIn(room, userFromToken(tokenFromRequest(req)));
    return describe(room);
  });

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
    const me = identify(room, req);
    if (!me) throw new HttpError(401, 'Doe eerst mee met de kijksessie.');
    allowedIn(room, me.user);
    if (!room.fileId) throw new HttpError(409, 'Er wordt nog gestemd over de film.');
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(room.fileId);
    if (!file) throw new HttpError(404, 'Deze versie bestaat niet meer.');
    // A guest watches under the limit of whoever opened the room.
    const lim = applyLimit(file, req.body || {}, me.user ? limitFor(me.user) : room.hostLimit);
    const play = file.peer_id ? await remotePlay(file, lim.body) : playLocal(file, lim.body);
    return { ...stripOriginal(play, lim.capped), room: describe(room), state: currentState(room) };
  });

  app.get('/api/watch/:code/ws', { websocket: true }, (socket, req) => {
    const room = rooms.get(String(req.params.code || '').toUpperCase());
    const me = room && identify(room, req);
    if (!me) { socket.close(4001, 'unauthorized'); return; }
    try { allowedIn(room, me.user); } catch { socket.close(4003, 'forbidden'); return; }
    room.clients.set(socket, me);
    const limits = { chat: {}, react: {}, vote: {} };
    socket.send(JSON.stringify({ t: 'hello', you: me.id, room: describe(room), state: currentState(room), chat: room.chat, now: Date.now() }));
    broadcast(room, { t: 'members', members: members(room), joined: me.name }, socket);

    socket.on('message', (raw) => {
      if (String(raw).length > 2000) return;
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (!m || typeof m !== 'object') return;
      const pos = Math.max(0, Number(m.position) || 0);
      switch (m.t) {
        case 'play': case 'pause': case 'seek': {
          if (!room.fileId) return;   // still voting
          const playing = m.t === 'seek' ? room.state.playing : m.t === 'play';
          room.state = { playing, position: pos, at: Date.now() };
          broadcast(room, { t: 'state', action: m.t, by: me.name, byId: me.id, state: currentState(room) });
          break;
        }
        case 'load': {
          // Switching episode/version is for account holders; guests follow.
          if (me.guest) return;
          const file = db.prepare('SELECT * FROM files WHERE id = ?').get(Number(m.fileId));
          if (!file || !canSeeFile(scopeFor(me.user), file)) return;
          Object.assign(room, { fileId: file.id, titleId: file.title_id, episodeId: file.episode_id || 0 });
          room.state = { playing: false, position: 0, at: Date.now() };
          // Whoever may not see the new file leaves the room before it is announced.
          for (const [sock, c] of room.clients) if (c.user && !canSeeFile(scopeFor(c.user), file)) { room.clients.delete(sock); try { sock.close(4003, 'forbidden'); } catch { /* closing */ } }
          broadcast(room, { t: 'load', by: me.name, byId: me.id, room: describe(room), state: currentState(room) });
          break;
        }
        case 'chat': {
          const text = String(m.text || '').trim().slice(0, 300);
          if (!text) break;
          // Five messages per ten seconds per person; the sender hears when they are over it.
          if (!allow(limits.chat, 5, 10_000)) { socket.send(JSON.stringify({ t: 'slow', what: 'chat' })); break; }
          const msg = { from: me.name, fromId: me.id, text, at: Date.now() };
          room.chat.push(msg); if (room.chat.length > HISTORY) room.chat.shift();
          broadcast(room, { t: 'chat', ...msg });
          break;
        }
        case 'react':
          if (typeof m.emoji === 'string' && m.emoji.length <= 8 && !/[<>&"'\s]/.test(m.emoji) && allow(limits.react, 10, 10_000)) broadcast(room, { t: 'react', from: me.name, fromId: me.id, emoji: m.emoji });
          break;
        case 'vote':
          if (allow(limits.vote, 10, 10_000)) castVote(room, me, Number(m.titleId));
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
