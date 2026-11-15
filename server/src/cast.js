// Casting: play a film, episode or song on a Chromecast or a DLNA/UPnP
// renderer (smart tv, AV receiver) in the house. The server finds the devices
// and tells them what to fetch; the device then streams straight from Kinoko.
// Being server-side, it works the same from the web GUI and both apps.
import dgram from 'node:dgram';
import tls from 'node:tls';
import os from 'node:os';
import { db, sha256, HttpError } from './db.js';
import { config } from './config.js';
import { requireUser } from './auth.js';
import { requireFile } from './access.js';
import { playLocal, applyLimit, limitFor, stripOriginal } from './stream.js';

// ---------------------------------------------------------------------------
// Chromecast speaks protobuf over TLS. One message type, six fields: small enough to write out.
// ---------------------------------------------------------------------------
const varint = (n) => { const out = []; let v = n >>> 0; while (v > 127) { out.push((v & 127) | 128); v >>>= 7; } out.push(v); return Buffer.from(out); };
const str = (field, s) => { const b = Buffer.from(String(s), 'utf8'); return Buffer.concat([Buffer.from([(field << 3) | 2]), varint(b.length), b]); };
export function encodeCast({ source = 'sender-0', destination = 'receiver-0', namespace, payload }) {
  const body = Buffer.concat([Buffer.from([0x08, 0]), str(2, source), str(3, destination), str(4, namespace), Buffer.from([0x28, 0]), str(6, JSON.stringify(payload))]);
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}
export function decodeCast(body) {
  const out = {}; let i = 0;
  const readVar = () => { let v = 0, shift = 0, b; do { b = body[i++]; v |= (b & 127) << shift; shift += 7; } while (b & 128 && i < body.length); return v >>> 0; };
  while (i < body.length) {
    const tag = readVar(), field = tag >> 3, type = tag & 7;
    if (type === 0) { readVar(); continue; }
    if (type !== 2) break;
    const len = readVar(), value = body.subarray(i, i + len).toString('utf8'); i += len;
    if (field === 2) out.source = value; else if (field === 3) out.destination = value; else if (field === 4) out.namespace = value; else if (field === 6) { try { out.payload = JSON.parse(value); } catch { out.payload = null; } }
  }
  return out;
}

const NS = { conn: 'urn:x-cast:com.google.cast.tp.connection', beat: 'urn:x-cast:com.google.cast.tp.heartbeat', recv: 'urn:x-cast:com.google.cast.receiver', media: 'urn:x-cast:com.google.cast.media' };
const DEFAULT_RECEIVER = 'CC1AD845';   // Google's own "Default Media Receiver": plays a URL, needs no registration

/** One connection to a Chromecast. Devices use self-signed certificates, so the certificate is not checked; this only ever connects to an address found on the local network. */
class CastLink {
  constructor(host, port = 8009) { this.host = host; this.port = port; this.req = 1; this.waiting = new Map(); this.transport = null; this.mediaSession = null; this.buf = Buffer.alloc(0); }
  connect() {
    return new Promise((resolve, reject) => {
      this.sock = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: false, timeout: 8000 }, () => { this.send(NS.conn, { type: 'CONNECT' }); this.beat = setInterval(() => this.send(NS.beat, { type: 'PING' }), 5000); this.beat.unref(); resolve(); });
      this.sock.on('data', (d) => this.onData(d));
      this.sock.on('error', (e) => { reject(e); this.close(); });
      this.sock.on('timeout', () => { reject(new Error('timeout')); this.close(); });
      this.sock.on('close', () => this.close());
    });
  }
  send(namespace, payload, destination = 'receiver-0') { try { this.sock.write(encodeCast({ destination, namespace, payload })); } catch { /* closing */ } }
  ask(namespace, payload, destination) {
    const requestId = this.req++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(requestId); reject(new Error('timeout')); }, 10000);
      this.waiting.set(requestId, (m) => { clearTimeout(timer); resolve(m); });
      this.send(namespace, { ...payload, requestId }, destination);
    });
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > 1 << 20) { this.close(); return; }
      if (this.buf.length < 4 + len) return;
      const m = decodeCast(this.buf.subarray(4, 4 + len)); this.buf = this.buf.subarray(4 + len);
      const p = m.payload; if (!p) continue;
      if (p.type === 'PING') this.send(NS.beat, { type: 'PONG' });
      if (p.type === 'MEDIA_STATUS' && p.status && p.status[0]) this.mediaSession = p.status[0].mediaSessionId;
      const w = p.requestId && this.waiting.get(p.requestId);
      if (w) { this.waiting.delete(p.requestId); w(p); }
    }
  }
  async load(url, contentType, meta, position) {
    const st = await this.ask(NS.recv, { type: 'LAUNCH', appId: DEFAULT_RECEIVER });
    const appl = (st.status?.applications || []).find((a) => a.appId === DEFAULT_RECEIVER);
    if (!appl) throw new Error('launch');
    this.transport = appl.transportId;
    this.send(NS.conn, { type: 'CONNECT' }, this.transport);
    const r = await this.ask(NS.media, { type: 'LOAD', autoplay: true, currentTime: position || 0, media: { contentId: url, contentType, streamType: 'BUFFERED',
      metadata: { metadataType: meta.music ? 3 : 1, title: meta.title, ...(meta.subtitle && (meta.music ? { artist: meta.subtitle } : { subtitle: meta.subtitle })), ...(meta.image && { images: [{ url: meta.image }] }) } } }, this.transport);
    if (r.type === 'LOAD_FAILED' || r.type === 'INVALID_REQUEST') throw new Error('load');
  }
  control(cmd, position) {
    if (!this.transport) return;
    if (cmd === 'stop') { this.send(NS.recv, { type: 'STOP', requestId: this.req++ }); return; }
    const type = { play: 'PLAY', pause: 'PAUSE', seek: 'SEEK' }[cmd];
    if (type && this.mediaSession) this.send(NS.media, { type, mediaSessionId: this.mediaSession, requestId: this.req++, ...(cmd === 'seek' && { currentTime: position }) }, this.transport);
  }
  close() { clearInterval(this.beat); try { this.sock.destroy(); } catch { /* gone */ } }
}

