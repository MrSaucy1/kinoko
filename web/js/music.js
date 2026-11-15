// Music in the browser: a simple library view and a player bar that keeps
// playing while you move around. The full experience is the Kinoko Music app.
import { api, h, icon, state, go, toast, act, openModal, confirmDialog } from './core.js';
import { shell } from './views.js';

const fmt = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const long = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} u ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`);

// ---------------------------------------------------------------------------
// The player: one <audio>, a queue, a bar at the bottom of the page
// ---------------------------------------------------------------------------
const P = { queue: [], index: -1, audio: null, bar: null, listened: 0, lastTick: 0, saveTimer: null };
const canOgg = () => document.createElement('audio').canPlayType('audio/ogg; codecs="opus"') !== '';
const quality = () => localStorage.getItem('kinoko_music_q') || 'original';

function report() {
  const t = P.queue[P.index];
  if (t && P.listened >= 5) api('/api/music/plays', { method: 'POST', body: { trackId: t.id, seconds: Math.round(P.listened) } }).catch(() => {});
  P.listened = 0;
}
function saveQueue() {
  clearTimeout(P.saveTimer);
  P.saveTimer = setTimeout(() => api('/api/music/queue', { method: 'PUT', body: { trackIds: P.queue.map((t) => t.id), index: Math.max(0, P.index), position: P.audio ? P.audio.currentTime : 0 } }).catch(() => {}), 1500);
}

function ensureBar() {
  if (P.bar) return;
  const a = P.audio = new Audio(); a.preload = 'auto';
  const cover = h('img', { alt: '' }), title = h('b'), artist = h('small');
  const playBtn = h('button.icon-btn', { 'aria-label': 'Afspelen of pauzeren', onclick: () => (a.paused ? a.play().catch(() => {}) : a.pause()) }, icon('play'));
  const fill = h('i'), time = h('small.mp-time', '0:00');
  const rail = h('div.mp-rail', { onclick: (e) => { const r = rail.getBoundingClientRect(); if (a.duration) a.currentTime = ((e.clientX - r.left) / r.width) * a.duration; } }, fill);
  const like = h('button.icon-btn', { 'aria-label': 'Vind ik leuk', onclick: () => { const t = P.queue[P.index]; if (!t) return; t.liked = !t.liked; draw(); api(`/api/music/likes/${t.id}`, { method: t.liked ? 'PUT' : 'DELETE' }).catch(() => { t.liked = !t.liked; draw(); }); } }, icon('heart'));
  P.bar = h('div.mp', h('div.mp-now', cover, h('div.grow', title, artist)),
    h('div.mp-mid', h('div.row', { style: { justifyContent: 'center', gap: '6px' } }, h('button.icon-btn', { 'aria-label': 'Vorige', onclick: () => step(-1) }, icon('back10')), playBtn, h('button.icon-btn', { 'aria-label': 'Volgende', onclick: () => step(1) }, icon('next'))), h('div.row', rail, time)),
    h('div.mp-side', like, h('button.icon-btn', { 'aria-label': 'Wachtrij', title: 'Wachtrij', onclick: queueDialog }, icon('layers')), h('button.icon-btn', { 'aria-label': 'Speler sluiten', onclick: stop }, icon('x'))));
  document.body.append(P.bar); document.body.classList.add('has-mp');
  function draw() {
    const t = P.queue[P.index]; if (!t) return;
    title.textContent = t.title; artist.textContent = `${t.artist} · ${t.album}`;
    if (t.cover) { cover.src = t.cover; cover.style.visibility = ''; } else cover.style.visibility = 'hidden';
    like.classList.toggle('on', !!t.liked);
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: t.cover ? [{ src: t.cover }] : [] });
  }
  P.draw = draw;
  a.addEventListener('play', () => { playBtn.replaceChildren(icon('pause')); P.lastTick = Date.now(); reportState(); });
  a.addEventListener('pause', () => { playBtn.replaceChildren(icon('play')); reportState(); });
  a.addEventListener('timeupdate', () => {
    const n = Date.now(); if (!a.paused && n - P.lastTick < 2000) P.listened += (n - P.lastTick) / 1000; P.lastTick = n;
    fill.style.width = a.duration ? `${(a.currentTime / a.duration) * 100}%` : '0'; time.textContent = `${fmt(a.currentTime)} / ${fmt(a.duration || (P.queue[P.index] || {}).duration)}`;
  });
  a.addEventListener('ended', () => step(1, true));
  a.addEventListener('error', () => { if (a.src) toast('Dit nummer kan nu niet worden afgespeeld.', 'bad'); });
  if ('mediaSession' in navigator) { navigator.mediaSession.setActionHandler('nexttrack', () => step(1)); navigator.mediaSession.setActionHandler('previoustrack', () => step(-1)); }
  window.addEventListener('pagehide', report);
}
function stop() { report(); if (P.audio) { P.audio.pause(); P.audio.removeAttribute('src'); } if (P.bar) { P.bar.remove(); P.bar = null; } document.body.classList.remove('has-mp'); P.queue = []; P.index = -1; }

async function start(index, position = 0, autoplay = true) {
  report();
  P.index = index;
  const t = P.queue[index]; if (!t) return;
  ensureBar(); P.draw();
  try {
    const r = await api(`/api/music/tracks/${t.id}/play`, { method: 'POST', body: { quality: quality(), format: canOgg() ? 'opus' : 'aac' } });
    if (P.queue[P.index] !== t) return;   // the user moved on while this was loading
    P.audio.src = r.url;
    if (position > 1) P.audio.addEventListener('loadedmetadata', () => { P.audio.currentTime = position; }, { once: true });
    if (autoplay) await P.audio.play().catch(() => {});
  } catch (e) { toast(e.message, 'bad'); }
  saveQueue();
  document.dispatchEvent(new Event('kinoko:track'));
}
function step(d, ended = false) {
  if (d < 0 && P.audio && P.audio.currentTime > 4) { P.audio.currentTime = 0; return; }
  const n = P.index + d;
  if (n < 0) return;
  if (n >= P.queue.length) { if (ended) { report(); P.audio.pause(); } return; }
  start(n);
}
// Kinoko Connect: this browser is a player the user's other devices can see and control.
function reportState() {
  const t = P.queue[P.index];
  window.dispatchEvent(new CustomEvent('kinoko:send', { detail: { t: 'player', state: { trackId: t ? t.id : null, title: t ? t.title : '', artist: t ? t.artist : '', cover: t ? t.cover : null, playing: !!(P.audio && !P.audio.paused), position: P.audio ? P.audio.currentTime : 0, duration: t ? t.duration : 0 } } }));
}
document.addEventListener('kinoko:track', reportState);
setInterval(() => { if (P.audio && !P.audio.paused) reportState(); }, 10_000);
window.addEventListener('kinoko:event', (e) => {
  const m = e.detail;
  if (!m || m.t !== 'control') return;
  if (m.cmd === 'load' && Array.isArray(m.items) && m.items.length) { P.queue = m.items; start(Math.min(m.index || 0, m.items.length - 1), m.position || 0, m.play !== false); return; }
  if (!P.audio) return;
  if (m.cmd === 'play') P.audio.play().catch(() => {}); else if (m.cmd === 'pause') P.audio.pause(); else if (m.cmd === 'next') step(1); else if (m.cmd === 'previous') step(-1);
  else if (m.cmd === 'seek') P.audio.currentTime = m.position || 0; else if (m.cmd === 'volume') P.audio.volume = Math.max(0, Math.min(1, m.volume));
  setTimeout(reportState, 300);
});

/** Replaces the queue with these tracks and starts at `index`. */
export function playTracks(tracks, index = 0) { if (!tracks.length) return; P.queue = tracks.slice(); start(index); }
export function playNext(track) { if (P.index < 0) return playTracks([track]); P.queue.splice(P.index + 1, 0, track); saveQueue(); toast('Speelt hierna'); }
export function addToQueue(track) { if (P.index < 0) return playTracks([track]); P.queue.push(track); saveQueue(); toast('Toegevoegd aan de wachtrij'); }

function queueDialog() {
  const list = h('div.stack', { style: { gap: '4px' } });
  const draw = () => list.replaceChildren(...P.queue.map((t, i) => h(`div.trk${i === P.index ? '.on' : ''}`, { onclick: () => { start(i); draw(); } }, h('span.trk-n', String(i + 1)), h('div.grow', h('b', t.title), h('small', t.artist)), h('small', fmt(t.duration)),
    i !== P.index && h('button.icon-btn', { 'aria-label': 'Uit de wachtrij', onclick: (e) => { e.stopPropagation(); P.queue.splice(i, 1); if (i < P.index) P.index--; saveQueue(); draw(); } }, icon('x')))));
  draw();
  openModal(h('div.stack', h('h2', 'Wachtrij'), list), { small: true });
}

// ---------------------------------------------------------------------------
// Lists of things
// ---------------------------------------------------------------------------
function trackRow(t, all, i, { number = false, onRemove = null } = {}) {
  const menu = (e) => {
    e.stopPropagation();
    const m = openModal(h('div.stack', { style: { gap: '6px' } }, h('h2', t.title), h('p.muted', `${t.artist} · ${t.album}`),
      h('button.btn', { onclick: () => { playNext(t); m.close(); } }, 'Speel hierna'), h('button.btn', { onclick: () => { addToQueue(t); m.close(); } }, 'Aan wachtrij toevoegen'),
      h('button.btn', { onclick: () => { m.close(); addToPlaylist(t); } }, 'Aan playlist toevoegen'), h('button.btn', { onclick: () => { m.close(); go(`/muziek/album/${t.albumId}`); } }, 'Naar album'),
      h('button.btn', { onclick: () => { m.close(); go(`/muziek/artiest/${t.artistId}`); } }, 'Naar artiest'), onRemove && h('button.btn.danger', { onclick: () => { m.close(); onRemove(); } }, 'Uit deze playlist halen')), { small: true });
  };
  const heart = h(`button.icon-btn.trk-like${t.liked ? '.on' : ''}`, { 'aria-label': 'Vind ik leuk', onclick: (e) => { e.stopPropagation(); t.liked = !t.liked; heart.classList.toggle('on', t.liked); api(`/api/music/likes/${t.id}`, { method: t.liked ? 'PUT' : 'DELETE' }).catch(() => { t.liked = !t.liked; heart.classList.toggle('on', t.liked); }); } }, icon('heart'));
  return h('div.trk', { onclick: () => playTracks(all, i), 'data-id': t.id }, number ? h('span.trk-n', String(t.trackNo || i + 1)) : (t.cover ? h('img', { src: t.cover, alt: '', loading: 'lazy' }) : h('span.trk-n', '♪')),
    h('div.grow', h('b', t.title, t.explicit && h('span.badge', { style: { marginLeft: '8px' } }, 'E')), h('small', number ? t.artist : `${t.artist} · ${t.album}`)), heart, h('small', fmt(t.duration)), h('button.icon-btn', { 'aria-label': 'Meer', onclick: menu }, icon('gear')));
}
const albumCard = (a) => h('a.mcard', { href: `/muziek/album/${a.id}` }, h('div.mart', a.cover ? h('img', { src: a.cover, alt: '', loading: 'lazy' }) : h('span', '♪')), h('b', a.title), h('small', [a.artist, a.year].filter(Boolean).join(' · ')));
const artistCard = (a) => h('a.mcard.round', { href: `/muziek/artiest/${a.id}` }, h('div.mart', a.image ? h('img', { src: a.image, alt: '', loading: 'lazy' }) : h('span', a.name[0])), h('b', a.name), h('small', `${a.albums} ${a.albums === 1 ? 'album' : 'albums'}`));
const playlistCard = (p) => h('a.mcard', { href: `/muziek/playlist/${p.id}` }, h('div.mart.quad', p.covers.length ? p.covers.map((c) => h('img', { src: c, alt: '', loading: 'lazy' })) : h('span', '♫')), h('b', p.name), h('small', `${p.count} nummers${p.mine ? '' : ` · van ${p.owner}`}`));

async function addToPlaylist(t) {
  const box = h('div.stack', { style: { gap: '6px' } }), name = h('input.input', { placeholder: 'Nieuwe playlist…', maxLength: 80 });
  const m = openModal(h('div.stack', h('h2', 'Aan playlist toevoegen'), box, h('form.row', { onsubmit: (e) => { e.preventDefault(); act(e.submitter, async () => { const r = await api('/api/music/playlists', { method: 'POST', body: { name: name.value } }); await api(`/api/music/playlists/${r.id}/items`, { method: 'POST', body: { trackIds: [t.id] } }); toast('Playlist gemaakt'); m.close(); }); } }, name, h('button.btn.primary', 'Maken'))), { small: true });
  const d = await api(`/api/music/playlists?track=${t.id}`);
  const mine = d.items.filter((p) => p.canEdit);
  box.replaceChildren(...(mine.length ? mine.map((p) => h('button.btn', { style: { justifyContent: 'flex-start' }, onclick: () => act(null, async () => { await api(`/api/music/playlists/${p.id}/items`, { method: 'POST', body: { trackIds: [t.id] } }); toast(`Toegevoegd aan ${p.name}`); m.close(); }) }, p.name, p.has && h('small.faint', { style: { marginLeft: '8px' } }, 'staat er al in'))) : [h('p.muted', 'Je hebt nog geen playlists.')]));
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const TABS = [['', 'Home'], ['albums', 'Albums'], ['artiesten', 'Artiesten'], ['playlists', 'Playlists'], ['nummers', 'Nummers'], ['leuk', 'Leuk gevonden']];
function frame(active, ...content) {
  let timer;
  const q = h('input.input', { type: 'search', placeholder: 'Zoek artiest, album of nummer', style: { maxWidth: '320px' }, value: active === 'zoeken' ? new URLSearchParams(location.search).get('q') || '' : '',
    oninput: () => { clearTimeout(timer); timer = setTimeout(() => { const v = q.value.trim(); if (v.length >= 2) go(`/muziek/zoeken?q=${encodeURIComponent(v)}`, { replace: active === 'zoeken' }); }, 320); } });
  const qsel = h('select.input', { title: 'Kwaliteit', 'aria-label': 'Kwaliteit', style: { width: 'auto' }, onchange: () => localStorage.setItem('kinoko_music_q', qsel.value) },
    [['original', 'Origineel'], ['320', '320 kbps'], ['160', '160 kbps'], ['96', '96 kbps']].map(([v, l]) => h('option', { value: v, selected: v === quality() }, l)));
  if (active === 'zoeken') setTimeout(() => { q.focus(); q.setSelectionRange(q.value.length, q.value.length); });
  return shell('music', h('div.page.music', h('div.row.wrap', { style: { marginBottom: '18px' } }, h('nav.mtabs', TABS.map(([id, label]) => h(`a${id === active ? '.on' : ''}`, { href: `/muziek${id ? `/${id}` : ''}` }, label))), h('span.spacer'), q, qsel), ...content));
}
/** A list that loads the next page when you scroll near its end. */
function paged(box, load, render) {
  let offset = 0, busy = false, done = false;
  const more = async () => {
    if (busy || done || !box.isConnected) return; busy = true;
    try { const d = await load(offset); box.append(...d.items.map(render)); offset += d.items.length; done = !d.items.length || offset >= d.total; if (!offset) box.append(h('p.muted', 'Nog niets te zien.')); } catch (e) { toast(e.message, 'bad'); done = true; }
    busy = false; if (!done && box.getBoundingClientRect().bottom < innerHeight + 600) more();
  };
  const onScroll = () => { if (box.getBoundingClientRect().bottom < innerHeight + 600) more(); };
  window.addEventListener('scroll', onScroll, { passive: true });
  setTimeout(more);
  return () => window.removeEventListener('scroll', onScroll);
}

export async function musicView({ section = '', id = null } = {}, query = new URLSearchParams()) {
  const body = h('div');
  const off = frame(section, body);
  let stopPaging = null;
  const wrap = () => () => { if (stopPaging) stopPaging(); off(); };
  try {
    if (section === '') {
      const d = await api('/api/music/home');
      if (d.empty) body.append(h('div.empty', h('h2', 'Nog geen muziek'), h('p', state.user.role === 'admin' ? 'Voeg in het beheer een muziekbibliotheek toe.' : 'De beheerder heeft nog geen muziek toegevoegd.'), state.user.role === 'admin' && h('a.btn.primary', { href: '/beheer/bibliotheken' }, 'Naar bibliotheken')));
      for (const r of d.rows) body.append(h('div.msec', h('h2', r.title), r.kind === 'tracks' ? h('div.trks', r.items.slice(0, 8).map((t, i) => trackRow(t, r.items, i))) : h('div.mgrid', r.items.map(r.kind === 'albums' ? albumCard : r.kind === 'playlists' ? playlistCard : artistCard))));
    } else if (section === 'albums') {
      const grid = h('div.mgrid'); body.append(grid);
      stopPaging = paged(grid, (o) => api(`/api/music/albums?sort=artist&limit=60&offset=${o}`), albumCard);
    } else if (section === 'artiesten') {
      const grid = h('div.mgrid'); body.append(grid);
      stopPaging = paged(grid, (o) => api(`/api/music/artists?limit=60&offset=${o}`), artistCard);
    } else if (section === 'nummers' || section === 'leuk') {
      const list = h('div.trks'), all = []; body.append(list);
      stopPaging = paged(list, async (o) => { const d = await api(`${section === 'leuk' ? '/api/music/likes' : '/api/music/tracks'}?limit=100&offset=${o}`); all.push(...d.items); return d; }, (t) => trackRow(t, all, all.indexOf(t)));
    } else if (section === 'playlists') {
      const d = await api('/api/music/playlists');
      body.append(h('div.row', { style: { marginBottom: '16px' } }, h('button.btn.primary', { onclick: () => { const n = prompt('Naam van de playlist'); if (n && n.trim()) act(null, async () => { const r = await api('/api/music/playlists', { method: 'POST', body: { name: n } }); go(`/muziek/playlist/${r.id}`); }); } }, icon('plus'), 'Nieuwe playlist')),
        d.items.length ? h('div.mgrid', d.items.map(playlistCard)) : h('p.muted', 'Nog geen playlists.'));
    } else if (section === 'zoeken') {
      const d = await api(`/api/music/search?q=${encodeURIComponent(query.get('q') || '')}`);
      if (!d.artists.length && !d.albums.length && !d.tracks.length && !d.playlists.length) body.append(h('p.muted', 'Niets gevonden.'));
      if (d.artists.length) body.append(h('div.msec', h('h2', 'Artiesten'), h('div.mgrid', d.artists.map(artistCard))));
      if (d.albums.length) body.append(h('div.msec', h('h2', 'Albums'), h('div.mgrid', d.albums.map(albumCard))));
      if (d.tracks.length) body.append(h('div.msec', h('h2', 'Nummers'), h('div.trks', d.tracks.map((t, i) => trackRow(t, d.tracks, i)))));
      if (d.playlists.length) body.append(h('div.msec', h('h2', 'Playlists'), h('div.mgrid', d.playlists.map(playlistCard))));
    } else if (section === 'album') {
      const a = await api(`/api/music/albums/${id}`);
      body.append(h('div.mhead', h('div.mart', a.cover ? h('img', { src: a.cover, alt: '' }) : h('span', '♪')), h('div', h('small', 'Album'), h('h1', a.title), h('p', h('a', { href: `/muziek/artiest/${a.artistId}` }, a.artist), [a.year, `${a.items.length} nummers`, long(a.duration)].filter(Boolean).map((x) => ` · ${x}`).join('')),
        h('div.row', h('button.btn.primary.lg', { onclick: () => playTracks(a.items) }, icon('play'), 'Afspelen'), h('button.btn', { onclick: () => playTracks([...a.items].sort(() => Math.random() - 0.5)) }, 'Shuffle')))), h('div.trks', a.items.map((t, i) => trackRow(t, a.items, i, { number: true }))));
    } else if (section === 'artiest') {
      const a = await api(`/api/music/artists/${id}`);
      body.append(h('div.mhead', h('div.mart.round', a.image ? h('img', { src: a.image, alt: '' }) : h('span', a.name[0])), h('div', h('small', 'Artiest'), h('h1', a.name), a.bio && h('p.muted', a.bio), h('div.row', h('button.btn.primary.lg', { onclick: () => playTracks(a.topTracks) }, icon('play'), 'Afspelen')))),
        a.topTracks.length ? h('div.msec', h('h2', 'Populair'), h('div.trks', a.topTracks.map((t, i) => trackRow(t, a.topTracks, i)))) : null, h('div.msec', h('h2', 'Albums'), h('div.mgrid', a.albums.map(albumCard))));
    } else if (section === 'playlist') {
      const draw = async () => {
        const p = await api(`/api/music/playlists/${id}`);
        body.replaceChildren(h('div.mhead', h('div.mart.quad', p.covers.length ? p.covers.map((c) => h('img', { src: c, alt: '' })) : h('span', '♫')), h('div', h('small', p.mine ? 'Playlist' : `Playlist van ${p.owner}`), h('h1', p.name), h('p.muted', `${p.count} nummers · ${long(p.duration)}`),
          h('div.row.wrap', h('button.btn.primary.lg', { onclick: () => playTracks(p.items) }, icon('play'), 'Afspelen'),
            p.mine && h('button.btn', { onclick: async () => { const dir = (await api('/api/users/directory')).users; const cur = new Map(p.shares.map((s) => [s.id, s.edit])); const rows = dir.map((u) => ({ u, on: h('input', { type: 'checkbox', checked: cur.has(u.id) }), edit: h('input', { type: 'checkbox', checked: cur.get(u.id) === true }) }));
              const m = openModal(h('form.stack', { onsubmit: (e) => { e.preventDefault(); act(e.submitter, async () => { await api(`/api/music/playlists/${id}/shares`, { method: 'PUT', body: { users: rows.filter((r) => r.on.checked).map((r) => ({ id: r.u.id, edit: r.edit.checked })) } }); toast('Opgeslagen'); m.close(); draw(); }); } }, h('h2', 'Playlist delen'), rows.length ? rows.map((r) => h('div.device', h('label.row.grow', r.on, h('b', r.u.name)), h('label.row', r.edit, h('span.faint', 'mag bewerken')))) : h('p.muted', 'Er zijn geen andere gebruikers.'), h('button.btn.primary', 'Opslaan')), { small: true }); } }, p.shares.length ? `Gedeeld met ${p.shares.length}` : 'Delen'),
            p.mine && h('button.btn', { onclick: () => { const n = prompt('Nieuwe naam', p.name); if (n && n.trim()) act(null, async () => { await api(`/api/music/playlists/${id}`, { method: 'PUT', body: { name: n } }); draw(); }); } }, 'Hernoemen'),
            h('button.btn.danger', { onclick: async () => { if (await confirmDialog(p.mine ? 'Playlist verwijderen?' : 'Playlist verlaten?', p.mine ? `"${p.name}" verdwijnt voor iedereen.` : 'De playlist verdwijnt uit jouw overzicht.', p.mine ? 'Verwijderen' : 'Verlaten')) { await api(`/api/music/playlists/${id}`, { method: 'DELETE' }); go('/muziek/playlists'); } } }, p.mine ? 'Verwijderen' : 'Verlaten')))),
          h('div.trks', p.items.map((t, i) => { const row = trackRow(t, p.items, i, { onRemove: p.canEdit ? () => act(null, async () => { await api(`/api/music/playlists/${id}/items/${t.itemId}`, { method: 'DELETE' }); draw(); }) : null });
            if (p.canEdit) { row.draggable = true; row.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', String(i))); row.addEventListener('dragover', (e) => e.preventDefault());
              row.addEventListener('drop', (e) => { e.preventDefault(); const from = Number(e.dataTransfer.getData('text/plain')); if (from === i || Number.isNaN(from)) return; const ids = p.items.map((x) => x.itemId); ids.splice(i, 0, ids.splice(from, 1)[0]); act(null, async () => { await api(`/api/music/playlists/${id}/order`, { method: 'PUT', body: { itemIds: ids } }); draw(); }); }); }
            return row; })), p.canEdit && p.items.length > 1 ? h('p.faint', { style: { marginTop: '10px', fontSize: '13px' } }, 'Sleep een nummer om de volgorde te veranderen.') : null);
      };
      await draw();
    }
  } catch (e) { body.replaceChildren(h('div.empty', h('h2', 'Niet gevonden'), h('p', e.message), h('a.btn', { href: '/muziek' }, 'Naar muziek'))); }
  return wrap();
}

/** Brings back the queue from last time, paused, so the bar is there when music was playing before. */
export async function restoreQueue() {
  if (P.index >= 0) return;
  try { const q = await api('/api/music/queue'); if (q.items.length && P.index < 0) { P.queue = q.items; await start(q.index, q.position, false); } } catch { /* no music, or not signed in */ }
}
