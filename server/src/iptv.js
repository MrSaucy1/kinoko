// Live TV: Xtream Codes accounts and M3U playlists, configured once by the
// admin and available on every device.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { db, now, sha256, settings, randomToken, HttpError } from './db.js';
import { requireUser, requireAdmin } from './auth.js';
import { config, dataPath } from './config.js';

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

// ---------------------------------------------------------------------------
// Country grouping: providers put the country in the category name
// ("NL | SPORT", "[UK] Kids", "DE: Filme", "Nederland HD").
// ---------------------------------------------------------------------------
const COUNTRIES = {
  NL: 'Nederland', BE: 'België', DE: 'Duitsland', UK: 'Verenigd Koninkrijk', GB: 'Verenigd Koninkrijk', IE: 'Ierland', US: 'Verenigde Staten', USA: 'Verenigde Staten',
  CA: 'Canada', FR: 'Frankrijk', ES: 'Spanje', IT: 'Italië', PT: 'Portugal', TR: 'Turkije', PL: 'Polen', AT: 'Oostenrijk', CH: 'Zwitserland', LU: 'Luxemburg',
  DK: 'Denemarken', SE: 'Zweden', NO: 'Noorwegen', FI: 'Finland', IS: 'IJsland', GR: 'Griekenland', RO: 'Roemenië', BG: 'Bulgarije', HU: 'Hongarije', CZ: 'Tsjechië',
  SK: 'Slowakije', SI: 'Slovenië', HR: 'Kroatië', RS: 'Servië', BA: 'Bosnië', MK: 'Noord-Macedonië', AL: 'Albanië', XK: 'Kosovo', ME: 'Montenegro', UA: 'Oekraïne',
  RU: 'Rusland', LT: 'Litouwen', LV: 'Letland', EE: 'Estland', MA: 'Marokko', DZ: 'Algerije', TN: 'Tunesië', EG: 'Egypte', IL: 'Israël', IR: 'Iran', IQ: 'Irak',
  SA: 'Saoedi-Arabië', AE: 'Emiraten', IN: 'India', PK: 'Pakistan', AF: 'Afghanistan', CN: 'China', JP: 'Japan', KR: 'Zuid-Korea', TH: 'Thailand', VN: 'Vietnam',
  PH: 'Filipijnen', ID: 'Indonesië', AU: 'Australië', NZ: 'Nieuw-Zeeland', BR: 'Brazilië', MX: 'Mexico', CO: 'Colombia', CL: 'Chili', SR: 'Suriname', ZA: 'Zuid-Afrika',
  AR: 'Arabisch', ARA: 'Arabisch', KU: 'Koerdisch', LAT: 'Latijns-Amerika', LATAM: 'Latijns-Amerika', AFR: 'Afrika', EXYU: 'Ex-Joegoslavië', EU: 'Europa',
};
const COUNTRY_WORDS = {
  NEDERLAND: 'NL', NETHERLANDS: 'NL', HOLLAND: 'NL', DUTCH: 'NL', BELGIE: 'BE', 'BELGIË': 'BE', BELGIUM: 'BE', DEUTSCHLAND: 'DE', GERMANY: 'DE', DUITSLAND: 'DE',
  ENGLAND: 'UK', FRANCE: 'FR', FRANKRIJK: 'FR', SPAIN: 'ES', SPANJE: 'ES', 'ESPAÑA': 'ES', ITALY: 'IT', ITALIA: 'IT', 'ITALIË': 'IT', PORTUGAL: 'PT', TURKEY: 'TR',
  'TÜRKIYE': 'TR', TURKIYE: 'TR', TURKIJE: 'TR', POLAND: 'PL', POLSKA: 'PL', POLEN: 'PL', AUSTRIA: 'AT', SWITZERLAND: 'CH', DENMARK: 'DK', SWEDEN: 'SE', NORWAY: 'NO',
  FINLAND: 'FI', GREECE: 'GR', ROMANIA: 'RO', BULGARIA: 'BG', HUNGARY: 'HU', CROATIA: 'HR', SERBIA: 'RS', ALBANIA: 'AL', UKRAINE: 'UA', RUSSIA: 'RU', MOROCCO: 'MA',
  MAROC: 'MA', MAROKKO: 'MA', INDIA: 'IN', PAKISTAN: 'PK', CANADA: 'CA', BRAZIL: 'BR', BRASIL: 'BR', MEXICO: 'MX', ARABIC: 'AR', ARAB: 'AR', KURDISH: 'KU', IRAN: 'IR',
  SURINAME: 'SR', AFRICA: 'AFR', LATINO: 'LAT', IRELAND: 'IE', AUSTRALIA: 'AU',
};
const WORDY = new Set(['IN', 'NO', 'IS', 'AT', 'ME', 'ID', 'AL', 'SA', 'MA', 'EU']);
const OTHER = { code: '', name: 'Overig' };
const tidy = (s) => s.replace(/^[\s|:\-–—▎►➤✦•★*#/\]\[)(]+|[\s|:\-–—▎►➤✦•★*#/\]\[)(]+$/g, '').trim();

/** "NL | SPORT" → { code: 'NL', country: 'Nederland', label: 'SPORT' } */
export function splitCategory(raw) {
  const name = String(raw || '').trim();
  const out = (code, rest) => ({ code: code === 'GB' ? 'UK' : code === 'USA' ? 'US' : code, country: COUNTRIES[code], label: tidy(rest) || 'Algemeen' });
  // A code up front, behind any decoration: "|NL| Sport", "[UK] Kids", "DE: Filme", "NL SPORT", "EX-YU | Sport".
  const m = name.replace(/^EX[\s-]?YU/i, 'EXYU').match(/^[^\p{L}\p{N}]*([A-Z]{2,5})(?![\p{L}\p{N}])(.*)$/u);
  // Codes that are also everyday words only count with a separator behind them ("NO | Sport", not "NO SIGNAL").
  if (m && COUNTRIES[m[1]] && !(WORDY.has(m[1]) && /^\s+[\p{L}\p{N}]/u.test(m[2]))) return out(m[1], m[2]);
  // A country name up front: "Nederland HD", "Germany | Sport".
  const w = name.match(/^[^\p{L}\p{N}]*([\p{L}]{4,})(?![\p{L}\p{N}])(.*)$/u);
  if (w && COUNTRY_WORDS[w[1].toUpperCase()]) return out(COUNTRY_WORDS[w[1].toUpperCase()], w[2]);
  return { code: OTHER.code, country: OTHER.name, label: name || 'Overig' };
}

/** Categories grouped per country, in the provider's order ("Overig" last). */
export function groupCategories(cats) {
  const groups = new Map();
  for (const c of cats) {
    const s = splitCategory(c.name);
    if (!groups.has(s.code)) groups.set(s.code, { code: s.code, name: s.country, count: 0, categories: [] });
    const g = groups.get(s.code);
    g.count += c.count;
    g.categories.push({ name: c.name, label: s.label, count: c.count });
  }
  const list = [...groups.values()];
  return [...list.filter((g) => g.code), ...list.filter((g) => !g.code)];
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

/** The coming programmes of a channel from the provider's guide (Xtream only); [] when there is none. */
export async function guide(channelId, limit = 3) {
  const c = db.prepare('SELECT c.*, s.kind, s.url surl, s.username, s.password FROM iptv_channels c JOIN iptv_sources s ON s.id = c.source_id WHERE c.id = ?').get(channelId);
  if (!c || c.kind !== 'xtream') return [];
  try {
    const data = JSON.parse(await getText(xtreamApi({ url: c.surl, username: c.username, password: c.password }, { action: 'get_short_epg', stream_id: c.ext_id, limit: String(Math.max(1, Math.min(60, limit))) }), 10000));
    const b64 = (s) => { try { return Buffer.from(String(s || ''), 'base64').toString('utf8'); } catch { return ''; } };
    return (data.epg_listings || []).map((p) => ({ title: b64(p.title), description: b64(p.description), start: Number(p.start_timestamp) || 0, end: Number(p.stop_timestamp) || 0 })).filter((p) => p.start > 0 && p.end > p.start);
  } catch { return []; }
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

// ---------------------------------------------------------------------------
// Live relay: ffmpeg pulls the channel once and repackages it as HLS. That
// plays in every browser (which can't do raw MPEG-TS, mixed content or a
// provider without CORS headers) and keeps the provider login on the server.
// Viewers of the same channel share one provider connection.
// ---------------------------------------------------------------------------
const live = new Map(); // channel id → session
const LIVE_IDLE = 30_000;

function stopLive(id) {
  const s = live.get(id);
  if (!s) return;
  live.delete(id);
  try { s.proc.kill('SIGKILL'); } catch { /* already gone */ }
  fs.rm(s.dir, { recursive: true, force: true }, () => {});
}

function startLive(channel) {
  const dir = dataPath('transcode', `live-${channel.id}-${randomToken(4)}`);
  fs.mkdirSync(dir, { recursive: true });
  const args = ['-hide_banner', '-loglevel', 'error', '-user_agent', 'VLC/3.0.20 LibVLC/3.0.20',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', channel.url,
    '-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '8', '-hls_flags', 'delete_segments+omit_endlist',
    '-hls_segment_filename', path.join(dir, '%05d.ts'), path.join(dir, 'index.m3u8')];
  const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const s = { dir, proc, last: Date.now(), error: '', exited: false };
  proc.stderr.on('data', (d) => { s.error = (s.error + d).slice(-600); });
  proc.on('error', (e) => { s.exited = true; s.error = e.message; });
  proc.on('exit', () => { s.exited = true; if (live.get(channel.id) === s) stopLive(channel.id); });
  live.set(channel.id, s);
  return s;
}

setInterval(() => { const n = Date.now(); for (const [id, s] of live) if (n - s.last > LIVE_IDLE) stopLive(id); }, 10_000).unref();
for (const d of fs.readdirSync(dataPath('transcode'))) if (d.startsWith('live-')) fs.rmSync(dataPath('transcode', d), { recursive: true, force: true });
process.on('exit', () => { for (const s of live.values()) { try { s.proc.kill('SIGKILL'); } catch { /* gone */ } } });

export default async function routes(app) {
  // Channels carry no age rating, so an account with an age limit gets no live tv at all.
  const isKid = (u) => u.role !== 'admin' && Number.isInteger(u.max_age);
  const noKids = async (req) => { await requireUser(req); if (isKid(req.user)) throw new HttpError(403, 'Live tv is niet beschikbaar voor dit account.'); };

  app.post('/api/iptv/:id/live', { preHandler: noKids }, async (req) => {
    const c = db.prepare('SELECT id, url FROM iptv_channels WHERE id = ?').get(req.params.id);
    if (!c) throw new HttpError(404, 'Zender niet gevonden.');
    const s = live.get(c.id) || startLive(c);
    s.last = Date.now();
    const playlist = path.join(s.dir, 'index.m3u8');
    for (let i = 0; i < 100 && !s.exited && !fs.existsSync(playlist); i++) { await new Promise((r) => setTimeout(r, 200)); s.last = Date.now(); }
    if (!fs.existsSync(playlist)) {
      const why = s.error.trim().split('\n').pop() || '';
      stopLive(c.id);
      console.warn('[iptv] zender start niet:', why);
      throw new HttpError(502, /40[134]|Forbidden|Unauthorized/i.test(why) ? 'De provider weigert deze zender (abonnement verlopen of te veel gelijktijdige kijkers?).' : 'Deze zender geeft op dit moment geen beeld.');
    }
    return { url: `/api/iptv/live/${c.id}/${sign(c.id)}/index.m3u8` };
  });

  app.get('/api/iptv/live/:id/:sig/:file', async (req, reply) => {
    if (req.params.sig !== sign(req.params.id)) throw new HttpError(403, 'Ongeldige link.');
    const s = live.get(Number(req.params.id));
    const file = req.params.file;
    if (!s || !/^(index\.m3u8|\d{5}\.ts)$/.test(file)) throw new HttpError(404, 'De zender is gestopt.');
    s.last = Date.now();
    let buf; try { buf = await fs.promises.readFile(path.join(s.dir, file)); } catch { throw new HttpError(404, 'Segment niet gevonden.'); }
    return reply.header('Content-Type', file.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl').header('Cache-Control', 'no-store').send(buf);
  });

  app.get('/api/iptv', { preHandler: requireUser }, async (req) => {
    if (isKid(req.user)) return { enabled: false, categories: [], groups: [], favorites: 0, channels: [] };
    const favs = new Set(db.prepare('SELECT channel_id FROM iptv_favs WHERE user_id = ?').all(req.user.id).map((r) => r.channel_id));
    const proxy = new Map(db.prepare('SELECT id, proxy FROM iptv_sources').all().map((s) => [s.id, !!s.proxy]));
    const cats = db.prepare('SELECT category, COUNT(*) n FROM iptv_channels GROUP BY category ORDER BY MIN(ord)').all();
    const { category, q, fav } = req.query;
    let rows;
    if (fav) rows = db.prepare('SELECT c.* FROM iptv_channels c JOIN iptv_favs f ON f.channel_id = c.id WHERE f.user_id = ? ORDER BY c.name').all(req.user.id);
    else if (q) rows = db.prepare("SELECT * FROM iptv_channels WHERE name LIKE ? ESCAPE '\\' ORDER BY ord LIMIT 300").all(`%${String(q).replace(/[\\%_]/g, '\\$&')}%`);
    else if (category) rows = db.prepare('SELECT * FROM iptv_channels WHERE category = ? ORDER BY ord LIMIT 2000').all(category);
    else rows = [];
    const categories = cats.map((c) => ({ name: c.category, count: c.n }));
    return { enabled: cats.length > 0, categories, groups: groupCategories(categories), favorites: favs.size, channels: rows.map((c) => channelOut(c, favs, proxy)) };
  });

  app.put('/api/iptv/fav/:id', { preHandler: noKids }, async (req) => {
    db.prepare('INSERT OR IGNORE INTO iptv_favs (user_id, channel_id) VALUES (?,?)').run(req.user.id, req.params.id);
    return { favorite: true };
  });
  app.delete('/api/iptv/fav/:id', { preHandler: requireUser }, async (req) => {
    db.prepare('DELETE FROM iptv_favs WHERE user_id = ? AND channel_id = ?').run(req.user.id, req.params.id);
    return { favorite: false };
  });

  // Now/next from the provider's short guide (Xtream only).
  app.get('/api/iptv/:id/epg', { preHandler: noKids }, async (req) => {
    if (!db.prepare('SELECT 1 FROM iptv_channels WHERE id = ?').get(req.params.id)) throw new HttpError(404, 'Zender niet gevonden.');
    return { programs: await guide(req.params.id, 3) };
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
