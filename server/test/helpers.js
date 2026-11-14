// Shared by the test files: a throw-away data directory, a Fastify app with
// the same error shape as the real server, and quick users.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.KINOKO_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kinoko-test-'));
export const tmp = (name = 'x-') => fs.mkdtempSync(path.join(os.tmpdir(), `kinoko-${name}`));

// Tests never talk to the internet: only loopback requests go through.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(String(url)) ? realFetch(url, opts) : Promise.reject(new Error('geen netwerk in tests')));

const { default: Fastify } = await import('fastify');
const { default: websocket } = await import('@fastify/websocket');
const { HttpError, db } = await import('../src/db.js');
const { createUser, createSession } = await import('../src/auth.js');

export async function makeApp(...routes) {
  const app = Fastify();
  app.setErrorHandler((err, req, reply) => reply.code(err instanceof HttpError ? err.status : (err.statusCode || 500)).send({ error: err.message }));
  await app.register(websocket);
  for (const r of routes) await app.register(r);
  return app;
}
export const bearer = (token) => ({ authorization: `Bearer ${token}` });

let seq = 0;
export function mkUser(role = 'user', name = `gebruiker${++seq}`) {
  const id = createUser({ name, password: 'geheim123', role });
  return { id, name, token: createSession(id, 'Test') };
}
/** Shorthand for app.inject with a signed-in user. */
export const call = (app, user, method, url, payload) => app.inject({ method, url, headers: user ? bearer(user.token) : {}, ...(payload !== undefined && { payload }) });

/** Inserts a title with one local file; returns their ids. */
export function mkFile({ title = `Film ${++seq}`, kind = 'movie', libraryId = null, file = null, height = 1080, bitrate = 6_000_000, episode = null } = {}) {
  const tid = db.prepare('INSERT INTO titles (kind, title, norm_key, added_at) VALUES (?,?,?,?)').run(kind, title, title.toLowerCase(), 1).lastInsertRowid;
  let eid = null;
  if (episode) eid = db.prepare('INSERT INTO episodes (title_id, season, episode) VALUES (?,?,?)').run(tid, episode[0], episode[1]).lastInsertRowid;
  const p = file || path.join(tmp('f-'), 'film.mkv');
  if (!file) fs.writeFileSync(p, 'x');
  const fid = db.prepare('INSERT INTO files (library_id, title_id, episode_id, path, duration, bitrate, width, height, vcodec, acodec, container, added_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(libraryId, tid, eid, p, 6000, bitrate, Math.round(height * 16 / 9), height, 'h264', 'aac', 'mkv', 1).lastInsertRowid;
  return { titleId: Number(tid), fileId: Number(fid), episodeId: eid && Number(eid), path: p };
}
