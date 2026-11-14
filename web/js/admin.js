// Admin GUI + first-run onboarding. The panels are shared between the two.
import { api, h, icon, state, go, setView, openModal, toast, act, copyText, confirmDialog, fmtDate, fmtSize, setToken, qrSvg } from './core.js';
import { shell } from './views.js';

// ---------------------------------------------------------------------------
// Shared panels
// ---------------------------------------------------------------------------
function folderPicker(onPick) {
  const list = h('div.folder-list'), where = h('div.codebox');
  let current = '/';
  async function open(path) {
    try {
      const d = await api(`/api/admin/browse?path=${encodeURIComponent(path)}`);
      current = d.path; where.textContent = d.path;
      list.replaceChildren(d.parent !== null && h('button', { type: 'button', onclick: () => open(d.parent) }, icon('back'), '..'),
        d.dirs.map((n) => h('button', { type: 'button', onclick: () => open(d.path === '/' ? `/${n}` : `${d.path}/${n}`) }, icon('folder'), n)),
        !d.dirs.length && h('p.muted', { style: { padding: '12px 14px' } }, 'Geen submappen.'));
    } catch (e) { toast(e.message, 'bad'); }
  }
  const m = openModal(h('div.stack', h('h2', 'Kies een map'), h('p.muted', 'Blader naar de map waar je films of series staan (bijvoorbeeld een gekoppelde NAS-share onder /mnt).'), where, list,
    h('div.row', h('span.spacer'), h('button.btn.primary', { onclick: () => { onPick(current); m.close(); } }, 'Deze map kiezen'))), { small: true });
  open('/mnt').catch(() => open('/'));
}

function libraryForm(onDone) {
  let type = 'movies'; const paths = [];
  const name = h('input.input', { placeholder: 'Films', required: true });
  const pathBox = h('div.stack', { style: { gap: '8px' } });
  const types = h('div.row');
  const drawTypes = () => types.replaceChildren(['movies', 'shows'].map((t) => h(`button.option${t === type ? '.on' : ''}`, { type: 'button', style: { flex: 1 }, onclick: () => { type = t; if (!name.value || ['Films', 'Series'].includes(name.value)) name.value = t === 'movies' ? 'Films' : 'Series'; drawTypes(); } },
    h('div.ico', icon(t === 'movies' ? 'film' : 'tv')), h('div', h('b', t === 'movies' ? 'Films' : 'Series'), h('span', t === 'movies' ? 'Eén bestand per film' : 'Mappen met seizoenen')))));
  const drawPaths = () => pathBox.replaceChildren(paths.map((p, i) => h('div.codebox', h('span.grow', p), h('button', { type: 'button', 'aria-label': 'Verwijder map', onclick: () => { paths.splice(i, 1); drawPaths(); } }, icon('x')))),
    h('button.btn', { type: 'button', onclick: () => folderPicker((p) => { if (!paths.includes(p)) paths.push(p); drawPaths(); }) }, icon('folder'), paths.length ? 'Nog een map' : 'Map kiezen'));
  const shared = h('input', { type: 'checkbox', checked: true });
  name.value = 'Films'; drawTypes(); drawPaths();
  const m = openModal(h('form.stack', { onsubmit: (e) => { e.preventDefault(); act(e.submitter, async () => {
    await api('/api/admin/libraries', { method: 'POST', body: { name: name.value, type, paths, shared: shared.checked } });
    toast('Bibliotheek toegevoegd — scannen is gestart'); m.close(); onDone();
  }); } }, h('h2', 'Bibliotheek toevoegen'), types, h('label.field', h('span', 'Naam'), name), h('div.field', h('span', 'Mappen'), pathBox),
    h('label.row', h('span.switch', shared, h('i')), h('span', 'Delen met gekoppelde servers')), h('button.btn.primary', 'Toevoegen en scannen')), { small: true });
}

function librariesPanel() {
  const box = h('div.stack'); let timer;
  async function draw() {
    let d; try { d = await api('/api/admin/libraries'); } catch { return; }
    const scan = d.scan;
    box.replaceChildren(
      d.libraries.length ? h('div.list', d.libraries.map((l) => h('div.list-item', h('div.option', { style: { width: 'auto', padding: '8px', border: 0, background: 'none', cursor: 'default' } }, h('div.ico', icon(l.type === 'movies' ? 'film' : 'tv'))),
        h('div.grow', h('b', l.name), h('small', l.paths.join(' · ')), h('small', `${l.titles} titels · ${l.files} bestanden${l.shared ? ' · gedeeld met koppelingen' : ''}`)),
        h('button.btn.sm.danger', { onclick: async () => { if (await confirmDialog('Bibliotheek verwijderen?', `"${l.name}" verdwijnt uit Kinoko. Je bestanden op schijf blijven staan.`, 'Verwijderen')) { await api(`/api/admin/libraries/${l.id}`, { method: 'DELETE' }); draw(); } } }, icon('trash')))))
        : h('p.muted', 'Nog geen bibliotheken. Voeg een map met films of series toe.'),
      scan.running && h('div.note', h('b', scan.phase === 'scan' ? `Scannen: ${scan.library}` : `Bezig met ${scan.phase}…`), scan.total > 0 && scan.phase === 'scan' && h('div.progress', { style: { marginTop: '10px' } }, h('i', { style: { width: `${(scan.done / scan.total) * 100}%` } }))),
      scan.error && h('div.note.warn', scan.error),
      h('div.row', h('button.btn.primary', { onclick: () => libraryForm(draw) }, icon('plus'), 'Bibliotheek toevoegen'),
        d.libraries.length ? h('button.btn', { disabled: scan.running, onclick: () => act(null, async () => { await api('/api/admin/scan', { method: 'POST' }); toast('Scan gestart'); draw(); }) }, icon('refresh'), 'Nu scannen') : null));
    clearTimeout(timer);
    if (scan.running && box.isConnected) timer = setTimeout(draw, 1500);
  }
  draw();
  return box;
}

