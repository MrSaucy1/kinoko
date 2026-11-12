// Smart collections: films that belong together are grouped automatically.
// Sources, in order of trust: TMDB's collection, Wikidata's "part of the
// series", and finally a title-prefix heuristic for unmatched files.
import { db, json } from './db.js';
import { normKey } from './parse.js';

// Wikidata also files films under studio lists and MCU phases; those are not collections people browse.
const NOISE = /\b(phase|fase|lijst|list of|filmography|filmografie)\b|\bfilms? (van|by|of)\b/i;
const GENERIC = new Set(['the', 'a', 'de', 'het', 'movie', 'film', 'part', 'deel', 'chapter', 'volume', 'vol']);

/** "Toy Story 3" → "toy story", "Dune: Part Two" → "dune". */
export function franchiseBase(title) {
  let s = title.split(/\s*[:–—]\s+|\s+-\s+/)[0];
  s = s.replace(/\b(part|deel|chapter|vol(?:ume)?)\.?\s*(\d+|[ivx]+|one|two|three|four|five)\b.*$/i, '');
  s = s.replace(/\s+(\d{1,2}|ii|iii|iv|v|vi|vii|viii|ix)$/i, '');
  return normKey(s, null);
}

export function buildGroups(titles) {
  const groups = new Map();
  const add = (key, name, rank, id) => {
    if (!groups.has(key)) groups.set(key, { key, name, rank, ids: new Set() });
    groups.get(key).ids.add(id);
  };
  for (const t of titles) {
    const tc = json(t.tmdb_collection, null);
    if (tc && tc.id) add(`tmdb:${tc.id}`, tc.name, 0, t.id);
    for (const s of json(t.series_json, [])) if (!NOISE.test(s.name)) add(`wd:${s.id}`, s.name, 1, t.id);
  }
  // Heuristic pass over everything: catches unmatched files and franchises
  // the databases don't model. Identical groups are dropped below.
  const byBase = new Map();
  for (const t of titles) {
    const base = franchiseBase(t.title);
    if (base.length < 3 || GENERIC.has(base)) continue;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(t);
  }
  for (const [base, list] of byBase) {
    if (list.length < 2) continue;
    // Only a real franchise if at least one member has more title after the base.
    if (!list.some((t) => normKey(t.title, null) !== base)) continue;
    const shortest = list.reduce((a, b) => (a.title.length <= b.title.length ? a : b));
    const name = shortest.title.split(/\s*[:–—]\s+|\s+-\s+/)[0].replace(/\s+(\d{1,2}|ii|iii|iv|v|vi)$/i, '');
    for (const t of list) add(`h:${base}`, `${name} collectie`, 2, t.id);
  }
  // Keep real groups, and drop duplicates of the same member set (best source wins).
  const kept = [];
  const seenSets = new Map();
  for (const g of [...groups.values()].filter((g) => g.ids.size >= 2).sort((a, b) => a.rank - b.rank || a.name.length - b.name.length)) {
    const sig = [...g.ids].sort((a, b) => a - b).join(',');
    if (seenSets.has(sig)) continue;
    seenSets.set(sig, true);
    kept.push(g);
  }
  return kept;
}

export const rebuildCollections = db.transaction(() => {
  const titles = db.prepare("SELECT id, title, year, tmdb_collection, series_json FROM titles WHERE kind = 'movie'").all();
  const years = new Map(titles.map((t) => [t.id, t.year || 9999]));
  const groups = buildGroups(titles);
  const keep = new Set(groups.map((g) => g.key));
  for (const c of db.prepare('SELECT id, source_key FROM collections').all()) {
    if (!keep.has(c.source_key)) db.prepare('DELETE FROM collections WHERE id = ?').run(c.id);
  }
  for (const g of groups) {
    db.prepare('INSERT INTO collections (name, source_key) VALUES (?, ?) ON CONFLICT(source_key) DO UPDATE SET name = excluded.name').run(g.name, g.key);
    const { id } = db.prepare('SELECT id FROM collections WHERE source_key = ?').get(g.key);
    db.prepare('DELETE FROM collection_items WHERE collection_id = ?').run(id);
    const ordered = [...g.ids].sort((a, b) => years.get(a) - years.get(b));
    ordered.forEach((tid, i) => db.prepare('INSERT INTO collection_items (collection_id, title_id, ord) VALUES (?,?,?)').run(id, tid, i));
  }
  return groups.length;
});
