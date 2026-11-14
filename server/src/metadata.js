// Metadata: local NFO first, then TMDB (when a key is configured) or the
// keyless Cinemeta + Wikidata pair. Also serves and caches artwork.
import fs from 'node:fs';
import path from 'node:path';
import { db, now, json, settings, sha256, HttpError } from './db.js';
import { dataPath } from './config.js';
import { normKey } from './parse.js';
import { mergeTitles, onScanFinished } from './library.js';
import { normalizeAge, pickAge, wikidataAges } from './ratings.js';
import { requireAdmin } from './auth.js';
import { rebuildCollections } from './collections.js';

const UA = 'Kinoko/0.1 (self-hosted media server)';

async function getJson(url, { headers = {}, timeout = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------
// NFO + local artwork
// ---------------------------------------------------------------------------
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1].trim()) : ''; };
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'gi'))].map((m) => decode(m[1].trim()));
const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

export function parseNfo(xml) {
  const out = {};
  const imdb = xml.match(/<uniqueid[^>]*type="imdb"[^>]*>\s*(tt\d+)/i) || xml.match(/<(?:imdbid|imdb_id|id)>\s*(tt\d+)/i) || xml.match(/imdb\.com\/title\/(tt\d+)/i);
  if (imdb) out.imdb_id = imdb[1];
  const tmdb = xml.match(/<uniqueid[^>]*type="tmdb"[^>]*>\s*(\d+)/i) || xml.match(/<tmdbid>\s*(\d+)/i);
  if (tmdb) out.tmdb_id = Number(tmdb[1]);
  if (tag(xml, 'title')) out.title = tag(xml, 'title');
  if (/^\d{4}$/.test(tag(xml, 'year'))) out.year = Number(tag(xml, 'year'));
  if (tag(xml, 'plot')) out.overview = tag(xml, 'plot');
  if (tag(xml, 'tagline')) out.tagline = tag(xml, 'tagline');
  const genres = tags(xml, 'genre'); if (genres.length) out.genres = genres;
  const cast = [...xml.matchAll(/<actor>([\s\S]*?)<\/actor>/gi)].map((m) => ({ name: tag(m[1], 'name'), role: tag(m[1], 'role'), photo: tag(m[1], 'thumb') || null })).filter((c) => c.name);
  if (cast.length) out.cast = cast;
  const directors = tags(xml, 'director'); if (directors.length) out.directors = directors;
  const rating = Number(tag(xml, 'rating') || tag(xml, 'value')); if (rating > 0 && rating <= 10) out.rating = rating;
  // <mpaa> is free text in practice: "Rated PG-13", "NL:12", "FSK 16" or several joined with " / ".
  for (const cert of [tag(xml, 'mpaa'), tag(xml, 'certification')].join(' / ').split(/\s*[/,;|]\s*/)) { const age = normalizeAge(cert); if (age !== null) { out.age = age; break; } }
  return out;
}