function metadataPanel(compact = false) {
  const box = h('div.stack');
  async function draw() {
    let d; try { d = await api('/api/admin/metadata'); } catch { return; }
    const key = h('input.input', { placeholder: 'TMDB API-sleutel (optioneel)', value: d.tmdbKey });
    const lang = h('select.input', ['nl-NL', 'en-US', 'de-DE', 'fr-FR', 'es-ES', 'tr-TR'].map((l) => h('option', { value: l, selected: l === d.lang }, l)));
    box.replaceChildren(
      h('div.note', h('b', 'Werkt direct, zonder sleutel. '), 'Kinoko leest eerst lokale .nfo-bestanden en posters. Wat ontbreekt komt uit open bronnen (Cinemeta en Wikidata): poster, beschrijving, cast, genres, beoordeling en filmreeksen voor de slimme collecties.'),
      h('label.field', h('span', 'TMDB-sleutel — optioneel, voor Nederlandse teksten en foto\'s van acteurs'), key, h('small', 'Gratis aan te maken op themoviedb.org → Instellingen → API.')),
      h('label.field', h('span', 'Taal van metadata (alleen met TMDB)'), lang),
      h('div.row', h('button.btn.primary', { onclick: (e) => act(e.currentTarget, async () => { await api('/api/admin/metadata', { method: 'PUT', body: { tmdbKey: key.value, lang: lang.value } }); toast('Opgeslagen'); draw(); }) }, 'Opslaan'),
        !compact && h('button.btn', { onclick: () => act(null, async () => { await api('/api/admin/metadata/refresh', { method: 'POST', body: { all: true } }); toast('Alle metadata wordt opnieuw opgehaald'); }) }, icon('refresh'), 'Alles opnieuw ophalen')),
      !compact && d.unmatched.length ? h('div.section', h('h2', 'Niet herkend', h('span.badge.warn', d.unmatched.length)), h('p.muted', { style: { marginBottom: '10px' } }, 'Plak de IMDb-link van de juiste titel om hem handmatig te koppelen.'),
        h('div.list', d.unmatched.map((t) => { const inp = h('input.input', { placeholder: 'https://www.imdb.com/title/tt…', style: { maxWidth: '300px', height: '38px' } });
          return h('div.list-item', h('div.grow', h('b', t.title), h('small', `${t.kind === 'movie' ? 'Film' : 'Serie'}${t.year ? ' · ' + t.year : ''}`)), inp,
            h('button.btn.sm', { onclick: (e) => act(e.currentTarget, async () => { await api(`/api/admin/titles/${t.id}/match`, { method: 'POST', body: { imdb: inp.value } }); toast('Gekoppeld'); draw(); }) }, 'Koppel')); }))) : null);
  }
  draw();
  return box;
}

function transcodePanel() {
  const box = h('div.stack');
  async function draw(redetect) {
    if (redetect) await api('/api/admin/transcoding', { method: 'PUT', body: { redetect: true } });
    let d; try { d = await api('/api/admin/transcoding'); } catch { return; }
    const hw = d.hardware;
    const options = [['auto', 'Automatisch', 'Kinoko kiest de beste beschikbare'], ...Object.entries(hw.backends || {}).map(([id, b]) => [id, b.label, b.available ? 'Beschikbaar op deze server' : 'Niet gevonden', !b.available]), ['none', 'Alleen software (CPU)', 'Werkt altijd, maar zwaarder']];
    box.replaceChildren(
      !hw.ffmpeg ? h('div.note.warn', 'ffmpeg is niet gevonden. Installeer ffmpeg op de server; zonder kan Kinoko niet scannen of omzetten.')
        : h('div.note', h('b', `Actief: ${d.active === 'none' ? 'software (CPU)' : hw.backends[d.active].label}. `), d.active === 'none' ? 'Geen videokaart gevonden. Geef de container toegang tot /dev/dri (Intel/AMD) of de NVIDIA-driver om hardware-versnelling te gebruiken.' : 'Omzetten naar een lagere kwaliteit gebeurt op de videokaart. Lukt dat bij een bestand niet, dan valt Kinoko vanzelf terug op software.'),
      h('div.stack', { style: { gap: '8px' } }, options.map(([id, label, text, disabled]) => h(`button.option${d.choice === id ? '.on' : ''}`, { disabled, style: disabled ? { opacity: 0.5 } : {}, onclick: () => act(null, async () => { await api('/api/admin/transcoding', { method: 'PUT', body: { choice: id } }); draw(); }) },
        h('div.ico', icon(id === 'auto' ? 'spark' : id === 'none' ? 'cpu' : 'bolt')), h('div.grow', h('b', label), h('span', text)), hw.backends?.[id]?.available && h('span.badge.ok', 'gevonden')))),
      h('div.row', h('button.btn', { onclick: (e) => act(e.currentTarget, () => draw(true)) }, icon('refresh'), 'Opnieuw detecteren')),
      d.sessions.length ? h('div.section', h('h2', 'Actieve sessies'), h('div.list', d.sessions.map((s) => h('div.list-item', h('div.grow', h('b', s.file), h('small', `${s.height}p · ${s.pipeline || 'wacht'}`)), h(`span.badge${s.running ? '.ok' : ''}`, s.running ? (s.paused ? 'gepauzeerd' : 'bezig') : 'klaar'))))) : null);
  }
  draw();
  return box;
}

