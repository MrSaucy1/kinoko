// The web player: direct play or HLS, skip intro, next-episode countdown,
// subtitles (incl. online search), version/quality switching, Watch Together.
import { api, h, icon, state, go, toast, act, mountLayer, fmtTime, fmtBitrate } from './core.js';
import { inviteDialog } from './views.js';

function browserCaps() {
  const v = document.createElement('video');
  const can = (t) => v.canPlayType(t) !== '';
  const vcodecs = ['h264'];
  if (can('video/mp4; codecs="hvc1.1.6.L93.B0"')) vcodecs.push('hevc');
  if (can('video/webm; codecs="vp9"')) vcodecs.push('vp9', 'vp8');
  if (can('video/mp4; codecs="av01.0.05M.08"')) vcodecs.push('av1');
  const acodecs = ['aac', 'mp3'];
  if (can('audio/webm; codecs="opus"')) acodecs.push('opus', 'vorbis');
  if (can('audio/flac')) acodecs.push('flac');
  return { containers: ['mp4', 'webm', 'mov'], vcodecs, acodecs };
}

const Q_LABEL = { original: 'Origineel', 1080: '1080p', 720: '720p', 480: '480p', 360: '360p' };

/**
 * opts: { titleId, episodeId?, fileId?, quality?, resume?, room?: { code, guest? } }
 */
