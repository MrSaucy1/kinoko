// Subtitles: sidecar files, embedded text tracks, and downloads from the
// keyless OpenSubtitles catalogue. Everything is served to clients as WebVTT.
import fs from 'node:fs';
import path from 'node:path';
import { db, json, HttpError } from './db.js';
import { config, dataPath } from './config.js';
import { run, shortLang } from './ffmpeg.js';
import { requireUser } from './auth.js';
import { requireFile } from './access.js';
import { onScanFinished } from './library.js';

const LANG_NAMES = { nl: 'Nederlands', en: 'Engels', de: 'Duits', fr: 'Frans', es: 'Spaans', it: 'Italiaans', pt: 'Portugees', tr: 'Turks', ar: 'Arabisch', ja: 'Japans', ko: 'Koreaans', ru: 'Russisch', zh: 'Chinees', pl: 'Pools', sv: 'Zweeds', da: 'Deens', no: 'Noors', fi: 'Fins', und: 'Onbekend' };
export const langName = (l) => LANG_NAMES[l] || l.toUpperCase();

/** SRT (or already-VTT) text → WebVTT. */
export function toVtt(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (/^WEBVTT/.test(text)) return text;
  const body = text.split('\n').map((line) => (/-->/.test(line) ? line.replace(/(\d),(\d{3})/g, '$1.$2') : line)).join('\n')
    .replace(/\{\\[^}]*\}/g, '');
  return 'WEBVTT\n\n' + body.trim() + '\n';
}

function decodeText(buf) {
  const utf8 = buf.toString('utf8');
  // Old Dutch/English SRTs are often Windows-1252; a replacement char gives that away.
  return utf8.includes('�') ? buf.toString('latin1') : utf8;
}

const addStmt = db.prepare('INSERT INTO subtitles (file_id, lang, label, path, source) VALUES (?,?,?,?,?)');

/** Registers sidecar subtitles and extracts embedded text tracks for one file. */
export async function indexSubtitles(file) {
  const known = new Set(db.prepare('SELECT path FROM subtitles WHERE file_id = ?').all(file.id).map((r) => r.path));
  const dir = path.dirname(file.path), stem = path.basename(file.path, path.extname(file.path));
  let names = []; try { names = await fs.promises.readdir(dir); } catch { /* unreadable dir */ }
  for (const n of names) {
    if (!n.startsWith(stem) || !/\.(srt|vtt)$/i.test(n)) continue;
    const p = path.join(dir, n);
    if (known.has(p)) continue;
    const m = n.slice(stem.length).match(/\.([a-z]{2,3})(?:\.(?:forced|sdh|hi|cc))?\.(?:srt|vtt)$/i);
    const lang = m ? shortLang(m[1]) : 'und';
    addStmt.run(file.id, lang, langName(lang), p, 'sidecar');
  }
  const streams = json(file.streams, { subs: [] });
  for (const s of streams.subs || []) {
    if (!s.text) continue;
    const out = dataPath('subs', `${file.id}-e${s.index}.vtt`);
    if (known.has(out)) continue;
    if (!fs.existsSync(out)) {
      const r = await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file.path, '-map', `0:s:${s.index}`, '-f', 'webvtt', out], { timeout: 180_000 });
      if (r.code !== 0 || !fs.existsSync(out)) continue;
    }
    addStmt.run(file.id, s.lang, `${langName(s.lang)}${s.forced ? ' (geforceerd)' : ''}${s.title ? ' · ' + s.title : ''}`, out, 'embedded');
  }
}

onScanFinished(async (state) => {
  state.phase = 'ondertitels';
  const rows = db.prepare(`SELECT * FROM files WHERE peer_id IS NULL AND id NOT IN (SELECT file_id FROM subtitles WHERE source IN ('embedded','sidecar'))`).all();
  for (const f of rows) { try { await indexSubtitles(f); } catch (e) { console.error('[subs]', f.path, e.message); } }
});

// ---------------------------------------------------------------------------
// Online search (OpenSubtitles through the public Stremio add-on: no key)
// ---------------------------------------------------------------------------
const OS = 'https://opensubtitles-v3.strem.io';

function imdbRef(file) {
  const t = db.prepare('SELECT kind, imdb_id FROM titles WHERE id = ?').get(file.title_id);
  if (!t || !t.imdb_id) return null;
  if (t.kind === 'movie') return `movie/${t.imdb_id}`;
  const e = db.prepare('SELECT season, episode FROM episodes WHERE id = ?').get(file.episode_id);
  return e ? `series/${t.imdb_id}:${e.season}:${e.episode}` : null;
}