function remotePanel(compact = false) {
  const box = h('div.stack');
  async function draw() {
    let d; try { d = await api('/api/admin/remote'); } catch { return; }
    const save = (body) => api('/api/admin/remote', { method: 'PUT', body });
    const modes = [['lan', 'home', 'Alleen thuis', 'Bereikbaar binnen je eigen netwerk'], ['tailscale', 'lock', 'Tailscale', 'Privé-VPN: veilig, zonder poorten open te zetten'], ['cloudflare', 'cloud', 'Cloudflare Tunnel', 'Eigen domein via Cloudflare, zonder port-forwarding'], ['custom', 'globe', 'Eigen domein / reverse proxy', 'Nginx, Caddy, Traefik of DDNS + port-forward']];
    const detail = h('div.stack');
    const urlInput = h('input.input', { placeholder: 'https://kinoko.jouwdomein.nl', value: d.publicUrl });
    const urlRow = (hint) => h('div.stack', { style: { gap: '8px' } }, h('label.field', h('span', 'Publiek adres van deze server'), urlInput, h('small', hint)),
      h('div.row', h('button.btn.primary', { onclick: (e) => act(e.currentTarget, async () => { await save({ publicUrl: urlInput.value, mode: d.mode }); toast('Adres opgeslagen'); draw(); }) }, 'Opslaan'),
        h('button.btn', { onclick: (e) => act(e.currentTarget, async () => { const r = await api('/api/admin/remote/test', { method: 'POST', body: { url: urlInput.value } }); toast(r.ok ? 'Bereikbaar ✓' : r.reason, r.ok ? '' : 'bad'); }) }, 'Test')));
    const helperNote = !d.helper && h('div.note.warn', 'De beheerhulp is op deze installatie niet aanwezig; knoppen hieronder werken alleen bij een installatie via het Kinoko-installscript. Je kunt de stappen ook handmatig op de server uitvoeren.');
    if (d.mode === 'lan') detail.append(h('div.note', 'Thuis bereik je Kinoko op: ', d.lan.map((u) => h('div.mono', u))), h('p.muted', 'Wil je ook onderweg kijken of bibliotheken delen met vrienden? Kies dan een van de andere opties.'));
    if (d.mode === 'tailscale') {
      const ts = d.tailscale; const run = (action) => (e) => act(e.currentTarget, async () => { const r = await api('/api/admin/remote/tailscale', { method: 'POST', body: { action } }); if (r.output) openModal(h('div.stack', h('h2', 'Tailscale aanmelden'), h('p.muted', 'Open deze link en log in om de server aan je tailnet toe te voegen:'), h('div.codebox', r.output)), { small: true }); draw(); });
      detail.append(helperNote, h('div.steps-list',
        h('div', h('b', 'Installeren '), ts.installed ? h('span.badge.ok', 'geïnstalleerd') : h('button.btn.sm', { onclick: run('install') }, 'Installeer Tailscale')),
        h('div', h('b', 'Aanmelden '), ts.running ? h('span.badge.ok', ts.dnsName || 'verbonden') : h('button.btn.sm', { disabled: !ts.installed, onclick: run('up') }, 'Aanmelden')),
        h('div', h('b', 'HTTPS binnen je tailnet '), ts.serving ? h('span.badge.ok', 'actief') : h('button.btn.sm', { disabled: !ts.running, onclick: run('serve') }, 'Zet aan'), h('div.muted', { style: { fontSize: '13px' } }, 'Alleen apparaten in jouw tailnet (en gedeelde gebruikers) kunnen erbij.')),
        h('div', h('b', 'Funnel (optioneel, openbaar) '), ts.funnel ? h('span.badge.warn', 'openbaar') : h('button.btn.sm', { disabled: !ts.running, onclick: run('funnel') }, 'Openbaar maken'), h('div.muted', { style: { fontSize: '13px' } }, 'Nodig als vrienden zonder Tailscale moeten kunnen meekijken of koppelen.'))),
        ts.url && h('div.note', 'Adres: ', h('span.mono', ts.url)));
    }
    if (d.mode === 'cloudflare') {
      const cf = d.cloudflare; const token = h('input.input', { placeholder: 'Tunnel-token (eyJ…)', type: 'password' }), host = h('input.input', { placeholder: 'kinoko.jouwdomein.nl' });
      detail.append(helperNote, h('div.steps-list',
        h('div', 'Maak in het Cloudflare-dashboard onder ', h('b', 'Zero Trust → Networks → Tunnels'), ' een tunnel aan en kopieer het token.'),
        h('div', 'Voeg bij de tunnel een ', h('b', 'Public hostname'), ' toe die wijst naar ', h('span.mono', `http://localhost:${location.port || 8096}`), '.'),
        h('div', h('b', 'cloudflared '), cf.installed ? h('span.badge.ok', cf.running ? 'verbonden' : 'geïnstalleerd') : h('button.btn.sm', { onclick: (e) => act(e.currentTarget, async () => { await api('/api/admin/remote/cloudflare', { method: 'POST', body: { action: 'install' } }); draw(); }) }, 'Installeer cloudflared')),
        h('div', h('div.stack', { style: { gap: '8px' } }, token, host, h('div.row', h('button.btn.primary.sm', { onclick: (e) => act(e.currentTarget, async () => { await api('/api/admin/remote/cloudflare', { method: 'POST', body: { action: 'connect', token: token.value, hostname: host.value } }); toast('Tunnel verbonden'); draw(); }) }, 'Verbinden'),
          cf.running && h('button.btn.sm.danger', { onclick: (e) => act(e.currentTarget, async () => { await api('/api/admin/remote/cloudflare', { method: 'POST', body: { action: 'disconnect' } }); draw(); }) }, 'Verbreken'))))),
        d.publicUrl && h('div.note', 'Adres: ', h('span.mono', d.publicUrl)));
    }
    if (d.mode === 'custom') detail.append(urlRow('Stuur je domein door naar poort ' + (location.port || 8096) + ' van deze server. WebSockets moeten worden doorgelaten (voor Samen kijken).'));
    box.replaceChildren(h('div.stack', { style: { gap: '8px' } }, modes.map(([id, ico, label, text]) => h(`button.option${d.mode === id ? '.on' : ''}`, { onclick: () => act(null, async () => { await save({ mode: id }); draw(); }) }, h('div.ico', icon(ico)), h('div', h('b', label), h('span', text))))), detail,
      !compact && d.mode !== 'custom' && d.mode !== 'lan' ? urlRow('Wordt automatisch ingevuld; pas alleen aan als het niet klopt.') : null);
  }
  draw();
  return box;
}