export async function startPlayback(opts) {
  const room = opts.room || null;
  const isGuest = !!(room && room.guest);
  let detail = null, episodes = [], episode = null, versions = [];
  let fileId = opts.fileId || null, quality = opts.quality || 'original', audio = 0;
  let play = null, hls = null, ws = null, closed = false;
  let subOffset = 0, offsetTimer = null, audioChosen = false, voting = null, voteEl = null, voteTick = null, myVote = null;
  let suppress = false, upnextShown = false, upnextDismissed = false, countdown = null, idleTimer = null, progressTimer = null;

  const video = h('video', { playsInline: true, preload: 'auto', crossOrigin: 'anonymous' });
  const title = h('h2'), sub = h('small');
  const fill = h('div.fill'), buf = h('div.buf'), knob = h('div.knob'), rail = h('div.rail', buf, fill);
  const thumbPic = h('i'), thumbTime = h('span');
  const thumb = h('div.p-thumb.hide', thumbPic, thumbTime);
  const seek = h('div.p-seek', rail, knob, thumb);
  // Hovering the seek bar shows the time, and a preview picture when the server has made them.
  function showThumb(clientX) {
    const r = rail.getBoundingClientRect(), d = duration();
    if (!d || !r.width) return;
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width)), t = f * d;
    const tp = play && play.trickplay;
    thumbTime.textContent = fmtTime(t);
    if (tp) {
      const per = tp.cols * tp.rows, idx = Math.min(tp.count - 1, Math.floor(t / tp.interval)), pos = idx % per;
      Object.assign(thumbPic.style, { display: 'block', width: `${tp.width}px`, height: `${tp.height}px`, backgroundImage: `url(${tp.base}${Math.floor(idx / per) + 1}.jpg)`, backgroundPosition: `-${(pos % tp.cols) * tp.width}px -${Math.floor(pos / tp.cols) * tp.height}px` });
    } else thumbPic.style.display = 'none';
    const half = (tp ? tp.width : 60) / 2 + 6;
    thumb.style.left = `${Math.max(half, Math.min(r.width - half, f * r.width))}px`;
    thumb.classList.remove('hide');
  }
  seek.addEventListener('mousemove', (e) => showThumb(e.clientX));
  seek.addEventListener('mouseleave', () => thumb.classList.add('hide'));
  const time = h('span.time', '0:00 / 0:00');
  const playBtn = h('button', { 'aria-label': 'Afspelen/pauzeren', onclick: () => toggle() }, icon('play'));
  const nextBtn = h('button.hide', { 'aria-label': 'Volgende aflevering', title: 'Volgende aflevering', onclick: () => goNext() }, icon('next'));
  const center = h('div.p-center');
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: Number(localStorage.getItem('kinoko_vol') || 1), 'aria-label': 'Volume', oninput: () => { video.volume = Number(vol.value); video.muted = false; localStorage.setItem('kinoko_vol', vol.value); drawVol(); } });
  const muteBtn = h('button', { 'aria-label': 'Geluid', onclick: () => { video.muted = !video.muted; drawVol(); } }, icon('vol'));
  const drawVol = () => muteBtn.replaceChildren(icon(video.muted || video.volume === 0 ? 'mute' : 'vol'));
  const overlay = h('div'); // skip / upnext / panels / toasts live here
  const stage = h('div.stage', video,
    h('div.p-ui',
      h('div.p-top', h('button.icon-btn', { 'aria-label': 'Terug', onclick: () => close() }, icon('back')), h('div.grow', title, sub),
        !isGuest && h('button.btn.ghost.sm', { onclick: () => startRoom() }, icon('users'), room ? 'Uitnodigen' : 'Samen kijken')),
      h('div.p-bottom', seek, h('div.p-controls', playBtn,
        h('button', { 'aria-label': '10 seconden terug', onclick: () => jump(-10) }, icon('back10')), h('button', { 'aria-label': '10 seconden vooruit', onclick: () => jump(10) }, icon('fwd10')),
        nextBtn, muteBtn, vol, time, h('span.spacer'),
        h('button', { 'aria-label': 'Ondertitels', title: 'Ondertitels', onclick: () => panel('subs') }, icon('subs')),
        h('button', { 'aria-label': 'Kwaliteit en versie', title: 'Kwaliteit en versie', onclick: () => panel('quality') }, icon('gear')),
        h('button', { 'aria-label': 'Volledig scherm', onclick: () => (document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen().catch(() => {})) }, icon('full'))))),
    center, overlay,
    h('div', { html: '<svg width="0" height="0" style="position:absolute"><defs><linearGradient id="ringgrad"><stop offset="0" stop-color="#a855f7"/><stop offset="1" stop-color="#e879f9"/></linearGradient></defs></svg>' }));
  const el = h('div.player', stage);
  const unmount = mountLayer(el);
  video.volume = Number(vol.value);

  // ---- helpers -------------------------------------------------------------
  const duration = () => (play && play.duration) || video.duration || 0;
  const spinner = (on) => center.replaceChildren(on ? h('div.spin') : '');
  const flash = (name) => { const f = h('div.p-flash', icon(name)); center.replaceChildren(f); setTimeout(() => { if (f.isConnected) f.remove(); }, 500); };
  const note = (text) => { const t = h('div.p-toast', text); overlay.append(t); setTimeout(() => t.remove(), 2600); };
  function wake() { el.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (!video.paused && !overlay.querySelector('.p-panel')) el.classList.add('idle'); }, 3200); }
  el.addEventListener('mousemove', wake); el.addEventListener('touchstart', wake, { passive: true });

  function toggle() { if (video.paused) video.play().catch(() => {}); else video.pause(); }
  function jump(d) { video.currentTime = Math.max(0, Math.min(duration() - 1, video.currentTime + d)); wake(); }
  video.addEventListener('click', toggle);
  video.addEventListener('play', () => { playBtn.replaceChildren(icon('pause')); flash('play'); wake(); send('play'); });
  video.addEventListener('pause', () => { playBtn.replaceChildren(icon('play')); if (!video.ended) flash('pause'); el.classList.remove('idle'); send('pause'); report(false, !video.ended && !video.seeking); });
  video.addEventListener('seeked', () => { send('seek'); upnextCheckReset(); });
  video.addEventListener('waiting', () => spinner(true));
  video.addEventListener('playing', () => spinner(false));
  video.addEventListener('canplay', () => spinner(false));
  video.addEventListener('ended', () => { report(true); if (nextEpisode()) goNext(); else close(); });
  video.addEventListener('error', () => { if (!closed && !hls) toast('Deze versie kan hier niet direct afgespeeld worden. Kies een andere kwaliteit.', 'bad'); });

  // seek bar
  function seekTo(clientX) { const r = rail.getBoundingClientRect(); const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width)); video.currentTime = f * duration(); draw(); }
  seek.addEventListener('pointerdown', (e) => { seek.setPointerCapture(e.pointerId); seekTo(e.clientX); const mv = (ev) => { seekTo(ev.clientX); showThumb(ev.clientX); }; seek.addEventListener('pointermove', mv); seek.addEventListener('pointerup', (ev) => { seek.removeEventListener('pointermove', mv); if (ev.pointerType !== 'mouse') thumb.classList.add('hide'); }, { once: true }); });

  function draw() {
    const d = duration(), t = video.currentTime;
    const pct = d ? (t / d) * 100 : 0;
    fill.style.width = `${pct}%`; knob.style.left = `${pct}%`;
    if (video.buffered.length && d) buf.style.width = `${(video.buffered.end(video.buffered.length - 1) / d) * 100}%`;
    time.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
    markers(t, d);
  }
  video.addEventListener('timeupdate', draw);
  video.addEventListener('progress', draw);

  // ---- intro skip + next episode -------------------------------------------
  let skipEl = null;
  function markers(t, d) {
    const m = (play && play.markers) || {};
    const inIntro = m.intro && t >= m.intro.start && t < m.intro.end - 1;
    if (inIntro && !skipEl) {
      skipEl = h('div.p-skip', h('button.btn', { onclick: () => { video.currentTime = m.intro.end; note('Intro overgeslagen'); } }, icon('skip'), 'Intro overslaan'));
      overlay.append(skipEl);
    } else if (!inIntro && skipEl) { skipEl.remove(); skipEl = null; }
    const next = nextEpisode();
    const creditsAt = m.credits ? m.credits.start : d - 20;
    if (next && d > 60 && t >= creditsAt && !upnextShown && !upnextDismissed && !video.paused) showUpNext(next);
  }
  function upnextCheckReset() {
    const m = (play && play.markers) || {};
    const creditsAt = m.credits ? m.credits.start : duration() - 20;
    if (video.currentTime < creditsAt - 2) { hideUpNext(); upnextDismissed = false; }
  }
  function hideUpNext() { clearInterval(countdown); const u = overlay.querySelector('.upnext'); if (u) u.remove(); upnextShown = false; }
  function showUpNext(next) {
    upnextShown = true;
    let left = 8;
    const C = 2 * Math.PI * 27;
    const fg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const ringSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ringSvg.setAttribute('viewBox', '0 0 62 62');
    ringSvg.innerHTML = '<circle class="bg" cx="31" cy="31" r="27"/>';
    for (const [k, v] of Object.entries({ class: 'fg', cx: 31, cy: 31, r: 27, 'stroke-dasharray': C, 'stroke-dashoffset': 0 })) fg.setAttribute(k, v);
    ringSvg.append(fg);
    const num = h('span', String(left));
    const card = h('div.upnext',
      h('div.thumb', { style: next.still ? { backgroundImage: `url(${next.still})` } : {} }),
      h('div.body', h('div.ring', { title: 'Nu afspelen', onclick: () => goNext() }, ringSvg, num),
        h('div.grow', h('small', 'Volgende aflevering'), h('b', `S${next.season} · A${next.episode} — ${next.name}`),
          h('button.btn.sm', { style: { marginTop: '8px' }, onclick: () => { upnextDismissed = true; hideUpNext(); } }, 'Aftiteling bekijken'))));
    overlay.append(card);
    requestAnimationFrame(() => fg.setAttribute('stroke-dashoffset', String(C / left)));
    countdown = setInterval(() => {
      if (video.paused) return;
      left--; num.textContent = String(Math.max(0, left));
      fg.setAttribute('stroke-dashoffset', String(C * ((8 - left + 1) / 8)));
      if (left <= 0) { clearInterval(countdown); goNext(); }
    }, 1000);
  }
  function nextEpisode() { if (!episode) return null; const i = episodes.findIndex((e) => e.id === episode.id); return i >= 0 ? episodes[i + 1] || null : null; }
  async function goNext() {
    const next = nextEpisode(); if (!next) return;
    report(true); hideUpNext(); upnextDismissed = false;
    episode = next; versions = next.versions; fileId = versions[0].fileId; audio = 0; audioChosen = false; if (quality !== 'original' && !versions[0].qualities.includes(quality)) quality = 'original';
    if (ws) ws.send(JSON.stringify({ t: 'load', fileId })); // room follows through the 'load' broadcast
    else await load(0);
  }

  // ---- loading a file --------------------------------------------------------
  function describe() {
    title.textContent = detail ? detail.title : '';
    sub.textContent = episode ? `S${episode.season} · A${episode.episode} — ${episode.name}` : (detail && detail.year ? String(detail.year) : '');
    nextBtn.classList.toggle('hide', !nextEpisode());
  }

  async function load(position = 0, autoplay = true) {
    spinner(true); hideUpNext(); if (skipEl) { skipEl.remove(); skipEl = null; }
    if (hls) { hls.destroy(); hls = null; }
    if (play && play.sessionId && !room) api(`/api/hls/${play.sessionId}`, { method: 'DELETE' }).catch(() => {});
    // A series remembers the audio language the user picked; the browser needs a conversion for a non-default track.
    const pref = detail && detail.prefs, ver = versions.find((v) => v.fileId === fileId);
    if (!audioChosen && pref && pref.audioLang && ver && ver.audio.length > 1) {
      const a = ver.audio.find((x) => x.lang === pref.audioLang);
      if (a && a.index !== audio) { audio = a.index; if (audio !== 0 && quality === 'original') quality = ver.qualities[1] || 'original'; }
    }
    const body = { fileId, quality, audio, caps: browserCaps() };
    try {
      play = room
        ? await api(`/api/watch/${room.code}/play`, { method: 'POST', body, headers: room.guest ? { 'x-guest': room.guest } : {} })
        : await api('/api/play', { method: 'POST', body });
    } catch (e) { toast(e.message, 'bad'); spinner(false); return; }
    fileId = play.fileId;
    for (const t of [...video.querySelectorAll('track')]) t.remove();
    subOffset = Number(play.subOffsetMs) || 0;
    const want = pref && pref.subLang ? (pref.subLang === 'off' ? '' : pref.subLang) : (localStorage.getItem('kinoko_sub') || '');
    let shown = false;
    for (const s of play.subtitles) { const on = !shown && s.lang === want; addTrack(s, on); shown = shown || on; }
    // markers on the seek bar
    for (const m of rail.querySelectorAll('.mark')) m.remove();
    if (play.markers.intro && play.duration) rail.append(h('div.mark', { style: { left: `${(play.markers.intro.start / play.duration) * 100}%`, width: `${((play.markers.intro.end - play.markers.intro.start) / play.duration) * 100}%` } }));
    const begin = () => { if (position > 1) video.currentTime = position; if (autoplay) video.play().catch(() => { playBtn.replaceChildren(icon('play')); }); };
    if (play.mode === 'hls' && window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ startPosition: position > 1 ? position : -1, maxBufferLength: 30 });
      hls.loadSource(play.url); hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => { if (autoplay) video.play().catch(() => {}); });
      hls.on(window.Hls.Events.ERROR, (_, data) => { if (data.fatal) { if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError(); else toast('Afspelen is onderbroken. Probeer het opnieuw.', 'bad'); } });
    } else {
      video.src = play.url;
      video.addEventListener('loadedmetadata', begin, { once: true });
    }
    describe();
  }

  function addTrack(s, on) {
    const t = h('track', { kind: 'subtitles', label: s.label, srclang: s.lang, src: s.url });
    t.dataset.id = s.id;
    video.append(t);
    t.track.mode = on ? 'showing' : 'disabled';
    t.addEventListener('load', syncOffset);
    return t;
  }
  // Subtitle timing: cues are moved in place; each track remembers how far it was already moved.
  function syncOffset() {
    for (const el of video.querySelectorAll('track')) {
      const tr = el.track, diff = (subOffset - (el._moved || 0)) / 1000;
      if (!diff || !tr.cues || !tr.cues.length) continue;
      for (const c of [...tr.cues]) { c.startTime = Math.max(0, c.startTime + diff); c.endTime = Math.max(0.01, c.endTime + diff); }
      el._moved = subOffset;
    }
  }
  function shiftSubs(ms) {
    subOffset = ms === 0 ? 0 : Math.max(-600000, Math.min(600000, subOffset + ms));
    syncOffset();
    clearTimeout(offsetTimer);
    if (!isGuest) offsetTimer = setTimeout(() => api(`/api/files/${fileId}/sub-offset`, { method: 'PUT', body: { offsetMs: subOffset } }).catch(() => {}), 800);
  }
  const savePref = (body) => { if (!isGuest && detail && detail.kind === 'show') { detail.prefs = { ...(detail.prefs || {}), ...body }; api(`/api/titles/${detail.id}/prefs`, { method: 'PUT', body }).catch(() => {}); } };

  // ---- panels ----------------------------------------------------------------
  function panel(kind) {
    const open = overlay.querySelector('.p-panel');
    if (open) { const same = open.dataset.kind === kind; open.remove(); if (same) return; }
    const p = h('div.p-panel', { 'data-kind': kind });
    const opt = (label, on, fn, small) => h(`button.opt${on ? '.on' : ''}`, { onclick: () => { fn(); p.remove(); } }, label, small && h('small', small));
    if (kind === 'subs') {
      const tracks = [...video.querySelectorAll('track')];
      const active = tracks.find((t) => t.track.mode === 'showing');
      const choose = (t) => { for (const x of tracks) x.track.mode = x === t ? 'showing' : 'disabled'; localStorage.setItem('kinoko_sub', t ? t.srclang : ''); savePref({ subLang: t ? t.srclang : 'off' }); setTimeout(syncOffset, 300); };
      p.append(h('h4', 'Ondertitels'), opt('Uit', !active, () => choose(null)), tracks.map((t) => opt(t.label, t === active, () => choose(t))));
      const offLabel = h('b', { style: { minWidth: '82px', textAlign: 'center' } });
      const drawOff = () => { offLabel.textContent = subOffset ? `${subOffset > 0 ? '+' : '−'}${(Math.abs(subOffset) / 1000).toFixed(1).replace('.', ',')} s` : 'Gelijk'; };
      const step = (ms) => h('button.btn.sm', { 'aria-label': ms < 0 ? 'Ondertitels eerder' : 'Ondertitels later', onclick: () => { shiftSubs(ms); drawOff(); } }, ms < 0 ? '−0,1 s' : '+0,1 s');
      drawOff();
      if (tracks.length) p.append(h('h4', 'Timing'), h('div.row', { style: { padding: '4px 10px 8px', gap: '8px' } }, step(-100), offLabel, step(100), h('button.btn.sm.ghost', { onclick: () => { shiftSubs(0); drawOff(); } }, 'Herstel')),
        h('p.faint', { style: { padding: '0 10px 6px', fontSize: '12.5px' } }, 'Komen de ondertitels te vroeg? Kies +. Te laat? Kies −.'));
      const results = h('div');
      p.append(h('h4', 'Online zoeken'), h('button.opt', { onclick: async (e) => {
        e.currentTarget.disabled = true; results.replaceChildren(h('p.muted', { style: { padding: '8px 10px' } }, 'Zoeken…'));
        try {
          const r = await api(`/api/files/${fileId}/subtitles/search?langs=nl,en`);
          results.replaceChildren(r.results.length ? r.results.map((s) => h('button.opt', { onclick: async () => {
            try { const d = await api(`/api/files/${fileId}/subtitles/download`, { method: 'POST', body: { url: s.url, lang: s.lang } }); const t = addTrack(d.subtitle, false); for (const x of video.querySelectorAll('track')) x.track.mode = x === t ? 'showing' : 'disabled'; localStorage.setItem('kinoko_sub', s.lang); note('Ondertitel toegevoegd'); p.remove(); }
            catch (err) { toast(err.message, 'bad'); }
          } }, icon('download'), s.label)) : h('p.muted', { style: { padding: '8px 10px' } }, 'Niets gevonden voor deze titel.'));
        } catch (err) { results.replaceChildren(h('p.muted', { style: { padding: '8px 10px' } }, err.message)); }
      } }, icon('search'), 'Zoek Nederlands & Engels'), results);
    } else {
      const cur = versions.find((v) => v.fileId === fileId) || versions[0];
      if (versions.length > 1 && !isGuest) {
        p.append(h('h4', 'Versie'), versions.map((v) => opt(`${v.resolution} · ${fmtBitrate(v.bitrate)}${v.best ? ' ★' : ''}`, v.fileId === fileId, () => {
          fileId = v.fileId; quality = 'original';
          if (ws) ws.send(JSON.stringify({ t: 'load', fileId })); else load(video.currentTime);
        }, v.server.name)));
      }
      if (cur) {
        p.append(h('h4', 'Kwaliteit'), cur.qualities.map((q) => opt(Q_LABEL[q] || q, String(q) === String(play.mode === 'direct' ? 'original' : play.quality), () => { quality = q; load(video.currentTime); }, q === 'original' ? fmtBitrate(cur.bitrate) : 'omgezet')));
        if (cur.audio.length > 1) p.append(h('h4', 'Audio'), cur.audio.map((a) => opt(`${(a.lang || 'und').toUpperCase()} · ${a.codec.toUpperCase()}${a.title ? ' · ' + a.title : ''}`, a.index === audio, () => {
          // The browser can't switch tracks inside a file, so another track means a server-side conversion.
          audio = a.index; audioChosen = true; savePref({ audioLang: a.lang && a.lang !== 'und' ? a.lang : '' }); if (quality === 'original') quality = cur.qualities[1] || 'original'; load(video.currentTime);
        })));
        p.append(h('p.faint', { style: { padding: '8px 10px', fontSize: '12.5px' } }, `Bron: ${cur.server.name}${play.mode === 'hls' ? ' · wordt live omgezet' : ' · direct'}`));
      }
    }
    overlay.append(p);
  }

  // ---- progress --------------------------------------------------------------
  function report(finished = false, paused = false) {
    if (isGuest || !detail || !video.currentTime) return;
    api('/api/progress', { method: 'POST', body: { titleId: detail.id, episodeId: episode ? episode.id : 0, position: video.currentTime, duration: duration(), ...(finished ? { watched: true } : {}), ...(paused && !room ? { paused: true } : {}) } }).catch(() => {});
  }
  progressTimer = setInterval(() => { if (!video.paused) report(); }, 10_000);

  // ---- Watch Together ----------------------------------------------------------
  let log = null, memberBox = null;
  function send(type) { if (ws && ws.readyState === 1 && !suppress) ws.send(JSON.stringify({ t: type, position: video.currentTime })); }
  function applyState(st) {
    suppress = true;
    if (Math.abs(video.currentTime - st.position) > 1.2) video.currentTime = st.position;
    if (st.playing && video.paused) video.play().catch(() => {}); else if (!st.playing && !video.paused) video.pause();
    setTimeout(() => { suppress = false; }, 500);
  }
  const sys = (text) => { if (log) { log.append(h('div.sys', text)); log.scrollTop = log.scrollHeight; } };

  function connectRoom() {
    log = h('div.wt-log'); memberBox = h('div.wt-members');
    const input = h('input.input', { placeholder: 'Bericht…', maxLength: 300, style: { height: '40px' } });
    const side = h('aside.wt',
      h('div.wt-head', h('div.row', h('b.grow', 'Samen kijken'), h('span.badge', room.code), !isGuest && h('button.btn.sm', { onclick: () => inviteDialog(room.code) }, icon('link'), 'Link')), memberBox),
      log,
      h('div.wt-react', ['😂', '😱', '😍', '👏', '🔥', '😢'].map((e) => h('button', { 'aria-label': `Reactie ${e}`, onclick: () => ws && ws.send(JSON.stringify({ t: 'react', emoji: e })) }, e))),
      h('form.wt-form', { onsubmit: (e) => { e.preventDefault(); if (input.value.trim() && ws) { ws.send(JSON.stringify({ t: 'chat', text: input.value })); input.value = ''; } } }, input, h('button.btn.primary.sm', { style: { height: '40px' } }, icon('chat'))));
    el.append(side);
    const q = room.guest ? `guest=${encodeURIComponent(room.guest)}` : `token=${encodeURIComponent(state.token)}`;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/watch/${room.code}/ws?${q}`);
    let me = null;
    ws.onmessage = async (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'hello') { me = m.you; drawMembers(m.room.members); if (!voting) applyState(m.state); for (const c of m.chat || []) log.append(h('div.msg', h('b', c.from), c.text)); sys(voting ? 'Stem op een film; chatten kan alvast.' : 'Je kijkt nu samen. Iedereen kan pauzeren en spoelen.'); }
      else if (m.t === 'vote') { if (voting) drawVote(m.vote); }
      else if (m.t === 'slow') note('Rustig aan — je stuurt te snel achter elkaar.');
      else if (m.t === 'members') { drawMembers(m.members); if (m.joined) sys(`${m.joined} kijkt mee`); if (m.left) sys(`${m.left} is weg`); }
      else if (m.t === 'state') {
        if (m.byId !== me) { applyState(m.state); note(`${m.by} ${m.action === 'play' ? 'speelt af' : m.action === 'pause' ? 'pauzeert' : 'spoelt naar ' + fmtTime(m.state.position)}`); }
      } else if (m.t === 'load') {
        fileId = m.room.fileId; quality = 'original';
        if (voting) { endVote(); note(`Gekozen: ${m.winner || m.room.title?.title || ''}`); if (!isGuest && m.room.title) { try { await loadDetail(m.room.title.id); } catch { /* room info is enough */ } } }
        if (m.room.title) { detail = { ...(detail || {}), id: m.room.title.id, title: m.room.title.title, year: m.room.title.year }; }
        if (m.room.episode) { episode = episodes.find((e) => e.id === m.room.episode.id) || m.room.episode; if (episode.versions) versions = episode.versions; }
        sys(`${m.by} start ${m.room.episode ? `S${m.room.episode.season} A${m.room.episode.episode}` : 'een andere versie'}`);
        await load(0, false);
      } else if (m.t === 'chat') { log.append(h('div.msg', h('b', m.from), m.text)); log.scrollTop = log.scrollHeight; }
      else if (m.t === 'react') { const f = h('div.float-emoji', { style: { left: `${20 + Math.random() * 60}%` } }, m.emoji); stage.append(f); setTimeout(() => f.remove(), 2700); }
    };
    ws.onclose = () => { if (!closed) sys('Verbinding verbroken.'); };
    function drawMembers(list) { memberBox.replaceChildren(list.map((u) => h(`div.avatar.${u.avatar}`, { title: u.name + (u.guest ? ' (gast)' : '') }, u.name[0]))); }
  }

  // Watch Night vote: three picks, everyone in the room chooses, the winner starts for all.
  function drawVote(v) {
    voting = v;
    clearInterval(voteTick);
    if (voteEl) voteEl.remove();
    const left = h('b');
    const tick = () => { const s = Math.max(0, Math.round((v.endsAt - Date.now()) / 1000)); left.textContent = s > 0 ? `nog ${s} s` : 'de stemmen worden geteld…'; };
    tick(); voteTick = setInterval(tick, 1000);
    voteEl = h('div.vote', h('div.vote-in', h('h2', 'Welke film wordt het?'), h('p.muted', 'Iedereen in de kamer stemt. Bij een meerderheid of als de tijd om is start de winnaar voor iedereen · ', left),
      h('div.vote-opts', v.options.map((o) => h(`button.vote-opt${myVote === o.id ? '.on' : ''}`, { onclick: () => { myVote = o.id; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'vote', titleId: o.id })); drawVote(voting); } },
        o.poster ? h('img', { src: o.poster, alt: '' }) : h('div.fallback', o.title), h('b', o.title), h('small', `${v.counts[o.id] || 0} ${(v.counts[o.id] || 0) === 1 ? 'stem' : 'stemmen'}`)))),
      !isGuest && h('div.row', { style: { justifyContent: 'center', marginTop: '18px' } }, h('button.btn', { onclick: () => inviteDialog(room.code) }, icon('link'), 'Mensen uitnodigen'))));
    stage.append(voteEl);
  }
  function endVote() { clearInterval(voteTick); if (voteEl) { voteEl.remove(); voteEl = null; } voting = null; }

  async function startRoom() {
    if (room) return inviteDialog(room.code);
    try {
      const r = await api('/api/watch', { method: 'POST', body: { fileId, position: video.currentTime } });
      report(); closed = true; cleanup(); go(`/w/${r.code}`);
    } catch (e) { toast(e.message, 'bad'); }
  }

  // ---- keyboard / close --------------------------------------------------------
  function onKey(e) {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowLeft') jump(-10); else if (e.key === 'ArrowRight') jump(10);
    else if (e.key === 'f') { if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen().catch(() => {}); }
    else if (e.key === 'm') { video.muted = !video.muted; drawVol(); }
    else if (e.key === 's' && skipEl) skipEl.querySelector('button').click();
    else if (e.key === 'Escape') { const p = overlay.querySelector('.p-panel'); if (p) p.remove(); else if (!document.fullscreenElement) close(); }
    wake();
  }
  document.addEventListener('keydown', onKey);
  function cleanup() {
    clearInterval(progressTimer); clearInterval(countdown); clearInterval(voteTick); clearTimeout(idleTimer); clearTimeout(offsetTimer);
    document.removeEventListener('keydown', onKey);
    if (ws) { ws.onclose = null; ws.close(); }
    if (hls) hls.destroy();
    video.removeAttribute('src'); video.load();
    if (play && play.sessionId && !room) api(`/api/hls/${play.sessionId}`, { method: 'DELETE' }).catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    unmount();
  }
  function close() {
    if (closed) return; closed = true;
    report(); cleanup();
    if (room) go(state.user ? '/' : '/login'); else if (location.pathname === '/') window.dispatchEvent(new Event('popstate')); // refresh "continue watching"
  }

  // ---- boot ------------------------------------------------------------------------
  spinner(true);
  try {
    let position = opts.resume || 0, autoplay = true;
    if (room) {
      // The room decides what plays; account holders also get the full detail for versions/next episode.
      const info = await api(`/api/watch/${room.code}`);
      fileId = info.fileId; detail = info.title; episode = info.episode;
      if (!fileId && info.vote) voting = info.vote;
      if (!isGuest && info.title) { try { await loadDetail(info.title.id, info.episode && info.episode.id); } catch { /* guest-level info is enough */ } }
      autoplay = false;
    } else {
      await loadDetail(opts.titleId, opts.episodeId);
      if (!fileId) fileId = versions[0] && versions[0].fileId;
      if (!position && !opts.episodeId && detail.kind === 'movie' && opts.resume === undefined && detail.progress && !detail.progress.watched) position = detail.progress.position;
    }
    if (!fileId && !voting) throw new Error('Er is geen afspeelbare versie van deze titel.');
    if (voting) { spinner(false); title.textContent = 'Watch Night'; sub.textContent = 'Stem samen op de film'; connectRoom(); drawVote(voting); }
    else { await load(position, autoplay); if (room) connectRoom(); }
  } catch (e) { toast(e.message, 'bad'); closed = true; cleanup(); if (room) go('/'); }

  async function loadDetail(titleId, episodeId) {
    detail = await api(`/api/titles/${titleId}`);
    if (detail.kind === 'show') {
      episodes = detail.seasons.flatMap((s) => s.episodes);
      episode = episodes.find((e) => e.id === (episodeId || (detail.nextUp && detail.nextUp.episodeId))) || episodes[0];
      versions = episode ? episode.versions : [];
      if (!opts.resume && episode && episode.progress && !episode.progress.watched && !room) opts.resume = episode.progress.position;
    } else versions = detail.versions;
  }
}

// ---------------------------------------------------------------------------
// Joining a room through an invite link
// ---------------------------------------------------------------------------
export async function joinRoomView({ code }) {
  code = code.toUpperCase();
  const { setView } = await import('./core.js');
  let info;
  try { info = await api(`/api/watch/${code}`); }
  catch (e) { setView(h('div.auth', h('div.auth-card', h('div.logo', h('span', 'Kinoko')), h('h1', 'Kijksessie niet gevonden'), h('p', e.message), h('a.btn.primary', { href: '/' }, 'Naar Kinoko')))); return; }
  const begin = (guest) => { setView(h('div')); startPlayback({ room: { code, guest } }); };
  if (state.user) {
    // Signed-in users go straight in; show the invite once to the person who just created the room.
    begin(null);
    if (info.host === state.user.name && !info.members.length) setTimeout(() => inviteDialog(code), 600);
    return;
  }
  const name = h('input.input', { placeholder: 'Je naam', maxLength: 24, autofocus: true, value: localStorage.getItem('kinoko_guest_name') || '' });
  setView(h('div.auth', h('form.auth-card', { onsubmit: (e) => { e.preventDefault(); act(e.submitter, async () => {
    const r = await api(`/api/watch/${code}/guest`, { method: 'POST', body: { name: name.value } });
    localStorage.setItem('kinoko_guest_name', r.name); begin(r.guest);
  }); } },
    h('div.logo', h('span', 'Kinoko')),
    info.title && info.title.backdrop && h('img', { src: info.title.backdrop, alt: '', style: { borderRadius: '14px', marginTop: '20px', aspectRatio: '16/9', objectFit: 'cover', width: '100%' } }),
    h('h1', `${info.host} nodigt je uit`),
    h('p', `Kijk samen naar ${info.title ? info.title.title : 'een film'}${info.episode ? ` — S${info.episode.season} A${info.episode.episode}` : ''}. Pauzeren en spoelen gaat voor iedereen tegelijk.`),
    h('label.field', h('span', 'Hoe heet je?'), name),
    h('button.btn.primary.lg', { style: { width: '100%', marginTop: '18px' } }, icon('play'), 'Meekijken'),
    h('p.faint', { style: { marginTop: '14px', fontSize: '13px', textAlign: 'center' } }, 'Heb je een account op deze server? ', h('a', { href: `/login?next=/w/${code}` }, 'Log in'),
      ' · ', h('a', { href: `kinoko://w/${code}`, target: '_self' }, 'Open in de Kinoko-app')))));
}

