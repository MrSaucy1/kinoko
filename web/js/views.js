// Browsing: shell, home, grids, title detail, Watch Night, Live TV.
import { api, h, icon, state, go, setView, openModal, mountLayer, toast, act, setToken, fmtRuntime, fmtBitrate, fmtSize, fmtTime, fmtDate, copyText, qrSvg } from './core.js';
import { startPlayback, playChannel, playExtra } from './player.js';

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
let liveEnabled = null;
async function hasLive() {
  if (liveEnabled === null) { try { liveEnabled = (await api('/api/iptv')).enabled; } catch { liveEnabled = false; } }
  return liveEnabled;
}

export function shell(active, ...content) {
  const links = [['home', '/', 'Home', 'home'], ['movie', '/films', 'Films', 'film'], ['show', '/series', 'Series', 'tv'], ['live', '/live', 'Live tv', 'globe'], ['mylist', '/mijn-lijst', 'Mijn lijst', 'heart']];
  const nav = h('nav.nav'), tabs = h('nav.tabbar');
  for (const [id, href, label, ic] of links) {
    const a = h(`a${id === active ? '.on' : ''}`, { href }, label);
    const t = h(`a${id === active ? '.on' : ''}`, { href }, icon(ic), label);
    if (id === 'live') { a.classList.add('hide'); t.classList.add('hide'); hasLive().then((on) => { if (on) { a.classList.remove('hide'); t.classList.remove('hide'); } }); }
    nav.append(a); tabs.append(t);
  }
  const search = h('input', { type: 'search', placeholder: 'Titels, acteurs, genres', 'aria-label': 'Zoeken', value: active === 'search' ? new URLSearchParams(location.search).get('q') || '' : '' });
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { const q = search.value.trim(); if (q) go(`/zoeken?q=${encodeURIComponent(q)}`, { replace: active === 'search' }); else if (active === 'search') go('/'); }, 320); });
  if (active === 'search') setTimeout(() => { search.focus(); search.setSelectionRange(search.value.length, search.value.length); });

  const menuWrap = h('div', { style: { position: 'relative' } });
  const avatar = h(`button.avatar.${state.user.avatar}`, { 'aria-label': 'Account', onclick: (e) => { e.stopPropagation(); toggleMenu(); } }, state.user.name[0]);
  let menu = null;
  const closeMenu = () => { if (menu) { menu.remove(); menu = null; document.removeEventListener('click', closeMenu); } };
  function toggleMenu() {
    if (menu) return closeMenu();
    menu = h('div.menu',
      h('div', { style: { padding: '8px 12px 10px' } }, h('b', state.user.name), h('div.faint', { style: { fontSize: '12.5px' } }, state.info.name)),
      h('hr'),
      state.user.role === 'admin' && h('a', { href: '/beheer' }, icon('gear'), 'Beheer'),
      h('button', { onclick: passwordDialog }, icon('tag'), 'Wachtwoord wijzigen'),
      h('button', { onclick: devicesDialog }, icon('tv'), 'Apparaten'),
      h('button', { onclick: twoFactorDialog }, icon('check'), 'Tweestapsverificatie'),
      h('button', { onclick: async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* token already invalid */ } setToken(''); state.user = null; go('/login'); } }, icon('back'), 'Uitloggen'));
    menuWrap.append(menu);
    setTimeout(() => document.addEventListener('click', closeMenu));
  }
  menuWrap.append(avatar);

  const bar = h('header.topbar', h('a.logo', { href: '/', 'aria-label': 'Kinoko home' }, h('span', 'Kinoko')), nav, h('span.spacer'),
    h('div.search', search),
    h('button.icon-btn', { title: 'Watch Night', 'aria-label': 'Watch Night', onclick: openWatchNight }, icon('dice')), menuWrap);
  const onScroll = () => bar.classList.toggle('solid', window.scrollY > 30);
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  setView(bar, h('main.view', content), tabs);
  return () => { window.removeEventListener('scroll', onScroll); closeMenu(); };
}