// ---------------------------------------------------------------------------
// Finding devices: mDNS for Chromecasts, SSDP for DLNA renderers
// ---------------------------------------------------------------------------
/** Reads a DNS name at `off`, following compression pointers. Returns [name, nextOffset]. */
function dnsName(buf, off) {
  const parts = []; let next = -1, hops = 0;
  while (off < buf.length && hops++ < 50) {
    const len = buf[off];
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) { if (next < 0) next = off + 2; off = ((len & 0x3f) << 8) | buf[off + 1]; continue; }
    parts.push(buf.subarray(off + 1, off + 1 + len).toString('utf8')); off += 1 + len;
  }
  return [parts.join('.'), next < 0 ? off : next];
}
/** Picks the Chromecast out of an mDNS answer: its friendly name (TXT fn=), address and port. */
export function parseMdns(buf) {
  try {
    const counts = [buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)];
    let off = 12; const out = { name: null, host: null, port: 8009, model: null, cast: false };
    for (let q = 0; q < counts[0]; q++) { [, off] = dnsName(buf, off); off += 4; }
    for (let r = 0; r < counts[1] + counts[2] + counts[3]; r++) {
      let name; [name, off] = dnsName(buf, off);
      const type = buf.readUInt16BE(off), len = buf.readUInt16BE(off + 8), data = off + 10; off = data + len;
      if (name.includes('_googlecast._tcp')) out.cast = true;
      if (type === 16) { let i = data; while (i < data + len) { const l = buf[i]; const kv = buf.subarray(i + 1, i + 1 + l).toString('utf8'); if (kv.startsWith('fn=')) out.name = kv.slice(3); if (kv.startsWith('md=')) out.model = kv.slice(3); i += 1 + l; } }
      else if (type === 33) out.port = buf.readUInt16BE(data + 4);
      else if (type === 1 && len === 4) out.host = [...buf.subarray(data, data + 4)].join('.');
    }
    return out.cast && out.host ? out : null;
  } catch { return null; }
}
const mdnsQuery = () => { const name = Buffer.concat(['_googlecast', '_tcp', 'local'].map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)]))); return Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), name, Buffer.from([0, 0, 12, 0x80, 1])]); };

/** Headers of an SSDP answer as a lower-case map. */
export function parseSsdp(text) { const h = {}; for (const line of String(text).split(/\r?\n/).slice(1)) { const i = line.indexOf(':'); if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); } return h; }
const tagOf = (xml, name) => { const m = String(xml).match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? m[1].trim() : ''; };
/** From a renderer's description: its name and where to send AVTransport commands. */
export function parseRenderer(xml, location) {
  const svc = [...String(xml).matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => m[1]).find((s) => /AVTransport/i.test(tagOf(s, 'serviceType')));
  if (!svc) return null;
  const base = tagOf(xml, 'URLBase') || location;
  try { return { name: tagOf(xml, 'friendlyName') || 'DLNA-apparaat', control: new URL(tagOf(svc, 'controlURL'), base).href }; } catch { return null; }
}