// ---------------------------------------------------------------------------
// Bonus material (trailers, featurettes): a plain player, no progress kept
// ---------------------------------------------------------------------------
export function playExtra(x) {
  const video = h('video', { autoplay: true, controls: true, playsInline: true });
  let hls = null, session = null;
  const el = h('div.player', h('div.stage', video, h('div.p-top', { style: { position: 'absolute', top: 0, left: 0, right: 0, background: 'linear-gradient(#000b, transparent)' } },
    h('button.icon-btn', { 'aria-label': 'Terug', onclick: () => close() }, icon('back')), h('div.grow', h('h2', x.name), h('small', x.label)))));
  const unmount = mountLayer(el);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { if (hls) hls.destroy(); video.removeAttribute('src'); video.load(); document.removeEventListener('keydown', onKey); if (session) api(`/api/hls/${session}`, { method: 'DELETE' }).catch(() => {}); unmount(); }
  video.addEventListener('ended', close);
  api(`/api/extras/${x.id}/play`, { method: 'POST', body: { caps: browserCaps() } }).then((r) => {
    session = r.sessionId || null;
    if (r.mode === 'hls' && window.Hls && window.Hls.isSupported()) { hls = new window.Hls(); hls.loadSource(r.url); hls.attachMedia(video); hls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {})); }
    else video.src = r.url;
  }).catch((e) => { toast(e.message, 'bad'); close(); });
}

