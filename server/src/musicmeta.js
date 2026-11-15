// Optional online metadata for music, used only where the files' own tags
// leave a gap: missing album covers (Cover Art Archive) and artist pictures and
// descriptions (Wikidata/Wikimedia), found through MusicBrainz. No key needed.
// Switch it off in the admin and Kinoko never contacts any of them.
import { db, now, settings } from './db.js';
import { config } from './config.js';
import { onMusicScanned } from './music.js';

// MusicBrainz asks for an identifying User-Agent and at most one request per second.
const UA = `Kinoko/${config.version} ( https://github.com/MrSaucy1/kinoko )`;
export const enabled = () => settings.get('music_online', true) !== false;

let chain = Promise.resolve(), last = 0;
/** Runs `fn` no sooner than `gap` ms after the previous call through this limiter. */
export function throttled(fn, gap = 1100) {
  const p = chain.then(async () => {
    const wait = last + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { last = Date.now(); }
  });
  chain = p.catch(() => {});
  return p;
}

async function getJson(url, gap) {
  const call = async () => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if (r.status === 404) return { missing: true };
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  return gap ? throttled(call, gap) : call();
}
const mb = (path) => getJson(`https://musicbrainz.org/ws/2/${path}`, 1100);
const lucene = (s) => String(s).replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');

/** Looks for the cover of one album. Returns true when something was stored, null when the service did not answer. */
export async function findCover(album) {
  let mbid = album.mbid;
  if (!mbid) {
    const artist = db.prepare('SELECT name FROM artists WHERE id = ?').get(album.artist_id)?.name || '';
    const r = await mb(`release/?fmt=json&limit=3&query=${encodeURIComponent(`release:"${lucene(album.title)}" AND artist:"${lucene(artist)}"`)}`);
    if (!r) return null;
    const hit = (r.releases || []).find((x) => (x.score || 0) >= 90);
    if (hit) { mbid = hit.id; db.prepare('UPDATE albums SET mbid = ? WHERE id = ?').run(mbid, album.id); }
  }
  if (!mbid) return false;
  const art = await getJson(`https://coverartarchive.org/release/${mbid}`, 0);
  if (!art) return null;
  const front = (art.images || []).find((i) => i.front) || (art.images || [])[0];
  const url = front && (front.thumbnails?.['500'] || front.thumbnails?.large || front.image);
  if (!url || !/^https?:\/\//.test(url)) return false;
  db.prepare('UPDATE albums SET cover = ? WHERE id = ? AND cover IS NULL').run(url.replace(/^http:/, 'https:'), album.id);
  return true;
}

/** Picture and a one-line description for an artist, through MusicBrainz → Wikidata. */
export async function findArtist(artist) {
  let mbid = artist.mbid;
  if (!mbid) {
    const r = await mb(`artist/?fmt=json&limit=3&query=${encodeURIComponent(`artist:"${lucene(artist.name)}"`)}`);
    if (!r) return null;
    const hit = (r.artists || []).find((x) => (x.score || 0) >= 95);
    if (hit) { mbid = hit.id; db.prepare('UPDATE artists SET mbid = ? WHERE id = ?').run(mbid, artist.id); }
  }
  if (!mbid) return false;
  const a = await mb(`artist/${mbid}?fmt=json&inc=url-rels`);
  if (!a) return null;
  const wd = (a.relations || []).map((r) => r.url?.resource || '').map((u) => (u.match(/wikidata\.org\/wiki\/(Q\d+)/) || [])[1]).find(Boolean);
  if (!wd) return false;
  const e = await getJson(`https://www.wikidata.org/wiki/Special:EntityData/${wd}.json`, 0);
  const ent = e?.entities?.[wd];
  if (!ent) return e ? false : null;
  const file = ent.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  const image = typeof file === 'string' ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, '_'))}?width=600` : null;
  const bio = ent.descriptions?.nl?.value || ent.descriptions?.en?.value || '';
  db.prepare('UPDATE artists SET image = COALESCE(image, ?), bio = CASE WHEN bio = \'\' THEN ? ELSE bio END WHERE id = ?').run(image, bio.slice(0, 300), artist.id);
  return !!(image || bio);
}

export const musicMetaState = { running: false, done: 0, total: 0 };
/** Works through albums without a cover and artists never looked up. Stops quietly when the services are down. */
export async function enrichMusic({ limit = 300 } = {}) {
  if (musicMetaState.running || !enabled()) return;
  const albums = db.prepare('SELECT * FROM albums WHERE cover IS NULL AND meta_at IS NULL AND id IN (SELECT album_id FROM tracks WHERE peer_id IS NULL) LIMIT ?').all(limit);
  const artists = db.prepare("SELECT * FROM artists WHERE meta_at IS NULL AND norm NOT IN ('diverse artiesten', 'onbekende artiest') AND id IN (SELECT artist_id FROM albums) LIMIT ?").all(limit);
  Object.assign(musicMetaState, { running: true, done: 0, total: albums.length + artists.length });
  try {
    let down = 0;
    for (const [list, fn, table] of [[albums, findCover, 'albums'], [artists, findArtist, 'artists']]) {
      for (const row of list) {
        if (!enabled() || down >= 3) return;
        const r = await fn(row).catch(() => null);
        // null = no answer: leave it for next time. Anything else is settled, found or not.
        if (r === null) down++; else { down = 0; db.prepare(`UPDATE ${table} SET meta_at = ? WHERE id = ?`).run(now(), row.id); }
        musicMetaState.done++;
      }
    }
  } finally { musicMetaState.running = false; }
}
onMusicScanned(() => { enrichMusic().catch((e) => console.error('[muziek-meta]', e.message)); });