const devices = new Map();   // id -> { id, kind, name, host, port?, control?, seen }
let lastScan = 0;
const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
const isPrivate = (host) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host);

export async function discover(ms = 2500) {
  if (Date.now() - lastScan < 15_000) return [...devices.values()];
  lastScan = Date.now();
  const found = [];
  await Promise.all(lanAddresses().map((addr) => new Promise((resolve) => {
    const socks = [];
    const done = () => { for (const s of socks) { try { s.close(); } catch { /* closed */ } } resolve(); };
    try {
      const m = dgram.createSocket({ type: 'udp4', reuseAddr: true }); socks.push(m);
      m.on('error', () => {}); m.on('message', (buf) => { const d = parseMdns(buf); if (d && isPrivate(d.host)) found.push({ kind: 'chromecast', name: d.name || d.model || 'Chromecast', host: d.host, port: d.port }); });
      m.bind(0, addr, () => { try { m.setMulticastInterface(addr); m.send(mdnsQuery(), 5353, '224.0.0.251'); } catch { /* no multicast here */ } });
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true }); socks.push(s);
      s.on('error', () => {});
      s.on('message', (buf) => { const loc = parseSsdp(buf.toString()).location; if (loc) found.push({ kind: 'dlna-pending', location: loc }); });
      s.bind(0, addr, () => { try { s.send(Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:service:AVTransport:1\r\n\r\n'), 1900, '239.255.255.250'); } catch { /* no multicast here */ } });
    } catch { /* interface without sockets */ }
    setTimeout(done, ms);
  })));
  for (const f of found) {
    let d = f;
    if (f.kind === 'dlna-pending') {
      let host; try { host = new URL(f.location).hostname; } catch { continue; }
      if (!isPrivate(host) || [...devices.values()].some((x) => x.location === f.location)) continue;   // only devices on the home network
      try { const r = await fetch(f.location, { signal: AbortSignal.timeout(4000) }); const info = parseRenderer(await r.text(), f.location); if (!info || !isPrivate(new URL(info.control).hostname)) continue; d = { kind: 'dlna', name: info.name, host, control: info.control, location: f.location }; } catch { continue; }
    }
    const id = sha256(`${d.kind}|${d.host}|${d.control || d.port}`).slice(0, 12);
    devices.set(id, { ...d, id, seen: Date.now() });
  }
  for (const [id, d] of devices) if (Date.now() - d.seen > 10 * 60_000 && !sessions.has(id)) devices.delete(id);
  return [...devices.values()];
}
/** Tests register a device directly. */
export const addDevice = (d) => { devices.set(d.id, { ...d, seen: Date.now() }); };

// ---------------------------------------------------------------------------
// DLNA: a few SOAP calls
// ---------------------------------------------------------------------------
const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function soap(action, args) {
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID>${Object.entries(args).map(([k, v]) => `<${k}>${xml(v)}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
}
async function dlna(device, action, args = {}) {
  let r;
  try { r = await fetch(device.control, { method: 'POST', headers: { 'content-type': 'text/xml; charset="utf-8"', SOAPAction: `"urn:schemas-upnp-org:service:AVTransport:1#${action}"` }, body: soap(action, args), signal: AbortSignal.timeout(8000) }); }
  catch { throw new HttpError(502, `${device.name} reageert niet.`); }
  if (!r.ok) throw new HttpError(502, `${device.name} weigert dit (${r.status}).`);
}
const hms = (s) => { const t = Math.max(0, Math.round(s)); return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };

// ---------------------------------------------------------------------------
// What to send, and where the device can reach us
// ---------------------------------------------------------------------------
/** What a Chromecast plays without help; anything else is transcoded to HLS, which it also plays. */
export const CHROMECAST_CAPS = { containers: ['mp4', 'webm'], vcodecs: ['h264', 'vp8', 'vp9'], acodecs: ['aac', 'mp3', 'opus', 'vorbis', 'flac'] };
/** The address of this server as a device on the same network sees it. */
export function baseFor(deviceHost) {
  const mine = lanAddresses();
  const same = mine.find((a) => a.split('.').slice(0, 3).join('.') === String(deviceHost).split('.').slice(0, 3).join('.'));
  return `http://${same || mine[0] || '127.0.0.1'}:${config.port}`;
}
const MIME = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', ts: 'video/mp2t', mov: 'video/quicktime' };

const sessions = new Map();   // device id -> { link?, userId, title }

export default async function routes(app) {
  app.get('/api/cast/devices', { preHandler: requireUser }, async () => ({
    devices: (await discover()).map((d) => ({ id: d.id, name: d.name, kind: d.kind, busy: sessions.has(d.id) })),
  }));

  app.post('/api/cast/:id/play', { preHandler: requireUser }, async (req) => {
    const device = devices.get(String(req.params.id));
    if (!device) throw new HttpError(404, 'Dit apparaat is niet (meer) gevonden. Zoek opnieuw.');
    const b = req.body || {}, base = baseFor(device.host), position = Math.max(0, Number(b.position) || 0);
    let url, type, meta;
    if (b.trackId) {
      const { requireTrack } = await import('./musicapi.js'); const { issueTrackTicket, audioMime } = await import('./music.js');
      const t = requireTrack(req.user, b.trackId);
      if (t.peer_id) throw new HttpError(400, 'Nummers van een gekoppelde server kunnen nog niet gecast worden.');
      // Chromecasts do not play every lossless format; 320 kbps AAC plays everywhere.
      const direct = ['mp3', 'aac', 'opus', 'vorbis', 'flac'].includes(t.codec);
      url = `${base}/api/music/stream/${issueTrackTicket(t.id)}${direct ? '' : '?q=320&f=aac'}`; type = direct ? audioMime(t.path) : 'audio/mp4';
      const m = db.prepare('SELECT ar.name artist, al.id album, al.cover FROM artists ar, albums al WHERE ar.id = ? AND al.id = ?').get(t.artist_id, t.album_id) || {};
      meta = { music: true, title: t.title, subtitle: m.artist, image: m.cover ? `${base}/api/music/cover/album/${m.album}` : null };
    } else {
      const file = requireFile(req.user, b.fileId);
      if (file.peer_id) throw new HttpError(400, 'Titels van een gekoppelde server kunnen nog niet gecast worden.');
      const lim = applyLimit(file, { quality: b.quality || 'original', caps: device.kind === 'chromecast' ? CHROMECAST_CAPS : 'any' }, limitFor(req.user));
      const play = stripOriginal(playLocal(file, lim.body), lim.capped);
      url = base + play.url; type = play.mode === 'hls' ? 'application/x-mpegURL' : (MIME[file.container] || 'video/mp4');
      const t = db.prepare('SELECT id, title, poster FROM titles WHERE id = ?').get(file.title_id);
      meta = { title: t ? t.title : 'Kinoko', image: t && t.poster ? `${base}/api/img/t/${t.id}/poster` : null };
    }
    const old = sessions.get(device.id); if (old && old.link) old.link.close();
    if (device.kind === 'chromecast') {
      const link = new CastLink(device.host, device.port);
      try { await link.connect(); await link.load(url, type, meta, position); }
      catch { link.close(); throw new HttpError(502, `${device.name} kon dit niet afspelen of reageert niet.`); }
      sessions.set(device.id, { link, userId: req.user.id, title: meta.title });
    } else {
      const didl = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>${xml(meta.title)}</dc:title><upnp:class>object.item.${meta.music ? 'audioItem.musicTrack' : 'videoItem'}</upnp:class><res protocolInfo="http-get:*:${type}:*">${xml(url)}</res></item></DIDL-Lite>`;
      await dlna(device, 'SetAVTransportURI', { CurrentURI: url, CurrentURIMetaData: didl });
      await dlna(device, 'Play', { Speed: '1' });
      if (position > 5) await dlna(device, 'Seek', { Unit: 'REL_TIME', Target: hms(position) }).catch(() => {});
      sessions.set(device.id, { userId: req.user.id, title: meta.title });
    }
    return { ok: true, device: device.name, title: meta.title };
  });

  app.post('/api/cast/:id/control', { preHandler: requireUser }, async (req) => {
    const device = devices.get(String(req.params.id)), s = sessions.get(String(req.params.id));
    // Only whoever started it (or an admin) holds the remote.
    if (!device || !s || (s.userId !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'Hier speelt niets van jou.');
    const cmd = String(req.body?.cmd || ''), position = Math.max(0, Number(req.body?.position) || 0);
    if (!['play', 'pause', 'stop', 'seek'].includes(cmd)) throw new HttpError(400, 'Onbekende opdracht.');
    if (device.kind === 'chromecast') s.link.control(cmd, position);
    else if (cmd === 'play') await dlna(device, 'Play', { Speed: '1' });
    else if (cmd === 'pause') await dlna(device, 'Pause');
    else if (cmd === 'stop') await dlna(device, 'Stop');
    else await dlna(device, 'Seek', { Unit: 'REL_TIME', Target: hms(position) });
    if (cmd === 'stop') { if (s.link) s.link.close(); sessions.delete(device.id); }
    return { ok: true };
  });
}
