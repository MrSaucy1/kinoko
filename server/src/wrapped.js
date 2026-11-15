// Kinoko Wrapped: one user's year in numbers. Private by default; the user
// can make a share link, and take it back.
import { db, now, json, randomToken, HttpError } from './db.js';
import { requireUser } from './auth.js';
import { card, genreName } from './catalog.js';

export { logWatch } from './watchlog.js';

const DAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
/** Extra sections (music, in a later phase) register here: fn(userId, year) -> object merged into the result. */
const extra = [];
export const addWrappedSection = (fn) => extra.push(fn);

export function wrapped(userId, year) {
  const rows = db.prepare('SELECT title_id, episode_id, day, seconds FROM watch_log WHERE user_id = ? AND day >= ? AND day <= ?').all(userId, `${year}-01-01`, `${year}-12-31`);
  const byTitle = new Map(), byDay = new Map(), byWeekday = Array(7).fill(0), byMonth = Array(12).fill(0), bySitting = new Map();
  let total = 0;
  for (const r of rows) {
    total += r.seconds;
    byTitle.set(r.title_id, (byTitle.get(r.title_id) || 0) + r.seconds);
    byDay.set(r.day, (byDay.get(r.day) || 0) + r.seconds);
    const d = new Date(`${r.day}T12:00:00`);
    byWeekday[d.getDay()] += r.seconds; byMonth[d.getMonth()] += r.seconds;
    const k = `${r.day}|${r.title_id}`; bySitting.set(k, (bySitting.get(k) || 0) + r.seconds);
  }
  const titles = new Map([...byTitle.keys()].map((id) => [id, db.prepare('SELECT * FROM titles WHERE id = ?').get(id)]));
  const genres = new Map(); let movies = 0, shows = 0;
  for (const [id, sec] of byTitle) {
    const t = titles.get(id); if (!t) continue;
    if (t.kind === 'movie') movies++; else shows++;
    for (const g of new Set(json(t.genres, []).map(genreName))) genres.set(g, (genres.get(g) || 0) + sec);
  }
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const longest = top(bySitting, 1)[0];
  const bestDay = byWeekday.indexOf(Math.max(...byWeekday));
  const out = {
    year, empty: total < 60, seconds: Math.round(total), hours: Math.round(total / 360) / 10, days: byDay.size, movies, shows,
    topTitles: top(byTitle, 5).filter(([id]) => titles.get(id)).map(([id, sec]) => { const c = card(titles.get(id)); return { id: c.id, kind: c.kind, title: c.title, year: c.year, poster: c.poster, seconds: Math.round(sec) }; }),
    topGenres: top(genres, 5).map(([name, sec]) => ({ name, seconds: Math.round(sec), share: total ? Math.round((sec / total) * 100) : 0 })),
    longestSession: longest && titles.get(Number(longest[0].split('|')[1])) ? { seconds: Math.round(longest[1]), day: longest[0].split('|')[0], title: titles.get(Number(longest[0].split('|')[1])).title } : null,
    favoriteDay: total ? { name: DAYS[bestDay], seconds: Math.round(byWeekday[bestDay]) } : null,
    months: byMonth.map((s) => Math.round(s)),
  };
  for (const fn of extra) { try { Object.assign(out, fn(userId, year)); } catch (e) { console.error('[wrapped]', e.message); } }
  if (out.music && !out.music.empty) out.empty = false;
  return out;
}

const validYear = (v) => { const y = Number(v) || new Date().getFullYear(); if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new HttpError(400, 'Ongeldig jaar.'); return y; };

export default async function routes(app) {
  app.get('/api/wrapped', { preHandler: requireUser }, async (req) => {
    const year = validYear(req.query.year);
    const share = db.prepare('SELECT token FROM wrapped_shares WHERE user_id = ? AND year = ?').get(req.user.id, year);
    const years = db.prepare("SELECT DISTINCT substr(day, 1, 4) y FROM watch_log WHERE user_id = ? ORDER BY y DESC").all(req.user.id).map((r) => Number(r.y));
    return { ...wrapped(req.user.id, year), name: req.user.name, years, sharePath: share ? `/wrapped/${share.token}` : null };
  });
  app.post('/api/wrapped/share', { preHandler: requireUser }, async (req) => {
    const year = validYear(req.body?.year);
    const have = db.prepare('SELECT token FROM wrapped_shares WHERE user_id = ? AND year = ?').get(req.user.id, year);
    const token = have ? have.token : randomToken(18);
    if (!have) db.prepare('INSERT INTO wrapped_shares (token, user_id, year, created_at) VALUES (?,?,?,?)').run(token, req.user.id, year, now());
    return { sharePath: `/wrapped/${token}` };
  });
  app.delete('/api/wrapped/share', { preHandler: requireUser }, async (req) => {
    db.prepare('DELETE FROM wrapped_shares WHERE user_id = ? AND year = ?').run(req.user.id, validYear(req.query.year));
    return { ok: true };
  });
  // The share link itself is the permission: no account needed, and only what the owner's own page shows.
  app.get('/api/wrapped/shared/:token', async (req) => {
    const s = db.prepare('SELECT w.user_id, w.year, u.name FROM wrapped_shares w JOIN users u ON u.id = w.user_id WHERE w.token = ?').get(String(req.params.token));
    if (!s) throw new HttpError(404, 'Dit jaaroverzicht wordt niet (meer) gedeeld.');
    const w = wrapped(s.user_id, s.year);
    // Title ids are internal; a visitor without an account gets names and posters only.
    return { ...w, name: s.name, shared: true, topTitles: w.topTitles.map(({ id, ...t }) => t) };
  });
}
