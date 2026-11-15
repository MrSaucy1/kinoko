import { api, h, state, route, render, go, setView, setToken, act, toast, icon } from './core.js';
import { homeView, gridView, liveView, openDetail, listsView, listView, wrappedView, sharedWrappedView, requestsView } from './views.js';
import { joinRoomView } from './player.js';
import { adminView, setupView } from './admin.js';

function loginView(_, query) {
  const next = query.get('next') || '/';
  const name = h('input.input', { autocomplete: 'username', required: true, autofocus: true }), pass = h('input.input', { type: 'password', autocomplete: 'current-password', required: true });
  const code = h('input.input', { inputMode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', maxLength: 12 });
  const codeField = h('label.field.hide', h('span', 'Code uit je authenticator-app'), code, h('small', 'Geen toegang tot de app? Vul een herstelcode in.'));
  setView(h('div.auth', h('form.auth-card', { onsubmit: (e) => { e.preventDefault(); act(e.submitter, async () => {
    const r = await api('/api/auth/login', { method: 'POST', body: { name: name.value, password: pass.value, device: 'Web', ...(code.value.trim() && { code: code.value.trim() }) } });
    if (r.totpRequired) { codeField.classList.remove('hide'); code.required = true; code.focus(); return; }
    setToken(r.token); state.user = r.user; connectEvents();
    if (r.user.role === 'admin') { try { state.onboarded = (await api('/api/admin/settings')).onboarded; } catch { /* wizard check is best-effort */ } }
    go(next.startsWith('/') && !next.startsWith('//') ? next : '/');
  }); } }, h('div.logo', h('span', 'Kinoko')), h('h1', 'Welkom terug'), h('p', `Log in op ${state.info.name}.`),
    h('div.stack', h('label.field', h('span', 'Naam'), name), h('label.field', h('span', 'Wachtwoord'), pass), codeField, h('button.btn.primary.lg', { style: { marginTop: '6px' } }, 'Inloggen')))));
}

async function joinView({ code }) {
  let inv = { valid: false };
  try { inv = await api(`/api/auth/invite/${encodeURIComponent(code)}`); } catch { /* shown as invalid */ }
  if (!inv.valid) { setView(h('div.auth', h('div.auth-card', h('div.logo', h('span', 'Kinoko')), h('h1', 'Uitnodiging verlopen'), h('p', 'Deze link is niet (meer) geldig. Vraag de beheerder om een nieuwe.'), h('a.btn', { href: '/login' }, 'Naar inloggen')))); return; }
  const name = h('input.input', { autocomplete: 'username', required: true, minLength: 2, autofocus: true }), pass = h('input.input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 6 });
  setView(h('div.auth', h('form.auth-card', { onsubmit: (e) => { e.preventDefault(); act(e.submitter, async () => {
    const r = await api('/api/auth/register', { method: 'POST', body: { code, name: name.value, password: pass.value, device: 'Web' } });
    setToken(r.token); state.user = r.user; connectEvents(); toast(`Welkom, ${r.user.name}!`); go('/');
  }); } }, h('div.logo', h('span', 'Kinoko')), h('h1', `Je bent uitgenodigd voor ${inv.server}`), h('p', 'Kies een naam en wachtwoord om te beginnen met kijken.'),
    h('div.stack', h('label.field', h('span', 'Naam'), name), h('label.field', h('span', 'Wachtwoord'), pass, h('small', 'Minstens 6 tekens.')), h('button.btn.primary.lg', { style: { marginTop: '6px' } }, 'Account aanmaken')))));
}

// A server-link opened in a browser: explain what to do with it.
function linkInfoView() {
  setView(h('div.auth', h('div.auth-card', h('div.logo', h('span', 'Kinoko')), h('h1', 'Dit is een koppellink'), h('p', `Hiermee koppel je een andere Kinoko-server aan ${state.info.name}, zodat jullie elkaars bibliotheken kunnen bekijken.`),
    h('div.steps-list', h('div', 'Open het beheer van ', h('b', 'je eigen'), ' Kinoko-server.'), h('div', 'Ga naar ', h('b', 'Gekoppelde servers'), '.'), h('div', 'Plak deze link bij "Koppellink ontvangen?".')),
    h('div.codebox', { style: { marginTop: '18px' } }, h('span.grow', location.href), h('button.btn.sm', { onclick: () => import('./core.js').then((c) => c.copyText(location.href, 'Link gekopieerd')) }, icon('copy'))))));
}

// Live messages from the server for this account (e.g. "continue here?").
let events = null, eventsFor = '';
export function connectEvents() {
  if (!state.token || (events && eventsFor === state.token && events.readyState <= 1)) return;
  if (events) { events.onclose = null; events.close(); }
  eventsFor = state.token;
  const ws = events = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events/ws?token=${encodeURIComponent(state.token)}&device=Web`);
  const beat = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 40_000);
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    window.dispatchEvent(new CustomEvent('kinoko:event', { detail: m }));
    if (m.t === 'resume' && !document.querySelector('.player')) resumeOffer(m);
    if (m.t === 'request') toast(m.status === 'available' ? `${m.title} staat nu in de bibliotheek` : m.status === 'approved' ? `Je verzoek voor ${m.title} is goedgekeurd` : m.status === 'declined' ? `Je verzoek voor ${m.title} is afgewezen${m.note ? `: ${m.note}` : ''}` : `Je verzoek voor ${m.title} is bijgewerkt`);
  };
  ws.onclose = () => { clearInterval(beat); if (events === ws) { events = null; setTimeout(() => { if (state.token && state.user) connectEvents(); }, 15_000); } };
}
function resumeOffer(m) {
  for (const old of document.querySelectorAll('.offer')) old.remove();
  const where = m.episodeId ? ` · S${m.season} A${m.episode}` : '';
  const el = h('div.offer', h('div.grow', h('small', 'Gepauzeerd op een ander apparaat'), h('b', `${m.title}${where}`)),
    h('button.btn.primary.sm', { onclick: async () => { el.remove(); (await import('./player.js')).startPlayback({ titleId: m.titleId, episodeId: m.episodeId || undefined, resume: m.position }); } }, icon('play'), 'Verder kijken'),
    h('button.icon-btn', { 'aria-label': 'Sluiten', onclick: () => el.remove() }, icon('x')));
  document.body.append(el);
  setTimeout(() => el.remove(), 30_000);
}

const guard = (fn) => (params, query) => {
  if (state.info.needsSetup) { go('/setup', { replace: true }); return undefined; }
  if (!state.user) { go(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true }); return undefined; }
  if (state.user.role === 'admin' && state.onboarded === false) { go('/setup', { replace: true }); return undefined; }
  return fn(params, query);
};

route('/setup', () => { if (!state.info.needsSetup && (!state.user || state.user.role !== 'admin' || state.onboarded !== false)) return go('/', { replace: true }); return setupView(); });
route('/login', (p, q) => (state.info.needsSetup ? go('/setup', { replace: true }) : state.user ? go('/', { replace: true }) : loginView(p, q)));
route('/join/:code', joinView);
route('/w/:code', joinRoomView);
route('/link/:token', linkInfoView);
route('/', guard(() => homeView()));
route('/films', guard(() => homeView('movie')));
route('/series', guard(() => homeView('show')));
route('/live', guard(() => liveView()));
route('/mijn-lijst', guard(() => gridView({ active: 'mylist', title: 'Mijn lijst', load: async () => { const d = await api('/api/home'); return { items: (d.rows.find((r) => r.id === 'mylist') || { items: [] }).items }; } })));
route('/zoeken', guard((_, q) => gridView({ active: 'search', title: `Resultaten voor "${q.get('q') || ''}"`, load: () => api(`/api/browse?q=${encodeURIComponent(q.get('q') || '')}`), lead: (d) => `${d.total} gevonden` })));
route('/genre/:name', guard(({ name }, q) => gridView({ active: q.get('kind') || 'home', title: name, load: () => api(`/api/browse?genre=${encodeURIComponent(name)}&sort=rating${q.get('kind') ? `&kind=${q.get('kind')}` : ''}`), lead: (d) => `${d.total} titels` })));
route('/collectie/:id', guard(({ id }) => gridView({ active: 'home', title: 'Collectie', load: () => api(`/api/collections/${id}`), lead: (d) => `${d.count} films` })));
route('/titel/:id', guard(async ({ id }) => { const off = await homeView(); openDetail(Number(id)); return off; }));
route('/lijsten', guard(() => listsView()));
route('/lijsten/:id', guard((p) => listView(p)));
route('/wrapped', guard((p, q) => wrappedView(p, q)));
route('/verzoeken', guard(() => requestsView()));
route('/wrapped/:token', sharedWrappedView);
route('/beheer', guard(() => adminView({})));
route('/beheer/:section', guard((p) => adminView(p)));

(async () => {
  try {
    state.info = await api('/api/info');
    if (state.token) {
      try {
        state.user = (await api('/api/auth/me')).user;
        if (state.user.role === 'admin') state.onboarded = (await api('/api/admin/settings')).onboarded;
      } catch { /* expired session: api() already cleared the token */ }
    }
  } catch { setView(h('div.empty', h('h2', 'Server niet bereikbaar'), h('p', 'Kinoko reageert niet. Probeer het zo opnieuw.'), h('button.btn', { onclick: () => location.reload() }, 'Opnieuw proberen'))); return; }
  document.title = state.info.name === 'Kinoko' ? 'Kinoko' : `${state.info.name} · Kinoko`;
  render();
  connectEvents();
})();
