// Age ratings. Whatever a source says (Kijkwijzer, FSK, MPAA, BBFC, TV
// guidelines) is reduced to one number: the minimum age on the Kijkwijzer
// scale AL/6/9/12/14/16/18, where AL is stored as 0. Unknown stays null.
export const AGES = [0, 6, 9, 12, 14, 16, 18];
export const ageLabel = (age) => (age === null || age === undefined ? null : age === 0 ? 'AL' : String(age));

/** A number of years becomes the first step at or above it — when in doubt, the stricter one. */
const bucket = (n) => AGES.find((a) => a >= n) ?? 18;

const WORDS = {
  // Kijkwijzer / general
  al: 0, 'alle leeftijden': 0, u: 0, g: 0, 'tv-y': 0, 'tv-g': 0, 'fsk 0': 0, 'approved': 0, 'passed': 0,
  'tv-y7': 6, 'tv-y7-fv': 6,
  pg: 9, 'tv-pg': 9,
  'pg-13': 12, '12a': 12,
  'tv-14': 14,
  r: 16, m: 16, ma15: 16, 'ma15+': 16, 'ma 15+': 16,
  'nc-17': 18, 'tv-ma': 18, x: 18, r18: 18, 'r18+': 18, 'unrated': null, 'not rated': null, nr: null,
};

/**
 * Turns one certification string into a minimum age, or null when it says nothing.
 * Accepts things like "12", "NL:12", "Rated PG-13", "FSK 16", "TV-MA", "Kijkwijzer AL".
 */
export function normalizeAge(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^rated\s+/, '').replace(/^[a-z]{2}\s*[:/]\s*/, '').replace(/^(kijkwijzer|nicam|bbfc|mpaa|mpa)\s*[:-]?\s*/, '').trim();
  if (s in WORDS) return WORDS[s];
  const fsk = s.match(/^(?:fsk|usk|ab)\s*-?\s*(\d{1,2})$/);
  if (fsk) return bucket(Number(fsk[1]));
  const num = s.match(/^(\d{1,2})\s*\+?$/);
  if (num) return bucket(Number(num[1]));
  return null;
}

/** Picks the rating to trust from several countries: the Dutch one first, then neighbours, then the US. */
export function pickAge(byCountry) {
  for (const c of ['NL', 'BE', 'DE', 'GB', 'US', 'FR', 'AU', 'CA']) {
    for (const cert of byCountry[c] || []) { const a = normalizeAge(cert); if (a !== null) return a; }
  }
  for (const list of Object.values(byCountry)) for (const cert of list) { const a = normalizeAge(cert); if (a !== null) return a; }
  return null;
}

/**
 * Keyless source: Wikidata knows the Kijkwijzer (P2684), FSK (P1981) and MPAA
 * (P1657) rating of many films. Returns Map<imdbId, age>, or null when the
 * service cannot be reached.
 */
export async function wikidataAges(imdbIds, getJson) {
  const out = new Map();
  for (let i = 0; i < imdbIds.length; i += 80) {
    const batch = imdbIds.slice(i, i + 80).filter((x) => /^tt\d+$/.test(x));
    if (!batch.length) continue;
    const query = `SELECT ?imdb ?k ?kLabel ?fLabel ?mLabel WHERE { VALUES ?imdb { ${batch.map((x) => `"${x}"`).join(' ')} } ?t wdt:P345 ?imdb. OPTIONAL { ?t wdt:P2684 ?k. } OPTIONAL { ?t wdt:P1981 ?f. } OPTIONAL { ?t wdt:P1657 ?m. } SERVICE wikibase:label { bd:serviceParam wikibase:language "nl,en". } }`;
    const res = await getJson(`https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`, { headers: { Accept: 'application/sparql-results+json' }, timeout: 30000 });
    if (!res) return null;
    for (const b of res.results?.bindings || []) {
      const id = b.imdb.value;
      if (out.has(id)) continue;
      // Q23649981 is Kijkwijzer's "all ages", which has no label in every language.
      const k = b.k?.value?.endsWith('/Q23649981') ? 0 : normalizeAge(b.kLabel?.value);
      const age = k ?? normalizeAge(b.fLabel?.value) ?? normalizeAge(b.mLabel?.value);
      if (age !== null && age !== undefined) out.set(id, age);
    }
  }
  return out;
}
