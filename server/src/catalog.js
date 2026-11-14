// Everything the clients browse: home rows, detail pages, search, My List,
// recommendations and Watch Night.
import { db, now, json, settings, HttpError } from './db.js';
import { requireUser } from './auth.js';
import { imgUrl } from './metadata.js';
import { QUALITIES } from './stream.js';
import { EXTRA_LABEL } from './library.js';
import { scopeFor, visibleTitles, canSeeFile, canSeeExtra, fileSql, requireTitle } from './access.js';
import { ageLabel } from './ratings.js';

/** Functions here take a user row; an id is accepted too (tests, older callers). */
const asUser = (u) => (u && typeof u === 'object' ? u : db.prepare('SELECT * FROM users WHERE id = ?').get(u) || null);
/** `vis` is the set of title ids a user may see, or null for everything. */
const seen = (vis, id) => !vis || vis.has(id);

const GENRE_NL = {
  action: 'Actie', adventure: 'Avontuur', animation: 'Animatie', comedy: 'Komedie', crime: 'Misdaad', documentary: 'Documentaire',
  drama: 'Drama', family: 'Familie', fantasy: 'Fantasy', history: 'Historisch', horror: 'Horror', music: 'Muziek', musical: 'Musical',
  mystery: 'Mysterie', romance: 'Romantiek', 'sci-fi': 'Sciencefiction', 'science fiction': 'Sciencefiction', thriller: 'Thriller',
  war: 'Oorlog', western: 'Western', biography: 'Biografie', sport: 'Sport', 'tv movie': 'Tv-film', 'film-noir': 'Film noir',
  short: 'Korte film', 'reality-tv': 'Reality', 'talk-show': 'Talkshow', 'game-show': 'Spelshow', news: 'Nieuws', kids: 'Kinderen',
  'action & adventure': 'Actie & Avontuur', 'sci-fi & fantasy': 'Sci-Fi & Fantasy', 'war & politics': 'Oorlog & Politiek',
};
export const genreName = (g) => GENRE_NL[String(g).toLowerCase()] || g;
const genresOf = (t) => [...new Set(json(t.genres, []).map(genreName))];

export function resolutionLabel(f) {
  if (f.height >= 2000 || f.width >= 3800) return '4K';
  if (f.height >= 1000 || f.width >= 1900) return '1080p';
  if (f.height >= 700 || f.width >= 1260) return '720p';
  return f.height ? `${f.height}p` : 'SD';
}

export function card(t) {
  return {
    id: t.id, kind: t.kind, title: t.title, year: t.year, rating: t.rating, runtime: t.runtime, age: ageLabel(t.age),
    genres: genresOf(t), overview: t.overview,
    poster: imgUrl('t', t.id, 'poster', t.poster), backdrop: imgUrl('t', t.id, 'backdrop', t.backdrop),
  };
}

const peerNames = () => new Map(db.prepare('SELECT id, name FROM peers').all().map((p) => [p.id, p.name]));

/** Files of a movie/episode as selectable versions; the best one (highest bitrate) first. */
export function versions(files, peers = peerNames()) {
  const own = settings.get('server_name');
  return files
    .slice()
    .sort((a, b) => b.bitrate - a.bitrate || (a.peer_id ? 1 : 0) - (b.peer_id ? 1 : 0) || b.height - a.height)
    .map((f, i) => {
      const s = json(f.streams, { audio: [], subs: [] });
      return {
        fileId: f.id, best: i === 0,
        server: { id: f.peer_id || 0, name: f.peer_id ? (peers.get(f.peer_id) || 'Gekoppelde server') : own, local: !f.peer_id },
        resolution: resolutionLabel(f), width: f.width, height: f.height, bitrate: f.bitrate, size: f.size, duration: f.duration,
        vcodec: f.vcodec, acodec: f.acodec, container: f.container, hdr: !!f.hdr,
        audio: s.audio || [], subs: (s.subs || []).map((x) => ({ lang: x.lang, title: x.title })),
        // Lower qualities are transcoded on the server that holds the file.
        qualities: ['original', ...Object.keys(QUALITIES).filter((q) => QUALITIES[q].height < (f.height || 99999)).sort((a, b) => b - a)],
      };
    });
}

