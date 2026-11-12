// Shared plumbing for the web GUI: API client, tiny DOM helper, router, toasts.

export const state = { user: null, info: null, token: localStorage.getItem('kinoko_token') || '' };

export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && state.token && !path.startsWith('/api/auth/login')) { setToken(''); state.user = null; go('/login'); }
    throw new ApiError(res.status, (data && data.error) || `Fout ${res.status}`);
  }
  return data;
}

export function setToken(t) { state.token = t; if (t) localStorage.setItem('kinoko_token', t); else localStorage.removeItem('kinoko_token'); }

// The views build DOM with nested arrays and `cond && node`. Native append /
// replaceChildren would print those as "[object …]" / "false", so within this
// app they flatten arrays and skip empty values — the same rules h() follows.
const tidy = (kids) => kids.flat(Infinity).filter((k) => k != null && k !== false);
for (const method of ['append', 'replaceChildren']) {
  const native = Element.prototype[method];
  Element.prototype[method] = function patched(...kids) { return native.apply(this, tidy(kids)); };
}

/** h('div.card', {onclick}, child, ...) → element. Strings become text nodes (never HTML). */
export function h(spec, ...rest) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const part of rest.flat(Infinity)) {
    if (part == null || part === false) continue;
    if (part instanceof Node) el.append(part);
    else if (typeof part === 'object') {
      for (const [k, v] of Object.entries(part)) {
        if (v == null || v === false) continue;
        if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'html') el.innerHTML = v; // only used with our own static SVG
        else if (k in el && k !== 'list') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
        else el.setAttribute(k, v === true ? '' : v);
      }
    } else el.append(String(part));
  }
  return el;
}