function localInfo(title) {
  const files = db.prepare('SELECT path FROM files WHERE title_id = ? AND peer_id IS NULL').all(title.id);
  const out = {};
  const dirs = new Set();
  for (const f of files) {
    const d = path.dirname(f.path);
    dirs.add(d);
    if (title.kind === 'show') { dirs.add(path.dirname(d)); }
    else {
      const own = f.path.replace(/\.[^.]+$/, '.nfo');
      if (fs.existsSync(own)) { try { Object.assign(out, parseNfo(fs.readFileSync(own, 'utf8'))); } catch { /* unreadable nfo */ } }
    }
  }
  for (const d of dirs) {
    for (const n of title.kind === 'show' ? ['tvshow.nfo'] : ['movie.nfo']) {
      const p = path.join(d, n);
      if (fs.existsSync(p)) { try { Object.assign(out, parseNfo(fs.readFileSync(p, 'utf8'))); } catch { /* unreadable nfo */ } }
    }
    for (const [key, names] of [['poster', ['poster.jpg', 'poster.png', 'folder.jpg', 'cover.jpg']], ['backdrop', ['fanart.jpg', 'backdrop.jpg', 'background.jpg', 'fanart.png']]]) {
      if (out[key]) continue;
      for (const n of names) { const p = path.join(d, n); if (fs.existsSync(p)) { out[key] = 'file:' + p; break; } }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching helper
// ---------------------------------------------------------------------------
function matchScore(wantTitle, wantYear, gotTitle, gotYear) {
  const a = normKey(wantTitle, null), b = normKey(gotTitle || '', null);
  if (!a || !b) return 0;
  let s;
  if (a === b) s = 100;
  else {
    const ta = new Set(a.split(' ')), tb = new Set(b.split(' '));
    const inter = [...ta].filter((x) => tb.has(x)).length;
    s = Math.round(80 * inter / Math.max(ta.size, tb.size));
  }
  if (wantYear && gotYear) { const d = Math.abs(wantYear - gotYear); s += d === 0 ? 20 : d === 1 ? 8 : -30; }
  return s;
}

// ---------------------------------------------------------------------------
// Provider: Cinemeta (keyless)
// ---------------------------------------------------------------------------
const CINEMETA = 'https://v3-cinemeta.strem.io';

async function cinemeta(kind, title, year, imdbId) {
  const type = kind === 'show' ? 'series' : 'movie';
  let id = imdbId;
  if (!id) {
    const res = await getJson(`${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(title)}.json`);
    if (!res) return { error: true };
    let best = null, bestScore = 0;
    for (const m of res.metas || []) {
      const s = matchScore(title, year, m.name, Number(String(m.releaseInfo || '').slice(0, 4)) || null);
      if (s > bestScore) { best = m; bestScore = s; }
    }
    if (!best || bestScore < 70) return null;
    id = best.imdb_id || best.id;
  }
  const res = await getJson(`${CINEMETA}/meta/${type}/${id}.json`);
  if (!res) return { error: true };
  const m = res.meta;
  if (!m || !m.name) return null;
  const big = (u) => (u ? u.replace('/poster/small/', '/poster/medium/') : null);
  const out = {
    source: 'cinemeta', imdb_id: m.imdb_id || id, tmdb_id: m.moviedb_id || null,
    title: m.name, year: Number(String(m.year || m.releaseInfo || '').slice(0, 4)) || null,
    overview: m.description || '', genres: m.genre || m.genres || [],
    cast: (m.cast || []).map((n) => ({ name: n, role: '', photo: null })),
    directors: m.director || [], rating: Number(m.imdbRating) || null,
    runtime: parseInt(m.runtime, 10) || null,
    poster: big(m.poster), backdrop: m.background || null,
    trailer: m.trailers && m.trailers[0] ? m.trailers[0].source : null,
  };
  if (kind === 'show') {
    out.episodes = (m.videos || []).filter((v) => v.season > 0).map((v) => ({
      season: v.season, episode: v.episode ?? v.number, name: v.name || v.title || '',
      overview: v.overview || v.description || '', still: v.thumbnail || null, air_date: (v.released || v.firstAired || '').slice(0, 10) || null,
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider: TMDB (optional, needs a free key)
// ---------------------------------------------------------------------------
const TMDB = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p';

function tmdbGet(p, params = {}) {
  const key = settings.get('tmdb_key', '');
  const lang = settings.get('meta_lang', 'nl-NL');
  const q = new URLSearchParams({ language: lang, ...params });
  const headers = {};
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; else q.set('api_key', key);
  return getJson(`${TMDB}${p}?${q}`, { headers });
}

/** Certifications per country out of a TMDB response (films: release_dates, series: content_ratings). */
export function tmdbAge(d, kind) {
  const by = {};
  if (kind === 'show') for (const r of d.content_ratings?.results || []) (by[r.iso_3166_1] ||= []).push(r.rating);
  else for (const r of d.release_dates?.results || []) for (const x of r.release_dates || []) if (x.certification) (by[r.iso_3166_1] ||= []).push(x.certification);
  return pickAge(by);
}

async function tmdb(kind, title, year, imdbId, tmdbId) {
  const type = kind === 'show' ? 'tv' : 'movie';
  let id = tmdbId;
  if (!id && imdbId) {
    const f = await tmdbGet(`/find/${imdbId}`, { external_source: 'imdb_id' });
    if (!f) return { error: true };
    id = (f[`${type}_results`] || [])[0]?.id;
  }
  if (!id) {
    const params = { query: title };
    if (year) params[kind === 'show' ? 'first_air_date_year' : 'year'] = String(year);
    let res = await tmdbGet(`/search/${type}`, params);
    if (!res) return { error: true };
    if (!(res.results || []).length && year) res = await tmdbGet(`/search/${type}`, { query: title });
    let best = null, bestScore = 0;
    for (const m of (res?.results || []).slice(0, 8)) {
      const y = Number(String(m.release_date || m.first_air_date || '').slice(0, 4)) || null;
      const s = Math.max(matchScore(title, year, m.title || m.name, y), matchScore(title, year, m.original_title || m.original_name, y));
      if (s > bestScore) { best = m; bestScore = s; }
    }
    if (!best || bestScore < 70) return null;
    id = best.id;
  }
  const d = await tmdbGet(`/${type}/${id}`, { append_to_response: `credits,external_ids,videos,${kind === 'show' ? 'content_ratings' : 'release_dates'}`, include_video_language: 'nl,en' });
  if (!d) return { error: true };
  let overview = d.overview || '', tagline = d.tagline || '';
  if (!overview) { const en = await tmdbGet(`/${type}/${id}`, { language: 'en-US' }); if (en) { overview = en.overview || ''; tagline = tagline || en.tagline || ''; } }
  const trailer = (d.videos?.results || []).find((v) => v.site === 'YouTube' && v.type === 'Trailer');
  const out = {
    source: 'tmdb', tmdb_id: d.id, imdb_id: d.imdb_id || d.external_ids?.imdb_id || imdbId || null,
    title: d.title || d.name, year: Number(String(d.release_date || d.first_air_date || '').slice(0, 4)) || null,
    overview, tagline, genres: (d.genres || []).map((g) => g.name),
    cast: (d.credits?.cast || []).slice(0, 20).map((c) => ({ name: c.name, role: c.character || '', photo: c.profile_path ? `${TMDB_IMG}/w185${c.profile_path}` : null })),
    directors: kind === 'show' ? (d.created_by || []).map((c) => c.name) : (d.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name),
    rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
    runtime: d.runtime || (d.episode_run_time || [])[0] || null,
    poster: d.poster_path ? `${TMDB_IMG}/w500${d.poster_path}` : null,
    backdrop: d.backdrop_path ? `${TMDB_IMG}/w1280${d.backdrop_path}` : null,
    trailer: trailer ? trailer.key : null,
    collection: d.belongs_to_collection ? { id: d.belongs_to_collection.id, name: d.belongs_to_collection.name } : null,
    age: tmdbAge(d, kind),
  };
  if (kind === 'show') {
    out.episodes = [];
    const have = db.prepare('SELECT DISTINCT season FROM episodes WHERE title_id IN (SELECT id FROM titles WHERE tmdb_id = ? OR imdb_id = ? OR norm_key = ?)').all(d.id, out.imdb_id, normKey(title, null)).map((r) => r.season);
    for (const sn of have) {
      const s = await tmdbGet(`/tv/${id}/season/${sn}`);
      for (const e of s?.episodes || []) {
        out.episodes.push({ season: sn, episode: e.episode_number, name: e.name || '', overview: e.overview || '', still: e.still_path ? `${TMDB_IMG}/w400${e.still_path}` : null, air_date: e.air_date || null });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wikidata: which film series does a film belong to (keyless collections)
// ---------------------------------------------------------------------------
async function wikidataSeries(imdbIds) {
  const out = new Map();
  for (let i = 0; i < imdbIds.length; i += 80) {
    const batch = imdbIds.slice(i, i + 80);
    const query = `SELECT ?imdb ?s ?sLabel WHERE { VALUES ?imdb { ${batch.map((x) => `"${x}"`).join(' ')} } ?f wdt:P345 ?imdb; wdt:P179 ?s. SERVICE wikibase:label { bd:serviceParam wikibase:language "nl,en". } }`;
    const res = await getJson(`https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`, { headers: { Accept: 'application/sparql-results+json' }, timeout: 30000 });
    if (!res) return null;
    for (const id of batch) out.set(id, []);
    for (const b of res.results?.bindings || []) {
      const label = b.sLabel?.value || '';
      if (!label || /^Q\d+$/.test(label)) continue;
      out.get(b.imdb.value)?.push({ id: b.s.value.split('/').pop(), name: label });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------
export async function enrichTitle(title) {
  const local = localInfo(title);
  const wantTitle = local.title || title.title, wantYear = local.year || title.year;
  const imdbId = local.imdb_id || title.imdb_id, tmdbId = local.tmdb_id || title.tmdb_id;
  let remote = null;
  if (settings.get('tmdb_key', '')) remote = await tmdb(title.kind, wantTitle, wantYear, imdbId, tmdbId);
  if (!remote || remote.error) {
    const c = await cinemeta(title.kind, wantTitle, wantYear, imdbId);
    if (c && !c.error) remote = c; else if (!remote) remote = c;
  }
  // Network trouble: leave meta_at empty so the next pass retries.
  if (remote && remote.error && !Object.keys(local).length) return false;
  const r = remote && !remote.error ? remote : {};
  const m = {
    title: local.title || r.title || title.title,
    year: local.year || r.year || title.year,
    imdb_id: local.imdb_id || r.imdb_id || title.imdb_id || null,
    tmdb_id: local.tmdb_id || r.tmdb_id || title.tmdb_id || null,
    overview: local.overview || r.overview || '',
    tagline: local.tagline || r.tagline || '',
    genres: (local.genres?.length ? local.genres : r.genres) || [],
    cast: (r.cast?.some((c) => c.photo) ? r.cast : local.cast || r.cast) || [],
    directors: (local.directors?.length ? local.directors : r.directors) || [],
    rating: r.rating || local.rating || null,
    runtime: r.runtime || null,
    poster: local.poster || r.poster || null,
    backdrop: local.backdrop || r.backdrop || null,
    trailer: r.trailer || null,
    collection: r.collection || null,
    age: local.age ?? r.age ?? null,
    source: r.source || (Object.keys(local).length ? 'nfo' : 'none'),
  };
  // The same film may already exist under its IMDb id (e.g. synced from a linked server).
  let id = title.id;
  if (m.imdb_id) {
    const other = db.prepare('SELECT id FROM titles WHERE kind = ? AND imdb_id = ? AND id != ?').get(title.kind, m.imdb_id, title.id);
    if (other) { mergeTitles(title.id, other.id); id = other.id; }
  }
  db.prepare(`UPDATE titles SET title=?, year=?, imdb_id=?, tmdb_id=?, overview=?, tagline=?, genres=?, cast_json=?, directors=?, rating=?, runtime=?,
      poster=?, backdrop=?, trailer=?, tmdb_collection=?, meta_source=?, meta_at=?, age=COALESCE(?, age), age_source=CASE WHEN ? IS NULL THEN age_source ELSE ? END WHERE id=?`)
    .run(m.title, m.year, m.imdb_id, m.tmdb_id, m.overview, m.tagline, JSON.stringify(m.genres), JSON.stringify(m.cast), JSON.stringify(m.directors),
      m.rating, m.runtime, m.poster, m.backdrop, m.trailer, m.collection ? JSON.stringify(m.collection) : null, m.source, now(),
      m.age, m.age, local.age !== undefined ? 'nfo' : 'tmdb', id);
  if (r.episodes) {
    const upd = db.prepare(`UPDATE episodes SET name = CASE WHEN ? != '' THEN ? ELSE name END, overview = ?, still = ?, air_date = ? WHERE title_id = ? AND season = ? AND episode = ?`);
    for (const e of r.episodes) upd.run(e.name, e.name, e.overview, e.still, e.air_date, id, e.season, e.episode);
  }
  return true;
}

export const metaState = { running: false, done: 0, total: 0 };

export async function enrichPending({ all = false } = {}) {
  if (metaState.running) return;
  const rows = db.prepare(`SELECT * FROM titles WHERE ${all ? '1' : 'meta_at IS NULL'} AND id IN (SELECT title_id FROM files WHERE peer_id IS NULL) ORDER BY id`).all();
  Object.assign(metaState, { running: true, done: 0, total: rows.length });
  try {
    for (const t of rows) {
      const fresh = db.prepare('SELECT * FROM titles WHERE id = ?').get(t.id);
      if (fresh) { try { await enrichTitle(fresh); } catch (e) { console.error('[meta]', t.title, e.message); } }
      metaState.done++;
    }
    // Film series for the keyless collections.
    const need = db.prepare("SELECT id, imdb_id FROM titles WHERE kind = 'movie' AND imdb_id IS NOT NULL AND tmdb_collection IS NULL").all();
    if (need.length) {
      const series = await wikidataSeries(need.map((t) => t.imdb_id));
      if (series) {
        const upd = db.prepare('UPDATE titles SET series_json = ? WHERE id = ?');
        for (const t of need) upd.run(JSON.stringify(series.get(t.imdb_id) || []), t.id);
      }
    }
    // Age ratings for whatever still has none (no TMDB key, or TMDB did not know).
    const unrated = db.prepare('SELECT id, imdb_id FROM titles WHERE age IS NULL AND imdb_id IS NOT NULL AND id IN (SELECT title_id FROM files WHERE peer_id IS NULL)').all();
    if (unrated.length) {
      const ages = await wikidataAges(unrated.map((t) => t.imdb_id), getJson);
      if (ages) { const upd = db.prepare("UPDATE titles SET age = ?, age_source = 'wikidata' WHERE id = ? AND age IS NULL"); for (const t of unrated) if (ages.has(t.imdb_id)) upd.run(ages.get(t.imdb_id), t.id); }
    }
    rebuildCollections();
  } finally { metaState.running = false; }
}

onScanFinished(async (state) => { state.phase = 'metadata'; await enrichPending(); });

// ---------------------------------------------------------------------------
// Artwork: fetch once, serve from disk
// ---------------------------------------------------------------------------
const inflight = new Map();

async function cachedImage(source) {
  if (source.startsWith('file:')) return { file: source.slice(5) };
  if (!/^https?:\/\//.test(source)) return null;
  const file = dataPath('images', sha256(source).slice(0, 32));
  if (fs.existsSync(file)) return { file };
  if (!inflight.has(source)) {
    inflight.set(source, (async () => {
      try {
        const r = await fetch(source, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
        if (!r.ok || !(r.headers.get('content-type') || '').startsWith('image/')) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 12 * 1024 * 1024) return null;
        await fs.promises.writeFile(file + '.tmp', buf);
        await fs.promises.rename(file + '.tmp', file);
        return { file };
      } catch { return null; } finally { inflight.delete(source); }
    })());
  }
  return inflight.get(source);
}

function sniff(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  return 'image/jpeg';
}

async function sendImage(reply, source) {
  const img = source ? await cachedImage(source) : null;
  if (!img) return reply.code(404).send({ error: 'Geen afbeelding.' });
  let buf; try { buf = await fs.promises.readFile(img.file); } catch { return reply.code(404).send({ error: 'Geen afbeelding.' }); }
  return reply.header('Content-Type', sniff(buf)).header('Cache-Control', 'public, max-age=604800').send(buf);
}

/** URL a client can load for a stored artwork source (versioned for caching). */
export const imgUrl = (kind, id, which, source) => (source ? `/api/img/${kind}/${id}/${which}?v=${sha256(source).slice(0, 8)}` : null);

export default async function routes(app) {
  // Artwork is public on purpose: <img> tags and TV image loaders cannot send
  // an Authorization header, and posters are not secrets.
  app.get('/api/img/t/:id/:which', async (req, reply) => {
    const t = db.prepare('SELECT poster, backdrop FROM titles WHERE id = ?').get(req.params.id);
    return sendImage(reply, t && (req.params.which === 'backdrop' ? t.backdrop : t.poster));
  });
  app.get('/api/img/e/:id/still', async (req, reply) => {
    const e = db.prepare('SELECT still FROM episodes WHERE id = ?').get(req.params.id);
    return sendImage(reply, e && e.still);
  });

  app.get('/api/admin/metadata', { preHandler: requireAdmin }, async () => ({
    tmdbKey: settings.get('tmdb_key', '') ? '••••' + settings.get('tmdb_key', '').slice(-4) : '',
    lang: settings.get('meta_lang', 'nl-NL'),
    state: metaState,
    unmatched: db.prepare("SELECT id, kind, title, year FROM titles WHERE (meta_source IS NULL OR meta_source = 'none') AND id IN (SELECT title_id FROM files WHERE peer_id IS NULL) ORDER BY title LIMIT 200").all(),
  }));
  app.put('/api/admin/metadata', { preHandler: requireAdmin }, async (req) => {
    const { tmdbKey, lang } = req.body || {};
    if (typeof tmdbKey === 'string' && !tmdbKey.startsWith('••••')) {
      const key = tmdbKey.trim();
      if (key) {
        const q = key.startsWith('eyJ') ? '' : `?api_key=${encodeURIComponent(key)}`;
        const ok = await getJson(`${TMDB}/configuration${q}`, { headers: key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {} });
        if (!ok) throw new HttpError(400, 'TMDB accepteert deze sleutel niet.');
      }
      settings.set('tmdb_key', key);
    }
    if (typeof lang === 'string' && /^[a-z]{2}-[A-Z]{2}$/.test(lang)) settings.set('meta_lang', lang);
    return { ok: true };
  });
  app.post('/api/admin/metadata/refresh', { preHandler: requireAdmin }, async (req) => {
    enrichPending({ all: !!(req.body && req.body.all) });
    return { started: true };
  });
  // Manual fix for a wrong or missing match: pin the IMDb id and refetch.
  // The admin's own judgement beats every source; null hands it back to the sources.
  app.put('/api/admin/titles/:id/age', { preHandler: requireAdmin }, async (req) => {
    const age = req.body?.age;
    if (age !== null && ![0, 6, 9, 12, 14, 16, 18].includes(age)) throw new HttpError(400, 'Kies een leeftijd uit de lijst.');
    const r = db.prepare("UPDATE titles SET age = ?, age_source = ? WHERE id = ?").run(age, age === null ? null : 'handmatig', Number(req.params.id));
    if (!r.changes) throw new HttpError(404, 'Titel niet gevonden.');
    return { ok: true };
  });
  app.get('/api/admin/ratings', { preHandler: requireAdmin }, async () => ({
    unrated: db.prepare('SELECT id, kind, title, year FROM titles WHERE age IS NULL AND id IN (SELECT title_id FROM files) ORDER BY title LIMIT 500').all(),
    counts: db.prepare('SELECT age, COUNT(*) n FROM titles WHERE id IN (SELECT title_id FROM files) GROUP BY age ORDER BY age').all(),
  }));

  app.post('/api/admin/titles/:id/match', { preHandler: requireAdmin }, async (req) => {
    const t = db.prepare('SELECT * FROM titles WHERE id = ?').get(req.params.id);
    if (!t) throw new HttpError(404, 'Titel niet gevonden.');
    const imdb = String(req.body?.imdb || '').match(/tt\d{6,}/);
    if (!imdb) throw new HttpError(400, 'Geef een IMDb-id (tt1234567) of IMDb-link.');
    await enrichTitle({ ...t, imdb_id: imdb[0], tmdb_id: null });
    rebuildCollections();
    return { ok: true };
  });
}