export async function searchOnline(file, langs) {
  const ref = imdbRef(file);
  if (!ref) throw new HttpError(409, 'Deze titel heeft geen IMDb-koppeling; zonder kan er niet gezocht worden.');
  let res;
  try {
    const r = await fetch(`${OS}/subtitles/${ref}.json`, { headers: { 'User-Agent': 'Kinoko/0.1' }, signal: AbortSignal.timeout(20000) });
    res = r.ok ? await r.json() : null;
  } catch { res = null; }
  if (!res) throw new HttpError(502, 'De ondertitelbron is nu niet bereikbaar.');
  const want = new Set(langs);
  const seen = new Map();
  const out = [];
  for (const s of res.subtitles || []) {
    const lang = shortLang(s.lang);
    if (want.size && !want.has(lang)) continue;
    const n = (seen.get(lang) || 0) + 1; seen.set(lang, n);
    if (n > 6) continue;
    out.push({ id: String(s.id), lang, label: `${langName(lang)} #${n}`, url: s.url });
  }
  return out.sort((a, b) => langs.indexOf(a.lang) - langs.indexOf(b.lang));
}

export async function downloadOnline(file, { url, lang }) {
  if (!/^https:\/\/[a-z0-9.-]*strem\.io\//.test(String(url))) throw new HttpError(400, 'Onbekende ondertitelbron.');
  let buf;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Kinoko/0.1' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(String(r.status));
    buf = Buffer.from(await r.arrayBuffer());
  } catch { throw new HttpError(502, 'Downloaden van de ondertitel is mislukt.'); }
  if (buf.length > 3 * 1024 * 1024 || !/-->/.test(buf.toString('latin1'))) throw new HttpError(502, 'Dit bestand is geen geldige ondertitel.');
  const l = shortLang(lang);
  const n = db.prepare("SELECT COUNT(*) c FROM subtitles WHERE file_id = ? AND source = 'online' AND lang = ?").get(file.id, l).c + 1;
  const out = dataPath('subs', `${file.id}-o-${l}-${Date.now()}.vtt`);
  await fs.promises.writeFile(out, toVtt(decodeText(buf)));
  const info = addStmt.run(file.id, l, `${langName(l)} (gedownload${n > 1 ? ' ' + n : ''})`, out, 'online');
  return { id: Number(info.lastInsertRowid), lang: l };
}

let remote = null;
/** federation.js registers how to search/download for files on a linked server. */
export const setRemoteSubs = (impl) => { remote = impl; };

export default async function routes(app) {
  // Ticket in the path: players fetch subtitle tracks without auth headers.
  app.get('/api/subs/:id/:ticket.vtt', async (req, reply) => {
    const s = db.prepare('SELECT * FROM subtitles WHERE id = ?').get(req.params.id);
    if (!s) throw new HttpError(404, 'Ondertitel niet gevonden.');
    let text; try { text = decodeText(await fs.promises.readFile(s.path)); } catch { throw new HttpError(404, 'Ondertitelbestand ontbreekt.'); }
    return reply.header('Content-Type', 'text/vtt; charset=utf-8').header('Access-Control-Allow-Origin', '*').send(toVtt(text));
  });

  app.get('/api/files/:id/subtitles/search', { preHandler: requireUser }, async (req) => {
    const file = requireFile(req.user, req.params.id, 'Bestand niet gevonden.');
    const langs = String(req.query.langs || 'nl,en').split(',').map((s) => s.trim()).filter(Boolean);
    if (file.peer_id) { if (!remote) throw new HttpError(501, 'Niet beschikbaar.'); return remote.search(file, langs); }
    return { results: await searchOnline(file, langs) };
  });
  app.post('/api/files/:id/subtitles/download', { preHandler: requireUser }, async (req) => {
    const file = requireFile(req.user, req.params.id, 'Bestand niet gevonden.');
    if (file.peer_id) { if (!remote) throw new HttpError(501, 'Niet beschikbaar.'); return remote.download(file, req.body || {}); }
    const { issueTicket } = await import('./stream.js');
    const sub = await downloadOnline(file, req.body || {});
    const row = db.prepare('SELECT id, lang, label, source FROM subtitles WHERE id = ?').get(sub.id);
    return { subtitle: { ...row, url: `/api/subs/${row.id}/${issueTicket(file.id)}.vtt` } };
  });
}