// Two-factor sign-in: scan the QR code, confirm with a code, keep the recovery codes.
function twoFactorDialog() {
  const body = h('div.stack');
  const m = openModal(body, { small: true });
  const done = (codes) => body.replaceChildren(h('h2', 'Tweestapsverificatie staat aan'), h('p.muted', 'Bewaar deze herstelcodes op een veilige plek. Elke code werkt één keer als je je telefoon kwijt bent. Ze worden niet opnieuw getoond.'),
    h('div.codebox', { style: { whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace', lineHeight: '1.8' } }, h('span.grow', codes.join('   ')), h('button.btn.sm', { onclick: () => copyText(codes.join('\n'), 'Herstelcodes gekopieerd') }, icon('copy'))),
    h('button.btn.primary', { onclick: () => m.close() }, 'Ik heb ze bewaard'));
  if (state.user.twoFactor) {
    const pass = h('input.input', { type: 'password', autocomplete: 'current-password' }), code = h('input.input', { inputMode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456' });
    body.replaceChildren(h('h2', 'Tweestapsverificatie'), h('p.muted', 'Staat aan: bij het inloggen vraagt Kinoko om een code uit je authenticator-app.'),
      h('form.stack', { onsubmit: (e) => { e.preventDefault(); act(e.submitter, async () => { await api('/api/auth/2fa/disable', { method: 'POST', body: { password: pass.value, code: code.value } }); state.user.twoFactor = false; toast('Tweestapsverificatie uitgezet'); m.close(); }); } },
        h('label.field', h('span', 'Wachtwoord'), pass), h('label.field', h('span', 'Code uit de app (of een herstelcode)'), code), h('button.btn.danger', 'Uitzetten')));
    return;
  }
  body.replaceChildren(h('h2', 'Tweestapsverificatie'), h('p.muted', 'Naast je wachtwoord vraagt Kinoko dan om een code uit een authenticator-app (Aegis, Google Authenticator, 1Password…).'),
    h('button.btn.primary', { onclick: (e) => act(e.currentTarget, async () => {
      const s = await api('/api/auth/2fa/setup', { method: 'POST' });
      const code = h('input.input', { inputMode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', autofocus: true });
      body.replaceChildren(h('h2', 'Scan de code'), h('div.row.wrap', { style: { gap: '18px' } }, qrSvg(s.url), h('div.grow.stack', { style: { gap: '8px' } }, h('p.muted', 'Scan dit met je authenticator-app, of typ de sleutel over:'), h('div.codebox', h('span.grow', { style: { wordBreak: 'break-all' } }, s.secret), h('button.btn.sm', { onclick: () => copyText(s.secret) }, icon('copy'))))),
        h('form.stack', { onsubmit: (ev) => { ev.preventDefault(); act(ev.submitter, async () => { const r = await api('/api/auth/2fa/enable', { method: 'POST', body: { code: code.value } }); state.user.twoFactor = true; state.user.mustSetup2fa = false; done(r.recoveryCodes); }); } },
          h('label.field', h('span', 'Vul de code in die de app nu toont'), code), h('button.btn.primary', 'Aanzetten')));
    }) }, 'Instellen'));
}

// Every place this account is signed in, with a way to sign each one out.
function devicesDialog() {
  const list = h('div.stack', { style: { gap: '8px' } }), others = h('button.btn', 'Overal anders uitloggen'), note = h('p.muted', { style: { fontSize: '13px' } });
  async function draw() {
    let d; try { d = await api('/api/auth/sessions'); } catch (e) { list.replaceChildren(h('p.muted', e.message)); return; }
    note.textContent = `Een apparaat dat ${d.idleDays} dagen niet is gebruikt, wordt vanzelf uitgelogd.`;
    others.disabled = d.sessions.length < 2;
    list.replaceChildren(...d.sessions.map((s) => h('div.device',
      h('div.grow', h('b', s.device || 'Onbekend apparaat'), s.current && h('span.badge', 'Dit apparaat'),
        h('div.faint', `Laatst gebruikt ${fmtDate(s.last_seen)} · ingelogd ${fmtDate(s.created_at)}`)),
      !s.current && h('button.btn.sm', { onclick: (e) => act(e.currentTarget, async () => { await api(`/api/auth/sessions/${s.id}`, { method: 'DELETE' }); toast('Apparaat uitgelogd'); await draw(); }) }, 'Uitloggen'))));
  }
  // draw() runs after act() so the button stays disabled when nothing else is signed in.
  others.onclick = async () => { await act(others, async () => { await api('/api/auth/sessions/revoke-others', { method: 'POST' }); toast('Alle andere apparaten zijn uitgelogd'); }); draw(); };
  openModal(h('div.stack', h('h2', 'Apparaten'), h('p.muted', 'Hier is je account ingelogd. Herken je er een niet? Log het uit en wijzig je wachtwoord.'), list, note, h('div.row', others)), { small: true });
  draw();
}

function passwordDialog() {
  const cur = h('input.input', { type: 'password', autocomplete: 'current-password' }), next = h('input.input', { type: 'password', autocomplete: 'new-password' });
  const m = openModal(h('form.stack', { onsubmit: (e) => { e.preventDefault(); act(e.submitter, async () => { await api('/api/auth/password', { method: 'POST', body: { current: cur.value, next: next.value } }); toast('Wachtwoord gewijzigd'); m.close(); }); } },
    h('h2', 'Wachtwoord wijzigen'), h('label.field', h('span', 'Huidig wachtwoord'), cur), h('label.field', h('span', 'Nieuw wachtwoord'), next, h('small', 'Minstens 6 tekens. Andere apparaten worden uitgelogd.')),
    h('button.btn.primary', 'Opslaan')), { small: true });
}

// ---------------------------------------------------------------------------
// Tiles & shelves
// ---------------------------------------------------------------------------
function lazyImg(src, alt = '') {
  const img = h('img', { alt, loading: 'lazy', decoding: 'async' });
  img.addEventListener('load', () => img.classList.add('in'));
  img.addEventListener('error', () => img.remove());
  if (src) img.src = src;
  return img;
}

export function tile(c, { wide = false } = {}) {
  if (c.kind === 'collection') {
    return h('button.tile.collection', { onclick: () => go(`/collectie/${c.id}`) },
      h('div.art', c.backdrop && lazyImg(c.backdrop), h('div.fan', c.posters.map((p) => lazyImg(p))),
        h('div.ctitle', h('b', c.title), h('small', `${c.count} films`))));
  }
  const r = c.resume;
  const sub = r && r.episodeId ? `S${r.season} · A${r.episode}${r.name ? ' — ' + r.name : ''}` : [c.year, c.genres && c.genres[0]].filter(Boolean).join(' · ');
  const art = wide ? (c.backdrop || c.poster) : (c.poster || c.backdrop);
  const el = h(`button.tile${wide ? '.wide' : ''}`, { onclick: () => (r ? startPlayback({ titleId: c.id, episodeId: r.episodeId || 0, resume: r.position }) : openDetail(c.id)), title: c.title },
    h('div.art', h('div.fallback', c.title), art && lazyImg(art, c.title),
      h('div.cap', h('b', c.title), h('small', sub)),
      r && r.duration > 0 && h('div.bar', h('i', { style: { width: `${Math.min(100, (r.position / r.duration) * 100)}%` } }))));
  if (r) el.addEventListener('contextmenu', (e) => { e.preventDefault(); openDetail(c.id); });
  return el;
}

function shelf(row) {
  const track = h('div.track', row.items.map((c) => tile(c, { wide: row.style === 'wide' })));
  const l = h('button.shelf-arrow.l', { 'aria-label': 'Terug', onclick: () => track.scrollBy({ left: -track.clientWidth * 0.85, behavior: 'smooth' }) }, icon('left'));
  const r = h('button.shelf-arrow.r', { 'aria-label': 'Verder', onclick: () => track.scrollBy({ left: track.clientWidth * 0.85, behavior: 'smooth' }) }, icon('right'));
  const sync = () => { l.disabled = track.scrollLeft < 8; r.disabled = track.scrollLeft + track.clientWidth > track.scrollWidth - 8; };
  track.addEventListener('scroll', sync, { passive: true }); setTimeout(sync, 50);
  return h('section.shelf', h('h2', row.title, row.genre && h('a', { href: `/genre/${encodeURIComponent(row.genre)}` }, 'Alles bekijken ›')), l, track, r);
}

function skeleton() {
  return h('div', { style: { paddingTop: '110px' } }, [0, 1, 2].map(() => h('section.shelf', h('h2', h('span.skel', { style: { width: '180px', height: '20px', display: 'block' } })),
    h('div.track', Array.from({ length: 8 }, () => h('div.tile', h('div.art.skel')))))));
}

// ---------------------------------------------------------------------------
// Trailers: a muted YouTube trailer fades in over the artwork, like Netflix.
// ---------------------------------------------------------------------------
let soundOn = false; // the viewer's choice sticks for the rest of the visit

/** Plays trailer `id` over `host`; `onDone(reason)` fires once: 'ended', 'error' or 'stopped'. */
function playTrailer(id, host, { onPlaying, onDone } = {}) {
  const frame = h('iframe.trailer', { src: `/trailer.html?v=${encodeURIComponent(id)}`, allow: 'autoplay; encrypted-media', tabIndex: -1, 'aria-hidden': 'true', title: 'Trailer' });
  const say = (cmd) => frame.contentWindow && frame.contentWindow.postMessage(cmd, location.origin);
  const mute = h('button.icon-btn.trailer-mute', { 'aria-label': 'Geluid van de trailer', title: 'Geluid aan/uit', onclick: (e) => { e.stopPropagation(); soundOn = !soundOn; say(soundOn ? 'unmute' : 'mute'); mute.replaceChildren(icon(soundOn ? 'vol' : 'mute')); } }, icon(soundOn ? 'vol' : 'mute'));
  let over = false;
  function finish(reason) {
    if (over) return;
    over = true;
    window.removeEventListener('message', onMsg); document.removeEventListener('kinoko:layer', onLayer);
    frame.classList.remove('on'); mute.remove();
    setTimeout(() => frame.remove(), 700);
    if (onDone) onDone(reason);
  }
  function onMsg(e) {
    if (e.source !== frame.contentWindow || !e.data || !e.data.kinokoTrailer) return;
    const what = e.data.kinokoTrailer;
    if (what === 'playing') { if (soundOn) say('unmute'); frame.classList.add('on'); host.append(mute); if (onPlaying) onPlaying(); }
    else finish(what === 'ended' ? 'ended' : 'error');
  }
  const onLayer = () => finish('stopped');
  window.addEventListener('message', onMsg);
  // Anything that opens on top (a player, a dialog) silences the trailer.
  setTimeout(() => { if (!over) document.addEventListener('kinoko:layer', onLayer); });
  host.append(frame);
  return { stop: () => finish('stopped') };
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
function hero(items) {
  if (!items.length) return null;
  let index = 0, timer;
  const slides = items.map((t, i) => h(`div.hero-slide${i === 0 ? '.on' : ''}`, h('img', { src: t.backdrop, alt: '' })));
  const info = h('div.hero-info');
  const dots = h('div.hero-dots', items.map((_, i) => h(`button${i === 0 ? '.on' : ''}`, { 'aria-label': `Uitgelicht ${i + 1}`, onclick: () => show(i, true) })));
  function fill(t) {
    info.replaceChildren(
      h('h1.hero-title', t.title),
      h('div.hero-meta', t.rating && h('span', h('span.star', '★ '), t.rating.toFixed(1)), t.year && h('span', t.year), t.runtime && h('span', fmtRuntime(t.runtime)), (t.genres || []).slice(0, 3).map((g) => h('span.chip', g))),
      h('p.hero-text', t.overview),
      h('div.hero-actions',
        h('button.btn.white.lg', { onclick: () => startPlayback({ titleId: t.id }) }, icon('play'), 'Afspelen'),
        h('button.btn.ghost.lg', { onclick: () => openDetail(t.id) }, icon('info'), 'Meer info')));
  }
  function show(i, manual) {
    slides[index].classList.remove('on'); dots.children[index].classList.remove('on');
    index = i; slides[index].classList.add('on'); dots.children[index].classList.add('on'); fill(items[index]);
    if (manual) rotate();
    queueTrailer();
  }
  const next = () => show((index + 1) % items.length);
  const rotate = () => { clearInterval(timer); if (items.length > 1) timer = setInterval(next, 9000); };
  // After a moment on a slide its trailer takes over; the carousel waits until it ends.
  let trailer = null, wait;
  function stopTrailer() { clearTimeout(wait); if (trailer) trailer.stop(); }
  function queueTrailer() {
    stopTrailer();
    const t = items[index];
    if (!t.trailer || innerWidth < 700) return;
    wait = setTimeout(() => {
      if (!el.isConnected || document.hidden || document.body.classList.contains('locked') || scrollY > el.offsetHeight * 0.5) return;
      clearInterval(timer); // hold the slide while the trailer loads
      const mine = trailer = playTrailer(t.trailer, el, {
        onPlaying: () => el.classList.add('playing'),
        onDone: (reason) => {
          if (trailer === mine) trailer = null;
          el.classList.remove('playing');
          if (!el.isConnected) return;
          if (reason === 'ended' && items.length > 1) next();
          rotate();
        },
      });
    }, 2500);
  }
  fill(items[0]);
  const el = h('section.hero', slides, info, items.length > 1 && dots);
  rotate();
  const onScroll = () => { if (scrollY > el.offsetHeight * 0.6) stopTrailer(); };
  window.addEventListener('scroll', onScroll, { passive: true });
  el.stop = () => { clearInterval(timer); stopTrailer(); window.removeEventListener('scroll', onScroll); };
  queueTrailer();
  return el;
}

export async function homeView(kind = null) {
  const off = shell(kind || 'home', skeleton());
  let data;
  try { data = await api(`/api/home${kind ? `?kind=${kind}` : ''}`); } catch (e) { toast(e.message, 'bad'); return off; }
  const main = document.querySelector('main');
  if (data.empty) {
    main.replaceChildren(h('div.empty', h('h2', kind ? 'Hier staat nog niets' : 'Je bibliotheek is nog leeg'),
      h('p', state.user.role === 'admin' ? 'Voeg een map met films of series toe en Kinoko doet de rest.' : 'De beheerder heeft nog geen films of series toegevoegd.'),
      state.user.role === 'admin' && h('a.btn.primary', { href: '/beheer/bibliotheken' }, 'Bibliotheek toevoegen')));
    return off;
  }
  const hr = hero(data.hero);
  const chips = h('div.chips', h(`a.chip${!kind ? '.on' : ''}`, { href: '/' }, 'Alles'), h(`a.chip${kind === 'movie' ? '.on' : ''}`, { href: '/films' }, 'Films'), h(`a.chip${kind === 'show' ? '.on' : ''}`, { href: '/series' }, 'Series'),
    data.genres.map((g) => h('a.chip', { href: `/genre/${encodeURIComponent(g)}${kind ? `?kind=${kind}` : ''}` }, g)));
  const rows = h(`div.rows${hr ? '' : '.flat'}`, chips);
  data.rows.forEach((row, i) => {
    rows.append(shelf(row));
    if (i === 0 && !kind) rows.append(h('div.wn-teaser', { onclick: openWatchNight, role: 'button', tabIndex: 0 },
      h('div.dice', icon('dice')), h('div.grow', h('h3', 'Watch Night'), h('p.muted', 'Geen idee wat je wilt kijken? Laat het seizoen kiezen en dobbel voor drie films.')), h('span.btn.primary', 'Dobbelen')));
  });
  main.replaceChildren(hr, rows);
  return () => { off(); if (hr) hr.stop(); };
}

// ---------------------------------------------------------------------------
// Grids: search, genre, my list, collection
// ---------------------------------------------------------------------------
export async function gridView({ active, title, load, lead }) {
  const off = shell(active, h('div.page-head', h('h1', title)), h('div.grid', Array.from({ length: 12 }, () => h('div.tile', h('div.art.skel')))));
  let data; try { data = await load(); } catch (e) { toast(e.message, 'bad'); return off; }
  const main = document.querySelector('main');
  const items = data.items || [];
  main.replaceChildren(
    h('div.page-head', h('h1', data.title || title), lead && h('span.muted', lead(data))),
    items.length ? h('div.grid', items.map((c) => tile(c))) : h('div.empty', h('h2', 'Niets gevonden'), h('p', 'Probeer een andere zoekterm of bekijk alles op de startpagina.')));
  return off;
}

// ---------------------------------------------------------------------------
// Title detail
// ---------------------------------------------------------------------------
const Q_LABEL = { original: 'Origineel', 1080: '1080p', 720: '720p', 480: '480p', 360: '360p' };

function versionPicker(versions, sel, onChange) {
  const box = h('div.versions');
  const draw = () => {
    box.replaceChildren(versions.map((v) => h(`button.version${v.fileId === sel.fileId ? '.on' : ''}`, { onclick: () => { sel.fileId = v.fileId; sel.quality = 'original'; draw(); onChange(); } },
      h('b', v.resolution), v.hdr && h('span.badge', 'HDR'), h('span.muted', [fmtBitrate(v.bitrate), v.vcodec.toUpperCase(), fmtSize(v.size)].filter(Boolean).join(' · ')),
      h('span.spacer'), v.best && h('span.badge.best', 'Beste kwaliteit'),
      h('span.srv', h(`i${v.server.local ? '' : '.remote'}`), v.server.name))));
    const cur = versions.find((v) => v.fileId === sel.fileId) || versions[0];
    box.append(h('div.row.wrap', { style: { marginTop: '6px' } }, h('span.muted', { style: { fontSize: '13px' } }, 'Kwaliteit'),
      cur.qualities.map((q) => h(`button.chip${String(sel.quality) === String(q) ? '.on' : ''}`, { onclick: () => { sel.quality = q; draw(); } }, Q_LABEL[q] || q)),
      sel.quality !== 'original' && h('span.faint', { style: { fontSize: '12.5px' } }, `wordt omgezet op ${cur.server.name}`)));
  };
  draw();
  return box;
}

export async function openDetail(id) {
  let d; try { d = await api(`/api/titles/${id}`); } catch (e) { return toast(e.message, 'bad'); }
  const sel = { fileId: null, quality: 'original' };
  const body = h('div');
  let trailer = null, trailerWait;
  const m = openModal(body, { onClose: () => { clearTimeout(trailerWait); if (trailer) trailer.stop(); } });
  const play = (opts = {}) => { m.close(); startPlayback({ titleId: d.id, fileId: sel.fileId, quality: sel.quality, ...opts }); };

  const listBtn = h(`button.icon-btn${d.inList ? '.on' : ''}`, { title: 'Mijn lijst', 'aria-label': 'Mijn lijst', onclick: () => act(listBtn, async () => {
    const r = await api(`/api/mylist/${d.id}`, { method: d.inList ? 'DELETE' : 'PUT' }); d.inList = r.inList;
    listBtn.classList.toggle('on', d.inList); listBtn.replaceChildren(icon(d.inList ? 'check' : 'plus')); toast(d.inList ? 'Toegevoegd aan Mijn lijst' : 'Verwijderd uit Mijn lijst');
  }) }, icon(d.inList ? 'check' : 'plus'));

  const head = h('div.d-hero', d.backdrop && h('img', { src: d.backdrop, alt: '' }), h('div.d-head', h('h1', d.title)));
  const actions = h('div.row.wrap');
  head.querySelector('.d-head').append(actions);
  if (d.trailer) trailerWait = setTimeout(() => { if (head.isConnected) trailer = playTrailer(d.trailer, head, { onDone: () => { trailer = null; } }); }, 1200);

  const meta = h('div.hero-meta', { style: { margin: '0 0 14px' } }, d.rating && h('span', h('span.star', '★ '), d.rating.toFixed(1)), d.year && h('span', d.year), d.age && h('span.age', { title: 'Kijkwijzer: minimumleeftijd' }, d.age),
    d.kind === 'movie' ? d.runtime && h('span', fmtRuntime(d.runtime)) : h('span', `${d.seasons.length} seizoen${d.seasons.length === 1 ? '' : 'en'}`));
  const side = h('div.side',
    d.cast.length ? h('div', h('b', 'Cast: '), d.cast.slice(0, 4).map((c) => c.name).join(', ')) : null,
    d.genres.length ? h('div', h('b', 'Genres: '), d.genres.join(', ')) : null,
    d.directors.length ? h('div', h('b', d.kind === 'show' ? 'Bedenkers: ' : 'Regie: '), d.directors.join(', ')) : null,
    d.collections.map((c) => h('a', { href: `/collectie/${c.id}`, onclick: () => m.close() }, icon('layers'), c.name)));
  body.append(head, h('div.d-body', h('div', meta, d.tagline && h('p', { style: { fontStyle: 'italic', color: 'var(--lilac)', marginBottom: '10px' } }, d.tagline), h('p', { style: { color: '#d9cfee' } }, d.overview || 'Geen beschrijving beschikbaar.')), side));

  const together = (fileId) => act(null, async () => {
    const r = await api('/api/watch', { method: 'POST', body: { fileId } });
    m.close(); go(`/w/${r.code}`);
  });
  const download = (fileId) => act(null, async () => {
    const p = await api('/api/play', { method: 'POST', body: { fileId, quality: 'original' } });
    if (!p.download) throw new Error('Het origineel downloaden is voor jouw account uitgezet door de beheerder.');
    const a = h('a', { href: p.download, download: '' }); document.body.append(a); a.click(); a.remove(); toast('Download gestart');
  });

  if (d.kind === 'movie') {
    if (!d.versions.length) { actions.append(h('span.badge.warn', 'Geen bestand beschikbaar')); return; }
    sel.fileId = d.versions[0].fileId;
    const p = d.progress;
    const resume = p && !p.watched && p.position > 30 ? p.position : 0;
    if (resume) head.querySelector('.d-head').insertBefore(h('div.d-progress', h('i', { style: { width: `${(p.position / p.duration) * 100}%` } })), actions);
    actions.append(
      h('button.btn.white.lg', { onclick: () => play({ resume }) }, icon('play'), resume ? `Verder kijken · ${fmtTime(resume)}` : 'Afspelen'),
      resume ? h('button.btn.ghost', { onclick: () => play({ resume: 0 }) }, 'Vanaf begin') : null,
      listBtn,
      h('button.icon-btn', { title: 'Samen kijken', 'aria-label': 'Samen kijken', onclick: () => together(sel.fileId) }, icon('users')),
      h('button.icon-btn', { title: 'Downloaden', 'aria-label': 'Downloaden', onclick: () => download(sel.fileId) }, icon('download')));
    body.append(h('div.d-section', h('h3', 'Versies', d.versions.length > 1 && h('span.badge', `${d.versions.length} beschikbaar`)),
      versionPicker(d.versions, sel, () => {})));
  } else {
    const all = d.seasons.flatMap((s) => s.episodes);
    const nu = all.find((e) => e.id === d.nextUp?.episodeId) || all[0];
    let season = nu ? nu.season : d.seasons[0]?.season;
    const playEp = (e, opts = {}) => { m.close(); startPlayback({ titleId: d.id, episodeId: e.id, resume: e.progress && !e.progress.watched ? e.progress.position : 0, ...opts }); };
    if (nu) actions.append(h('button.btn.white.lg', { onclick: () => playEp(nu) }, icon('play'), `${nu.progress && nu.progress.position > 0 ? 'Verder' : 'Afspelen'} · S${nu.season} A${nu.episode}`));
    actions.append(listBtn, nu && h('button.icon-btn', { title: 'Samen kijken', 'aria-label': 'Samen kijken', onclick: () => together(nu.versions[0].fileId) }, icon('users')));
    const eps = h('div.eps');
    const seasonSel = h('select.input', { style: { width: 'auto', height: '38px' }, onchange: () => { season = Number(seasonSel.value); drawEps(); } },
      d.seasons.map((s) => h('option', { value: s.season, selected: s.season === season }, `Seizoen ${s.season}`)));
    function drawEps() {
      const s = d.seasons.find((x) => x.season === season);
      eps.replaceChildren(s.episodes.map((e) => {
        const best = e.versions[0];
        const others = [...new Set(e.versions.map((v) => v.server.name))];
        return h(`div.ep${nu && e.id === nu.id ? '.next' : ''}`, { role: 'button', tabIndex: 0, onclick: () => playEp(e), onkeydown: (ev) => { if (ev.key === 'Enter') playEp(e); } },
          h('div.n', e.episode),
          h('div.thumb', e.still && h('img', { src: e.still, alt: '', loading: 'lazy' }), e.progress && (e.progress.watched || e.progress.position > 0) && h('div.bar', h('i', { style: { width: e.progress.watched ? '100%' : `${(e.progress.position / (e.progress.duration || 1)) * 100}%` } }))),
          h('div', h('b', e.name), h('p', e.overview), h('div.row', { style: { marginTop: '6px', gap: '6px' } }, best && h('span.badge', best.resolution), best && h('span.faint', { style: { fontSize: '12px' } }, others.join(' + ')))),
          h('div.row.dur', { style: { gap: '4px' } }, h('span.muted', { style: { fontSize: '13px' } }, e.duration ? `${Math.round(e.duration / 60)} min` : ''),
            best && h('button.icon-btn', { title: 'Downloaden', 'aria-label': 'Downloaden', style: { width: '34px', height: '34px' }, onclick: (ev) => { ev.stopPropagation(); download(best.fileId); } }, icon('download'))));
      }));
    }
    drawEps();
    body.append(h('div.d-section', h('h3', 'Afleveringen', h('span.spacer'), d.seasons.length > 1 ? seasonSel : h('span.muted', { style: { fontSize: '14px', fontWeight: 500 } }, `Seizoen ${season}`)), eps));
  }

  if (d.cast.length) body.append(h('div.d-section', h('h3', 'Cast'), h('div.cast', d.cast.slice(0, 16).map((c) => h('div', h('div.ph', c.photo ? h('img', { src: c.photo, alt: '', loading: 'lazy' }) : c.name[0]), h('b', c.name), c.role && h('small', c.role))))));
  if (d.extras && d.extras.length) body.append(h('div.d-section', h('h3', "Extra's"), h('div.extras', d.extras.map((x) => h('button.extra', { onclick: () => playExtra(x) }, icon('play'), h('span.grow', h('b', x.name), h('small', x.label)), x.duration ? h('small', fmtTime(x.duration)) : null)))));
  if (d.similar.length) body.append(h('div.d-section', h('h3', 'Meer zoals dit'), h('div.d-similar', d.similar.map((c) => { const t = tile(c); t.addEventListener('click', () => m.close(), { capture: true }); return t; }))));
}

// ---------------------------------------------------------------------------
// Watch Night
// ---------------------------------------------------------------------------
// Seasonal particles are drawn as shapes (not emoji) so they look the same on every device.
const PARTICLE_COLORS = { snow: ['#ffffff', '#e9d5ff'], leaves: ['#f59e0b', '#ea580c', '#c084fc'], hearts: ['#ff6fb5', '#f0abfc'], bats: ['#ff7a1a', '#b266ff'], petals: ['#fbcfe8', '#d8b4fe'], fireflies: ['#fde68a', '#facc15'] };

function drawParticle(ctx, kind, s) {
  ctx.beginPath();
  if (kind === 'snow' || kind === 'fireflies') ctx.arc(0, 0, s * 0.22, 0, 6.283);
  else if (kind === 'hearts') { const r = s * 0.3; ctx.moveTo(0, r); ctx.bezierCurveTo(-r * 2, -r * 0.4, -r * 0.8, -r * 1.7, 0, -r * 0.6); ctx.bezierCurveTo(r * 0.8, -r * 1.7, r * 2, -r * 0.4, 0, r); }
  else if (kind === 'bats') { const r = s * 0.5; ctx.moveTo(0, -r * 0.2); ctx.quadraticCurveTo(r * 0.5, -r * 0.9, r, -r * 0.1); ctx.quadraticCurveTo(r * 0.6, 0, r * 0.4, r * 0.5); ctx.quadraticCurveTo(0, 0, -r * 0.4, r * 0.5); ctx.quadraticCurveTo(-r * 0.6, 0, -r, -r * 0.1); ctx.quadraticCurveTo(-r * 0.5, -r * 0.9, 0, -r * 0.2); }
  else { ctx.ellipse(0, 0, s * 0.42, s * 0.2, 0, 0, 6.283); } // leaves, petals
  ctx.fill();
}

function particleCanvas(kind) {
  const c = h('canvas'); const ctx = c.getContext('2d');
  const colors = PARTICLE_COLORS[kind] || PARTICLE_COLORS.snow;
  let w, hgt, raf; const parts = [];
  const resize = () => { w = c.width = innerWidth; hgt = c.height = innerHeight; };
  resize(); window.addEventListener('resize', resize);
  for (let i = 0; i < 54; i++) parts.push({ x: Math.random(), y: Math.random(), s: 8 + Math.random() * 18, v: 0.0006 + Math.random() * 0.0016, d: Math.random() * 6.28, c: colors[i % colors.length], r: Math.random() * 6.28 });
  const rising = kind === 'fireflies' || kind === 'hearts';
  const tick = () => {
    ctx.clearRect(0, 0, w, hgt);
    for (const p of parts) {
      p.y += rising ? -p.v : p.v; p.d += 0.012; p.r += 0.012;
      if (p.y > 1.05) p.y = -0.05; if (p.y < -0.05) p.y = 1.05;
      ctx.save(); ctx.translate((p.x + Math.sin(p.d) * 0.02) * w, p.y * hgt); ctx.rotate(kind === 'hearts' ? Math.sin(p.r) * 0.3 : p.r);
      ctx.globalAlpha = kind === 'fireflies' ? 0.25 + Math.abs(Math.sin(p.d * 3)) * 0.7 : 0.5; ctx.fillStyle = p.c;
      if (kind === 'fireflies') { ctx.shadowColor = p.c; ctx.shadowBlur = 14; }
      drawParticle(ctx, kind, p.s); ctx.restore();
    }
    raf = requestAnimationFrame(tick);
  };
  tick();
  c.stop = () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  return c;
}

export async function openWatchNight() {
  let data; try { data = await api('/api/watchnight'); } catch (e) { return toast(e.message, 'bad'); }
  if (!data.picks.length) return toast('Voeg eerst films toe om te kunnen dobbelen.');
  const canvas = particleCanvas(data.theme.particle);
  const cards = h('div.wn-cards');
  const rollBtn = h('button.btn.primary.lg', { onclick: () => roll(false) }, h('span.wn-dice', icon('dice')), 'Opnieuw dobbelen');
  const el = h('div.wn', { style: { '--wn-a': data.theme.colors[0] + '55', '--wn-b': data.theme.colors[0], '--wn-c': data.theme.colors[1] } }, canvas,
    h('button.icon-btn.wn-close', { 'aria-label': 'Sluiten', onclick: () => close() }, icon('x')),
    h('div.wn-inner', h('div.wn-eyebrow', 'Watch Night'), h('h1', data.theme.name), h('p', data.theme.tagline), cards,
      h('div.row', { style: { justifyContent: 'center' } }, rollBtn), h('p.faint', { style: { marginTop: '18px', fontSize: '13px' } }, `Gekozen uit ${data.poolSize} films die bij dit moment passen.`)));
  const unmount = mountLayer(el);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { canvas.stop(); document.removeEventListener('keydown', onKey); unmount(); }
  let seen = [];

  async function roll(first) {
    if (!first) { rollBtn.disabled = true; rollBtn.classList.add('rolling-dice'); try { data = await api(`/api/watchnight?exclude=${seen.join(',')}`); } catch (e) { toast(e.message, 'bad'); } }
    seen = [...seen, ...data.picks.map((p) => p.id)].slice(-12);
    cards.replaceChildren();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    data.picks.forEach((p, i) => {
      // Slot-machine reel: a strip of random posters that decelerates onto the pick.
      const strip = [...data.reel.filter((u) => u !== p.poster)].sort(() => Math.random() - 0.5).slice(0, 9);
      const reel = h('div.wn-reel', strip.map((u) => h('img', { src: u, alt: '' })), p.poster ? h('img', { src: p.poster, alt: p.title }) : h('div', { style: { aspectRatio: '2/3', display: 'grid', placeItems: 'center', padding: '14px', fontWeight: 700 } }, p.title));
      const slot = h('div.wn-slot.rolling', { onclick: () => { close(); openDetail(p.id); } }, reel);
      const card = h('div.wn-card', slot, h('div.info', h('b', p.title), h('small', [p.year, p.fit].filter(Boolean).join(' · '))));
      cards.append(card);
      const dur = reduce ? 0 : 1500 + i * 650;
      requestAnimationFrame(() => {
        const dist = slot.clientHeight * strip.length;
        reel.animate([{ transform: 'translateY(0)' }, { transform: `translateY(-${dist}px)` }], { duration: dur, easing: 'cubic-bezier(.12,.72,.18,1)', fill: 'forwards' });
        setTimeout(() => { slot.classList.remove('rolling'); slot.classList.add('landed'); card.classList.add('show'); if (i === data.picks.length - 1) { rollBtn.disabled = false; rollBtn.classList.remove('rolling-dice'); } }, dur);
      });
    });
  }
  roll(true);
}

// ---------------------------------------------------------------------------
// Live TV
// ---------------------------------------------------------------------------
export async function liveView() {
  const list = h('div.channels'), cats = h('div.live-cats'), side = h('div.live-side');
  const off = shell('live', h('div.live', side, list));
  let current = null;
  async function load(params, key, title) {
    current = key;
    list.replaceChildren(Array.from({ length: 9 }, () => h('div.skel', { style: { height: '72px' } })));
    let d; try { d = await api(`/api/iptv?${params}`); } catch (e) { return toast(e.message, 'bad'); }
    if (current !== key) return;
    mark();
    list.replaceChildren(h('h2.live-title', title, h('span.faint', ` ${d.channels.length}`)), d.channels.length ? d.channels.map((c) => {
      const star = h('button', { title: 'Favoriet', 'aria-label': 'Favoriet', style: { color: c.favorite ? '#fcd34d' : 'var(--faint)', fontSize: '18px' }, onclick: (e) => { e.stopPropagation(); act(star, async () => { const r = await api(`/api/iptv/fav/${c.id}`, { method: c.favorite ? 'DELETE' : 'PUT' }); c.favorite = r.favorite; star.style.color = c.favorite ? '#fcd34d' : 'var(--faint)'; }); } }, '★');
      return h('div.channel', { role: 'button', tabIndex: 0, onclick: () => playChannel(c), onkeydown: (e) => { if (e.key === 'Enter') playChannel(c); } },
        c.logo ? h('img', { src: c.logo, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(h('div.ph', c.name[0])) }) : h('div.ph', c.name[0]),
        h('div.grow', h('b', c.name), h('small.faint', c.category)), star);
    }) : h('p.muted', key === 'fav' ? 'Nog geen favorieten. Tik op de ster bij een zender.' : 'Geen zenders gevonden.'));
  }
  const mark = () => { for (const b of side.querySelectorAll('button[data-key]')) b.classList.toggle('on', b.dataset.key === current); };
  let d; try { d = await api('/api/iptv'); } catch (e) { toast(e.message, 'bad'); return off; }
  if (!d.enabled) {
    document.querySelector('main').replaceChildren(h('div.empty', h('h2', 'Live tv staat nog uit'), h('p', 'Voeg in Beheer een IPTV-abonnement (Xtream) of M3U-playlist toe.'), state.user.role === 'admin' && h('a.btn.primary', { href: '/beheer/live-tv' }, 'Live tv instellen')));
    return off;
  }
  // Country → category → channels. Without recognisable countries it stays a flat list.
  const groups = d.groups && d.groups.length ? d.groups : [{ code: '', name: 'Overig', count: 0, categories: d.categories.map((c) => ({ ...c, label: c.name })) }];
  const flat = groups.length === 1;
  const openCat = (g, c) => load(`category=${encodeURIComponent(c.name)}`, 'c:' + c.name, flat ? c.label : `${g.name} · ${c.label}`);
  function showCountries() {
    cats.replaceChildren(h('div.live-label', 'Landen'), groups.map((g) => h('button.country', { onclick: () => showCountry(g, true) }, g.code && h('span.cc', g.code), h('span.grow', g.name), h('span.faint', g.count), icon('right'))));
  }
  function showCountry(g, open) {
    try { localStorage.setItem('kinoko_live_country', g.code); } catch { /* private mode */ }
    cats.replaceChildren(!flat && h('button.back', { onclick: showCountries }, icon('left'), 'Alle landen'), h('div.live-label', flat ? 'Categorieën' : g.name),
      g.categories.map((c) => h('button', { 'data-key': 'c:' + c.name, onclick: () => openCat(g, c) }, h('span.grow', c.label), h('span.faint', c.count))));
    mark();
    if (open && g.categories[0]) openCat(g, g.categories[0]);
  }
  const search = h('input.input', { type: 'search', placeholder: 'Zender zoeken', oninput: () => { const q = search.value.trim(); if (q.length >= 2) load(`q=${encodeURIComponent(q)}`, 'q:' + q, `Zoeken: ${q}`); } });
  side.append(search, h('button.fav', { 'data-key': 'fav', onclick: () => load('fav=1', 'fav', 'Favorieten') }, h('span.grow', '★ Favorieten'), h('span.faint', d.favorites)), cats);
  let saved = null; try { saved = localStorage.getItem('kinoko_live_country'); } catch { /* private mode */ }
  const start = groups.find((g) => g.code === saved) || groups[0];
  showCountry(start, !d.favorites);
  if (d.favorites) load('fav=1', 'fav', 'Favorieten');
  return off;
}

export function inviteDialog(code) {
  const url = `${location.origin}/w/${code}`;
  openModal(h('div.stack', h('h2', 'Nodig iemand uit'), h('p.muted', 'Stuur deze link. Wie hem opent kijkt direct mee — pauzeren, spoelen en afspelen gaat voor iedereen tegelijk.'),
    h('div.codebox', h('span.grow', url), h('button.btn.sm', { onclick: () => copyText(url, 'Link gekopieerd') }, icon('copy'), 'Kopieer')),
    h('div.row', { style: { justifyContent: 'center', gap: '22px', marginTop: '6px' } }, window.qrcode ? (() => { const q = window.qrcode(0, 'M'); q.addData(url); q.make(); return h('div.qr', { html: q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }) }); })() : null,
      h('div', h('div.faint', { style: { fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.1em' } }, 'Code voor de app'), h('div', { style: { fontSize: '34px', fontWeight: 800, letterSpacing: '.12em' } }, code)))), { small: true });
}
