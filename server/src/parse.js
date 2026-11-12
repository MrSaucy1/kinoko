// Turns a file path into "which movie / which episode of which show".
import path from 'node:path';

export const VIDEO_EXT = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm', '.ts', '.m2ts', '.wmv', '.flv', '.mpg', '.mpeg']);

const JUNK = /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10\+?|hdr|dv|dovi|bluray|blu-ray|brrip|bdrip|web-?dl|web-?rip|webrip|hdtv|dvdrip|remux|x264|x265|h\.?264|h\.?265|hevc|avc|av1|xvid|divx|aac|ac3|eac3|dts(-?hd)?|truehd|atmos|ddp?5\.?1|5\.1|7\.1|10bit|8bit|proper|repack|extended|unrated|remastered|imax|multi|dual|nl|dutch|subs?|nlsubs)\b.*$/i;

export function cleanTitle(raw) {
  let s = raw.replace(/\[[^\]]*\]/g, ' ').replace(/[._]/g, ' ');
  s = s.replace(JUNK, ' ');
  s = s.replace(/\(\s*\)/g, ' ').replace(/[\s\-–]+$/g, '').replace(/\s{2,}/g, ' ').trim();
  return s;
}

/** Splits "Some Title (2019)" / "Some.Title.2019.1080p" into title + year. */
export function splitYear(raw) {
  const s = raw.replace(/[._]/g, ' ');
  // Prefer a year in brackets; otherwise the last plausible year that is not the very start.
  let m = s.match(/^(.*?)[\s]*[\(\[]((?:19|20)\d{2})[\)\]]/);
  if (!m) {
    const all = [...s.matchAll(/\b((?:19|20)\d{2})\b/g)].filter((x) => x.index > 0);
    if (all.length) { const last = all[all.length - 1]; m = [null, s.slice(0, last.index), last[1]]; }
  }
  if (m && cleanTitle(m[1])) return { title: cleanTitle(m[1]), year: Number(m[2]) };
  return { title: cleanTitle(s), year: null };
}

const EP_PATTERNS = [
  /\bS(\d{1,2})[\s._-]*E(\d{1,3})\b/i,
  /\b(\d{1,2})x(\d{1,3})\b/i,
  /\bseason[\s._-]*(\d{1,2})[\s._-]*episode[\s._-]*(\d{1,3})\b/i,
  /\bseizoen[\s._-]*(\d{1,2})[\s._-]*aflevering[\s._-]*(\d{1,3})\b/i,
];
const SEASON_DIR = /^(?:season|seizoen|series|staffel|s)[\s._-]*(\d{1,2})$/i;

export function parseMovie(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const dir = path.basename(path.dirname(filePath));
  const fromFile = splitYear(base);
  // A "Title (Year)" folder is the more deliberate name, so it wins when present.
  const fromDir = splitYear(dir);
  if (fromDir.year && fromDir.title) return fromDir;
  return fromFile;
}

export function parseEpisode(filePath, libraryRoot) {
  const base = path.basename(filePath, path.extname(filePath));
  const rel = path.relative(libraryRoot, filePath).split(path.sep);
  let season = null, episode = null, matchIndex = -1, name = '';
  for (const re of EP_PATTERNS) {
    const m = base.match(re);
    if (m) { season = Number(m[1]); episode = Number(m[2]); matchIndex = m.index; name = base.slice(m.index + m[0].length); break; }
  }
  const parent = rel.length >= 2 ? rel[rel.length - 2] : '';
  const sd = parent.match(SEASON_DIR);
  if (episode === null) {
    // "Season 2/05 - Name.mkv" or "Show - 05.mkv"
    const m = base.match(/(?:^|[\s._-])(?:e|ep|episode|aflevering)?[\s._-]*(\d{1,3})(?:[\s._-]|$)/i);
    if (!m) return null;
    episode = Number(m[1]); season = sd ? Number(sd[1]) : 1; matchIndex = m.index; name = base.slice(m.index + m[0].length);
  }
  // Show name: top folder under the library root if the file lives in one, else the filename prefix.
  let showRaw;
  if (rel.length >= 3 || (rel.length === 2 && !sd)) showRaw = rel[0];
  else showRaw = base.slice(0, matchIndex);
  const show = splitYear(showRaw);
  if (!show.title) return null;
  name = cleanTitle(name.replace(/^[\s._-]+/, ''));
  return { title: show.title, year: show.year, season, episode, name };
}

export function normKey(title, year) {
  const t = title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').replace(/^(the|a|an|de|het|een) /, '').trim();
  return year ? `${t}|${year}` : t;
}