// ---------------------------------------------------------------------------
// Admin pages
// ---------------------------------------------------------------------------
const PAGES = {
  '': ['Overzicht', 'home', dashboard],
  bibliotheken: ['Bibliotheken', 'folder', () => page('Bibliotheken', 'Mappen met films en series. Kinoko scant ze automatisch en haalt posters, cast en genres erbij.', librariesPanel())],
  metadata: ['Metadata', 'tag', () => page('Metadata', 'Waar titels, posters, acteurs en genres vandaan komen.', metadataPanel())],
  transcoderen: ['Transcoderen', 'chip', () => page('Transcoderen', 'Als iemand een lagere kwaliteit kiest, zet de server de video live om — het liefst op de videokaart.', transcodePanel(), markersSection())],
  gebruikers: ['Gebruikers', 'users', usersPage],
  servers: ['Gekoppelde servers', 'server', peersPage],
  'live-tv': ['Live tv', 'globe', iptvPage],
  'back-ups': ['Back-ups', 'download', backupsPage],
  meldingen: ['Meldingen', 'chat', webhooksPage],
  toegang: ['Externe toegang', 'link', () => page('Externe toegang', 'Kies hoe Kinoko van buiten je huis bereikbaar is. Dit adres wordt gebruikt voor uitnodigingen en serverkoppelingen.', remotePanel())],
};
let main;
function page(title, lead, ...content) { main.replaceChildren(h('h1', title), h('p.lead', lead), ...content.filter(Boolean)); }

export function adminView({ section = '' } = {}) {
  if (state.user.role !== 'admin') { go('/', { replace: true }); return undefined; }
  if (!PAGES[section]) section = '';
  main = h('div.admin-main.view');
  const off = shell('admin', h('div.admin', h('nav.admin-nav', Object.entries(PAGES).map(([id, [label, ic]]) => h(`a${id === section ? '.on' : ''}`, { href: `/beheer${id ? '/' + id : ''}` }, icon(ic), label))), main));
  document.querySelector('main').classList.remove('view');
  PAGES[section][2]();
  return off;
}

async function dashboard() {
  page('Overzicht', 'Zo staat je server erbij.');
  let timer;
  async function draw() {
    let d; try { d = await api('/api/admin/settings'); } catch { return; }
    const name = h('input.input', { value: d.serverName, style: { maxWidth: '280px' } });
    const idle = h('input.input', { type: 'number', min: 1, max: 3650, value: d.sessionIdleDays, style: { maxWidth: '120px' } });
    const t = d.tasks;
    const busy = t.scan.running || t.metadata.running || t.markers.running;
    main.replaceChildren(h('h1', d.serverName), h('p.lead', `Kinoko ${d.version} · ${d.publicUrl || d.currentUrl}`),
      h('div.stats', [[d.counts.movies, 'films'], [d.counts.shows, 'series'], [d.counts.episodes, 'afleveringen'], [d.counts.collections, 'collecties'], [fmtSize(d.counts.size), 'op schijf'], [d.counts.remoteFiles, 'via koppelingen'], [d.counts.channels, 'tv-zenders'], [d.counts.users, 'gebruikers']].map(([v, l]) => h('div.stat', h('b', String(v)), h('span', l)))),
      !d.ffmpeg && h('div.note.warn', { style: { marginBottom: '18px' } }, 'ffmpeg ontbreekt op deze server. Installeer het (apt install ffmpeg) en herstart Kinoko.'),
      busy && h('div.note', { style: { marginBottom: '18px' } }, h('b', 'Bezig op de achtergrond: '), [t.scan.running && `bibliotheek scannen (${t.scan.phase})`, t.metadata.running && `metadata ${t.metadata.done}/${t.metadata.total}`, t.markers.running && `intro's detecteren ${t.markers.done}/${t.markers.total}`].filter(Boolean).join(' · ')),
      h('div.section', h('h2', 'Server'), h('div.card-box.stack',
        h('label.field', h('span', 'Naam van deze server (zichtbaar voor gekoppelde servers en bij versies)'), h('div.row', name, h('button.btn', { onclick: (e) => act(e.currentTarget, async () => { await api('/api/admin/settings', { method: 'PUT', body: { serverName: name.value } }); toast('Opgeslagen'); state.info.name = name.value; draw(); }) }, 'Opslaan'))),
        h('label.field', h('span', 'Apparaten automatisch uitloggen na zoveel dagen zonder gebruik'), h('div.row', idle, h('button.btn', { onclick: (e) => act(e.currentTarget, async () => { const n = Number(idle.value); if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error('Vul een aantal dagen in tussen 1 en 3650.'); await api('/api/admin/settings', { method: 'PUT', body: { sessionIdleDays: n } }); toast('Opgeslagen'); draw(); }) }, 'Opslaan'))),
        h('div.row.wrap', h('button.btn', { onclick: () => act(null, async () => { await api('/api/admin/scan', { method: 'POST' }); toast('Scan gestart'); draw(); }) }, icon('refresh'), 'Bibliotheken scannen'),
          h('button.btn', { onclick: async (e) => { if (await confirmDialog('Kinoko bijwerken?', 'De server haalt de nieuwste versie van GitHub en herstart. Lopende streams worden kort onderbroken.', 'Bijwerken')) act(e.currentTarget, async () => { await api('/api/admin/update', { method: 'POST' }); toast('Bijgewerkt — de server herstart'); }); } }, icon('download'), 'Kinoko bijwerken')))),
      h('div.section', h('h2', 'Apps'), h('div.card-box.row.wrap', { style: { gap: '22px' } }, qrSvg(d.publicUrl || d.currentUrl),
        h('div.grow.stack', { style: { gap: '8px' } }, h('p', 'Installeer de Kinoko-app op je telefoon of Android TV en vul dit adres in:'), h('div.codebox', h('span.grow', d.publicUrl || d.currentUrl), h('button.btn.sm', { onclick: () => copyText(d.publicUrl || d.currentUrl) }, icon('copy'))),
          h('p.muted', { style: { fontSize: '13px' } }, 'De APK\'s staan bij de releases van de Kinoko-repository op GitHub.')))));
    clearTimeout(timer);
    if (busy && main.isConnected) timer = setTimeout(draw, 2500);
  }
  draw();
}

