// Requests: a user looks up a film or series that is not in the library and
// asks for it; the admin approves or declines. An approved request can be
// handed to Radarr/Sonarr when their address and API key are set.
// Also here: the webhook Sonarr/Radarr call when they have imported something.
import crypto from 'node:crypto';
import { db, now, settings, randomToken, HttpError } from './db.js';
import { requireUser, requireAdmin } from './auth.js';
import { normKey } from './parse.js';
import { scanPath, onScanFinished } from './library.js';
import { emit } from './webhooks.js';
import { notifyUser } from './events.js';
import { audit } from './audit.js';

const UA = 'Kinoko (self-hosted media server)';
async function getJson(url, { headers = {}, timeout = 12000, method = 'GET', body } = {}) {
  try {
    const r = await fetch(url, { method, headers: { 'User-Agent': UA, Accept: 'application/json', ...(body && { 'content-type': 'application/json' }), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: null }; }
}

const isKid = (u) => u.role !== 'admin' && Number.isInteger(u.max_age);
const noKids = async (req) => { await requireUser(req); if (isKid(req.user)) throw new HttpError(403, 'Verzoeken zijn niet beschikbaar voor dit account.'); };

/** Is this already in the library? By IMDb id when we have one, else by name and year. */
function inLibrary(kind, title, year, imdbId) {
  if (imdbId && db.prepare('SELECT 1 FROM titles WHERE kind = ? AND imdb_id = ? AND id IN (SELECT title_id FROM files)').get(kind, imdbId)) return true;
  const key = kind === 'show' ? normKey(title, null) : normKey(title, year);
  return !!db.prepare('SELECT 1 FROM titles WHERE kind = ? AND norm_key = ? AND id IN (SELECT title_id FROM files)').get(kind, key);
}

// ---- search -------------------------------------------------------------------
async function searchTmdb(q, kind) {
  const key = settings.get('tmdb_key', '');
  const type = kind === 'show' ? 'tv' : 'movie';
  const params = new URLSearchParams({ query: q, language: settings.get('meta_lang', 'nl-NL'), include_adult: 'false' });
  const headers = {};
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; else params.set('api_key', key);
  const r = await getJson(`https://api.themoviedb.org/3/search/${type}?${params}`, { headers });
  if (!r.ok) return null;
  return (r.data?.results || []).slice(0, 20).map((m) => ({
    kind, title: m.title || m.name, year: Number(String(m.release_date || m.first_air_date || '').slice(0, 4)) || null, tmdbId: m.id, imdbId: null,
    poster: m.poster_path ? `https://image.tmdb.org/t/p/w342${m.poster_path}` : null, overview: m.overview || '',
  }));
}
async function searchCinemeta(q, kind) {
  const type = kind === 'show' ? 'series' : 'movie';
  const r = await getJson(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(q)}.json`);
  if (!r.ok) return null;
  return (r.data?.metas || []).slice(0, 20).map((m) => ({
    kind, title: m.name, year: Number(String(m.releaseInfo || m.year || '').slice(0, 4)) || null, tmdbId: null, imdbId: /^tt\d+$/.test(m.imdb_id || m.id || '') ? (m.imdb_id || m.id) : null,
    poster: m.poster || null, overview: m.description || '',
  }));
}

// ---- Radarr / Sonarr ------------------------------------------------------------
const arr = (which) => ({ url: String(settings.get(`${which}_url`, '') || '').replace(/\/+$/, ''), key: settings.get(`${which}_key`, '') || '' });
const maskKey = (k) => (k ? `••••${k.slice(-4)}` : '');

/** Hands an approved request to Radarr or Sonarr. Returns '' on success or a short reason. */
export async function forward(req) {
  const which = req.kind === 'movie' ? 'radarr' : 'sonarr';
  const { url, key } = arr(which);
  if (!url || !key) return null;   // not configured: nothing to do
  const h = { 'X-Api-Key': key };
  const term = req.imdb_id ? `imdb:${req.imdb_id}` : req.tmdb_id && which === 'radarr' ? `tmdb:${req.tmdb_id}` : `${req.title}${req.year ? ` ${req.year}` : ''}`;
  const res = which === 'radarr' ? 'movie' : 'series';
  const look = await getJson(`${url}/api/v3/${res}/lookup?term=${encodeURIComponent(term)}`, { headers: h });
  if (!look.ok) return look.status === 401 ? 'API-sleutel geweigerd' : 'niet bereikbaar';
  const hit = (look.data || [])[0];
  if (!hit) return 'titel niet gevonden';
  if (hit.id) return '';   // already there
  const [roots, profiles] = await Promise.all([getJson(`${url}/api/v3/rootfolder`, { headers: h }), getJson(`${url}/api/v3/qualityprofile`, { headers: h })]);
  const root = roots.data?.[0]?.path, profile = profiles.data?.[0]?.id;
  if (!root || !profile) return 'geen map of kwaliteitsprofiel ingesteld';
  const body = { ...hit, rootFolderPath: root, qualityProfileId: profile, monitored: true,
    addOptions: which === 'radarr' ? { searchForMovie: true } : { searchForMissingEpisodes: true }, ...(which === 'sonarr' && { seasonFolder: true }) };
  const add = await getJson(`${url}/api/v3/${res}`, { method: 'POST', headers: h, body, timeout: 20000 });
  return add.ok ? '' : `toevoegen mislukt (${add.status || 'geen antwoord'})`;
}

const out = (r, names) => ({
  id: r.id, kind: r.kind, title: r.title, year: r.year, poster: r.poster, overview: r.overview, status: r.status, note: r.note,
  forwarded: r.forwarded === 'radarr' || r.forwarded === 'sonarr' ? r.forwarded : '', forwardError: r.forwarded && !['radarr', 'sonarr'].includes(r.forwarded) ? r.forwarded : '',
  created_at: r.created_at, decided_at: r.decided_at, ...(names && { user: names.get(r.user_id) || '' }),
});

// A requested title that has arrived is marked so.
onScanFinished(() => {
  for (const r of db.prepare("SELECT * FROM requests WHERE status IN ('pending','approved')").all()) {
    if (!inLibrary(r.kind, r.title, r.year, r.imdb_id)) continue;
    db.prepare("UPDATE requests SET status = 'available', decided_at = COALESCE(decided_at, ?) WHERE id = ?").run(now(), r.id);
    notifyUser(r.user_id, { t: 'request', id: r.id, status: 'available', title: r.title });
    emit('request.updated', { text: `${r.title} staat nu in de bibliotheek.`, fields: { title: r.title, status: 'available' } });
  }
});

/** The folder a Sonarr/Radarr event is about, translated to how this server sees it. */
export function arrPath(body, map = settings.get('arr_path_map', '')) {
  let p = body?.movieFile?.path || body?.episodeFile?.path || body?.movie?.folderPath || body?.series?.path || '';
  if (body?.movieFile?.relativePath && body?.movie?.folderPath) p = body.movie.folderPath;
  if (body?.episodeFile?.relativePath && body?.series?.path) p = body.series.path;
  p = String(p || '');
  for (const line of String(map || '').split('\n')) {
    const [from, to] = line.split('=').map((s) => s.trim().replace(/\/+$/, ''));
    if (from && to && (p === from || p.startsWith(`${from}/`))) return to + p.slice(from.length);
  }
  return p;
}

export default async function routes(app) {
  // ---- for users -----------------------------------------------------------
  app.get('/api/requests/search', { preHandler: noKids }, async (req) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    const kind = req.query.kind === 'show' ? 'show' : 'movie';
    if (q.length < 2) return { results: [] };
    let results = settings.get('tmdb_key', '') ? await searchTmdb(q, kind) : null;
    if (!results) results = await searchCinemeta(q, kind);
    if (!results) throw new HttpError(502, 'Zoeken lukt nu niet: de filmdatabase is niet bereikbaar.');
    const mine = new Set(db.prepare("SELECT kind || '|' || title || '|' || COALESCE(year, '') k FROM requests WHERE status IN ('pending','approved')").all().map((r) => r.k));
    return { results: results.filter((r) => r.title).map((r) => ({ ...r, available: inLibrary(r.kind, r.title, r.year, r.imdbId), requested: mine.has(`${r.kind}|${r.title}|${r.year ?? ''}`) })) };
  });

  app.get('/api/requests', { preHandler: requireUser }, async (req) => ({
    requests: db.prepare('SELECT * FROM requests WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.id).map((r) => out(r)),
  }));

  app.post('/api/requests', { preHandler: noKids }, async (req) => {
    const b = req.body || {};
    const kind = b.kind === 'show' ? 'show' : 'movie';
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) throw new HttpError(400, 'Kies een titel om aan te vragen.');
    const year = Number.isInteger(b.year) && b.year > 1870 && b.year < 2100 ? b.year : null;
    const imdb = /^tt\d{5,10}$/.test(String(b.imdbId || '')) ? b.imdbId : null;
    const tmdb = Number.isInteger(b.tmdbId) && b.tmdbId > 0 ? b.tmdbId : null;
    // Posters come from the lookup above; anything else is not stored.
    const poster = /^https:\/\/(image\.tmdb\.org|images\.metahub\.space|[a-z0-9.-]*strem\.io)\//.test(String(b.poster || '')) ? String(b.poster).slice(0, 300) : null;
    if (inLibrary(kind, title, year, imdb)) throw new HttpError(409, 'Deze titel staat al in de bibliotheek.');
    if (db.prepare("SELECT 1 FROM requests WHERE kind = ? AND title = ? AND COALESCE(year, 0) = ? AND status IN ('pending','approved')").get(kind, title, year || 0)) throw new HttpError(409, 'Deze titel is al aangevraagd.');
    if (db.prepare("SELECT COUNT(*) c FROM requests WHERE user_id = ? AND status = 'pending'").get(req.user.id).c >= 25) throw new HttpError(429, 'Je hebt al 25 verzoeken openstaan. Wacht tot de beheerder er een paar heeft bekeken.');
    const id = Number(db.prepare('INSERT INTO requests (user_id, kind, title, year, imdb_id, tmdb_id, poster, overview, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(req.user.id, kind, title, year, imdb, tmdb, poster, String(b.overview || '').slice(0, 600), now()).lastInsertRowid);
    emit('request.created', { text: `${req.user.name} vraagt aan: ${title}${year ? ` (${year})` : ''}`, fields: { user: req.user.name, title, year, kind } });
    return { id };
  });

  app.delete('/api/requests/:id', { preHandler: requireUser }, async (req) => {
    // Only your own, and only while nobody has acted on it.
    const r = db.prepare("DELETE FROM requests WHERE id = ? AND user_id = ? AND status = 'pending'").run(Number(req.params.id), req.user.id);
    if (!r.changes) throw new HttpError(404, 'Verzoek niet gevonden.');
    return { ok: true };
  });

  // ---- for the admin ---------------------------------------------------------
  app.get('/api/admin/requests', { preHandler: requireAdmin }, async () => {
    const names = new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    const r = arr('radarr'), s = arr('sonarr');
    return {
      requests: db.prepare("SELECT * FROM requests ORDER BY (status = 'pending') DESC, id DESC LIMIT 500").all().map((x) => out(x, names)),
      radarr: { url: r.url, key: maskKey(r.key) }, sonarr: { url: s.url, key: maskKey(s.key) },
      // The webhook address contains a secret; it is shown to admins so they can paste it into Sonarr/Radarr.
      hookPath: settings.get('arr_token', '') ? `/api/hooks/arr/${settings.get('arr_token')}` : null, pathMap: settings.get('arr_path_map', ''),
    };
  });

  app.put('/api/admin/requests/settings', { preHandler: requireAdmin }, async (req) => {
    const b = req.body || {};
    for (const which of ['radarr', 'sonarr']) {
      const v = b[which];
      if (!v) continue;
      if (typeof v.url === 'string') {
        const url = v.url.trim().replace(/\/+$/, '');
        if (url && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(url)) throw new HttpError(400, 'Vul een volledig adres in, bijvoorbeeld http://192.168.1.10:7878');
        settings.set(`${which}_url`, url);
      }
      // An empty or masked key leaves the stored one alone.
      if (typeof v.key === 'string' && v.key.trim() && !v.key.includes('•')) settings.set(`${which}_key`, v.key.trim().slice(0, 100));
      if (v.clear === true) { settings.set(`${which}_url`, ''); settings.set(`${which}_key`, ''); }
    }
    if (typeof b.pathMap === 'string') settings.set('arr_path_map', b.pathMap.slice(0, 2000));
    if (b.newHook === true) settings.set('arr_token', randomToken(24));
    if (b.removeHook === true) settings.set('arr_token', '');
    audit('settings.change', { user: req.user, ip: req.ip, detail: 'Verzoeken / Sonarr / Radarr' });
    return { ok: true };
  });

  app.put('/api/admin/requests/:id', { preHandler: requireAdmin }, async (req) => {
    const r = db.prepare('SELECT * FROM requests WHERE id = ?').get(Number(req.params.id));
    if (!r) throw new HttpError(404, 'Verzoek niet gevonden.');
    const status = req.body?.status;
    if (!['approved', 'declined', 'pending'].includes(status)) throw new HttpError(400, 'Kies goedkeuren of afwijzen.');
    const note = String(req.body?.note || '').trim().slice(0, 300);
    let forwarded = '';
    if (status === 'approved') {
      const err = await forward(r);
      forwarded = err === null ? '' : err === '' ? (r.kind === 'movie' ? 'radarr' : 'sonarr') : err;
    }
    db.prepare('UPDATE requests SET status = ?, note = ?, forwarded = ?, decided_at = ?, decided_by = ? WHERE id = ?').run(status, note, forwarded, now(), req.user.id, r.id);
    const word = status === 'approved' ? 'goedgekeurd' : status === 'declined' ? 'afgewezen' : 'teruggezet';
    audit('request.decide', { user: req.user, ip: req.ip, detail: `${r.title}: ${word}` });
    notifyUser(r.user_id, { t: 'request', id: r.id, status, title: r.title, note });
    emit('request.updated', { text: `Verzoek ${word}: ${r.title}${note ? ` — ${note}` : ''}`, fields: { title: r.title, status } });
    return out(db.prepare('SELECT * FROM requests WHERE id = ?').get(r.id));
  });

  app.delete('/api/admin/requests/:id', { preHandler: requireAdmin }, async (req) => {
    db.prepare('DELETE FROM requests WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });

  // ---- Sonarr / Radarr webhook -------------------------------------------------
  // No account: the unguessable token in the address is the credential, compared in constant time.
  app.post('/api/hooks/arr/:token', async (req) => {
    const want = String(settings.get('arr_token', '') || ''), got = String(req.params.token || '');
    const a = crypto.createHash('sha256').update(want).digest(), b = crypto.createHash('sha256').update(got).digest();
    if (!want || !crypto.timingSafeEqual(a, b)) throw new HttpError(404, 'Niet gevonden.');
    const event = String(req.body?.eventType || '');
    if (event === 'Test') return { ok: true, test: true };
    const p = arrPath(req.body);
    if (!p) return { ok: true, scanned: false };
    return { ok: true, scanned: scanPath(p) };
  });
}
