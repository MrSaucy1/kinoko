// ffprobe + hardware-acceleration detection.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { settings } from './db.js';

export function run(bin, args, { timeout = 60_000, input = null, maxBuffer = 64 * 1024 * 1024, binary = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, stdout: binary ? Buffer.alloc(0) : '', stderr: String(e) }); }
    const out = []; let outLen = 0; let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => { outLen += d.length; if (outLen <= maxBuffer) out.push(d); });
    child.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: binary ? Buffer.alloc(0) : '', stderr: String(e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      resolve({ code, stdout: binary ? buf : buf.toString('utf8'), stderr: err });
    });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

// Looks the program up in PATH itself; no shell is involved, so a name can never be run as a command.
export function which(bin) {
  if (!/^[A-Za-z0-9._+-]+$/.test(String(bin))) return false;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try { const f = path.join(dir, bin); if (fs.statSync(f).isFile()) { fs.accessSync(f, fs.constants.X_OK); return true; } } catch { /* not here */ }
  }
  return false;
}

let available = null;
export async function ffmpegAvailable() {
  if (available === null) {
    const r = await run(config.ffmpeg, ['-version'], { timeout: 8000 });
    available = r.code === 0 ? (r.stdout.split('\n')[0] || 'ffmpeg') : false;
  }
  return available;
}

const LANG = { nld: 'nl', dut: 'nl', eng: 'en', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it', jpn: 'ja', kor: 'ko', por: 'pt', tur: 'tr', ara: 'ar', rus: 'ru', zho: 'zh', chi: 'zh' };
export const shortLang = (l) => (!l || /^und/i.test(l) ? 'und' : (LANG[l.toLowerCase()] || l.toLowerCase().slice(0, 2)));
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

function containerName(format, file) {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  if (format.includes('matroska')) return ext === 'webm' ? 'webm' : 'mkv';
  if (format.includes('mp4')) return ext === 'mov' ? 'mov' : 'mp4';
  if (format === 'mpegts') return 'ts';
  return format.split(',')[0] || ext;
}

/** Probes one file. Returns null when ffprobe cannot read it. */
export async function probe(file) {
  const r = await run(config.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file], { timeout: 45_000 });
  if (r.code !== 0) return null;
  let j; try { j = JSON.parse(r.stdout); } catch { return null; }
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) return null;
  const audio = streams.filter((s) => s.codec_type === 'audio').map((s, i) => ({
    index: i, codec: s.codec_name || '', channels: s.channels || 2,
    lang: shortLang(s.tags && s.tags.language), title: (s.tags && s.tags.title) || '',
    default: !!(s.disposition && s.disposition.default),
  }));
  const subs = streams.filter((s) => s.codec_type === 'subtitle').map((s, i) => ({
    index: i, codec: s.codec_name || '', text: TEXT_SUBS.has(s.codec_name),
    lang: shortLang(s.tags && s.tags.language), title: (s.tags && s.tags.title) || '',
    forced: !!(s.disposition && s.disposition.forced),
  }));
  const duration = Number(j.format?.duration) || Number(v.duration) || 0;
  let bitrate = Number(j.format?.bit_rate) || 0;
  if (!bitrate && duration > 0) { try { bitrate = Math.round(fs.statSync(file).size * 8 / duration); } catch { /* keep 0 */ } }
  const transfer = v.color_transfer || '';
  let fps = 0;
  if (v.avg_frame_rate && v.avg_frame_rate.includes('/')) { const [a, b] = v.avg_frame_rate.split('/').map(Number); if (b) fps = a / b; }
  return {
    duration, bitrate,
    width: v.width || 0, height: v.height || 0,
    vcodec: v.codec_name || '', acodec: audio[0]?.codec || '',
    container: containerName(j.format?.format_name || '', file),
    hdr: transfer === 'smpte2084' || transfer === 'arib-std-b67' ? 1 : 0,
    pixFmt: v.pix_fmt || '', fps,
    streams: { audio, subs },
    chapters: (j.chapters || []).map((c) => ({ start: Number(c.start_time), end: Number(c.end_time), title: (c.tags && c.tags.title) || '' })),
    tags: j.format?.tags || {},
  };
}

// ---------------------------------------------------------------------------
// Hardware acceleration
// ---------------------------------------------------------------------------
// Each backend is verified by actually encoding a few frames; listing an
// encoder in `ffmpeg -encoders` says nothing about whether this box has the
// device for it.

const RENDER_NODES = ['/dev/dri/renderD128', '/dev/dri/renderD129'];
const TEST_SRC = ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-frames:v', '10'];

export const HW_BACKENDS = {
  nvenc: { label: 'NVIDIA NVENC', test: () => [[...TEST_SRC, '-c:v', 'h264_nvenc', '-f', 'null', '-']] },
  qsv: { label: 'Intel Quick Sync', test: () => [[...TEST_SRC, '-vf', 'format=nv12', '-c:v', 'h264_qsv', '-f', 'null', '-']] },
  vaapi: {
    label: 'VA-API (Intel/AMD)',
    test: () => RENDER_NODES.filter((n) => fs.existsSync(n)).map((n) =>
      ['-vaapi_device', n, ...TEST_SRC, '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-f', 'null', '-']),
  },
  v4l2m2m: { label: 'V4L2 (Raspberry Pi e.d.)', test: () => (fs.existsSync('/dev/video11') ? [[...TEST_SRC, '-vf', 'format=yuv420p', '-c:v', 'h264_v4l2m2m', '-f', 'null', '-']] : []) },
};

let hwCache = null;

export async function detectHardware(force = false) {
  if (hwCache && !force) return hwCache;
  const result = { ffmpeg: await ffmpegAvailable(), backends: {}, device: null, filters: {} };
  if (result.ffmpeg) {
    for (const [id, b] of Object.entries(HW_BACKENDS)) {
      let ok = false;
      for (const args of b.test()) {
        const r = await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { timeout: 20_000 });
        if (r.code === 0) { ok = true; if (id === 'vaapi') result.device = args[1]; break; }
      }
      result.backends[id] = { label: b.label, available: ok };
    }
    const mux = await run(config.ffmpeg, ['-hide_banner', '-muxers'], { timeout: 8000 });
    result.chromaprint = /\bchromaprint\b/.test(mux.stdout);
    // What this build offers for HDR → SDR.
    const fl = await run(config.ffmpeg, ['-hide_banner', '-filters'], { timeout: 8000 });
    const has = (name) => new RegExp(`\\s${name}\\s`).test(fl.stdout);
    result.filters = { zscale: has('zscale'), tonemap: has('tonemap'), tonemap_vaapi: has('tonemap_vaapi'), tonemap_opencl: has('tonemap_opencl'), libplacebo: has('libplacebo') };
  }
  hwCache = result;
  return result;
}

/** The backend to use right now, honouring the admin's choice. */
export async function activeBackend() {
  const hw = await detectHardware();
  const pref = settings.get('hwaccel', 'auto');
  if (pref === 'none') return { id: 'none', device: null };
  if (pref !== 'auto' && hw.backends[pref]?.available) return { id: pref, device: hw.device };
  if (pref === 'auto') {
    for (const id of ['nvenc', 'qsv', 'vaapi', 'v4l2m2m']) if (hw.backends[id]?.available) return { id, device: hw.device };
  }
  return { id: 'none', device: null };
}
