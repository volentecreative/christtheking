/* Christ the King — sermon player (registered script `mediaPlayer`, site-wide footer).
 *
 * Stage   .video-embed[data-video] on the Media Template: data-youtube-id, data-audio-url,
 *         optional data-audio-offset (seconds the MP3 runs ahead of the video).
 * Switch  [data-player-modes] > [data-player-mode="watch|listen"] below the stage (Designer).
 *         Shown only when both sources exist; the chosen one gets .is-active.
 * Watch   the YouTube embed, created in the stage on first use.
 * Listen  the stage keeps its 16:9 size: the video fades to its thumbnail under the controls
 *         (.media-player_overlay: −15 / play / +15 and a scrubber). Once the audio has played
 *         and the stage is off screen, the bar (media-player_bar) docks to the bottom
 *         (.is-visible). Same-site links then load in place so the audio carries on; when it
 *         ends, the next part in the series ([data-series-next]) loads and plays.
 * Drawer  in listen mode, a click on the docked bar opens the player (.media-drawer) with the same controls: a sheet on phones, a card over the bar on desktop.
 * Mode    cookie ctk-playback-mode (watch|listen), written only by a tap on the switch.
 * Mobile  ≤991px (the site's tablet breakpoint, as the transcript sheet): a playing video that
 *         scrolls fully off screen hands over to the audio once. If the browser blocks audio
 *         without a tap, the video keeps playing and the docked bar offers Continue listening.
 * API     window.ctkPlayer: hasVideo, hasAudio, getMode, getTime, getDuration, isPlaying, play,
 *         pause, toggle, seek(s, {play}), setMode(mode). Times are on the video's clock.
 * Events  ctk:player:play · pause · ended · mode · navigate, on document.
 */
