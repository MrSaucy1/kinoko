import { api, h, state, route, render, go, setView, setToken, act, toast, icon } from './core.js';
import { homeView, gridView, liveView, openDetail } from './views.js';
import { joinRoomView } from './player.js';
import { adminView, setupView } from './admin.js';

function loginView(_, query) {
  const next = query.get('next') || '/';
  const name = h('input.input', { autocomplete: 'username', required: true, autofocus: true }), pass = h('input.input', { type: 'password', autocomplete: 'current-password', required: true });
  setView(h('div.auth', h('form.auth-card', { onsubmit: (e) => { e.preventDefault(); act(e.submitter, async () => {
    const r = await api('/api/auth/login', { method: 'POST', body: { name: name.value, password: pass.value, device: 'Web' } });
    setToken(r.token); state.user = r.user;
    if (r.user.role === 'admin') { try { state.onboarded = (await api('/api/admin/settings')).onboarded; } catch { /* wizard check is best-effort */ } }
    go(next.startsWith('/') && !next.startsWith('//') ? next : '/');
  }); } }, h('div.logo', h('span', 'Kinoko')), h('h1', 'Welkom terug'), h('p', `Log in op ${state.info.name}.`),
    h('div.stack', h('label.field', h('span', 'Naam'), name), h('label.field', h('span', 'Wachtwoord'), pass), h('button.btn.primary.lg', { style: { marginTop: '6px' } }, 'Inloggen')))));
}

async function joinView({ code }) {
  let inv = { valid: false };
  try { inv = await api(`/api/auth/invite/${encodeURIComponent(code)}`); } catch { /* shown as invalid */ }
  if (!inv.valid) { setView(h('div.auth', h('div.auth-card', h('div.logo', h('span', 'Kinoko')), h('h1', 'Uitnodiging verlopen'), h('p', 'Deze link is niet (meer) geldig. Vraag de beheerder om een nieuwe.'), h('a.btn', { href: '/login' }, 'Naar inloggen')))); return; }
  const name = h('input.input', { autocomplete: 'username', required: true, minLength: 2, autofocus: true }), pass = h('input.input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 6 });
  setView(h('div.auth', h('form.auth-card', { onsubmit: (e) => { e.preventDefault(); act(e.submitter, async () => {
    const r = await api('/api/auth/register', { method: 'POST', body: { code, name: name.value, password: pass.value, device: 'Web' } });
    setToken(r.token); state.user = r.user; toast(`Welkom, ${r.user.name}!`); go('/');
  }); } }, h('div.logo', h('span', 'Kinoko')), h('h1', `Je bent uitgenodigd voor ${inv.server}`), h('p', 'Kies een naam en wachtwoord om te beginnen met kijken.'),
    h('div.stack', h('label.field', h('span', 'Naam'), name), h('label.field', h('span', 'Wachtwoord'), pass, h('small', 'Minstens 6 tekens.')), h('button.btn.primary.lg', { style: { marginTop: '6px' } }, 'Account aanmaken')))));
}

// A server-link opened in a browser: explain what to do with it.
function linkInfoView() {
  setView(h('div.auth', h('div.auth-card', h('div.logo', h('span', 'Kinoko')), h('h1', 'Dit is een koppellink'), h('p', `Hiermee koppel je een andere Kinoko-server aan ${state.info.name}, zodat jullie elkaars bibliotheken kunnen bekijken.`),
    h('div.steps-list', h('div', 'Open het beheer van ', h('b', 'je eigen'), ' Kinoko-server.'), h('div', 'Ga naar ', h('b', 'Gekoppelde servers'), '.'), h('div', 'Plak deze link bij "Koppellink ontvangen?".')),
    h('div.codebox', { style: { marginTop: '18px' } }, h('span.grow', location.href), h('button.btn.sm', { onclick: () => import('./core.js').then((c) => c.copyText(location.href, 'Link gekopieerd')) }, icon('copy'))))));
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
})();
