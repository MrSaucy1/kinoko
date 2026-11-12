import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { config } from './config.js';
import { db, settings, HttpError } from './db.js';
import authRoutes, { needsSetup, createUser, createSession, publicUser, requireAdmin } from './auth.js';
import libraryRoutes, { scanAll, scanState } from './library.js';
import metadataRoutes, { metaState } from './metadata.js';
import streamRoutes, { cleanupTranscodes } from './stream.js';
import subtitleRoutes from './subtitles.js';
import markerRoutes, { markerState } from './markers.js';
import catalogRoutes from './catalog.js';
import watchRoutes from './watch.js';
import federationRoutes, { syncAllPeers, publicUrl } from './federation.js';
import iptvRoutes, { syncAllSources } from './iptv.js';
import remoteRoutes, { lanUrls } from './remote.js';
import { detectHardware, ffmpegAvailable } from './ffmpeg.js';

const require = createRequire(import.meta.url);
const app = Fastify({ trustProxy: true, bodyLimit: 2 * 1024 * 1024, logger: process.env.KINOKO_LOG ? { level: process.env.KINOKO_LOG } : false });

app.setErrorHandler((err, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
  if (err.validation || err.statusCode === 400) return reply.code(400).send({ error: 'Ongeldig verzoek.' });
  if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
  console.error(`[fout] ${req.method} ${req.url}`, err);
  return reply.code(500).send({ error: 'Er ging iets mis op de server.' });
});

await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

// ---- first-run setup ------------------------------------------------------
app.post('/api/setup', async (req) => {
  if (!needsSetup()) throw new HttpError(403, 'Deze server is al ingesteld.');
  const { name, password, serverName } = req.body || {};
  const id = createUser({ name, password, role: 'admin' });
  if (String(serverName || '').trim()) settings.set('server_name', String(serverName).trim().slice(0, 40));
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return { token: createSession(id, 'Web'), user: publicUser(u) };
});

app.get('/api/admin/settings', { preHandler: requireAdmin }, async (req) => ({
  serverName: settings.get('server_name'), publicUrl: publicUrl(), currentUrl: publicUrl(req), lan: lanUrls(),
  onboarded: settings.get('onboarded', false), scanHours: settings.get('scan_hours', 6), version: config.version,
  ffmpeg: await ffmpegAvailable(), fingerprint: settings.get('fingerprint', true),
  counts: {
    movies: db.prepare("SELECT COUNT(*) c FROM titles WHERE kind = 'movie'").get().c,
    shows: db.prepare("SELECT COUNT(*) c FROM titles WHERE kind = 'show'").get().c,
    episodes: db.prepare('SELECT COUNT(*) c FROM episodes').get().c,
    files: db.prepare('SELECT COUNT(*) c FROM files WHERE peer_id IS NULL').get().c,
    remoteFiles: db.prepare('SELECT COUNT(*) c FROM files WHERE peer_id IS NOT NULL').get().c,
    size: db.prepare('SELECT COALESCE(SUM(size),0) c FROM files WHERE peer_id IS NULL').get().c,
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    collections: db.prepare('SELECT COUNT(*) c FROM collections').get().c,
    channels: db.prepare('SELECT COUNT(*) c FROM iptv_channels').get().c,
  },
  tasks: { scan: scanState, metadata: metaState, markers: markerState },
}));
app.put('/api/admin/settings', { preHandler: requireAdmin }, async (req) => {
  const b = req.body || {};
  if (typeof b.serverName === 'string' && b.serverName.trim()) settings.set('server_name', b.serverName.trim().slice(0, 40));
  if (typeof b.onboarded === 'boolean') settings.set('onboarded', b.onboarded);
  if (Number(b.scanHours) >= 1 && Number(b.scanHours) <= 168) settings.set('scan_hours', Number(b.scanHours));
  if (typeof b.fingerprint === 'boolean') settings.set('fingerprint', b.fingerprint);
  return { ok: true };
});

for (const r of [authRoutes, libraryRoutes, metadataRoutes, streamRoutes, subtitleRoutes, markerRoutes, catalogRoutes, watchRoutes, federationRoutes, iptvRoutes, remoteRoutes]) {
  await app.register(r);
}

// ---- web GUI --------------------------------------------------------------
const vendor = {
  '/vendor/hls.js': require.resolve('hls.js/dist/hls.min.js'),
  '/vendor/qrcode.js': require.resolve('qrcode-generator'),
};
for (const [url, file] of Object.entries(vendor)) {
  app.get(url, (req, reply) => reply.header('Content-Type', 'text/javascript; charset=utf-8').header('Cache-Control', 'public, max-age=86400').send(fs.createReadStream(file)));
}
await app.register(fastifyStatic, { root: config.webDir, index: false, cacheControl: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') });
const indexHtml = () => fs.readFileSync(path.join(config.webDir, 'index.html'), 'utf8');
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/') || req.method !== 'GET') return reply.code(404).send({ error: 'Niet gevonden.' });
  // Single-page app: every other path (/w/CODE, /link/TOKEN, ...) boots the GUI.
  return reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(indexHtml());
});
app.get('/', (req, reply) => reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(indexHtml()));

// ---- background work ------------------------------------------------------
cleanupTranscodes();
await app.listen({ port: config.port, host: config.host });
console.log(`Kinoko ${config.version} luistert op poort ${config.port}`);
for (const u of lanUrls()) console.log(`  → ${u}`);

detectHardware().then((hw) => {
  const on = Object.entries(hw.backends).filter(([, b]) => b.available).map(([id]) => id);
  console.log(hw.ffmpeg ? `ffmpeg gevonden; hardware-acceleratie: ${on.join(', ') || 'geen (software)'}` : 'LET OP: ffmpeg niet gevonden — transcoderen en scannen van details staat uit.');
});

let lastScan = Date.now();
setTimeout(() => scanAll(), 4000).unref();
setInterval(() => {
  if (Date.now() - lastScan >= settings.get('scan_hours', 6) * 3600_000) { lastScan = Date.now(); scanAll(); }
}, 10 * 60_000).unref();
setTimeout(() => syncAllPeers(), 20_000).unref();
setInterval(() => syncAllPeers(), 30 * 60_000).unref();
setInterval(() => syncAllSources(), 12 * 3600_000).unref();

const stop = async () => { cleanupTranscodes(); await app.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