(function () {
  'use strict';
  var w = window, d = document;
  if (w.ctkPlayer) return;

  var COOKIE = 'ctk-playback-mode';
  var POS_KEY = 'ctk-player:positions';
  var mobile = w.matchMedia('(max-width: 991px)');
  var YT_ENDED = 0, YT_PLAYING = 1, YT_PAUSED = 2, YT_BUFFERING = 3;
  var ICON = {
    play: 'M320-200v-560l440 280-440 280Z',
    pause: 'M560-200v-560h160v560H560Zm-320 0v-560h160v560H240Z',
    replay: 'M480-80q-75 0-140.5-28.5t-114-77q-48.5-48.5-77-114T120-440h80q0 117 81.5 198.5T480-160q117 0 198.5-81.5T760-440q0-117-81.5-198.5T480-720h-6l62 62-56 58-160-160 160-160 56 58-62 62h6q75 0 140.5 28.5t114 77q48.5 48.5 77 114T840-440q0 75-28.5 140.5t-77 114q-48.5 48.5-114 77T480-80Z',
    up: 'M480-528 296-344l-56-56 240-240 240 240-56 56-184-184Z',
    close: 'm256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z',
    listen: 'M360-120H200q-33 0-56.5-23.5T120-200v-280q0-75 28.5-140.5t77-114q48.5-48.5 114-77T480-840q75 0 140.5 28.5t114 77q48.5 48.5 77 114T840-480v280q0 33-23.5 56.5T760-120H600v-320h160v-40q0-117-81.5-198.5T480-760q-117 0-198.5 81.5T200-480v40h160v320Zm-80-240h-80v160h80v-160Zm400 0v160h80v-160h-80Zm-400 0h-80 80Zm400 0h80-80Z'
  };

  var S = {
    mode: 'watch', videoId: null, audioUrl: null, offset: 0,
    title: '', artist: '', artwork: null, slug: '', known: 0, // known: CMS duration (s)
    played: false,     // either source has played on this sermon
    started: false,    // the audio has played on this sermon: the bar may dock
    dismissed: false,  // the docked bar was closed
    onStage: true,     // any of the stage is on screen
    handoff: 'idle',   // idle · trying · blocked (Continue listening shown) · spent · done
    unlocked: false, unlocking: false,
    videoAt: null,     // start time cued into a video that has not played yet
    pendingSeek: null, seekTries: 0, // audio seconds not yet reached by playing audio
    resumed: false, autoplay: false, lastTime: 0
  };
  var stage = null, modes = null, root, bar, els = {}, audio = null, io = null, drawer = null, dr = {};
  var yt = null, ytReady = false, ytQueue = [], iframe = null, poster = null;

  function $(sel, r) { return (r || d).querySelector(sel); }
  function el(tag, cls, attrs) {
    var n = d.createElement(tag);
    if (cls) n.className = cls;
    for (var k in attrs || {}) n.setAttribute(k, attrs[k]);
    return n;
  }
  function svg(path, cls) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="100%" fill="currentColor" aria-hidden="true"' +
      (cls ? ' class="' + cls + '"' : '') + '><path d="' + path + '"/></svg>';
  }
  function clamp(n, lo, hi) { return Math.min(Math.max(n, lo), hi); }
  function fmt(s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (x < 10 ? '0' : '') + x;
  }
  function emit(name, extra) {
    var detail = { player: api, mode: S.mode, time: api.getTime() };
    for (var k in extra || {}) detail[k] = extra[k];
    d.dispatchEvent(new CustomEvent('ctk:player:' + name, { bubbles: true, detail: detail }));
  }

  /* ---------- preference and positions ---------- */
  function savedMode() {
    try { var m = /(?:^|;\s*)ctk-playback-mode=(watch|listen)(?:;|$)/.exec(d.cookie); return m ? m[1] : null; } catch (e) { return null; }
  }
  function saveMode(mode) {
    try { d.cookie = COOKIE + '=' + mode + '; Max-Age=31536000; Path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : ''); } catch (e) { /* blocked */ }
  }
  function positions() { try { return JSON.parse(localStorage.getItem(POS_KEY)) || {}; } catch (e) { return {}; } }
  function savePos() {
    if (!S.slug || !S.played) return;
    var all = positions();
    all[S.slug] = { t: Math.floor(api.getTime()), at: Date.now() };
    var keys = Object.keys(all).sort(function (a, b) { return all[b].at - all[a].at; });
    keys.slice(50).forEach(function (k) { delete all[k]; });
    try { localStorage.setItem(POS_KEY, JSON.stringify(all)); } catch (e) { /* private mode */ }
  }
  // Where to pick up a sermon heard before: once per page, not near either end.
  function resumeAt() {
    if (S.resumed) return 0;
    S.resumed = true;
    var p = positions()[S.slug], dur = api.getDuration();
    return p && p.t > 15 && !(dur && p.t > dur - 30) ? p.t : 0;
  }

  /* ---------- audio ---------- */
  function ensureAudio() {
    if (!audio) {
      audio = new Audio();
      audio.preload = 'metadata';
      audio.setAttribute('playsinline', '');
      audio.addEventListener('playing', function () {
        if (S.unlocking) return;
        if (S.mode !== 'listen' && S.handoff !== 'trying') { audio.pause(); return; }
        S.played = S.started = true; S.dismissed = false;
        session(); place(); emit('play');
      });
      audio.addEventListener('pause', function () {
        if (S.unlocking || S.mode !== 'listen') return;
        savePos(); paint(); emit('pause');
      });
      audio.addEventListener('ended', ended);
      ['loadedmetadata', 'canplay', 'playing', 'seeked'].forEach(function (ev) { audio.addEventListener(ev, applySeek); });
      ['loadedmetadata', 'durationchange'].forEach(function (ev) { audio.addEventListener(ev, paint); });
      audio.addEventListener('timeupdate', function () {
        applySeek();
        if (S.mode !== 'listen') return;
        paint(); positionState();
        if (Math.floor(audio.currentTime) % 5 === 0) savePos();
      });
    }
    if (S.audioUrl && audio.getAttribute('src') !== S.audioUrl) { audio.src = S.audioUrl; S.pendingSeek = null; }
    return audio;
  }
  function clampAudio(x) {
    var dur = Math.max(audio && isFinite(audio.duration) ? audio.duration : 0, S.known + S.offset);
    return dur > 1 ? clamp(x, 0, dur - 1) : Math.max(0, x);
  }
  // Seek on the video's clock. iOS can drop a seek made before playback starts, so it stays
  // pending (and is re-applied) until playing audio has reached it.
  function seekAudio(t) {
    ensureAudio();
    S.pendingSeek = t + S.offset; S.seekTries = 0;
    applySeek();
  }
  function applySeek() {
    if (S.pendingSeek === null || !audio || audio.readyState < 1) return;
    var target = clampAudio(S.pendingSeek);
    if (Math.abs(audio.currentTime - target) < 1.5) { if (!audio.paused && audio.readyState >= 3) S.pendingSeek = null; return; }
    if (++S.seekTries > 40) { S.pendingSeek = null; return; }
    try { audio.currentTime = target; } catch (e) { /* not seekable yet */ }
  }
  function startAudio() {
    var p = ensureAudio().play();
    if (p && p.catch) p.catch(paint);
  }
  // iOS lets code start an <audio> only once a tap has played it. The first tap on the page
  // (outside YouTube's frame) plays it muted for an instant, so a later hand-off can start.
  function unlock() {
    if (S.unlocked || S.unlocking || S.mode !== 'watch' || !S.audioUrl || !mobile.matches) return;
    var a = ensureAudio();
    if (!a.paused) return;
    S.unlocking = true;
    a.muted = true;
    var p = a.play();
    function done(ok) {
      if (ok) S.unlocked = true;
      if (!S.unlocking) return;
      S.unlocking = false;
      if (S.handoff !== 'trying') a.pause();
      a.muted = false;
    }
    if (p && p.then) p.then(function () { done(true); }, function () { done(false); });
  }
  function cancelUnlock() { if (S.unlocking) { S.unlocking = false; audio.pause(); audio.muted = false; } }

  /* ---------- video ---------- */
  function ytPlaying() {
    var s = ytReady && yt.getPlayerState ? yt.getPlayerState() : -1;
    return s === YT_PLAYING || s === YT_BUFFERING;
  }
  function ytTime() {
    if (S.videoAt !== null) return S.videoAt;
    if (ytReady && yt.getCurrentTime) { var t = yt.getCurrentTime(); if (t >= 0) S.lastTime = t; }
    return S.lastTime;
  }
  function ytDuration() { return ytReady && yt.getDuration ? yt.getDuration() || 0 : 0; }
  // Runs fn once the YouTube player is ready, creating it on first use.
  function withVideo(fn) {
    if (!S.videoId || !stage) return;
    if (ytReady) { fn(); return; }
    ytQueue.push(fn);
    if (iframe) return;
    iframe = el('iframe', null, {
      src: 'https://www.youtube.com/embed/' + encodeURIComponent(S.videoId) +
        '?rel=0&modestbranding=1&playsinline=1&enablejsapi=1&origin=' + encodeURIComponent(location.origin),
      title: S.title || 'Sermon video', frameborder: '0', allowfullscreen: '',
      allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
      referrerpolicy: 'strict-origin-when-cross-origin'
    });
    stage.insertBefore(iframe, poster ? poster.nextSibling : stage.firstChild);
    var mine = iframe;
    youtubeAPI(function () {
      if (mine !== iframe) return; // replaced by another sermon meanwhile
      yt = new w.YT.Player(mine, { events: {
        onReady: function () { if (mine !== iframe) return; ytReady = true; var q = ytQueue; ytQueue = []; q.forEach(function (f) { f(); }); },
        onStateChange: onVideo
      } });
    });
  }
  function youtubeAPI(cb) {
    if (w.YT && w.YT.Player) return cb();
    var prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = function () { if (typeof prev === 'function') prev(); cb(); };
    if (!$('script[src*="youtube.com/iframe_api"]')) d.head.appendChild(el('script', null, { src: 'https://www.youtube.com/iframe_api' }));
  }
  function onVideo(e) {
    if (e.data === YT_BUFFERING && S.mode !== 'watch') { yt.pauseVideo(); return; }
    if (e.data === YT_PLAYING) {
      S.videoAt = null;
      if (S.mode !== 'watch') { yt.pauseVideo(); return; }
      S.played = true;
      if (audio && !audio.paused && S.handoff !== 'trying') audio.pause();
      var t = resumeAt();
      if (t) yt.seekTo(t, true);
      emit('play');
    } else if (e.data === YT_PAUSED || e.data === YT_ENDED) {
      if (S.mode !== 'watch') return;
      ytTime(); savePos();
      if (S.handoff === 'blocked') { S.handoff = 'spent'; place(); }
      emit(e.data === YT_ENDED ? 'ended' : 'pause');
    }
  }
  function seekVideo(t, play) {
    withVideo(function () {
      var s = yt.getPlayerState ? yt.getPlayerState() : -1;
      t = Math.min(t, ytDuration() ? ytDuration() - 1 : t);
      S.lastTime = t;
      // A video that has never played (always the case on iOS until its own play button is
      // tapped) ignores seekTo; loading it with a start time sticks, even if iOS blocks the play.
      if (s === -1 || s === 5) {
        S.videoAt = t;
        yt[play ? 'loadVideoById' : 'cueVideoById']({ videoId: S.videoId, startSeconds: t });
      } else {
        yt.seekTo(t, true);
        if (play) yt.playVideo();
      }
    });
  }

  /* ---------- modes ---------- */
  function has(mode) { return mode === 'listen' ? !!S.audioUrl : !!S.videoId; }
  function show(mode) {
    S.mode = mode;
    if (stage) stage.setAttribute('data-player-mode', mode);
    if (mode === 'listen') { if (ytPlaying()) yt.pauseVideo(); }
    else { if (audio && !audio.paused) audio.pause(); closeDrawer(); }
    if (modes) Array.prototype.forEach.call(modes.querySelectorAll('[data-player-mode]'), function (b) {
      var on = b.getAttribute('data-player-mode') === mode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    place();
  }
  // how: 'user' (the switch: remembered) · 'continue' (the blocked hand-off) · anything else.
  function setMode(mode, how) {
    if (!has(mode)) return;
    if (how === 'user') saveMode(mode);
    if (mode === S.mode) return;
    var t = api.getTime(), playing = api.isPlaying();
    S.resumed = true; // the switch carries the position; no jump to a remembered one
    // A hand-off happens once per sermon; choosing Watch again also ends it.
    S.handoff = how === 'continue' || mode === 'watch' ? 'done' : 'idle';
    if (mode === 'listen') {
      cancelUnlock();
      seekAudio(t);
      show('listen');
      if (playing) startAudio(); // inside the tap: allowed everywhere
    } else {
      show('watch');
      seekVideo(t, playing);
    }
    emit('mode');
  }
  // A playing video left the screen on a phone: try the audio before stopping the video.
  function handoff() {
    S.handoff = 'trying';
    var a = ensureAudio();
    cancelUnlock();
    seekAudio(ytTime());
    if (yt.mute) yt.mute(); // no echo while the audio starts
    var p = a.play();
    (p && p.then ? p : Promise.resolve()).then(function () {
      if (S.handoff !== 'trying') return;
      S.handoff = 'done';
      show('listen');
      if (yt.unMute) yt.unMute();
      emit('mode', { auto: true });
    }, function () {
      if (S.handoff !== 'trying') return;
      S.handoff = 'blocked'; // the video carries on; the bar offers one tap
      if (yt.unMute) yt.unMute();
      place();
    });
  }
  function ended() {
    savePos(); emit('ended');
    var next = $('[data-series-next]');
    if (S.mode === 'listen' && next && next.getAttribute('aria-hidden') !== 'true' && next.href && next.href.indexOf('#') === -1) {
      S.autoplay = true;
      nav.go(next.href, true);
    } else paint();
  }

  /* ---------- controls: the docked bar, the stage overlay and the drawer ---------- */
  var sets = [], overlay = null; // full control sets (stage overlay, drawer), painted together
  function key(fn) { return function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } }; }
  function back() { if (stage) stage.scrollIntoView({ behavior: 'smooth', block: 'center' }); else if (S.href) nav.go(S.href, true); }
  function openOrBack() { if (S.mode === 'listen') openDrawer(); else back(); }
  // A large scrubber with times and −15 / play / +15. In the stage the buttons sit above.
  function controlSet(parent, inStage) {
    var c = {};
    c.scrub = el('div', 'media-controls_scrub', { role: 'slider', tabindex: '0', 'aria-label': 'Position', 'aria-valuemin': '0' });
    var track = c.track = el('div', 'media-controls_track');
    c.thumb = el('div', 'media-controls_thumb');
    c.bubble = el('div', 'media-controls_bubble text-style-mono', { 'aria-hidden': 'true' }); // the time while dragging
    [el('div', 'media-controls_fill'), c.thumb, c.bubble].forEach(function (n) { track.appendChild(n); });
    c.scrub.appendChild(track);
    var times = el('div', 'media-controls_times');
    c.elapsed = el('div', 'text-style-media-meta'); c.left = el('div', 'text-style-media-meta');
    times.appendChild(c.elapsed); times.appendChild(c.left);
    var buttons = el('div', 'media-controls_buttons' + (inStage ? ' is-overlay' : ''));
    function skip(sec) {
      var b = el('button', 'media-player_btn is-skip', { type: 'button', 'aria-label': (sec < 0 ? 'Back ' : 'Forward ') + Math.abs(sec) + ' seconds' });
      b.innerHTML = svg(ICON.replay, sec > 0 ? 'is-forward' : '') + '<span class="media-controls_skip-label" aria-hidden="true">' + Math.abs(sec) + '</span>';
      b.addEventListener('click', function () { api.seek(api.getTime() + sec); });
      return b;
    }
    c.play = el('button', 'media-player_btn is-play is-large', { type: 'button' });
    c.play.innerHTML = svg(ICON.play);
    c.playPath = c.play.querySelector('path');
    c.play.addEventListener('click', function () { api.toggle(); });
    buttons.appendChild(skip(-15)); buttons.appendChild(c.play); buttons.appendChild(skip(15));
    var timeline = el('div', 'media-controls_timeline'); // scrubber + times: one piece in both places
    timeline.appendChild(c.scrub); timeline.appendChild(times);
    (inStage ? [buttons, timeline] : [timeline, buttons]).forEach(function (n) { parent.appendChild(n); });
    scrubbing(c.scrub, track);
    sets.push(c);
    return c;
  }
  function build() {
    root = el('div', 'media-player', { 'data-player': 'root', role: 'region', 'aria-label': 'Sermon audio player' });
    bar = el('div', 'media-player_bar', { 'data-player': 'bar' });
    els.info = el('div', 'media-player_info', { role: 'button', tabindex: '0' });
    els.title = el('div', 'text-style-title-small media-player_title');
    els.title.appendChild(el('span'));
    els.time = el('div', 'media-player_time', { 'aria-hidden': 'true' });
    els.elapsed = el('div', 'text-style-media-meta');
    els.progress = el('div', 'media-player_progress');
    els.progress.appendChild(el('div', 'media-player_progress-fill'));
    els.duration = el('div', 'text-style-media-meta');
    els.time.appendChild(els.elapsed); els.time.appendChild(els.progress); els.time.appendChild(els.duration);
    els.info.appendChild(els.title); els.info.appendChild(els.time);

    var controls = el('div', 'media-player_controls');
    els.play = el('button', 'media-player_btn is-play', { type: 'button', 'data-player': 'play' });
    els.play.innerHTML = svg(ICON.play);
    els.playPath = els.play.querySelector('path');
    // Continue listening: the site's primary button, shown only after a blocked hand-off.
    els.cont = el('a', 'button', { href: '#', role: 'button', 'data-player': 'continue', 'data-player-nav': 'off' });
    els.cont.innerHTML = '<div class="button-type">' + svg(ICON.listen, 'button-icon') + '<p class="text-button">Continue listening</p><div class="button-sheen"></div></div>';
    // Phones open the drawer; desktop (and a blocked hand-off) can close the bar.
    els.expand = el('a', 'icon-button', { href: '#', role: 'button', 'aria-label': 'Open player', 'data-player': 'expand', 'data-player-nav': 'off' });
    els.expand.innerHTML = svg(ICON.up);
    els.close = el('a', 'icon-button', { href: '#', role: 'button', 'aria-label': 'Close player', 'data-player': 'close', 'data-player-nav': 'off' });
    els.close.innerHTML = svg(ICON.close);
    [els.play, els.cont, els.expand, els.close].forEach(function (n) { controls.appendChild(n); });
    bar.appendChild(els.info); bar.appendChild(controls);
    root.appendChild(bar);
    d.body.appendChild(root);

    function close() {
      if (S.handoff === 'blocked') S.handoff = 'spent';
      else { api.pause(); S.dismissed = true; }
      place();
    }
    function cont() { setMode('listen', 'continue'); }
    [[els.cont, cont], [els.expand, openDrawer], [els.close, close]].forEach(function (x) {
      x[0].addEventListener('click', function (e) { e.preventDefault(); x[1](); });
      x[0].addEventListener('keydown', key(x[1]));
    });
    els.play.addEventListener('click', function () { api.toggle(); });
    // The whole bar opens the player; only its buttons do something else.
    bar.addEventListener('click', function (e) { if (!e.target.closest('button, a')) openOrBack(); });
    els.info.addEventListener('keydown', function (e) { if (e.target === els.info) key(openOrBack)(e); });

    overlay = el('div', 'media-player_overlay', { 'data-player': 'overlay' });
    controlSet(overlay, true);
    buildDrawer();
  }

  /* ---------- the drawer: a sheet on phones, a card over the bar on desktop ---------- */
  function buildDrawer() {
    drawer = el('div', 'media-drawer', { 'data-player': 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Audio player' });
    var scrim = el('div', 'media-drawer_scrim');
    var panel = el('div', 'media-drawer_panel');
    dr.art = el('img', 'media-drawer_art', { alt: '' });
    // Header as on the site's other drawers (filters, transcript): grab, title, close.
    var header = el('div', 'modal_header');
    header.innerHTML = '<div class="modal_title">' + svg(ICON.listen, 'button-icon') + '<h2 class="heading-style-h5">Now playing</h2></div>';
    dr.close = el('button', 'modal_close', { type: 'button', 'aria-label': 'Close player' });
    dr.close.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true" class="button-icon"><path d="M18 6 6 18M6 6l12 12"></path></svg>';
    header.appendChild(dr.close);
    var head = el('div', 'media-drawer_head'), text = el('div', 'media-drawer_text');
    dr.title = el('div', 'text-style-title-small media-player_title');
    dr.title.appendChild(el('span'));
    dr.artist = el('div', 'text-style-media-meta');
    text.appendChild(dr.title); text.appendChild(dr.artist);
    head.appendChild(text);
    [el('div', 'media-drawer_grab', { 'aria-hidden': 'true' }), header, dr.art, head].forEach(function (n) { panel.appendChild(n); });
    dr.set = controlSet(panel, false);
    drawer.appendChild(scrim); drawer.appendChild(panel);
    drawer.inert = true;
    root.appendChild(drawer);

    scrim.addEventListener('click', closeDrawer);
    dr.close.addEventListener('click', closeDrawer);
    dr.art.addEventListener('click', function () { if (!dragged) { closeDrawer(); back(); } });
    drawer.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
    // Drag the sheet down to close it.
    var y0 = null, dy = 0, dragged = false;
    panel.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button, [role="slider"]')) return;
      y0 = e.clientY; dy = 0; dragged = false;
    });
    panel.addEventListener('pointermove', function (e) {
      if (y0 === null) return;
      dy = Math.max(0, e.clientY - y0);
      if (dy > 4 && !dragged) { dragged = true; drawer.classList.add('is-dragging'); if (panel.setPointerCapture) panel.setPointerCapture(e.pointerId); }
      drawer.style.setProperty('--drawer-drag', dy + 'px');
    });
    function release() {
      if (y0 === null) return;
      y0 = null;
      drawer.classList.remove('is-dragging');
      drawer.style.removeProperty('--drawer-drag');
      if (dy > 80) closeDrawer();
      setTimeout(function () { dragged = false; }, 0);
    }
    panel.addEventListener('pointerup', release);
    panel.addEventListener('pointercancel', release);
  }
  var lastFocus = null;
  function openDrawer() {
    if (drawer.classList.contains('is-visible') || S.mode !== 'listen') return;
    lastFocus = d.activeElement;
    var src = poster ? poster.currentSrc || poster.src : S.artwork;
    dr.art.style.display = src ? '' : 'none';
    if (src && dr.art.getAttribute('src') !== src) dr.art.src = src;
    drawer.inert = false;
    drawer.classList.add('is-visible');
    d.documentElement.classList.add('has-player-drawer');
    paint();
    dr.set.play.focus({ preventScroll: true });
  }
  function closeDrawer() {
    if (!drawer || !drawer.classList.contains('is-visible')) return;
    drawer.classList.remove('is-visible');
    drawer.inert = true;
    d.documentElement.classList.remove('has-player-drawer');
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }
  // Docked once the audio has played and the stage is off screen (or on another page);
  // also docked with Continue listening after a blocked hand-off while the stage is away.
  function place() {
    if (!bar) return;
    var away = !stage || !S.onStage;
    var docked = away && (S.mode === 'listen' ? S.started && !S.dismissed : S.handoff === 'blocked');
    bar.classList.toggle('is-visible', docked);
    bar.setAttribute('data-state', S.mode === 'watch' && S.handoff === 'blocked' ? 'blocked' : '');
    bar.inert = !docked;
    d.body.classList.toggle('has-player-dock', docked);
    paint();
    if (docked) d.documentElement.style.setProperty('--player-dock-height', bar.offsetHeight + 'px');
    else d.documentElement.style.removeProperty('--player-dock-height');
  }
  // A title too long for its line scrolls while playing, as Spotify does.
  function title(box, playing) {
    var span = box.firstChild;
    if (span.textContent !== S.title) span.textContent = S.title;
    var key = S.title + '|' + playing + '|' + box.clientWidth;
    if (box._key === key) return;
    box._key = key;
    var over = span.scrollWidth - box.clientWidth, run = playing && over > 4;
    box.classList.toggle('is-marquee', run);
    if (!run) return;
    var shift = over + box.clientWidth * 0.2; // ends clear of the fade on the right
    box.style.setProperty('--marquee-shift', -shift + 'px');
    box.style.setProperty('--marquee-time', (shift / 30 / 0.6).toFixed(1) + 's'); // 30px/s over the moving 60%
  }
  var scrubAt = null;
  function paint() {
    if (!bar) return;
    var playing = S.mode === 'listen' && api.isPlaying();
    var dur = S.mode === 'listen' ? api.getDuration() : 0;
    var t = scrubAt === null ? api.getTime() : scrubAt * dur;
    var pct = (dur ? clamp(t / dur, 0, 1) * 100 : 0).toFixed(2) + '%';
    els.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    els.playPath.setAttribute('d', playing ? ICON.pause : ICON.play);
    title(els.title, playing);
    els.info.setAttribute('aria-label', S.title + (S.mode === 'listen' ? ' — open player' : ' — back to the sermon'));
    els.elapsed.textContent = fmt(t);
    els.elapsed.style.minWidth = dur ? fmt(dur).length + 'ch' : '';
    els.duration.textContent = dur ? fmt(dur) : '';
    els.progress.style.setProperty('--player-progress', pct);
    sets.forEach(function (c) {
      c.scrub.style.setProperty('--player-progress', pct);
      c.scrub.style.setProperty('--player-progress-n', (dur ? clamp(t / dur, 0, 1) : 0).toFixed(4));
      c.scrub.setAttribute('aria-valuemax', String(Math.round(dur)));
      c.scrub.setAttribute('aria-valuenow', String(Math.round(t)));
      c.scrub.setAttribute('aria-valuetext', fmt(t) + (dur ? ' of ' + fmt(dur) : ''));
      c.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      c.playPath.setAttribute('d', playing ? ICON.pause : ICON.play);
      c.elapsed.textContent = fmt(t);
      if (c.scrub.classList.contains('is-scrubbing')) {
        c.bubble.textContent = fmt(t);
        var tw = c.track.offsetWidth, th = c.thumb.offsetWidth, bw = c.bubble.offsetWidth;
        var mid = (tw - th) * (dur ? clamp(t / dur, 0, 1) : 0) + th / 2; // over the thumb, kept within the track
        c.bubble.style.left = clamp(mid - bw / 2, 0, Math.max(0, tw - bw)) + 'px';
      }
      c.left.textContent = dur ? '-' + fmt(dur - t) : '';
    });
    title(dr.title, playing);
    dr.artist.textContent = S.artist;
  }
  // pr takes the pointer and keys; the position is measured along track.
  function scrubbing(pr, track) {
    var thumb = track.querySelector('.media-controls_thumb');
    function at(e) { // along the thumb's travel, so it stays under the finger
      var r = track.getBoundingClientRect(), tw = thumb ? thumb.offsetWidth : 0;
      return r.width > tw ? clamp((e.clientX - r.left - tw / 2) / (r.width - tw), 0, 1) : 0;
    }
    pr.addEventListener('pointerdown', function (e) {
      if (!api.getDuration()) return;
      scrubAt = at(e);
      pr.classList.add('is-scrubbing');
      if (pr.setPointerCapture) pr.setPointerCapture(e.pointerId);
      paint(); e.preventDefault();
    });
    pr.addEventListener('pointermove', function (e) { if (scrubAt !== null) { scrubAt = at(e); paint(); } });
    pr.addEventListener('pointerup', function () {
      if (scrubAt === null) return;
      var f = scrubAt; scrubAt = null;
      pr.classList.remove('is-scrubbing');
      api.seek(f * api.getDuration());
    });
    pr.addEventListener('pointercancel', function () { scrubAt = null; pr.classList.remove('is-scrubbing'); paint(); });
    pr.addEventListener('keydown', function (e) {
      var dur = api.getDuration(), t = api.getTime(), step = e.shiftKey ? 30 : 5;
      if (!dur) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') t += step;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') t -= step;
      else if (e.key === 'Home') t = 0;
      else if (e.key === 'End') t = dur;
      else return;
      e.preventDefault();
      api.seek(clamp(t, 0, dur));
    });
  }
  function css() {
    var s = el('style', null, { 'data-player-style': '' });
    s.textContent = [
      '.media-player{display:contents}',
      '.video-embed > iframe,.video-embed > [data-player="poster"]{position:absolute;inset:0;display:block;width:100%;height:100%;border:0;transition:opacity .35s ease,visibility .35s,filter .35s ease}',
      '.video-embed > [data-player="poster"]{object-fit:cover}',
      '.video-embed > [data-player="overlay"]{transition:opacity .35s ease,visibility .35s}',
      '.video-embed:not([data-player-mode="listen"]) > [data-player="overlay"]{opacity:0;visibility:hidden}',
      '.video-embed[data-player-mode="listen"] > iframe{opacity:0;visibility:hidden;pointer-events:none}',
      '.video-embed[data-player-mode="listen"] > [data-player="poster"]{filter:brightness(.3)}',
      'button.media-player_btn{-webkit-appearance:none;appearance:none;margin:0;padding:0;border:0;font:inherit}',
      '.media-player_bar[data-state="blocked"] [data-player="expand"]{display:none}',
      '@media (min-width: 992px){.media-player_bar [data-player="expand"]{display:none}}',
      '@media (max-width: 991px){.media-player_bar:not([data-state="blocked"]) [data-player="close"]{display:none}}',
      '.media-player_bar:not([data-state="blocked"]) [data-player="continue"],.media-player_bar[data-state="blocked"] [data-player="play"],.media-player_bar[data-state="blocked"] .media-player_time{display:none}',
      '.media-player_time > :empty{display:none}',
      '.media-player_progress > .media-player_progress-fill{position:absolute;left:0;top:50%;transform:translateY(-50%);width:var(--player-progress,0%);flex:none;margin:0}',
      'html[data-player-navigating] .page-wrapper{cursor:progress}',
      '.media-drawer{transition:visibility 0s linear .32s}',
      '.media-drawer.is-visible{visibility:visible;pointer-events:auto;transition:none}',
      '.media-drawer_scrim{transition:opacity .32s ease}',
      '.media-drawer.is-visible .media-drawer_scrim{opacity:.7}',
      '.media-drawer_panel{transform:translateY(100%);transition:transform .32s cubic-bezier(.22,1,.36,1);touch-action:none}',
      '.media-drawer.is-visible .media-drawer_panel{transform:translateY(var(--drawer-drag,0px))}',
      '.media-drawer.is-dragging .media-drawer_panel{transition:none}',
      '@media (min-width: 992px){.media-drawer_panel{transform:translateY(calc(100% + 2rem))}}',
      'html.has-player-drawer{overflow:hidden}',
      '.media-controls_scrub{touch-action:none}',
      '.media-controls_fill{width:calc(var(--player-progress,0%) + (.5 - var(--player-progress-n,0)) * 1.25rem)}',
      '.media-controls_thumb{left:calc(var(--player-progress,0%) - var(--player-progress-n,0) * 1.25rem);transform:translateY(-50%);transition:transform .15s ease}',
      '.media-controls_scrub.is-scrubbing .media-controls_thumb,.media-controls_scrub:focus-visible .media-controls_thumb{transform:translateY(-50%) scale(1.3)}',
      '.media-controls_buttons svg.is-forward{transform:scaleX(-1)}',
      '.media-player_title > span{display:inline-block;white-space:nowrap}',
      '.media-player_title.is-marquee > span{animation:ctk-marquee var(--marquee-time,10s) linear infinite}',
      '@keyframes ctk-marquee{0%,20%{transform:none}80%,100%{transform:translateX(var(--marquee-shift,0))}}',
      // While scrolling, fade the left edge in once the text moves and the right edge out once the end shows.
      '@property --fade-l{syntax:"<length-percentage>";inherits:false;initial-value:0%}',
      '@property --fade-r{syntax:"<length-percentage>";inherits:false;initial-value:20%}',
      '.media-player_title.is-marquee{-webkit-mask-image:linear-gradient(90deg,#0000,#000 var(--fade-l),#000 calc(100% - var(--fade-r)),#0000);mask-image:linear-gradient(90deg,#0000,#000 var(--fade-l),#000 calc(100% - var(--fade-r)),#0000);animation:ctk-marquee-fade var(--marquee-time,10s) linear infinite}',
      '@keyframes ctk-marquee-fade{0%,20%{--fade-l:0%;--fade-r:20%}24%,76%{--fade-l:15%;--fade-r:20%}80%,100%{--fade-l:15%;--fade-r:0%}}',
      '@media (prefers-reduced-motion: reduce){.media-player_title.is-marquee > span,.media-player_title.is-marquee{animation:none}}',
      '.media-controls_bubble{opacity:0;transform:translateY(.25rem);transition:opacity .15s ease,transform .15s ease}',
      '.media-controls_scrub.is-scrubbing .media-controls_bubble{opacity:1;transform:none}',
      // Nothing at the bottom of the page sits under the docked bar.
      'body.has-player-dock .page-wrapper{padding-bottom:var(--player-dock-height,0px)}',
      'body.has-player-dock .scroll-to-top_button{margin-bottom:calc(var(--player-dock-height,0px) + .5rem)}',
      '.media-transcript.is-visible [data-transcript-sync]{bottom:calc(1rem + var(--player-dock-height,0px))}',
      '.media-transcript.is-visible .media-transcript_body{padding-bottom:calc(1.5rem + var(--player-dock-height,0px))}'
    ].join('\n');
    d.head.appendChild(s);
  }

  /* ---------- lock screen ---------- */
  function session() {
    if (!('mediaSession' in navigator)) return;
    var ms = navigator.mediaSession;
    try {
      if (w.MediaMetadata) ms.metadata = new w.MediaMetadata({
        title: S.title, artist: S.artist || 'Christ the King Church', album: 'Christ the King Church',
        artwork: S.artwork ? [{ src: S.artwork, sizes: '480x360', type: 'image/jpeg' }] : []
      });
      var next = $('[data-series-next]');
      var actions = {
        play: function () { api.play(); },
        pause: function () { api.pause(); },
        seekbackward: function (x) { api.seek(api.getTime() - (x && x.seekOffset || 15)); },
        seekforward: function (x) { api.seek(api.getTime() + (x && x.seekOffset || 15)); },
        seekto: function (x) { if (x && typeof x.seekTime === 'number') api.seek(x.seekTime - S.offset); },
        nexttrack: next && next.getAttribute('aria-hidden') !== 'true' ? function () { ended(); } : null
      };
      for (var k in actions) { try { ms.setActionHandler(k, actions[k]); } catch (e) { /* unsupported */ } }
    } catch (e) { /* no media session */ }
  }
  function positionState() {
    var dur = api.getDuration() + S.offset;
    if (!navigator.mediaSession || !navigator.mediaSession.setPositionState || !(dur > 0)) return;
    try { navigator.mediaSession.setPositionState({ duration: dur, playbackRate: audio.playbackRate, position: clamp(audio.currentTime, 0, dur) }); } catch (e) { /* out of range */ }
  }

  /* ---------- API ---------- */
  var api = {
    hasVideo: false,
    hasAudio: false,
    getMode: function () { return S.mode; },
    getTime: function () {
      if (S.mode !== 'listen') return ytTime();
      if (S.pendingSeek !== null) return Math.max(0, S.pendingSeek - S.offset);
      return audio ? Math.max(0, audio.currentTime - S.offset) : S.lastTime;
    },
    // iOS can briefly report a short duration after a seek into unloaded audio, so the
    // length is never less than what YouTube or the CMS (the page's JSON-LD) says.
    getDuration: function () {
      var a = S.mode === 'listen' && audio && audio.duration > 1 && isFinite(audio.duration) ? audio.duration - S.offset : 0;
      return Math.max(a, ytDuration(), S.known);
    },
    isPlaying: function () { return S.mode === 'listen' ? !!audio && !audio.paused && !S.unlocking : ytPlaying(); },
    play: function () {
      if (S.mode === 'listen') {
        cancelUnlock();
        var t = resumeAt();
        if (t) seekAudio(t);
        startAudio();
      } else withVideo(function () { yt.playVideo(); });
    },
    pause: function () {
      if (S.mode === 'listen') { if (audio) audio.pause(); } else if (ytReady) yt.pauseVideo();
    },
    toggle: function () { if (api.isPlaying()) api.pause(); else api.play(); },
    seek: function (s, opts) {
      s = Math.max(0, Number(s) || 0);
      var play = opts && opts.play;
      S.resumed = true;
      if (S.mode === 'listen') { cancelUnlock(); seekAudio(s); if (play) startAudio(); paint(); }
      else seekVideo(s, play);
    },
    setMode: function (mode) { setMode(mode, 'user'); }
  };
  w.ctkPlayer = api;

  /* ---------- sermons ---------- */
  function findStage() { return $('[data-player="stage"]') || $('.video-embed[data-video]') || $('[data-youtube-id]'); }
  function read(el) {
    return {
      videoId: (el.getAttribute('data-youtube-id') || '').trim() || null,
      audioUrl: (el.getAttribute('data-audio-url') || '').trim() || null,
      offset: Number(el.getAttribute('data-audio-offset')) || 0
    };
  }
  function observe() {
    if (io) io.disconnect();
    S.onStage = !!stage;
    if (!stage || !('IntersectionObserver' in w)) return;
    io = new IntersectionObserver(function (entries) {
      S.onStage = entries[entries.length - 1].isIntersecting;
      if (!S.onStage && S.mode === 'watch' && S.handoff === 'idle' && S.audioUrl && mobile.matches && ytPlaying()) handoff();
      place();
    }, { threshold: 0 });
    io.observe(stage);
  }
  function wireModes() {
    modes = $('[data-player-modes]');
    if (!modes) return;
    modes.style.display = S.videoId && S.audioUrl ? '' : 'none';
    if (modes.hasAttribute('data-wired')) return;
    modes.setAttribute('data-wired', '');
    modes.setAttribute('role', 'radiogroup');
    if (!modes.hasAttribute('aria-label')) modes.setAttribute('aria-label', 'Watch or listen');
    var btns = Array.prototype.slice.call(modes.querySelectorAll('[data-player-mode]'));
    btns.forEach(function (b, i) {
      b.setAttribute('role', 'radio');
      b.addEventListener('click', function () { setMode(b.getAttribute('data-player-mode'), 'user'); });
      b.addEventListener('keydown', function (e) {
        var step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        var to = btns[(i + step + btns.length) % btns.length];
        setMode(to.getAttribute('data-player-mode'), 'user');
        to.focus();
      });
    });
  }
  function readPage() {
    var h1 = $('h1');
    S.title = h1 ? h1.textContent.trim() : d.title;
    S.artist = Array.prototype.map.call(d.querySelectorAll('.media-byline .contributor_content > :first-child'), function (n) { return n.textContent.trim(); }).filter(Boolean).join(', ');
    S.artwork = S.videoId ? 'https://i.ytimg.com/vi/' + encodeURIComponent(S.videoId) + '/hqdefault.jpg' : null;
    var ld = $('script[type="application/ld+json"]'), m = ld && /"duration"\s*:\s*"PT(\d+)S"/.exec(ld.textContent);
    S.known = m ? Number(m[1]) : 0;
  }
  // A (new) stage element: the thumbnail behind the video, which is created on first use.
  function use(node) {
    stage = node; iframe = null; poster = null; yt = null; ytReady = false; ytQueue = [];
    node.appendChild(overlay);
    if (!S.videoId) return;
    poster = node.insertBefore(el('img', null, { 'data-player': 'poster', alt: '', src: 'https://i.ytimg.com/vi/' + encodeURIComponent(S.videoId) + '/maxresdefault.jpg' }), node.firstChild);
    poster.onload = function () { if (this.naturalWidth <= 120) { this.onload = null; this.src = 'https://i.ytimg.com/vi/' + encodeURIComponent(S.videoId) + '/hqdefault.jpg'; } }; // no HD thumbnail
  }
  // Load the sermon on this page (first load, or another sermon reached in place).
  function mount(el) {
    var src = read(el);
    if (audio) { cancelUnlock(); audio.pause(); }
    S.videoId = src.videoId; S.audioUrl = src.audioUrl; S.offset = src.offset;
    use(el);
    S.slug = location.pathname.replace(/\/+$/, '').split('/').pop();
    S.href = location.pathname + location.search;
    S.played = S.started = false; S.dismissed = false; S.handoff = 'idle'; S.videoAt = null;
    S.pendingSeek = null; S.resumed = false; S.lastTime = 0;
    api.hasVideo = !!S.videoId; api.hasAudio = !!S.audioUrl;
    readPage();
    wireModes();
    if (!S.videoId && !S.audioUrl) { el.style.display = 'none'; stage = null; observe(); show('watch'); return; }
    var want = S.autoplay ? 'listen' : savedMode() || 'watch';
    if (!has(want)) want = want === 'listen' ? 'watch' : 'listen';
    if (want === 'listen') ensureAudio();
    observe();
    show(want);
    if (want === 'watch') withVideo(function () {});
    if (S.autoplay) { S.autoplay = false; S.resumed = true; if (want === 'listen') startAudio(); }
  }
  // After an in-place swap: the same sermon re-anchors, another one loads, no stage docks the bar.
  function adopt() {
    dropMockups(); // every page brings the Designer mockup again
    var el = findStage();
    if (!el) { stage = null; observe(); place(); return; }
    var src = read(el);
    if (!S.autoplay && src.videoId === S.videoId && src.audioUrl === S.audioUrl) {
      use(el); S.href = location.pathname + location.search;
      wireModes(); observe(); show(S.mode);
      return;
    }
    savePos();
    mount(el);
  }

  /* ---------- in-place navigation while the audio plays ----------
     Same-site links fetch the next page and swap the content between the navbar and the
     footer, so the audio element (never in the page) keeps playing. Closing the bar returns
     the site to normal navigation. */
  var nav = (function () {
    var ctl = null, current = location.pathname + location.search, seenScripts = {}, seenStyles = {};
    var FILE = /\.(pdf|mp3|m4a|wav|zip|jpe?g|png|gif|svg|webp|avif|vtt|txt|csv|xml|rss|json|ics)$/i;
    var KEEP = '.announcement-bar, nav.navbar, [vci-nav="header"], footer.footer, footer';
    function each(list, fn) { Array.prototype.forEach.call(list, fn); }
    function active() { return S.mode === 'listen' && S.started && !S.dismissed; }
    function clone(old) {
      var sc = d.createElement('script');
      each(old.attributes, function (a) { sc.setAttribute(a.name, a.value); });
      sc.textContent = old.textContent;
      return sc;
    }
    function loaded(src) { return Array.prototype.some.call(d.scripts, function (x) { return x.src === src; }); }
    function onClick(e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !active()) return;
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download') || a.closest('[data-player-nav="off"]') || root.contains(a)) return;
      var url;
      try { url = new URL(a.href, location.href); } catch (x) { return; }
      if (url.origin !== location.origin || FILE.test(url.pathname) || (url.pathname === location.pathname && url.search === location.search)) return;
      e.preventDefault();
      go(url.href, true);
    }
    function go(href, push) {
      if (ctl) ctl.abort();
      var mine = ctl = 'AbortController' in w ? new AbortController() : null;
      d.documentElement.setAttribute('data-player-navigating', '');
      fetch(href, { credentials: 'same-origin', headers: { Accept: 'text/html' }, signal: mine && mine.signal })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text().then(function (h) { return { html: h, url: r.url || href }; }); })
        .then(function (res) { if (mine !== ctl) return; ctl = null; swap(new DOMParser().parseFromString(res.html, 'text/html'), res.url, push); })
        .catch(function (err) {
          if (err && err.name === 'AbortError') return;
          d.documentElement.removeAttribute('data-player-navigating');
          location.href = href;
        });
    }
    function swap(doc, url, push) {
      var oldWrap = $('.page-wrapper'), newWrap = doc.querySelector('.page-wrapper');
      if (!oldWrap || !newWrap) { location.href = url; return; }
      savePos();
      if (push) history.pushState({ ctkPlayer: true }, '', url);
      current = location.pathname + location.search;
      d.title = doc.title;
      ['meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]', 'meta[property="og:image"]', 'link[rel="canonical"]'].forEach(function (sel) {
        var from = doc.querySelector(sel), to = $(sel);
        if (!from || !to) return;
        if (from.hasAttribute('content')) to.setAttribute('content', from.getAttribute('content'));
        if (from.hasAttribute('href')) to.setAttribute('href', from.getAttribute('href'));
      });
      ['data-wf-page', 'data-wf-collection', 'data-wf-item-slug', 'data-wf-item-id'].forEach(function (n) {
        var v = doc.documentElement.getAttribute(n);
        if (v === null) d.documentElement.removeAttribute(n); else d.documentElement.setAttribute(n, v);
      });
      d.body.className = doc.body.className;
      each(d.head.querySelectorAll('script[type="application/ld+json"]'), function (x) { x.parentNode.removeChild(x); });
      each(doc.head.querySelectorAll('script[type="application/ld+json"]'), function (x) { d.head.appendChild(d.adoptNode(x)); });
      each(doc.querySelectorAll('link[rel="stylesheet"]'), function (l) {
        if (!$('link[rel="stylesheet"][href="' + l.getAttribute('href') + '"]')) d.head.appendChild(d.adoptNode(l));
      });
      each(doc.querySelectorAll('head style, body > style'), function (st) {
        if (seenStyles[st.textContent]) return;
        seenStyles[st.textContent] = true;
        d.head.appendChild(d.adoptNode(st));
      });
      var footer = null, scripts = [];
      each(Array.prototype.slice.call(oldWrap.children), function (c) {
        if (c.matches(KEEP)) { if (c.matches('footer')) footer = c; return; }
        oldWrap.removeChild(c);
      });
      each(Array.prototype.slice.call(newWrap.children), function (c) {
        if (c.matches(KEEP)) return;
        var node = d.adoptNode(c);
        oldWrap.insertBefore(node, footer);
        if (node.tagName === 'SCRIPT') scripts.push(node); else Array.prototype.push.apply(scripts, node.querySelectorAll('script'));
      });
      // Scripts arriving by DOM insertion are inert: replace each with a live copy, in order.
      scripts.forEach(function (sc) {
        if (sc.src && loaded(sc.src)) sc.parentNode.removeChild(sc); else sc.parentNode.replaceChild(clone(sc), sc);
      });
      each(doc.body.querySelectorAll(':scope > script'), function (sc) {
        if (sc.src) {
          // Webflow's runtime and jQuery are re-initialised below, never loaded twice.
          if (/\/js\/webflow[.-]/.test(sc.src) || /jquery/.test(sc.src) || /media-player/.test(sc.src)) return;
          if (/website-files\.com\/.*%2F.*\.js/.test(sc.src) || !loaded(sc.src)) d.body.appendChild(clone(sc));
          return;
        }
        if (seenScripts[sc.textContent]) return;
        seenScripts[sc.textContent] = true;
        d.body.appendChild(clone(sc));
      });
      each(d.querySelectorAll('a.w--current'), function (a) { a.classList.remove('w--current'); a.removeAttribute('aria-current'); });
      each(d.querySelectorAll('nav a[href], footer a[href]'), function (a) {
        if (a.pathname === location.pathname && a.origin === location.origin) { a.classList.add('w--current'); a.setAttribute('aria-current', 'page'); }
      });
      try { var W = w.Webflow; if (W && W.destroy && W.ready) { W.destroy(); W.ready(); var ix = W.require && W.require('ix2'); if (ix && ix.init) ix.init(); } } catch (e) { /* runtime changed */ }
      try {
        var fa = w.FinsweetAttributes;
        if (fa && fa.modules) {
          for (var k in fa.modules) { if (fa.modules[k] && typeof fa.modules[k].restart === 'function') fa.modules[k].restart(); }
          if (typeof fa.load === 'function' && $('[fs-list-element]') && !fa.modules.list) fa.load('list');
        }
      } catch (e) { /* Finsweet changed */ }
      try { var v = w.vci; if (v && v.accordion && v.accordion.init) v.accordion.init(); if (v && v.nav && v.nav.measure) v.nav.measure(); } catch (e) { /* narthex changed */ }
      var target = location.hash && $(location.hash);
      if (target) target.scrollIntoView(); else w.scrollTo(0, 0);
      var h1 = $('.page-wrapper h1');
      if (h1) { if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); }
      adopt();
      d.documentElement.removeAttribute('data-player-navigating');
      emit('navigate', { url: url });
    }
    function onPop() {
      if (location.pathname + location.search === current) return;
      if (active()) go(location.href, false); else location.reload();
    }
    function start() {
      each(d.body.querySelectorAll(':scope > script:not([src])'), function (sc) { seenScripts[sc.textContent] = true; });
      each(d.querySelectorAll('style'), function (st) { seenStyles[st.textContent] = true; });
      d.addEventListener('click', onClick);
      w.addEventListener('popstate', onPop);
    }
    return { go: go, start: start };
  })();

  /* ---------- start ---------- */
  function dropMockups() { Array.prototype.forEach.call(d.querySelectorAll('[data-player-mockup]'), function (m) { m.parentNode.removeChild(m); }); }
  function init() {
    var el = findStage();
    if (!el || root) return !!root;
    dropMockups();
    css();
    build();
    nav.start();
    ['pointerdown', 'touchend', 'keydown'].forEach(function (ev) { d.addEventListener(ev, unlock, { capture: true, passive: true }); });
    w.addEventListener('pagehide', savePos);
    mount(el);
    return true;
  }
  if (!init() && d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init);
})();
