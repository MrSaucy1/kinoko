// Linked servers. One server creates an invite link; the other pastes it.
// After that each side can browse the other's shared libraries as if they
// were its own, and streams are relayed through the user's own server.
import { Readable } from 'node:stream';
import { db, now, json, randomToken, sha256, settings, HttpError } from './db.js';
import { requireAdmin } from './auth.js';
import { findOrCreateTitle, findOrCreateEpisode, pruneOrphans } from './library.js';
import { rebuildCollections } from './collections.js';
import { playLocal, setRemotePlayer } from './stream.js';
import { searchOnline, downloadOnline, setRemoteSubs } from './subtitles.js';
import { imgUrl } from './metadata.js';
import { issueTicket } from './stream.js';

export function publicUrl(req = null) {
  const set = String(settings.get('public_url', '') || '').replace(/\/+$/, '');
  if (set) return set;
  if (req) return `${req.protocol}://${req.headers.host}`;
  return '';
}

async function peerFetch(peer, path, { method = 'GET', body = null, timeout = 30000 } = {}) {
  let r;
  try {
    r = await fetch(peer.url + path, {
      method, signal: AbortSignal.timeout(timeout),
      headers: { Authorization: `Peer ${peer.out_key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new HttpError(502, `Server "${peer.name}" is niet bereikbaar.`); }
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new HttpError(r.status === 401 ? 502 : r.status, data?.error || `Server "${peer.name}" gaf een fout (${r.status}).`);
  return data;
}

async function requirePeer(req) {
  const h = req.headers.authorization || '';
  const peer = h.startsWith('Peer ') ? db.prepare('SELECT * FROM peers WHERE in_key_hash = ?').get(sha256(h.slice(5))) : null;
  if (!peer) throw new HttpError(401, 'Onbekende of ingetrokken koppeling.');
  req.peer = peer;
}

// ---------------------------------------------------------------------------
// Playing a file that lives on a linked server
// ---------------------------------------------------------------------------
const relay = (peer, p) => (typeof p === 'string' && p.startsWith('/api/') ? `/api/peer/${peer.id}/${p.slice(5)}` : p);

export async function remotePlay(file, body) {
  const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(file.peer_id);
  if (!peer || !peer.out_key) throw new HttpError(502, 'De koppeling met deze server bestaat niet meer.');
  const r = await peerFetch(peer, '/api/federation/play', { method: 'POST', body: { fileId: file.remote_id, quality: body.quality, audio: body.audio, caps: body.caps } });
  return {
    ...r, fileId: file.id, url: relay(peer, r.url), download: relay(peer, r.download),
    subtitles: (r.subtitles || []).map((s) => ({ ...s, url: relay(peer, s.url) })),
    via: peer.name,
  };
}
setRemotePlayer(remotePlay);
setRemoteSubs({
  async search(file, langs) {
    const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(file.peer_id);
    return peerFetch(peer, `/api/federation/files/${file.remote_id}/subtitles/search?langs=${encodeURIComponent(langs.join(','))}`);
  },
  async download(file, body) {
    const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(file.peer_id);
    const r = await peerFetch(peer, `/api/federation/files/${file.remote_id}/subtitles/download`, { method: 'POST', body });
    return { subtitle: { ...r.subtitle, url: relay(peer, r.subtitle.url) } };
  },
});

// ---------------------------------------------------------------------------
// Catalogue exchange
// ---------------------------------------------------------------------------
function exportCatalog(base) {
  const abs = (p) => (p ? base + p : null);
  const files = db.prepare(`SELECT f.* FROM files f JOIN libraries l ON l.id = f.library_id WHERE f.peer_id IS NULL AND l.shared = 1`).all();
  const titles = new Map();
  for (const f of files) {
    if (!titles.has(f.title_id)) {
      const t = db.prepare('SELECT * FROM titles WHERE id = ?').get(f.title_id);
      titles.set(f.title_id, {
        kind: t.kind, title: t.title, year: t.year, imdb_id: t.imdb_id, tmdb_id: t.tmdb_id, overview: t.overview, tagline: t.tagline,
        genres: json(t.genres, []), cast: json(t.cast_json, []), directors: json(t.directors, []), rating: t.rating, runtime: t.runtime,
        poster: abs(imgUrl('t', t.id, 'poster', t.poster)), backdrop: abs(imgUrl('t', t.id, 'backdrop', t.backdrop)), trailer: t.trailer,
        tmdb_collection: json(t.tmdb_collection, null), series: json(t.series_json, []), files: [],
      });
    }
    let ep = null;
    if (f.episode_id) {
      const e = db.prepare('SELECT * FROM episodes WHERE id = ?').get(f.episode_id);
      ep = { season: e.season, episode: e.episode, name: e.name, overview: e.overview, still: abs(imgUrl('e', e.id, 'still', e.still)), air_date: e.air_date };
    }
    titles.get(f.title_id).files.push({
      id: f.id, episode: ep, size: f.size, duration: f.duration, bitrate: f.bitrate, width: f.width, height: f.height,
      vcodec: f.vcodec, acodec: f.acodec, container: f.container, hdr: f.hdr, streams: json(f.streams, {}),
    });
  }
  return [...titles.values()];
}

const importCatalog = db.transaction((peer, titles) => {
  const seen = new Set();
  for (const rt of titles) {
    let t = findOrCreateTitle({ kind: rt.kind, title: rt.title, year: rt.year, imdb_id: rt.imdb_id });
    if (!t.meta_at) {
      // No local metadata yet: adopt what the other server already worked out.
      db.prepare(`UPDATE titles SET imdb_id = COALESCE(imdb_id, ?), tmdb_id = COALESCE(tmdb_id, ?), overview = ?, tagline = ?, genres = ?, cast_json = ?, directors = ?,
        rating = ?, runtime = ?, poster = ?, backdrop = ?, trailer = ?, tmdb_collection = ?, series_json = ?, meta_source = 'peer', meta_at = ? WHERE id = ?`)
        .run(rt.imdb_id && !db.prepare('SELECT 1 FROM titles WHERE kind = ? AND imdb_id = ? AND id != ?').get(rt.kind, rt.imdb_id, t.id) ? rt.imdb_id : null, rt.tmdb_id,
          rt.overview || '', rt.tagline || '', JSON.stringify(rt.genres || []), JSON.stringify(rt.cast || []), JSON.stringify(rt.directors || []),
          rt.rating, rt.runtime, rt.poster, rt.backdrop, rt.trailer, rt.tmdb_collection ? JSON.stringify(rt.tmdb_collection) : null, JSON.stringify(rt.series || []),
          // Titles we also hold locally keep meta_at empty so our own lookup still runs.
          db.prepare('SELECT 1 FROM files WHERE title_id = ? AND peer_id IS NULL').get(t.id) ? null : now(), t.id);
    }
    for (const rf of rt.files || []) {
      let epId = null;
      if (rf.episode) {
        const e = findOrCreateEpisode(t.id, rf.episode.season, rf.episode.episode, rf.episode.name || '');
        epId = e.id;
        if (!e.overview && !e.still) db.prepare("UPDATE episodes SET name = CASE WHEN name = '' THEN ? ELSE name END, overview = ?, still = ?, air_date = ? WHERE id = ?")
          .run(rf.episode.name || '', rf.episode.overview || '', rf.episode.still, rf.episode.air_date, e.id);
      }
      const cols = [t.id, epId, rf.size || 0, rf.duration || 0, rf.bitrate || 0, rf.width || 0, rf.height || 0, rf.vcodec || '', rf.acodec || '', rf.container || '', rf.hdr ? 1 : 0, JSON.stringify(rf.streams || {})];
      const prev = db.prepare('SELECT id FROM files WHERE peer_id = ? AND remote_id = ?').get(peer.id, rf.id);
      if (prev) db.prepare('UPDATE files SET title_id=?, episode_id=?, size=?, duration=?, bitrate=?, width=?, height=?, vcodec=?, acodec=?, container=?, hdr=?, streams=? WHERE id=?').run(...cols, prev.id);
      else db.prepare(`INSERT INTO files (peer_id, remote_id, path, title_id, episode_id, size, duration, bitrate, width, height, vcodec, acodec, container, hdr, streams, markers_done, added_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`).run(peer.id, rf.id, `peer:${peer.id}:${rf.id}`, ...cols, now());
      seen.add(rf.id);
    }
  }
  for (const f of db.prepare('SELECT id, remote_id FROM files WHERE peer_id = ?').all(peer.id)) if (!seen.has(f.remote_id)) db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
  pruneOrphans();
  rebuildCollections();
  return seen.size;
});

export async function syncPeer(peer) {
  if (!peer.out_key) return 0;
  try {
    const data = await peerFetch(peer, '/api/federation/catalog', { timeout: 120_000 });
    const n = importCatalog(peer, data.titles || []);
    db.prepare('UPDATE peers SET last_sync = ?, last_error = NULL, name = ? WHERE id = ?').run(now(), data.name || peer.name, peer.id);
    return n;
  } catch (e) {
    db.prepare('UPDATE peers SET last_error = ? WHERE id = ?').run(String(e.message || e), peer.id);
    throw e;
  }
}

export async function syncAllPeers() {
  for (const p of db.prepare('SELECT * FROM peers WHERE out_key IS NOT NULL').all()) { try { await syncPeer(p); } catch (e) { console.warn('[peer]', p.name, e.message); } }
}

function removePeer(id) {
  db.prepare('DELETE FROM peers WHERE id = ?').run(id); // files cascade
  pruneOrphans();
  rebuildCollections();
}

// ---------------------------------------------------------------------------
export default async function routes(app) {
  // ---- admin side ---------------------------------------------------------
  app.get('/api/admin/peers', { preHandler: requireAdmin }, async (req) => ({
    publicUrl: publicUrl(), guessedUrl: publicUrl(req),
    peers: db.prepare('SELECT id, name, url, last_sync, last_error, out_key IS NOT NULL AS receiving, in_key_hash IS NOT NULL AS sharing FROM peers ORDER BY name').all()
      .map((p) => ({ ...p, receiving: !!p.receiving, sharing: !!p.sharing, files: db.prepare('SELECT COUNT(*) c FROM files WHERE peer_id = ?').get(p.id).c })),
    invites: db.prepare('SELECT token, mutual, expires_at FROM peer_invites WHERE used = 0 AND expires_at > ?').all(now()).map((i) => ({ ...i, link: `${publicUrl(req)}/link/${i.token}` })),
  }));

  app.post('/api/admin/peers/invite', { preHandler: requireAdmin }, async (req) => {
    const token = randomToken(24);
    const mutual = req.body?.mutual !== false;
    db.prepare('INSERT INTO peer_invites (token, mutual, created_at, expires_at) VALUES (?,?,?,?)').run(token, mutual ? 1 : 0, now(), now() + 7 * 86400);
    return { link: `${publicUrl(req)}/link/${token}`, mutual };
  });
  app.delete('/api/admin/peers/invite/:token', { preHandler: requireAdmin }, async (req) => {
    db.prepare('DELETE FROM peer_invites WHERE token = ?').run(req.params.token);
    return { ok: true };
  });

  // Paste a link made on another server.
  app.post('/api/admin/peers/link', { preHandler: requireAdmin }, async (req) => {
    const m = /^(https?:\/\/[^\s]+?)\/link\/([A-Za-z0-9_-]{16,})\/?$/.exec(String(req.body?.link || '').trim());
    if (!m) throw new HttpError(400, 'Dit is geen geldige Kinoko-koppellink.');
    const [, url, token] = m;
    const info = await fetch(`${url}/api/federation/invite/${token}`, { signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!info) throw new HttpError(502, 'Die server is niet bereikbaar of de link is verlopen.');
    if (info.id === settings.get('server_id')) throw new HttpError(400, 'Dit is een link van deze server zelf.');
    const mine = publicUrl(req);
    // If they want our libraries too, hand them a key to call us with.
    const keyForThem = info.mutual ? randomToken(32) : null;
    let res;
    try {
      const r = await fetch(`${url}/api/federation/accept`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ token, name: settings.get('server_name'), id: settings.get('server_id'), url: mine, key: keyForThem }),
      });
      res = await r.json();
      if (!r.ok) throw new HttpError(r.status, res.error || 'Koppelen geweigerd.');
    } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(502, 'Koppelen is mislukt: de andere server reageerde niet.'); }
    db.prepare('DELETE FROM peers WHERE url = ?').run(url);
    const ins = db.prepare('INSERT INTO peers (name, url, out_key, in_key_hash, created_at) VALUES (?,?,?,?,?)')
      .run(res.name, url, res.key, keyForThem ? sha256(keyForThem) : null, now());
    const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(ins.lastInsertRowid);
    let titles = 0; try { titles = await syncPeer(peer); } catch { /* shown as last_error in the list */ }
    return { ok: true, name: res.name, files: titles, mutual: !!info.mutual };
  });

  app.post('/api/admin/peers/:id/sync', { preHandler: requireAdmin }, async (req) => {
    const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(req.params.id);
    if (!peer) throw new HttpError(404, 'Koppeling niet gevonden.');
    return { files: await syncPeer(peer) };
  });
  app.delete('/api/admin/peers/:id', { preHandler: requireAdmin }, async (req) => {
    const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(req.params.id);
    if (peer?.out_key) peerFetch(peer, '/api/federation/unlink', { method: 'POST', timeout: 8000 }).catch(() => {});
    removePeer(req.params.id);
    return { ok: true };
  });

  // ---- server-to-server ---------------------------------------------------
  app.get('/api/federation/invite/:token', async (req) => {
    const inv = db.prepare('SELECT * FROM peer_invites WHERE token = ? AND used = 0 AND expires_at > ?').get(req.params.token, now());
    if (!inv) throw new HttpError(404, 'Deze koppellink is verlopen of al gebruikt.');
    return { name: settings.get('server_name'), id: settings.get('server_id'), mutual: !!inv.mutual };
  });

  app.post('/api/federation/accept', async (req) => {
    const { token, name, url, key } = req.body || {};
    const inv = db.prepare('SELECT * FROM peer_invites WHERE token = ? AND used = 0 AND expires_at > ?').get(String(token || ''), now());
    if (!inv) throw new HttpError(403, 'Deze koppellink is verlopen of al gebruikt.');
    const cleanUrl = String(url || '').replace(/\/+$/, '');
    if (!/^https?:\/\/.+/.test(cleanUrl)) throw new HttpError(400, 'De andere server gaf geen geldig adres door.');
    const wantBack = inv.mutual && typeof key === 'string' && key.length >= 24;
    const keyForThem = randomToken(32);
    db.prepare('UPDATE peer_invites SET used = 1 WHERE token = ?').run(inv.token);
    db.prepare('DELETE FROM peers WHERE url = ?').run(cleanUrl);
    const ins = db.prepare('INSERT INTO peers (name, url, out_key, in_key_hash, created_at) VALUES (?,?,?,?,?)')
      .run(String(name || 'Kinoko').slice(0, 60), cleanUrl, wantBack ? key : null, sha256(keyForThem), now());
    if (wantBack) {
      const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(ins.lastInsertRowid);
      setTimeout(() => syncPeer(peer).catch(() => {}), 3000);
    }
    return { name: settings.get('server_name'), id: settings.get('server_id'), key: keyForThem };
  });

  app.get('/api/federation/catalog', { preHandler: requirePeer }, async (req) => ({
    name: settings.get('server_name'), titles: exportCatalog(publicUrl(req)),
  }));

  const sharedFile = (id) => {
    const f = db.prepare('SELECT f.* FROM files f JOIN libraries l ON l.id = f.library_id WHERE f.id = ? AND f.peer_id IS NULL AND l.shared = 1').get(id);
    if (!f) throw new HttpError(404, 'Dit bestand wordt niet (meer) gedeeld.');
    return f;
  };
  app.post('/api/federation/play', { preHandler: requirePeer }, async (req) => playLocal(sharedFile(Number(req.body?.fileId)), req.body || {}));
  app.get('/api/federation/files/:id/subtitles/search', { preHandler: requirePeer }, async (req) => ({
    results: await searchOnline(sharedFile(req.params.id), String(req.query.langs || 'nl,en').split(',')),
  }));
  app.post('/api/federation/files/:id/subtitles/download', { preHandler: requirePeer }, async (req) => {
    const file = sharedFile(req.params.id);
    const sub = await downloadOnline(file, req.body || {});
    const row = db.prepare('SELECT id, lang, label, source FROM subtitles WHERE id = ?').get(sub.id);
    return { subtitle: { ...row, url: `/api/subs/${row.id}/${issueTicket(file.id)}.vtt` } };
  });
  app.post('/api/federation/unlink', { preHandler: requirePeer }, async (req) => { removePeer(req.peer.id); return { ok: true }; });

  // ---- relay: our clients reach a linked server's streams through us ------
  app.get('/api/peer/:id/*', async (req, reply) => {
    const peer = db.prepare('SELECT * FROM peers WHERE id = ?').get(req.params.id);
    const rest = req.params['*'];
    // Only ticketed media paths are relayed; they carry their own credential.
    if (!peer || !/^(stream|hls|subs)\//.test(rest)) throw new HttpError(404, 'Niet gevonden.');
    const qs = req.raw.url.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
    const ctl = new AbortController();
    req.raw.on('close', () => ctl.abort());
    let r;
    try { r = await fetch(`${peer.url}/api/${rest}${qs}`, { headers: req.headers.range ? { Range: req.headers.range } : {}, signal: ctl.signal }); }
    catch { throw new HttpError(502, `Server "${peer.name}" is niet bereikbaar.`); }
    reply.code(r.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'cache-control']) {
      const v = r.headers.get(h); if (v) reply.header(h, v);
    }
    return reply.send(r.body ? Readable.fromWeb(r.body) : '');
  });
}