function progressMap(userId, titleId) {
  return new Map(db.prepare('SELECT * FROM progress WHERE user_id = ? AND title_id = ?').all(userId, titleId).map((p) => [p.episode_id, p]));
}

/** For a show: the episode to resume, or the first unwatched one. */
function nextUp(episodes, prog) {
  let latest = null;
  for (const e of episodes) { const p = prog.get(e.id); if (p && (!latest || p.updated_at > latest.p.updated_at)) latest = { e, p }; }
  if (!latest) return episodes[0] || null;
  if (!latest.p.watched) return latest.e;
  const i = episodes.indexOf(latest.e);
  return episodes[i + 1] || null;
}

function similarTo(t, limit = 12, vis = null) {
  const g = new Set(json(t.genres, [])), c = new Set(json(t.cast_json, []).slice(0, 8).map((x) => x.name)), d = new Set(json(t.directors, []));
  const colMates = new Set(db.prepare('SELECT title_id FROM collection_items WHERE collection_id IN (SELECT collection_id FROM collection_items WHERE title_id = ?)').all(t.id).map((r) => r.title_id));
  const scored = [];
  for (const o of db.prepare('SELECT * FROM titles WHERE id != ?').all(t.id)) {
    if (!seen(vis, o.id)) continue;
    let s = 0;
    for (const x of json(o.genres, [])) if (g.has(x)) s += 2;
    for (const x of json(o.cast_json, []).slice(0, 8)) if (c.has(x.name)) s += 3;
    for (const x of json(o.directors, [])) if (d.has(x)) s += 2;
    if (colMates.has(o.id)) s += 5;
    if (o.kind === t.kind) s += 1;
    if (s >= 3) scored.push({ o, s: s + (o.rating || 0) / 10 });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => card(x.o));
}