// ---------------------------------------------------------------------------
// Live TV (minimal player)
// ---------------------------------------------------------------------------
export function playChannel(c) {
  const video = h('video', { autoplay: true, controls: true, playsInline: true });
  let hls = null;
  const epg = h('small');
  const el = h('div.player', h('div.stage', video, h('div.p-top', { style: { position: 'absolute', top: 0, left: 0, right: 0, background: 'linear-gradient(#000b, transparent)' } },
    h('button.icon-btn', { 'aria-label': 'Terug', onclick: () => close() }, icon('back')), h('div.grow', h('h2', c.name), epg))));
  const unmount = mountLayer(el);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { closed = true; if (hls) hls.destroy(); video.removeAttribute('src'); video.load(); document.removeEventListener('keydown', onKey); unmount(); }
  let closed = false;
  const busy = h('div.p-center', h('div.spin'));
  el.querySelector('.stage').append(busy);
  video.addEventListener('playing', () => busy.remove());
  const fail = (msg) => { if (closed) return; busy.remove(); toast(msg || 'Deze zender geeft op dit moment geen beeld.', 'bad'); };
  // The server repackages the channel as HLS, so it plays in any browser and
  // the provider is never contacted from here.
  api(`/api/iptv/${c.id}/live`, { method: 'POST' }).then((r) => {
    if (closed) return;
    if (window.Hls && window.Hls.isSupported()) {
      let retries = 0;
      hls = new window.Hls({ liveSyncDurationCount: 3, manifestLoadingMaxRetry: 4 });
      hls.loadSource(r.url); hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      hls.on(window.Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR && retries++ < 3) return hls.recoverMediaError();
        fail(d.type === window.Hls.ErrorTypes.MEDIA_ERROR ? 'Je browser kan het videoformaat van deze zender niet afspelen. In de Kinoko-app werkt hij wel.' : null);
      });
    } else { video.src = r.url; video.addEventListener('error', () => fail(), { once: true }); }
  }).catch((e) => fail(e.message));
  api(`/api/iptv/${c.id}/epg`).then((r) => { if (r.programs[0]) epg.textContent = `Nu: ${r.programs[0].title}${r.programs[1] ? ' · Straks: ' + r.programs[1].title : ''}`; }).catch(() => {});
}