const ICON = {
  play: '<path d="M7 4.500v15a1 1 0 0 0 1.500.860l12.500-7.500a1 1 0 0 0 0-1.720L8.500 3.640A1 1 0 0 0 7 4.500z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4" width="4.500" height="16" rx="1.200" fill="currentColor" stroke="none"/><rect x="13.500" y="4" width="4.500" height="16" rx="1.200" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="m5 12.500 4.500 4.500L19 7.500"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>',
  left: '<path d="m15 5-7 7 7 7"/>', right: '<path d="m9 5 7 7-7 7"/>', back: '<path d="M19 12H5m6-7-7 7 7 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.500v.500"/>',
  users: '<circle cx="9" cy="8" r="3.500"/><path d="M2.500 20c.500-3.500 3-5.500 6.500-5.500s6 2 6.500 5.500M16 4.800a3.500 3.500 0 0 1 0 6.400M18.500 14.800c1.800.800 2.800 2.600 3 5.200"/>',
  download: '<path d="M12 4v11m0 0-4.500-4.500M12 15l4.500-4.500M5 19.500h14"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.500v3M12 18.500v3M2.500 12h3M18.500 12h3M5.300 5.300l2.100 2.100M16.600 16.600l2.100 2.100M5.300 18.700l2.100-2.100M16.600 7.400l2.100-2.100"/>',
  subs: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 13h4M13.500 13H17M7 16h7"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', vol: '<path d="M4 9.500v5h3.500L12 19V5L7.500 9.500z" fill="currentColor"/><path d="M15.500 9a4 4 0 0 1 0 6M18 6.500a8 8 0 0 1 0 11"/>',
  mute: '<path d="M4 9.500v5h3.500L12 19V5L7.500 9.500z" fill="currentColor"/><path d="m16 9.500 5 5M21 9.500l-5 5"/>',
  back10: '<path d="M4 12a8 8 0 1 0 2.600-5.900M4 4v4.500h4.500"/><text x="12" y="15.500" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-weight="700">10</text>',
  fwd10: '<path d="M20 12a8 8 0 1 1-2.600-5.900M20 4v4.500h-4.500"/><text x="12" y="15.500" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-weight="700">10</text>',
  next: '<path d="M6 5v14l10-7z" fill="currentColor" stroke="none"/><path d="M18.500 5v14"/>',
  home: '<path d="M4 11 12 4l8 7v8.500a.500.500 0 0 1-.500.500H15v-6H9v6H4.500a.500.500 0 0 1-.500-.500z"/>',
  film: '<rect x="3.500" y="4" width="17" height="16" rx="2.500"/><path d="M8 4v16M16 4v16M3.500 9H8M3.500 15H8M16 9h4.500M16 15h4.500"/>',
  tv: '<rect x="3" y="6" width="18" height="12.500" rx="2.500"/><path d="M8 21.500h8M9 2.500l3 3.500 3-3.500"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.500"/><circle cx="9" cy="9" r="1.100" fill="currentColor"/><circle cx="15" cy="15" r="1.100" fill="currentColor"/><circle cx="15" cy="9" r="1.100" fill="currentColor"/><circle cx="9" cy="15" r="1.100" fill="currentColor"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1-1"/>',
  copy: '<rect x="8.500" y="8.500" width="11" height="11" rx="2.500"/><path d="M15.500 5.500h-8a2 2 0 0 0-2 2v8"/>',
  star: '<path d="m12 3.500 2.600 5.400 5.900.800-4.300 4.100 1 5.900L12 16.900l-5.200 2.800 1-5.900L3.500 9.700l5.900-.800z" fill="currentColor" stroke="none"/>',
  server: '<rect x="3.500" y="4" width="17" height="7" rx="2"/><rect x="3.500" y="13" width="17" height="7" rx="2"/><path d="M7 7.500h.500M7 16.500h.500"/>',
  folder: '<path d="M3.500 7a2 2 0 0 1 2-2h4l2 2.500h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.800 3 2.800 15 0 18M12 3c-2.800 3-2.800 15 0 18"/>',
  chip: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3.500V7M14 3.500V7M10 17v3.500M14 17v3.500M3.500 10H7M3.500 14H7M17 10h3.500M17 14h3.500"/>',
  heart: '<path d="M12 20s-7.500-4.600-7.500-10A4.300 4.300 0 0 1 12 7.300 4.300 4.300 0 0 1 19.500 10c0 5.400-7.500 10-7.500 10z"/>',
  chat: '<path d="M4.500 6.500a2.500 2.500 0 0 1 2.500-2.500h10a2.500 2.500 0 0 1 2.500 2.500v7A2.500 2.500 0 0 1 17 16h-5l-4.500 4v-4H7a2.500 2.500 0 0 1-2.500-2.500z"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.600-5.900M20 4v4.500h-4.500"/>', trash: '<path d="M5 7h14M10 7V4.500h4V7M7 7l.800 12.500h8.400L17 7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.500-3.500"/>', tag: '<path d="M4 4h7.500l8.500 8.500-7.500 7.500L4 11.500z"/><circle cx="8.500" cy="8.500" r="1.200"/>',
  skip: '<path d="M5 5v14l9-7z" fill="currentColor" stroke="none"/><path d="M14 5v14l6-7z" fill="currentColor" stroke="none"/>',
  bolt: '<path d="M13 2.500 5 13.500h6l-1 8 8-11h-6z"/>', spark: '<path d="M12 3v5M12 16v5M3 12h5M16 12h5M6 6l3 3M15 15l3 3M6 18l3-3M15 9l3-3"/>', cpu: '<rect x="5" y="5" width="14" height="14" rx="2.500"/><path d="M9.500 9.500h5v5h-5z"/>',
  lock: '<rect x="5" y="10.500" width="14" height="9.500" rx="2.500"/><path d="M8.500 10.500V8a3.500 3.500 0 0 1 7 0v2.500"/>', cloud: '<path d="M7 18.500a4 4 0 0 1-.500-7.970A5.500 5.500 0 0 1 17.200 9.600 4.500 4.500 0 0 1 17 18.500z"/>',
  layers: '<path d="m12 3.500 9 4.500-9 4.500-9-4.500zM3.500 12.500l8.500 4.300 8.500-4.300M3.500 16.500l8.500 4.300 8.500-4.300"/>',
};
export function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ic'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.900'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = ICON[name] || '';
  return s;
}