function markersSection() {
  const box = h('div.section', { style: { marginTop: '30px' } });
  (async () => {
    let d; try { d = await api('/api/admin/markers'); } catch { return; }
    const n = (kind, src) => d.counts.filter((c) => c.kind === kind && (!src || c.source === src)).reduce((a, c) => a + c.n, 0);
    box.replaceChildren(h('h2', 'Intro\'s en aftiteling'), h('div.card-box.stack',
      h('p.muted', 'Kinoko herkent intro\'s door afleveringen van hetzelfde seizoen op geluid te vergelijken, en leest hoofdstukken uit het bestand. Daarmee werkt "Intro overslaan" en het automatisch doorgaan naar de volgende aflevering.'),
      h('div.row.wrap', h('span.badge', `${n('intro')} intro's gevonden`), h('span.badge', `${n('credits', 'audio') + n('credits', 'chapter')} aftitelingen herkend`), !d.chromaprint && h('span.badge.warn', 'ffmpeg mist chromaprint: alleen hoofdstukken'),
        d.state.running && h('span.badge.ok', `bezig ${d.state.done}/${d.state.total}`)),
      h('div.row', h('button.btn', { onclick: (e) => act(e.currentTarget, async () => { await api('/api/admin/markers/redetect', { method: 'POST' }); toast('Detectie opnieuw gestart'); }) }, icon('refresh'), 'Opnieuw detecteren'))));
  })();
  return box;
}

