// Live TV: Xtream Codes accounts and M3U playlists, configured once by the
// admin and available on every device.
import { Readable } from 'node:stream';
import { db, now, sha256, settings, randomToken, HttpError } from './db.js';
import { requireUser, requireAdmin } from './auth.js';

if (!settings.get('iptv_secret')) settings.set('iptv_secret', randomToken(24));
const sign = (id) => sha256(`${settings.get('iptv_secret')}:${id}`).slice(0, 24);

async function getText(url, timeout = 60000) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Kinoko/0.1' }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

export function parseM3u(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) {
      const attr = (k) => { const m = line.match(new RegExp(`${k}="([^"]*)"`, 'i')); return m ? m[1] : ''; };
      cur = { name: line.slice(line.lastIndexOf(',') + 1).trim() || attr('tvg-name'), logo: attr('tvg-logo') || null, category: attr('group-title') || 'Overig', ext_id: attr('tvg-id') };
    } else if (line && !line.startsWith('#') && cur) {
      out.push({ ...cur, url: line, ext_id: cur.ext_id || sha256(line).slice(0, 16) });
      cur = null;
    }
  }
  return out;
}

const xtreamBase = (s) => s.url.replace(/\/+$/, '');
const xtreamApi = (s, params) => `${xtreamBase(s)}/player_api.php?${new URLSearchParams({ username: s.username, password: s.password, ...params })}`;

async function fetchChannels(src) {
  if (src.kind === 'm3u') return parseM3u(await getText(src.url));
  const [cats, streams] = await Promise.all([
    getText(xtreamApi(src, { action: 'get_live_categories' })).then(JSON.parse),
    getText(xtreamApi(src, { action: 'get_live_streams' })).then(JSON.parse),
  ]);
  if (!Array.isArray(streams)) throw new Error('Provider gaf geen zenderlijst (controleer de inloggegevens).');
  const catName = new Map((Array.isArray(cats) ? cats : []).map((c) => [String(c.category_id), c.category_name]));
  return streams.map((s) => ({
    ext_id: String(s.stream_id), name: s.name || `Zender ${s.stream_id}`, logo: s.stream_icon || null,
    category: catName.get(String(s.category_id)) || 'Overig',
    url: `${xtreamBase(src)}/live/${encodeURIComponent(src.username)}/${encodeURIComponent(src.password)}/${s.stream_id}.ts`,
  }));
}

export async function syncSource(src) {
  try {
    const channels = await fetchChannels(src);
    db.transaction(() => {
      const keep = new Set();
      const up = db.prepare(`INSERT INTO iptv_channels (source_id, ext_id, name, logo, category, url, ord) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(source_id, ext_id) DO UPDATE SET name = excluded.name, logo = excluded.logo, category = excluded.category, url = excluded.url, ord = excluded.ord`);
      channels.forEach((c, i) => { up.run(src.id, c.ext_id, c.name, c.logo, c.category, c.url, i); keep.add(c.ext_id); });
      for (const row of db.prepare('SELECT id, ext_id FROM iptv_channels WHERE source_id = ?').all(src.id)) if (!keep.has(row.ext_id)) db.prepare('DELETE FROM iptv_channels WHERE id = ?').run(row.id);
      db.prepare('UPDATE iptv_sources SET last_sync = ?, last_error = NULL WHERE id = ?').run(now(), src.id);
    })();
    return channels.length;
  } catch (e) {
    db.prepare('UPDATE iptv_sources SET last_error = ? WHERE id = ?').run(String(e.message || e).slice(0, 200), src.id);
    throw new HttpError(502, `Zenders ophalen mislukt: ${e.message || e}`);
  }
}

export async function syncAllSources() {
  for (const s of db.prepare('SELECT * FROM iptv_sources').all()) { try { await syncSource(s); } catch (e) { console.warn('[iptv]', s.name, e.message); } }
}

function channelOut(c, favs, proxy) {
  return {
    id: c.id, name: c.name, logo: c.logo, category: c.category, favorite: favs.has(c.id),
    // With relay on, the provider URL (and its credentials) never leaves the server.
    url: proxy.get(c.source_id) ? `/api/iptv/stream/${c.id}/${sign(c.id)}` : c.url,
  };
}