export function toast(message, kind = '') {
  const el = h(`div.toast${kind ? '.' + kind : ''}`, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, kind === 'bad' ? 5200 : 3200);
}
/** Runs an async action from a button: disables it meanwhile, shows errors as a toast. */
export async function act(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); }
  catch (e) { toast(e.message || 'Er ging iets mis.', 'bad'); return undefined; }
  finally { if (btn) btn.disabled = false; }
}
export async function copyText(text, label = 'Gekopieerd') {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = h('textarea', { value: text }); document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
  toast(label);
}

export const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
};
export const fmtRuntime = (min) => (min ? (min >= 60 ? `${Math.floor(min / 60)}u ${min % 60}m` : `${min}m`) : '');
export const fmtBitrate = (b) => (b ? (b >= 1e6 ? `${(b / 1e6).toFixed(1).replace('.', ',')} Mbps` : `${Math.round(b / 1000)} kbps`) : '');
export const fmtSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.round(b / 1e6)} MB`);
export const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'nooit');

// ---- overlay layer (modals, player) ---------------------------------------
const layer = () => document.getElementById('layer');
export function openModal(content, { small = false, onClose } = {}) {
  const close = () => { scrim.remove(); if (!layer().children.length) document.body.classList.remove('locked'); document.removeEventListener('keydown', onKey); if (onClose) onClose(); };
  const onKey = (e) => { if (e.key === 'Escape' && layer().lastElementChild === scrim) close(); };
  const modal = h(`div.modal${small ? '.small' : ''}`, h('button.icon-btn.modal-close', { onclick: close, 'aria-label': 'Sluiten' }, icon('x')), content);
  const scrim = h('div.scrim', { onmousedown: (e) => { if (e.target === scrim) close(); } }, modal);
  layer().append(scrim); document.body.classList.add('locked'); document.addEventListener('keydown', onKey);
  return { close, modal };
}
export function mountLayer(el) { layer().append(el); document.body.classList.add('locked'); return () => { el.remove(); if (!layer().children.length) document.body.classList.remove('locked'); }; }

export function confirmDialog(title, text, okLabel = 'Bevestigen') {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal(h('div.stack', h('h2', title), h('p.muted', text), h('div.row', { style: { marginTop: '10px' } }, h('span.spacer'),
      h('button.btn', { onclick: () => m.close() }, 'Annuleren'),
      h('button.btn.primary', { onclick: () => { done = true; resolve(true); m.close(); } }, okLabel))), { small: true, onClose: () => { if (!done) resolve(false); } });
  });
}

// ---- router ----------------------------------------------------------------
const routes = [];
export function route(pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:[a-z]+/gi, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '/?$');
  routes.push({ re, keys, handler });
}
export function go(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  render();
}
let cleanup = null;
export async function render() {
  const path = location.pathname;
  for (const r of routes) {
    const m = r.re.exec(path);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    if (cleanup) { try { cleanup(); } catch { /* view already gone */ } cleanup = null; }
    window.scrollTo(0, 0);
    const out = await r.handler(params, new URLSearchParams(location.search));
    if (typeof out === 'function') cleanup = out;
    return;
  }
  go('/', { replace: true });
}
window.addEventListener('popstate', render);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/"]');
  if (!a || a.target || e.metaKey || e.ctrlKey || a.hasAttribute('download')) return;
  e.preventDefault(); go(a.getAttribute('href'));
});

export const app = () => document.getElementById('app');
export function setView(...children) { const el = app(); el.replaceChildren(...children.flat().filter(Boolean)); }

export function qrSvg(text) {
  const q = window.qrcode(0, 'M'); q.addData(text); q.make();
  return h('div.qr', { html: q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }) });
}