async function backupsPage() {
  const lead = 'Elke dag maakt Kinoko een kopie van de database (accounts, voortgang, instellingen). Je mediabestanden zitten er niet in.';
  page('Back-ups', lead);
  async function draw() {
    const d = await api('/api/admin/backups');
    const keep = h('input.input', { type: 'number', min: 1, max: 365, value: d.keep, style: { maxWidth: '110px' } });
    const download = (name) => act(null, async () => {
      // The download needs the session header, so it is fetched and handed to the browser as a file.
      const r = await fetch(`/api/admin/backups/${name}`, { headers: { Authorization: `Bearer ${state.token}` } });
      if (!r.ok) throw new Error('Downloaden is mislukt.');
      const a = h('a', { href: URL.createObjectURL(await r.blob()), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    main.replaceChildren(h('h1', 'Back-ups'), h('p.lead', lead),
      h('div.section', h('div.card-box.stack',
        h('label.row', h('input', { type: 'checkbox', checked: d.daily, onchange: (e) => act(null, async () => { await api('/api/admin/backups', { method: 'PUT', body: { daily: e.target.checked } }); toast('Opgeslagen'); }) }), h('span', 'Elke dag automatisch een back-up maken')),
        h('label.field', h('span', 'Aantal back-ups om te bewaren'), h('div.row', keep, h('button.btn', { onclick: (e) => act(e.currentTarget, async () => { await api('/api/admin/backups', { method: 'PUT', body: { keep: Number(keep.value) } }); toast('Opgeslagen'); }) }, 'Opslaan'))),
        h('div.row', h('button.btn.primary', { onclick: (e) => act(e.currentTarget, async () => { await api('/api/admin/backups', { method: 'POST' }); toast('Back-up gemaakt'); await draw(); }) }, icon('download'), 'Nu een back-up maken')))),
      h('div.section', h('h2', 'Bewaarde back-ups'), d.backups.length ? h('div.list', d.backups.map((b) => h('div.list-item', h('div.grow', h('b', fmtDate(b.created_at)), h('small', `${b.name} · ${fmtSize(b.size)}`)),
        h('button.btn.sm', { onclick: () => download(b.name) }, icon('download'), 'Downloaden'),
        h('button.btn.sm.danger', { 'aria-label': 'Verwijderen', onclick: async () => { if (await confirmDialog('Back-up verwijderen?', `${b.name} wordt van de server gewist.`, 'Verwijderen')) { await api(`/api/admin/backups/${b.name}`, { method: 'DELETE' }); draw(); } } }, icon('trash'))))) : h('p.muted', 'Nog geen back-ups.')),
      h('p.muted', { style: { fontSize: '13px' } }, 'Een back-up bevat ook wachtwoord-hashes en ingelogde sessies. Bewaar een gedownloade kopie op een veilige plek.'));
  }
  draw().catch((e) => toast(e.message, 'bad'));
}

async function webhooksPage() {
  const lead = 'Laat Kinoko een bericht sturen als er iets gebeurt, bijvoorbeeld naar een Discord-kanaal.';
  page('Meldingen', lead);
  async function draw() {
    const d = await api('/api/admin/webhooks');
    const form = (hook = null) => {
      const name = h('input.input', { placeholder: 'Naam (bijv. Discord #kinoko)', value: hook ? hook.name : '', maxLength: 40 });
      const url = h('input.input', { placeholder: hook ? `Adres ongewijzigd laten (${hook.url})` : 'https://discord.com/api/webhooks/…', autocomplete: 'off' });
      const format = h('select.input', { style: { width: 'auto' } }, h('option', { value: 'discord', selected: !hook || hook.format === 'discord' }, 'Discord'), h('option', { value: 'json', selected: hook && hook.format === 'json' }, 'Algemene JSON'));
      const boxes = d.events.map((e) => [e.id, h('input', { type: 'checkbox', checked: hook ? hook.events.includes(e.id) : e.id !== 'playback.started' })]);
      const m = openModal(h('form.stack', { onsubmit: (ev) => { ev.preventDefault(); act(ev.submitter, async () => {
        const body = { name: name.value, format: format.value, events: boxes.filter(([, b]) => b.checked).map(([id]) => id), ...(url.value.trim() && { url: url.value }) };
        await api(hook ? `/api/admin/webhooks/${hook.id}` : '/api/admin/webhooks', { method: hook ? 'PUT' : 'POST', body }); toast('Opgeslagen'); m.close(); draw();
      }); } }, h('h2', hook ? 'Webhook bewerken' : 'Webhook toevoegen'), h('label.field', h('span', 'Naam'), name), h('label.field', h('span', 'Adres'), url), h('label.field', h('span', 'Formaat'), format),
        h('div.stack', { style: { gap: '8px' } }, h('span.muted', 'Stuur een bericht bij:'), d.events.map((e, i) => h('label.row', boxes[i][1], h('span', e.label)))),
        h('button.btn.primary', 'Opslaan')), { small: true });
    };
    main.replaceChildren(h('h1', 'Meldingen'), h('p.lead', lead),
      h('div.section', d.webhooks.length ? h('div.list', d.webhooks.map((w) => h('div.list-item', h('div.grow', h('b', w.name), h('small', `${w.format === 'discord' ? 'Discord' : 'JSON'} · ${w.url} · ${w.events.length} gebeurtenis${w.events.length === 1 ? '' : 'sen'}`),
        w.last_error && h('small', { style: { color: 'var(--bad)' } }, `Laatste poging mislukt: ${w.last_error} (${fmtDate(w.last_at)})`)),
        h('button.btn.sm', { onclick: (e) => act(e.currentTarget, async () => { await api(`/api/admin/webhooks/${w.id}/test`, { method: 'POST' }); toast('Testbericht verstuurd'); draw(); }) }, 'Testen'),
        h('button.btn.sm', { onclick: () => form(w) }, 'Bewerken'),
        h('button.btn.sm.danger', { 'aria-label': 'Verwijderen', onclick: async () => { if (await confirmDialog('Webhook verwijderen?', `${w.name} krijgt geen berichten meer.`, 'Verwijderen')) { await api(`/api/admin/webhooks/${w.id}`, { method: 'DELETE' }); draw(); } } }, icon('trash'))))) : h('p.muted', 'Nog geen webhooks.')),
      h('div.row', h('button.btn.primary', { onclick: () => form() }, icon('plus'), 'Webhook toevoegen')));
  }
  draw().catch((e) => toast(e.message, 'bad'));
}

async function usersPage() {
  page('Gebruikers', 'Iedereen heeft een eigen account met eigen voortgang, lijst en aanbevelingen.');
  async function draw() {
    const d = await api('/api/admin/users');
    const inviteUrl = (c) => `${location.origin}/join/${c}`;
    main.replaceChildren(h('h1', 'Gebruikers'), h('p.lead', 'Iedereen heeft een eigen account met eigen voortgang, lijst en aanbevelingen.'),
      h('div.section', h('div.list', d.users.map((u) => h('div.list-item', h(`div.avatar.${u.avatar}`, u.name[0]), h('div.grow', h('b', u.name), h('small', u.role === 'admin' ? 'Beheerder' : 'Kijker')),
        h('select.input', { title: 'Maximale streamkwaliteit', 'aria-label': `Maximale kwaliteit voor ${u.name}`, style: { width: 'auto', height: '34px' }, onchange: (e) => act(null, async () => { await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: { maxQuality: e.target.value } }); toast('Opgeslagen'); }) },
          [['', 'Geen limiet'], ['1080', 'Max. 1080p · 8 Mbps'], ['720', 'Max. 720p · 4 Mbps'], ['480', 'Max. 480p · 1,5 Mbps'], ['360', 'Max. 360p · 0,7 Mbps']].map(([v, l]) => h('option', { value: v, selected: (u.maxQuality || '') === v }, l))),
        u.id !== state.user.id && h('button.btn.sm.danger', { onclick: async () => { if (await confirmDialog('Gebruiker verwijderen?', `${u.name} kan niet meer inloggen en de kijkgeschiedenis wordt gewist.`, 'Verwijderen')) { await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); draw(); } } }, icon('trash')))))),
      h('div.section', h('h2', 'Uitnodigen'), h('div.card-box.stack', h('p.muted', 'Maak een uitnodigingslink. Wie hem opent kiest zelf een naam en wachtwoord. De link is 7 dagen geldig en werkt één keer.'),
        d.invites.map((i) => h('div.codebox', h('span.grow', inviteUrl(i.code)), h('button.btn.sm', { onclick: () => copyText(inviteUrl(i.code), 'Link gekopieerd') }, icon('copy')), h('button.btn.sm.danger', { onclick: async () => { await api(`/api/admin/users/invite/${i.code}`, { method: 'DELETE' }); draw(); } }, icon('x')))),
        h('div.row', h('button.btn.primary', { onclick: (e) => act(e.currentTarget, async () => { const r = await api('/api/admin/users/invite', { method: 'POST' }); await copyText(inviteUrl(r.code), 'Uitnodiging gekopieerd'); draw(); }) }, icon('link'), 'Nieuwe uitnodigingslink')))));
  }
  draw().catch((e) => toast(e.message, 'bad'));
}

async function peersPage() {
  async function draw() {
    const d = await api('/api/admin/peers');
    const link = h('input.input', { placeholder: 'https://…/link/…' });
    const mutual = h('input', { type: 'checkbox', checked: true });
    main.replaceChildren(h('h1', 'Gekoppelde servers'), h('p.lead', 'Koppel je Kinoko aan die van een vriend. Elkaars bibliotheken verschijnen dan als eigen titels; staat een film op beide servers, dan kiest Kinoko automatisch de versie met de hoogste bitrate.'),
      !d.publicUrl && h('div.note.warn', { style: { marginBottom: '18px' } }, 'Er is nog geen publiek adres ingesteld. Voor koppelen moet de andere server jou kunnen bereiken — stel dit in bij ', h('a', { href: '/beheer/toegang' }, 'Externe toegang'), '.'),
      h('div.section', d.peers.length ? h('div.list', d.peers.map((p) => h('div.list-item', h('div.option', { style: { width: 'auto', padding: 0, border: 0, background: 'none' } }, h('div.ico', icon('link'))),
        h('div.grow', h('b', p.name), h('small.mono', p.url), h('small', `${p.files} bestanden · laatste sync ${fmtDate(p.last_sync)}`), p.last_error && h('small', { style: { color: 'var(--bad)' } }, p.last_error)),
        p.receiving && h('span.badge.ok', 'jij ziet hun bibliotheek'), p.sharing && h('span.badge', 'zij zien de jouwe'),
        p.receiving && h('button.btn.sm', { onclick: (e) => act(e.currentTarget, async () => { const r = await api(`/api/admin/peers/${p.id}/sync`, { method: 'POST' }); toast(`${r.files} bestanden gesynchroniseerd`); draw(); }) }, icon('refresh')),
        h('button.btn.sm.danger', { onclick: async () => { if (await confirmDialog('Koppeling verbreken?', `Titels van ${p.name} verdwijnen uit je bibliotheek en zij verliezen toegang tot de jouwe.`, 'Verbreken')) { await api(`/api/admin/peers/${p.id}`, { method: 'DELETE' }); draw(); } } }, icon('trash')))))
        : h('p.muted', 'Nog geen koppelingen.')),
      h('div.section', h('h2', 'Iemand uitnodigen'), h('div.card-box.stack', h('p.muted', 'Maak een koppellink en stuur die naar de beheerder van de andere server. Die plakt hem hieronder in zijn eigen Kinoko.'),
        h('label.row', h('span.switch', mutual, h('i')), h('span', 'Wederzijds: ik wil hun bibliotheek ook zien')),
        d.invites.map((i) => h('div.codebox', h('span.grow', i.link), h('button.btn.sm', { onclick: () => copyText(i.link, 'Koppellink gekopieerd') }, icon('copy')), h('button.btn.sm.danger', { onclick: async () => { await api(`/api/admin/peers/invite/${i.token}`, { method: 'DELETE' }); draw(); } }, icon('x')))),
        h('div.row', h('button.btn.primary', { onclick: (e) => act(e.currentTarget, async () => { const r = await api('/api/admin/peers/invite', { method: 'POST', body: { mutual: mutual.checked } }); await copyText(r.link, 'Koppellink gekopieerd'); draw(); }) }, icon('link'), 'Koppellink maken')))),
      h('div.section', h('h2', 'Koppellink ontvangen?'), h('div.card-box.stack', h('label.field', h('span', 'Plak hier de link die je kreeg'), link),
        h('div.row', h('button.btn.primary', { onclick: (e) => act(e.currentTarget, async () => { const r = await api('/api/admin/peers/link', { method: 'POST', body: { link: link.value } }); toast(`Gekoppeld met ${r.name} — ${r.files} bestanden`); draw(); }) }, 'Koppelen')))));
  }
  draw().catch((e) => toast(e.message, 'bad'));
}

async function iptvPage() {
  async function draw() {
    const d = await api('/api/admin/iptv');
    let kind = 'xtream';
    const name = h('input.input', { placeholder: 'Naam (bijv. Mijn IPTV)' }), url = h('input.input', { placeholder: 'http://provider.tv:8080' }), user = h('input.input', { placeholder: 'Gebruikersnaam', autocomplete: 'off' }), pass = h('input.input', { placeholder: 'Wachtwoord', type: 'password', autocomplete: 'new-password' });
    const proxy = h('input', { type: 'checkbox' });
    const kinds = h('div.row'), creds = h('div.row', user, pass);
    const drawKind = () => { kinds.replaceChildren(['xtream', 'm3u'].map((k) => h(`button.chip${k === kind ? '.on' : ''}`, { onclick: () => { kind = k; drawKind(); } }, k === 'xtream' ? 'Xtream Codes' : 'M3U-playlist'))); creds.classList.toggle('hide', kind !== 'xtream'); url.placeholder = kind === 'xtream' ? 'http://provider.tv:8080' : 'https://voorbeeld.nl/playlist.m3u'; };
    drawKind();
    main.replaceChildren(h('h1', 'Live tv'), h('p.lead', 'Voeg je IPTV-abonnement één keer toe; daarna staan de zenders op elk apparaat in Kinoko.'),
      h('div.section', d.sources.length ? h('div.list', d.sources.map((s) => h('div.list-item', h('div.grow', h('b', s.name), h('small', `${s.kind === 'xtream' ? 'Xtream' : 'M3U'} · ${s.channels} zenders · bijgewerkt ${fmtDate(s.last_sync)}`), s.last_error && h('small', { style: { color: 'var(--bad)' } }, s.last_error)),
        h('label.row', { title: 'Stream loopt via Kinoko; inloggegevens van de provider blijven op de server' }, h('span.switch', h('input', { type: 'checkbox', checked: s.proxy, onchange: (e) => api(`/api/admin/iptv/${s.id}`, { method: 'PUT', body: { proxy: e.target.checked } }) }), h('i')), h('small', 'via server')),
        h('button.btn.sm', { onclick: (e) => act(e.currentTarget, async () => { const r = await api(`/api/admin/iptv/${s.id}/sync`, { method: 'POST' }); toast(`${r.channels} zenders`); draw(); }) }, icon('refresh')),
        h('button.btn.sm.danger', { onclick: async () => { if (await confirmDialog('Bron verwijderen?', `Alle zenders van "${s.name}" verdwijnen.`, 'Verwijderen')) { await api(`/api/admin/iptv/${s.id}`, { method: 'DELETE' }); draw(); } } }, icon('trash'))))) : h('p.muted', 'Nog geen bronnen.')),
      h('div.section', h('h2', 'Bron toevoegen'), h('div.card-box.stack', kinds, name, url, creds,
        h('label.row', h('span.switch', proxy, h('i')), h('span', 'Streams via deze server laten lopen (verbergt je inloggegevens voor kijkers)')),
        h('div.row', h('button.btn.primary', { onclick: (e) => act(e.currentTarget, async () => { const r = await api('/api/admin/iptv', { method: 'POST', body: { name: name.value, kind, url: url.value, username: user.value, password: pass.value, proxy: proxy.checked } }); toast(`${r.channels} zenders toegevoegd`); draw(); }) }, 'Toevoegen en zenders ophalen')))));
  }
  draw().catch((e) => toast(e.message, 'bad'));
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------
export function setupView() {
  const STEPS = ['Welkom', 'Account', 'Bibliotheken', 'Metadata', 'Transcoderen', 'Toegang', 'Klaar'];
  // Reloading mid-way continues after the account step.
  let step = state.user ? 2 : 0;
  const card = h('div.auth-card.wide');
  setView(h('div.auth', card));

  const foot = (nextLabel, onNext, { back = true, skip = false } = {}) => h('div.wizard-foot', back && step > 2 ? h('button.btn', { type: 'button', onclick: () => show(step - 1) }, 'Terug') : null, h('span.spacer'),
    skip && h('button.btn', { type: 'button', onclick: () => show(step + 1) }, 'Sla over'), h('button.btn.primary', { onclick: onNext }, nextLabel));

  function show(n) {
    step = n;
    const head = [h('div.row', h('div.logo', h('span', 'Kinoko')), h('span.spacer'), h('span.faint', `${n + 1} / ${STEPS.length}`)), h('div.steps', { style: { marginTop: '18px' } }, STEPS.map((_, i) => h(`i${i <= n ? '.on' : ''}`)))];
    const body = h('div.step-body');
    if (n === 0) {
      body.append(h('div.welcome-art', h('div')), h('h1', { style: { textAlign: 'center', marginTop: 0 } }, 'Welkom bij Kinoko'), h('p.muted', { style: { textAlign: 'center', marginBottom: '20px' } }, 'Je eigen streamingdienst, op je eigen server. In een paar stappen staat alles klaar.'),
        h('div.feature-list', [['film', 'Films & series', 'Automatisch posters, cast en collecties'], ['users', 'Samen kijken', 'Nodig iemand uit met een link'], ['link', 'Bibliotheken delen', 'Koppel servers van vrienden'], ['tv', 'Live tv', 'Je IPTV-abonnement erbij'], ['bolt', 'Hardware-transcoding', 'Soepel op elk apparaat'], ['dice', 'Watch Night', 'Laat het seizoen kiezen']].map(([ic, a, b]) => h('div', icon(ic), h('div', h('b', a), h('span', b))))),
        h('div.wizard-foot', h('span.spacer'), h('button.btn.primary.lg', { onclick: () => show(1) }, 'Aan de slag')));
    } else if (n === 1) {
      const server = h('input.input', { value: 'Kinoko', maxLength: 40 }), name = h('input.input', { autocomplete: 'username', required: true, minLength: 2, autofocus: true }), pass = h('input.input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 6 });
      body.append(h('h1', 'Maak je beheerdersaccount'), h('p.muted', { style: { marginBottom: '18px' } }, 'Hiermee beheer je de server en log je in op je apparaten.'),
        h('form.stack', { onsubmit: (e) => { e.preventDefault(); act(e.submitter, async () => {
          const r = await api('/api/setup', { method: 'POST', body: { name: name.value, password: pass.value, serverName: server.value } });
          setToken(r.token); state.user = r.user; state.info.needsSetup = false; state.info.name = server.value || 'Kinoko'; show(2);
        }); } }, h('label.field', h('span', 'Naam van je server'), server, h('small', 'Zien anderen als je bibliotheken deelt, bijv. "Kinoko van Sam".')),
          h('label.field', h('span', 'Jouw naam'), name), h('label.field', h('span', 'Wachtwoord'), pass, h('small', 'Minstens 6 tekens.')),
          h('div.wizard-foot', h('span.spacer'), h('button.btn.primary', 'Account aanmaken'))));
    } else if (n === 2) {
      body.append(h('h1', 'Waar staan je films en series?'), h('p.muted', { style: { marginBottom: '18px' } }, 'Voeg één of meer mappen toe. Kinoko begint direct met scannen; je kunt ondertussen gewoon verder.'), librariesPanel(), foot('Verder', () => show(3), { skip: false }));
    } else if (n === 3) {
      body.append(h('h1', 'Posters, cast en genres'), h('p.muted', { style: { marginBottom: '18px' } }, 'Dit gaat vanzelf. Een TMDB-sleutel is alleen een extraatje.'), metadataPanel(true), foot('Verder', () => show(4)));
    } else if (n === 4) {
      body.append(h('h1', 'Hardware-versnelling'), h('p.muted', { style: { marginBottom: '18px' } }, 'Kinoko heeft getest wat deze server kan.'), transcodePanel(), foot('Verder', () => show(5)));
    } else if (n === 5) {
      body.append(h('h1', 'Hoe wil je erbij kunnen?'), h('p.muted', { style: { marginBottom: '18px' } }, 'Kies waar Kinoko bereikbaar is. Je kunt dit later altijd aanpassen in Beheer.'), remotePanel(true), foot('Verder', () => show(6)));
    } else {
      const url = h('span.grow', location.origin);
      api('/api/admin/settings').then((d) => { url.textContent = d.publicUrl || d.currentUrl; qr.replaceChildren(qrSvg(d.publicUrl || d.currentUrl)); }).catch(() => {});
      const qr = h('div');
      body.append(h('div.welcome-art', h('div')), h('h1', { style: { textAlign: 'center', marginTop: 0 } }, 'Je Kinoko staat klaar'), h('p.muted', { style: { textAlign: 'center', marginBottom: '20px' } }, 'Installeer de app op je telefoon of tv en vul dit adres in — of kijk direct hier in de browser.'),
        h('div.row.wrap', { style: { justifyContent: 'center', gap: '22px' } }, qr, h('div.stack', { style: { maxWidth: '300px' } }, h('div.codebox', url, h('button.btn.sm', { onclick: () => copyText(url.textContent) }, icon('copy'))), h('p.faint', { style: { fontSize: '13px' } }, 'Tip: nodig vrienden uit via Beheer → Gebruikers, of koppel hun server via Beheer → Gekoppelde servers.'))),
        h('div.wizard-foot', h('span.spacer'), h('button.btn.primary.lg', { onclick: (e) => act(e.currentTarget, async () => { await api('/api/admin/settings', { method: 'PUT', body: { onboarded: true } }); state.onboarded = true; go('/'); }) }, 'Open Kinoko'), h('span.spacer')));
    }
    card.replaceChildren(...head, body);
  }
  show(step);
}