export function titleDetail(id, who) {
  const user = asUser(who), userId = user ? user.id : null;
  const scope = scopeFor(user), vis = visibleTitles(scope);
  const t = db.prepare('SELECT * FROM titles WHERE id = ?').get(id);
  if (!t || !seen(vis, t.id)) throw new HttpError(404, 'Titel niet gevonden.');
  const peers = peerNames();
  const prog = userId ? progressMap(userId, t.id) : new Map();
  const out = {
    ...card(t), tagline: t.tagline, cast: json(t.cast_json, []), directors: json(t.directors, []), trailer: t.trailer, imdbId: t.imdb_id,
    inList: userId ? !!db.prepare('SELECT 1 FROM mylist WHERE user_id = ? AND title_id = ?').get(userId, t.id) : false,
    collections: db.prepare('SELECT c.id, c.name FROM collections c JOIN collection_items i ON i.collection_id = c.id WHERE i.title_id = ?').all(t.id),
    similar: similarTo(t, 12, vis),
    extras: db.prepare('SELECT id, name, kind, duration, library_id, title_id FROM extras WHERE title_id = ? ORDER BY kind, name').all(t.id)
      .filter((x) => canSeeExtra(scope, x)).map((x) => ({ id: x.id, name: x.name, kind: x.kind, label: EXTRA_LABEL[x.kind] || 'Extra', duration: x.duration })),
  };
  if (userId && t.kind === 'show') {
    const p = db.prepare('SELECT audio_lang, sub_lang FROM series_prefs WHERE user_id = ? AND title_id = ?').get(userId, t.id);
    out.prefs = { audioLang: p?.audio_lang || '', subLang: p?.sub_lang || '' };
  }
  const files = db.prepare('SELECT * FROM files WHERE title_id = ?').all(t.id).filter((f) => canSeeFile(scope, f));
  if (t.kind === 'movie') {
    out.versions = versions(files, peers);
    const p = prog.get(0);
    out.progress = p ? { position: p.position, duration: p.duration, watched: !!p.watched } : null;
  } else {
    const byEp = new Map();
    for (const f of files) { if (!byEp.has(f.episode_id)) byEp.set(f.episode_id, []); byEp.get(f.episode_id).push(f); }
    const eps = db.prepare('SELECT * FROM episodes WHERE title_id = ? ORDER BY season, episode').all(t.id).filter((e) => byEp.has(e.id));
    const seasons = new Map();
    for (const e of eps) {
      const v = versions(byEp.get(e.id), peers);
      const p = prog.get(e.id);
      if (!seasons.has(e.season)) seasons.set(e.season, { season: e.season, episodes: [] });
      seasons.get(e.season).episodes.push({
        id: e.id, season: e.season, episode: e.episode, name: e.name || `Aflevering ${e.episode}`, overview: e.overview, airDate: e.air_date,
        still: imgUrl('e', e.id, 'still', e.still), duration: v[0]?.duration || 0, versions: v,
        progress: p ? { position: p.position, duration: p.duration, watched: !!p.watched } : null,
      });
    }
    out.seasons = [...seasons.values()];
    const nu = nextUp(eps, prog);
    out.nextUp = nu ? { episodeId: nu.id, season: nu.season, episode: nu.episode } : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
function seeded(seed) { let x = seed | 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 100000) / 100000; }; }
function shuffle(list, rnd = Math.random) { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function continueWatching(userId, scope = { all: true }, vis = null) {
  const rows = db.prepare(`SELECT p.*, MAX(p.updated_at) latest FROM progress p WHERE p.user_id = ? GROUP BY p.title_id ORDER BY latest DESC LIMIT 30`).all(userId);
  const out = [];
  for (const p of rows) {
    const t = db.prepare('SELECT * FROM titles WHERE id = ?').get(p.title_id);
    if (!t || !seen(vis, t.id)) continue;
    if (t.kind === 'movie') {
      if (p.watched || p.position < 30) continue;
      out.push({ ...card(t), resume: { position: p.position, duration: p.duration } });
    } else {
      const eps = db.prepare(`SELECT * FROM episodes WHERE title_id = ? AND id IN (SELECT f.episode_id FROM files f WHERE ${fileSql(scope)}) ORDER BY season, episode`).all(t.id);
      const nu = nextUp(eps, progressMap(userId, t.id));
      if (!nu) continue;
      const ep = db.prepare('SELECT * FROM progress WHERE user_id = ? AND title_id = ? AND episode_id = ?').get(userId, t.id, nu.id);
      out.push({ ...card(t), resume: { episodeId: nu.id, season: nu.season, episode: nu.episode, name: nu.name, position: ep && !ep.watched ? ep.position : 0, duration: ep ? ep.duration : 0 } });
    }
  }
  return out.slice(0, 20);
}

function tasteProfile(userId) {
  const genres = new Map(), seen = new Set();
  for (const p of db.prepare('SELECT DISTINCT title_id FROM progress WHERE user_id = ? UNION SELECT title_id FROM mylist WHERE user_id = ?').all(userId, userId)) {
    const t = db.prepare('SELECT genres FROM titles WHERE id = ?').get(p.title_id);
    if (!t) continue;
    seen.add(p.title_id);
    for (const g of json(t.genres, [])) genres.set(g, (genres.get(g) || 0) + 1);
  }
  return { genres, seen };
}

export function home(who, kind = null) {
  const user = asUser(who), userId = user.id;
  const scope = scopeFor(user), vis = visibleTitles(scope);
  const where = kind ? 'WHERE kind = ?' : '';
  const args = kind ? [kind] : [];
  const all = db.prepare(`SELECT t.*, (SELECT MAX(added_at) FROM files WHERE title_id = t.id) file_added,
    (SELECT COUNT(*) FROM files WHERE title_id = t.id AND peer_id IS NULL) local_files FROM titles t ${where}`).all(...args).filter((t) => seen(vis, t.id));
  const day = Math.floor(Date.now() / 86400000);
  const rnd = seeded(day * 31 + userId);
  const rows = [];
  const kids = !!(scope.kids && user.kids_home);
  const push = (id, title, items, extra = {}) => { if (items.length) rows.push({ id, title, items, ...extra }); };

  const cont = continueWatching(userId, scope, vis).filter((c) => !kind || c.kind === kind);
  push('continue', 'Verder kijken', cont, { style: 'wide' });

  const recent = all.slice().sort((a, b) => (b.file_added || 0) - (a.file_added || 0)).slice(0, 20);
  push('recent', 'Nieuw toegevoegd', recent.map(card));

  const list = db.prepare(`SELECT t.* FROM mylist m JOIN titles t ON t.id = m.title_id WHERE m.user_id = ? ${kind ? 'AND t.kind = ?' : ''} ORDER BY m.added_at DESC`).all(userId, ...args).filter((t) => seen(vis, t.id));
  push('mylist', 'Mijn lijst', list.map(card));

  const taste = tasteProfile(userId);
  // The children's home stays simple: continue, new, own list and a few genres.
  if (taste.genres.size && !kids) {
    const rec = all.filter((t) => !taste.seen.has(t.id))
      .map((t) => ({ t, s: json(t.genres, []).reduce((n, g) => n + (taste.genres.get(g) || 0), 0) + (t.rating || 5) / 5 + rnd() }))
      .filter((x) => x.s > 2).sort((a, b) => b.s - a.s).slice(0, 20);
    push('foryou', 'Aanbevolen voor jou', rec.map((x) => card(x.t)));
    const last = db.prepare('SELECT title_id FROM progress WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(userId);
    const lastT = last && db.prepare('SELECT * FROM titles WHERE id = ?').get(last.title_id);
    if (lastT && seen(vis, lastT.id)) push('because', `Omdat je ${lastT.title} keek`, similarTo(lastT, 16, vis).filter((c) => !kind || c.kind === kind));
  }

  if (kind !== 'show' && !kids) {
    const cols = db.prepare('SELECT c.*, (SELECT COUNT(*) FROM collection_items WHERE collection_id = c.id) n FROM collections c ORDER BY n DESC, name LIMIT 30').all();
    push('collections', 'Collecties', cols.map((c) => collectionCard(c, vis)).filter((c) => c.count >= 2), { style: 'collection' });
  }

  if (!kids) push('top', 'Hoog gewaardeerd', all.filter((t) => t.rating >= 7.5).sort((a, b) => b.rating - a.rating).slice(0, 20).map(card));

  // One row per genre that has enough in it; order rotates per day so home feels fresh.
  const byGenre = new Map();
  for (const t of all) for (const g of genresOf(t)) { if (!byGenre.has(g)) byGenre.set(g, []); byGenre.get(g).push(t); }
  const genreRows = [...byGenre.entries()].filter(([, l]) => l.length >= 3);
  for (const [g, l] of shuffle(genreRows, rnd).slice(0, kids ? 4 : 10)) push(`genre:${g}`, g, shuffle(l, rnd).slice(0, 20).map(card), { genre: g });

  const peers = peerNames();
  for (const [pid, name] of scope.peers && !kids ? peers : []) {
    const theirs = all.filter((t) => !t.local_files && db.prepare('SELECT 1 FROM files WHERE title_id = ? AND peer_id = ?').get(t.id, pid));
    push(`peer:${pid}`, `Gedeeld door ${name}`, shuffle(theirs, rnd).slice(0, 20).map(card));
  }

  const heroPool = all.filter((t) => t.backdrop && t.overview);
  const hero = shuffle(heroPool.sort((a, b) => (b.file_added || 0) - (a.file_added || 0)).slice(0, 30), rnd).slice(0, 6).map((t) => ({ ...card(t), trailer: t.trailer || null }));
  return { hero: kids ? hero.map((x) => ({ ...x, trailer: null })) : hero, rows, genres: [...byGenre.keys()].sort((a, b) => a.localeCompare(b)), empty: all.length === 0, kids };
}

function collectionCard(c, vis = null) {
  const items = db.prepare('SELECT t.id, t.poster, t.backdrop FROM collection_items i JOIN titles t ON t.id = i.title_id WHERE i.collection_id = ? ORDER BY i.ord').all(c.id).filter((i) => seen(vis, i.id));
  const withPoster = items.filter((i) => i.poster), withBackdrop = items.filter((i) => i.backdrop);
  return {
    id: c.id, kind: 'collection', title: c.name, count: items.length,
    posters: withPoster.slice(0, 3).map((i) => imgUrl('t', i.id, 'poster', i.poster)),
    backdrop: withBackdrop.length ? imgUrl('t', withBackdrop[0].id, 'backdrop', withBackdrop[0].backdrop) : null,
  };
}

// ---------------------------------------------------------------------------
// Watch Night
// ---------------------------------------------------------------------------
const THEMES = {
  kerst: { name: 'Kerstavond', tagline: 'Dekentje, warme chocomel en een kerstklassieker.', particle: 'snow', colors: ['#c8a2ff', '#ff5d8f'],
    genres: ['Family', 'Comedy', 'Fantasy', 'Romance'], words: /\b(christmas|kerst|santa|kerstman|xmas|noel|grinch|elf|north pole|noordpool|holiday|snowman|sneeuwpop)\b/i,
    ids: ['tt0099785', 'tt0104431', 'tt0319343', 'tt0314331', 'tt0457939', 'tt0095016', 'tt0170016', 'tt0338348', 'tt4729430', 'tt0107688', 'tt0038650', 'tt0087363', 'tt0099487', 'tt2294629'] },
  halloween: { name: 'Griezelnacht', tagline: 'Lichten uit. Deur op slot. Succes.', particle: 'bats', colors: ['#b266ff', '#ff7a1a'],
    genres: ['Horror', 'Thriller', 'Mystery'], words: /\b(halloween|ghost|spook|haunted|witch|heks|vampire|vampier|zombie|demon|exorcis|nightmare|curse|vloek|monster|killer|moordenaar)\b/i,
    ids: ['tt0077651', 'tt0117571', 'tt0107120', 'tt1457767', 'tt1396484', 'tt5052448', 'tt6644200', 'tt0327597', 'tt0094721', 'tt0087332', 'tt0070047', 'tt7784604', 'tt0081505', 'tt0107688'] },
  valentijn: { name: 'Valentijnsavond', tagline: 'Voor twee. Of voor één, met extra popcorn.', particle: 'hearts', colors: ['#ff6fb5', '#b388ff'],
    genres: ['Romance', 'Comedy', 'Drama', 'Musical'], words: /\b(love|liefde|romance|romantic|wedding|bruiloft|heart|hart|valentine|kiss|kus|verliefd)\b/i,
    ids: ['tt0332280', 'tt0120338', 'tt3783958', 'tt0414387', 'tt0125439', 'tt1570728', 'tt0147800', 'tt2194499', 'tt0098635', 'tt0314331', 'tt0211915', 'tt5726616'] },
  winter: { name: 'Winteravond', tagline: 'Koud buiten, warm binnen. Tijd voor een winterfilm.', particle: 'snow', colors: ['#a78bfa', '#7dd3fc'],
    genres: ['Fantasy', 'Family', 'Adventure', 'Drama', 'Animation'], words: /\b(winter|snow|sneeuw|ice|ijs|frozen|arctic|blizzard|cold|mountain|berg|ski|yeti|north|noord)\b/i,
    ids: ['tt2294629', 'tt4520988', 'tt0081505', 'tt0116282', 'tt1663202', 'tt0268380', 'tt0241527', 'tt0363771', 'tt0099487', 'tt4729430', 'tt3281548', 'tt0245429', 'tt1109624', 'tt4468740'] },
  lente: { name: 'Lente-avond', tagline: 'Alles bloeit weer op — ook je watchlist.', particle: 'petals', colors: ['#d8b4fe', '#86efac'],
    genres: ['Romance', 'Comedy', 'Animation', 'Family', 'Musical'], words: /\b(spring|lente|garden|tuin|bloom|flower|bloem|paris|parijs|easter|pasen|rabbit|konijn|new beginning)\b/i,
    ids: ['tt0211915', 'tt0096283', 'tt0045152', 'tt1109624', 'tt4468740', 'tt0414387', 'tt2194499', 'tt0432283', 'tt0125439', 'tt3783958'] },
  zomer: { name: 'Zomeravond', tagline: 'Ramen open, lang licht, grote blockbusters.', particle: 'fireflies', colors: ['#c084fc', '#fbbf24'],
    genres: ['Adventure', 'Action', 'Comedy', 'Musical', 'Animation'], words: /\b(summer|zomer|beach|strand|island|eiland|ocean|oceaan|sea|zee|surf|vacation|vakantie|road trip|sun|zon|shark|haai|pirate|piraat)\b/i,
    ids: ['tt0795421', 'tt0073195', 'tt0077631', 'tt3521164', 'tt0266543', 'tt0325980', 'tt1745960', 'tt1392190', 'tt0275847', 'tt5726616'] },
  herfst: { name: 'Herfstavond', tagline: 'Regen tegen het raam, kaarsje aan, film erop.', particle: 'leaves', colors: ['#b794f6', '#f59e0b'],
    genres: ['Mystery', 'Drama', 'Crime', 'Fantasy', 'Thriller'], words: /\b(autumn|fall|herfst|school|college|detective|mystery|mysterie|murder|moord|rain|regen|forest|bos|magic|magie|wizard|tovenaar)\b/i,
    ids: ['tt0097165', 'tt8946378', 'tt0432283', 'tt0119217', 'tt0098635', 'tt0241527', 'tt0327597', 'tt3281548', 'tt0094721', 'tt0245429'] },
};

export function themeFor(date = new Date()) {
  const m = date.getMonth() + 1, d = date.getDate();
  if ((m === 12 && d >= 6 && d <= 26)) return 'kerst';
  if (m === 10 && d >= 18) return 'halloween';
  if (m === 2 && d >= 7 && d <= 14) return 'valentijn';
  if (m === 12 || m <= 2) return 'winter';
  if (m <= 5) return 'lente';
  if (m <= 8) return 'zomer';
  return 'herfst';
}

export function watchNight(who, { exclude = [], themeId = null } = {}) {
  const user = asUser(who), userId = user.id, vis = visibleTitles(scopeFor(user));
  const id = THEMES[themeId] ? themeId : themeFor();
  const theme = THEMES[id];
  const ids = new Set(theme.ids), genres = new Set(theme.genres.map(genreName));
  const watched = new Set(db.prepare('SELECT title_id FROM progress WHERE user_id = ? AND watched = 1 AND episode_id = 0').all(userId).map((r) => r.title_id));
  const scored = db.prepare("SELECT * FROM titles WHERE kind = 'movie'").all().filter((t) => seen(vis, t.id)).map((t) => {
    let s = 0;
    if (t.imdb_id && ids.has(t.imdb_id)) s += 10;
    if (theme.words.test(t.title)) s += 5; else if (theme.words.test(t.overview)) s += 3;
    for (const g of genresOf(t)) if (genres.has(g)) s += 1;
    if (watched.has(t.id)) s -= 1;
    return { t, s };
  }).sort((a, b) => b.s - a.s);
  // The pool is everything that clearly fits; topped up so there is always something to roll.
  let pool = scored.filter((x) => x.s >= 3);
  if (pool.length < 9) pool = scored.slice(0, Math.max(9, pool.length));
  const skip = new Set(exclude.map(Number));
  let candidates = pool.filter((x) => !skip.has(x.t.id));
  if (candidates.length < 3) candidates = pool;
  // Weighted draw: better fits come up more often, but anything in the pool can.
  const picks = [];
  const bag = candidates.slice();
  while (picks.length < 3 && bag.length) {
    const total = bag.reduce((n, x) => n + x.s + 2, 0);
    let r = Math.random() * total, i = 0;
    for (; i < bag.length - 1; i++) { r -= bag[i].s + 2; if (r <= 0) break; }
    picks.push(bag.splice(i, 1)[0]);
  }
  return {
    theme: { id, name: theme.name, tagline: theme.tagline, particle: theme.particle, colors: theme.colors },
    picks: picks.map((x) => ({ ...card(x.t), fit: x.s >= 10 ? 'klassieker' : x.s >= 3 ? 'past bij het seizoen' : 'verrassing' })),
    // Posters the client spins through during the roll animation.
    reel: shuffle(pool).slice(0, 14).map((x) => imgUrl('t', x.t.id, 'poster', x.t.poster)).filter(Boolean),
    poolSize: pool.length,
  };
}

// ---------------------------------------------------------------------------
export default async function routes(app) {
  app.get('/api/home', { preHandler: requireUser }, async (req) => home(req.user, ['movie', 'show'].includes(req.query.kind) ? req.query.kind : null));

  app.get('/api/titles/:id', { preHandler: requireUser }, async (req) => titleDetail(Number(req.params.id), req.user));

  app.get('/api/browse', { preHandler: requireUser }, async (req) => {
    const { kind, genre, q, sort = 'title' } = req.query;
    let rows = db.prepare(`SELECT t.*, (SELECT MAX(added_at) FROM files WHERE title_id = t.id) file_added FROM titles t ${['movie', 'show'].includes(kind) ? 'WHERE kind = ?' : ''}`)
      .all(...(['movie', 'show'].includes(kind) ? [kind] : []));
    const vis = visibleTitles(scopeFor(req.user));
    rows = rows.filter((t) => seen(vis, t.id));
    if (genre) rows = rows.filter((t) => genresOf(t).includes(genre));
    if (q) {
      const needle = String(q).toLowerCase().trim();
      rows = rows.map((t) => {
        const title = t.title.toLowerCase();
        let s = title === needle ? 100 : title.startsWith(needle) ? 60 : title.includes(needle) ? 40 : 0;
        if (!s && json(t.cast_json, []).some((c) => c.name.toLowerCase().includes(needle))) s = 20;
        if (!s && json(t.directors, []).some((c) => c.toLowerCase().includes(needle))) s = 15;
        if (!s && genresOf(t).some((g) => g.toLowerCase() === needle)) s = 10;
        return { t, s };
      }).filter((x) => x.s).sort((a, b) => b.s - a.s || (b.t.rating || 0) - (a.t.rating || 0)).map((x) => x.t);
    } else if (sort === 'recent') rows.sort((a, b) => (b.file_added || 0) - (a.file_added || 0));
    else if (sort === 'rating') rows.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    else if (sort === 'year') rows.sort((a, b) => (b.year || 0) - (a.year || 0));
    else rows.sort((a, b) => a.title.localeCompare(b.title));
    return { items: rows.slice(0, 500).map(card), total: rows.length };
  });

  app.get('/api/collections', { preHandler: requireUser }, async (req) => {
    const vis = visibleTitles(scopeFor(req.user));
    return { items: db.prepare('SELECT * FROM collections ORDER BY name').all().map((c) => collectionCard(c, vis)).filter((c) => c.count >= (vis ? 1 : 0)) };
  });
  app.get('/api/collections/:id', { preHandler: requireUser }, async (req) => {
    const c = db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id);
    if (!c) throw new HttpError(404, 'Collectie niet gevonden.');
    const vis = visibleTitles(scopeFor(req.user));
    const items = db.prepare('SELECT t.* FROM collection_items i JOIN titles t ON t.id = i.title_id WHERE i.collection_id = ? ORDER BY i.ord').all(c.id).filter((t) => seen(vis, t.id));
    if (vis && !items.length) throw new HttpError(404, 'Collectie niet gevonden.');
    return { ...collectionCard(c, vis), items: items.map(card) };
  });

  // Audio and subtitle language the user chose for a series; applied to the next episodes.
  app.put('/api/titles/:id/prefs', { preHandler: requireUser }, async (req) => {
    const id = Number(req.params.id);
    requireTitle(req.user, id);
    const lang = (v) => (typeof v === 'string' && /^[a-z]{2,3}$|^off$|^$/.test(v) ? v : null);
    const prev = db.prepare('SELECT audio_lang, sub_lang FROM series_prefs WHERE user_id = ? AND title_id = ?').get(req.user.id, id) || { audio_lang: '', sub_lang: '' };
    const audio = req.body?.audioLang === undefined ? prev.audio_lang : lang(req.body.audioLang);
    const sub = req.body?.subLang === undefined ? prev.sub_lang : lang(req.body.subLang);
    if (audio === null || sub === null || audio === 'off') throw new HttpError(400, 'Ongeldige taal.');
    db.prepare(`INSERT INTO series_prefs (user_id, title_id, audio_lang, sub_lang, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id, title_id) DO UPDATE SET audio_lang = excluded.audio_lang, sub_lang = excluded.sub_lang, updated_at = excluded.updated_at`).run(req.user.id, id, audio, sub, now());
    return { audioLang: audio, subLang: sub };
  });

  app.put('/api/mylist/:id', { preHandler: requireUser }, async (req) => {
    requireTitle(req.user, req.params.id);
    db.prepare('INSERT OR IGNORE INTO mylist (user_id, title_id, added_at) VALUES (?,?,?)').run(req.user.id, req.params.id, now());
    return { inList: true };
  });
  app.delete('/api/mylist/:id', { preHandler: requireUser }, async (req) => {
    db.prepare('DELETE FROM mylist WHERE user_id = ? AND title_id = ?').run(req.user.id, req.params.id);
    return { inList: false };
  });

  app.get('/api/watchnight', { preHandler: requireUser }, async (req) => watchNight(req.user, {
    exclude: String(req.query.exclude || '').split(',').filter(Boolean), themeId: req.query.theme,
  }));
}