export default async function routes(app) {
  app.get('/api/iptv', { preHandler: requireUser }, async (req) => {
    const favs = new Set(db.prepare('SELECT channel_id FROM iptv_favs WHERE user_id = ?').all(req.user.id).map((r) => r.channel_id));
    const proxy = new Map(db.prepare('SELECT id, proxy FROM iptv_sources').all().map((s) => [s.id, !!s.proxy]));
    const cats = db.prepare('SELECT category, COUNT(*) n FROM iptv_channels GROUP BY category ORDER BY MIN(ord)').all();
    const { category, q, fav } = req.query;
    let rows;
    if (fav) rows = db.prepare('SELECT c.* FROM iptv_channels c JOIN iptv_favs f ON f.channel_id = c.id WHERE f.user_id = ? ORDER BY c.name').all(req.user.id);
    else if (q) rows = db.prepare("SELECT * FROM iptv_channels WHERE name LIKE ? ESCAPE '\\' ORDER BY ord LIMIT 300").all(`%${String(q).replace(/[\\%_]/g, '\\$&')}%`);
    else if (category) rows = db.prepare('SELECT * FROM iptv_channels WHERE category = ? ORDER BY ord LIMIT 2000').all(category);
    else rows = [];
    return { enabled: cats.length > 0, categories: cats.map((c) => ({ name: c.category, count: c.n })), favorites: favs.size, channels: rows.map((c) => channelOut(c, favs, proxy)) };
  });

  app.put('/api/iptv/fav/:id', { preHandler: requireUser }, async (req) => {
    db.prepare('INSERT OR IGNORE INTO iptv_favs (user_id, channel_id) VALUES (?,?)').run(req.user.id, req.params.id);
    return { favorite: true };
  });
  app.delete('/api/iptv/fav/:id', { preHandler: requireUser }, async (req) => {
    db.prepare('DELETE FROM iptv_favs WHERE user_id = ? AND channel_id = ?').run(req.user.id, req.params.id);
    return { favorite: false };
  });

  // Now/next from the provider's short guide (Xtream only).
  app.get('/api/iptv/:id/epg', { preHandler: requireUser }, async (req) => {
    const c = db.prepare('SELECT c.*, s.kind, s.url surl, s.username, s.password FROM iptv_channels c JOIN iptv_sources s ON s.id = c.source_id WHERE c.id = ?').get(req.params.id);
    if (!c) throw new HttpError(404, 'Zender niet gevonden.');
    if (c.kind !== 'xtream') return { programs: [] };
    try {
      const data = JSON.parse(await getText(xtreamApi({ url: c.surl, username: c.username, password: c.password }, { action: 'get_short_epg', stream_id: c.ext_id, limit: '3' }), 10000));
      const b64 = (s) => { try { return Buffer.from(String(s || ''), 'base64').toString('utf8'); } catch { return ''; } };
      return { programs: (data.epg_listings || []).map((p) => ({ title: b64(p.title), description: b64(p.description), start: Number(p.start_timestamp) || 0, end: Number(p.stop_timestamp) || 0 })) };
    } catch { return { programs: [] }; }
  });

  app.get('/api/iptv/stream/:id/:sig', async (req, reply) => {
    if (req.params.sig !== sign(req.params.id)) throw new HttpError(403, 'Ongeldige link.');
    const c = db.prepare('SELECT url FROM iptv_channels WHERE id = ?').get(req.params.id);
    if (!c) throw new HttpError(404, 'Zender niet gevonden.');
    const ctl = new AbortController();
    req.raw.on('close', () => ctl.abort());
    let r;
    try { r = await fetch(c.url, { headers: { 'User-Agent': 'Kinoko/0.1' }, signal: ctl.signal }); }
    catch { throw new HttpError(502, 'De zender is niet bereikbaar.'); }
    if (!r.ok || !r.body) throw new HttpError(502, `De provider gaf een fout (${r.status}).`);
    reply.header('Content-Type', r.headers.get('content-type') || 'video/mp2t').header('Cache-Control', 'no-store');
    return reply.send(Readable.fromWeb(r.body));
  });

  // ---- admin --------------------------------------------------------------
  app.get('/api/admin/iptv', { preHandler: requireAdmin }, async () => ({
    sources: db.prepare('SELECT id, name, kind, url, username, proxy, last_sync, last_error FROM iptv_sources ORDER BY id').all()
      .map((s) => ({ ...s, proxy: !!s.proxy, channels: db.prepare('SELECT COUNT(*) c FROM iptv_channels WHERE source_id = ?').get(s.id).c })),
  }));
  app.post('/api/admin/iptv', { preHandler: requireAdmin }, async (req) => {
    const { name, kind, url, username = '', password = '', proxy = false } = req.body || {};
    if (!['xtream', 'm3u'].includes(kind)) throw new HttpError(400, 'Kies Xtream of M3U.');
    if (!/^https?:\/\/.+/.test(String(url || ''))) throw new HttpError(400, 'Vul een geldig adres in (http:// of https://).');
    if (kind === 'xtream' && (!username || !password)) throw new HttpError(400, 'Xtream heeft een gebruikersnaam en wachtwoord nodig.');
    const ins = db.prepare('INSERT INTO iptv_sources (name, kind, url, username, password, proxy) VALUES (?,?,?,?,?,?)')
      .run(String(name || '').trim() || (kind === 'xtream' ? 'IPTV' : 'Playlist'), kind, String(url).trim(), username, password, proxy ? 1 : 0);
    const src = db.prepare('SELECT * FROM iptv_sources WHERE id = ?').get(ins.lastInsertRowid);
    try { return { id: src.id, channels: await syncSource(src) }; }
    catch (e) { db.prepare('DELETE FROM iptv_sources WHERE id = ?').run(src.id); throw e; }
  });
  app.put('/api/admin/iptv/:id', { preHandler: requireAdmin }, async (req) => {
    db.prepare('UPDATE iptv_sources SET proxy = ? WHERE id = ?').run(req.body?.proxy ? 1 : 0, req.params.id);
    return { ok: true };
  });
  app.post('/api/admin/iptv/:id/sync', { preHandler: requireAdmin }, async (req) => {
    const src = db.prepare('SELECT * FROM iptv_sources WHERE id = ?').get(req.params.id);
    if (!src) throw new HttpError(404, 'Bron niet gevonden.');
    return { channels: await syncSource(src) };
  });
  app.delete('/api/admin/iptv/:id', { preHandler: requireAdmin }, async (req) => {
    db.prepare('DELETE FROM iptv_sources WHERE id = ?').run(req.params.id);
    return { ok: true };
  });
}
