// Remote access: the admin chooses how the server is reached from outside —
// Tailscale, a Cloudflare Tunnel, or their own domain / reverse proxy.
// Privileged steps go through the small root helper installed by install.sh.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { settings, HttpError } from './db.js';
import { config } from './config.js';
import { run } from './ffmpeg.js';
import { requireAdmin } from './auth.js';
import { audit } from './audit.js';
import { publicUrl } from './federation.js';

// Looks the program up in PATH itself; no shell is involved, so a name can never be run as a command.
export function which(bin) {
  if (!/^[A-Za-z0-9._+-]+$/.test(String(bin))) return false;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try { const f = path.join(dir, bin); if (fs.statSync(f).isFile()) { fs.accessSync(f, fs.constants.X_OK); return true; } } catch { /* not here */ }
  }
  return false;
}
const helperAvailable = () => fs.existsSync(config.helper);

async function helper(args, timeout = 180_000) {
  if (!helperAvailable()) throw new HttpError(501, 'De beheerhulp ontbreekt. Voer deze stap handmatig uit op de server (zie de documentatie).');
  const r = await run('sudo', ['-n', config.helper, ...args], { timeout });
  if (r.code !== 0) throw new HttpError(500, (r.stderr || r.stdout || 'De opdracht is mislukt.').trim().split('\n').slice(-3).join(' '));
  return r.stdout.trim();
}

export function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${config.port}`);
  }
  return out;
}

async function tailscaleStatus() {
  if (!(await which('tailscale'))) return { installed: false };
  const r = await run('tailscale', ['status', '--json'], { timeout: 8000 });
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* not running */ }
  if (!j) return { installed: true, running: false };
  const dns = (j.Self?.DNSName || '').replace(/\.$/, '');
  const serve = await run('tailscale', ['serve', 'status', '--json'], { timeout: 8000 });
  let serving = false, funnel = false;
  try { const s = JSON.parse(serve.stdout || '{}'); serving = !!s.TCP || !!s.Web; funnel = !!s.AllowFunnel && Object.values(s.AllowFunnel).some(Boolean); } catch { /* no serve config */ }
  return {
    installed: true, running: j.BackendState === 'Running', state: j.BackendState, dnsName: dns, authUrl: j.AuthURL || null,
    ips: j.Self?.TailscaleIPs || [], serving, funnel,
    url: dns ? (serving ? `https://${dns}` : `http://${dns}:${config.port}`) : null,
  };
}

async function cloudflaredStatus() {
  if (!(await which('cloudflared'))) return { installed: false };
  const r = await run('systemctl', ['is-active', 'cloudflared'], { timeout: 5000 });
  return { installed: true, running: r.stdout.trim() === 'active' };
}

export default async function routes(app) {
  app.get('/api/admin/remote', { preHandler: requireAdmin }, async (req) => ({
    mode: settings.get('remote_mode', 'lan'), publicUrl: publicUrl(), currentUrl: publicUrl(req), lan: lanUrls(),
    helper: helperAvailable(), tailscale: await tailscaleStatus(), cloudflare: await cloudflaredStatus(),
  }));

  app.put('/api/admin/remote', { preHandler: requireAdmin }, async (req) => {
    const { mode, publicUrl: url } = req.body || {};
    if (mode) {
      if (!['lan', 'tailscale', 'cloudflare', 'custom'].includes(mode)) throw new HttpError(400, 'Onbekende keuze.');
      settings.set('remote_mode', mode);
    }
    if (typeof url === 'string') {
      const clean = url.trim().replace(/\/+$/, '');
      if (clean && !/^https?:\/\/[^\s/]+(:\d+)?(\/[^\s]*)?$/.test(clean)) throw new HttpError(400, 'Vul een volledig adres in, bijvoorbeeld https://kinoko.voorbeeld.nl');
      settings.set('public_url', clean);
    }
    return { ok: true };
  });

  // Checks that the given address really reaches *this* server.
  app.post('/api/admin/remote/test', { preHandler: requireAdmin }, async (req) => {
    const url = String(req.body?.url || publicUrl()).replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) throw new HttpError(400, 'Geen adres om te testen.');
    try {
      const r = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(10000) });
      const j = await r.json();
      if (j.id !== settings.get('server_id')) return { ok: false, reason: 'Op dit adres antwoordt een andere server.' };
      return { ok: true };
    } catch { return { ok: false, reason: 'Het adres is vanaf de server zelf niet bereikbaar. (Vanaf buiten kan het alsnog werken.)' }; }
  });

  app.post('/api/admin/remote/tailscale', { preHandler: requireAdmin }, async (req) => {
    const action = req.body?.action;
    if (action === 'install') await helper(['tailscale-install'], 300_000);
    else if (action === 'up') return { output: await helper(['tailscale-up'], 30_000), status: await tailscaleStatus() };
    else if (action === 'serve') await helper(['tailscale-serve', String(config.port)]);
    else if (action === 'funnel') await helper(['tailscale-funnel', String(config.port)]);
    else if (action === 'off') await helper(['tailscale-serve-off']);
    else throw new HttpError(400, 'Onbekende actie.');
    const status = await tailscaleStatus();
    if ((action === 'serve' || action === 'funnel') && status.url) { settings.set('public_url', status.url); settings.set('remote_mode', 'tailscale'); }
    return { status };
  });

  app.post('/api/admin/remote/cloudflare', { preHandler: requireAdmin }, async (req) => {
    const { action, token, hostname } = req.body || {};
    if (action === 'install') await helper(['cloudflared-install'], 300_000);
    else if (action === 'connect') {
      if (!/^[A-Za-z0-9_=-]{40,}$/.test(String(token || ''))) throw new HttpError(400, 'Dit lijkt geen geldig tunnel-token.');
      await helper(['cloudflared-connect', token]);
      if (hostname && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hostname)) { settings.set('public_url', `https://${hostname}`); settings.set('remote_mode', 'cloudflare'); }
    } else if (action === 'disconnect') await helper(['cloudflared-disconnect']);
    else throw new HttpError(400, 'Onbekende actie.');
    return { status: await cloudflaredStatus() };
  });

  app.post('/api/admin/update', { preHandler: requireAdmin }, async (req) => {
    const output = await helper(['update'], 600_000);
    audit('update', { user: req.user, ip: req.ip, detail: output.split('\n').pop() });
    return { output };
  });
}
