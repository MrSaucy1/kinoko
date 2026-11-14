// Outgoing webhooks: the admin lists one or more URLs and picks the events
// each should receive. Two formats: Discord-compatible, and plain JSON.
// Delivery is best effort — a webhook that is down never holds Kinoko up.
import { db, now, json, settings, HttpError } from './db.js';
import { requireAdmin } from './auth.js';

export const EVENTS = {
  'title.added': 'Nieuwe titel toegevoegd',
  'playback.started': 'Iemand begint te kijken',
  'scan.finished': 'Scan klaar',
  'request.created': 'Nieuw verzoek',
  'request.updated': 'Verzoek goedgekeurd of afgewezen',
  error: 'Fout op de server',
};
const COLOR = { 'title.added': 0xa855f7, 'playback.started': 0x7c3aed, 'scan.finished': 0x22c55e, 'request.created': 0xc084fc, 'request.updated': 0xc084fc, error: 0xef4444 };

/** The URL is a secret (Discord: whoever has it can post), so it is never sent back in full. */
export const maskUrl = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.host}/…${url.slice(-4)}`; } catch { return '…'; } };

export function payload(format, event, data) {
  const server = settings.get('server_name');
  if (format === 'json') return { event, server, at: new Date().toISOString(), text: data.text, ...data.fields && { data: data.fields } };
  return { username: server, embeds: [{ title: EVENTS[event] || event, description: String(data.text || '').slice(0, 1800), color: COLOR[event] || 0xa855f7, timestamp: new Date().toISOString() }] };
}

async function deliver(hook, event, data) {
  let error = null;
  try {
    const r = await fetch(hook.url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Kinoko' }, body: JSON.stringify(payload(hook.format, event, data)), signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!r.ok) error = `HTTP ${r.status}`;
  } catch (e) { error = e.name === 'TimeoutError' ? 'geen antwoord binnen 8 seconden' : 'niet bereikbaar'; }
  db.prepare('UPDATE webhooks SET last_at = ?, last_error = ? WHERE id = ?').run(now(), error, hook.id);
  return error;
}

/** Fire and forget. `data` = { text, fields? }. */
export function emit(event, data) {
  let hooks;
  try { hooks = db.prepare('SELECT * FROM webhooks').all().filter((h) => json(h.events, []).includes(event)); } catch { return; }
  for (const h of hooks) deliver(h, event, data).catch(() => {});
}

function clean(body, prev = {}) {
  const name = String(body.name ?? prev.name ?? '').trim().slice(0, 40);
  if (!name) throw new HttpError(400, 'Geef de webhook een naam.');
  let url = prev.url;
  if (body.url !== undefined && String(body.url).trim()) {
    url = String(body.url).trim();
    let u; try { u = new URL(url); } catch { throw new HttpError(400, 'Vul een volledig adres in dat begint met https:// of http://'); }
    if (!['https:', 'http:'].includes(u.protocol)) throw new HttpError(400, 'Vul een volledig adres in dat begint met https:// of http://');
  }
  if (!url) throw new HttpError(400, 'Vul het adres van de webhook in.');
  const format = body.format ?? prev.format ?? 'discord';
  if (!['discord', 'json'].includes(format)) throw new HttpError(400, 'Kies Discord of JSON.');
  const events = Array.isArray(body.events) ? body.events.filter((e) => EVENTS[e]) : json(prev.events, []);
  return { name, url, format, events: JSON.stringify([...new Set(events)]) };
}

export default async function routes(app) {
  app.get('/api/admin/webhooks', { preHandler: requireAdmin }, async () => ({
    events: Object.entries(EVENTS).map(([id, label]) => ({ id, label })),
    webhooks: db.prepare('SELECT * FROM webhooks ORDER BY id').all().map((h) => ({ id: h.id, name: h.name, url: maskUrl(h.url), format: h.format, events: json(h.events, []), last_at: h.last_at, last_error: h.last_error })),
  }));
  app.post('/api/admin/webhooks', { preHandler: requireAdmin }, async (req) => {
    const c = clean(req.body || {});
    return { id: db.prepare('INSERT INTO webhooks (name, url, format, events, created_at) VALUES (?,?,?,?,?)').run(c.name, c.url, c.format, c.events, now()).lastInsertRowid };
  });
  app.put('/api/admin/webhooks/:id', { preHandler: requireAdmin }, async (req) => {
    const prev = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(Number(req.params.id));
    if (!prev) throw new HttpError(404, 'Webhook niet gevonden.');
    const c = clean(req.body || {}, prev);
    db.prepare('UPDATE webhooks SET name = ?, url = ?, format = ?, events = ? WHERE id = ?').run(c.name, c.url, c.format, c.events, prev.id);
    return { ok: true };
  });
  app.delete('/api/admin/webhooks/:id', { preHandler: requireAdmin }, async (req) => {
    db.prepare('DELETE FROM webhooks WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });
  app.post('/api/admin/webhooks/:id/test', { preHandler: requireAdmin }, async (req) => {
    const hook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(Number(req.params.id));
    if (!hook) throw new HttpError(404, 'Webhook niet gevonden.');
    const error = await deliver(hook, 'scan.finished', { text: 'Dit is een testbericht van Kinoko.' });
    if (error) throw new HttpError(502, `De webhook gaf een fout: ${error}.`);
    return { ok: true };
  });
}
