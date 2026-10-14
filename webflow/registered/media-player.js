/* Christ the King — sermon media player.
 * Site settings → Custom code → Registered scripts, as `mediaPlayer`, applied
 * site-wide in the footer. Source of truth: webflow/registered/media-player.js.
 *
 * One player for Watch (YouTube IFrame API) and Listen (the Libsyn MP3 in an
 * HTML <audio>), inline on the sermon page and floating once the video scrolls
 * away. One component, one state, the same controls on desktop and phone; only
 * the dock's size and placement change with the viewport.
 *
 * HOOKS (Media Template)
 *   .video-embed[data-video]                 the stage: a block that keeps the layout
 *     data-youtube-id="<id>"                 bound to Media → YouTube Video ID (exists today)
 *     data-audio-url="<mp3 url>"             bound to Media → Audio URL  ← add in the Designer
 *     data-audio-offset="<seconds>"          optional, Media → Audio Offset Seconds
 *     data-audio-duration="<seconds>"        optional, Media → Audio Duration Seconds
 *   h1                                        the title, for the dock and the lock screen
 *   .media-byline .contributor_content > :first-child   the speaker(s), for the lock screen
 *
 *   Debug only: ?ctk-audio=<url> overrides data-audio-url (never in production links).
 *
 * WHAT IT BUILDS, inside the stage
 *   .media-player [data-player="root"] [data-mode] [data-presentation] [data-status]
 *     .media-player_video   the 16:9 box that owns the YouTube iframe, for the page's life
 *     .media-player_bar     title · status · Listen/Watch · −15 · play/pause · +15 · speed · time · expand · close
 *   The iframe is never moved in the DOM (moving an iframe reloads it). Inline
 *   and floating are the same element at two geometries: in flow inside the
 *   stage, or position:fixed at the dock, with the stage holding its height.
 *
 * YOUTUBE POLICY (developers.google.com/youtube/terms/required-minimum-functionality)
 *   The player viewport stays ≥ 200×200px, nothing is drawn over it, and
 *   YouTube is never played hidden or in the background: Listen mode pauses
 *   YouTube and plays the MP3. That is why the floating video is a full-width
 *   strip on a phone and why the controls sit under the video, not on it.
 *
 * API     window.ctkPlayer — ready, hasVideo, hasAudio, getMode(), getTime(),
 *         getDuration(), isPlaying(), play(), pause(), toggle(), seek(s, {play}),
 *         skip(±s), setMode('watch'|'listen'), setRate(r), getRate(), expand(),
 *         close(), setAudio(url), on(event, fn)
 *         Times are on the VIDEO timeline (audio = video + offset), so the
 *         transcript's #t= anchors work in both modes.
 * EVENTS  on document: ctk:player:ready · play · pause · ended · time (≈400ms while
 *         active) · mode · float · inline · hidden · error — detail { player, mode, time }
 * STORAGE localStorage ctk-player:prefs { mode, rate } · ctk-player:positions { slug: { t, mode, at } }
 */
(function () {
  'use strict';
  var w = window, d = document;
  if (w.ctkPlayer) return;

  var SKIP = 15;
  var RATES = [1, 1.25, 1.5, 1.75, 2, 0.75];
  var PREF_KEY = 'ctk-player:prefs';
  var POS_KEY = 'ctk-player:positions';
  var FLOAT_OUT = 0.25, FLOAT_IN = 0.6;   // stage visibility that floats / restores
  var MIN_RESUME = 15, END_SLACK = 30;     // resume only between these from either end
  var SWITCH_TIMEOUT = 8000;
  var YT_PLAYING = 1, YT_PAUSED = 2, YT_BUFFERING = 3, YT_ENDED = 0, YT_CUED = 5;

  var reduced = w.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- state ---------- */
  var S = {
    slug: location.pathname.replace(/\/+$/, '').split('/').pop() || 'home',
    mode: 'watch',
    status: 'idle',          // idle | loading | playing | paused | ended | error
    presentation: 'inline',  // inline | floating | hidden
    userStarted: false,
    dismissed: false,
    rate: 1,
    offset: 0,
    pending: null,           // mode being switched to, while the handoff completes
    lastTime: 0
  };
  var stage, root, videoBox, bar, iframe, audio = null;
  var yt = null, ytReady = false, ytHoldPause = false, ytDuration = 0;
  var videoId = null, audioUrl = null, audioDuration = 0;
  var title = '', artist = '', artwork = null;
  var els = {};
  var statusTimer = 0, switchTimer = 0, tickTimer = 0, saveAt = 0;
  var listeners = [];

  /* ---------- small helpers ---------- */
  function $(sel, r) { return (r || d).querySelector(sel); }
  function emit(name, extra) {
    var detail = { player: api, mode: S.mode, time: api.getTime(), status: S.status };
    if (extra) for (var k in extra) detail[k] = extra[k];
    d.dispatchEvent(new CustomEvent('ctk:player:' + name, { bubbles: true, detail: detail }));
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }
  function load(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function clamp(n, lo, hi) { return Math.min(Math.max(n, lo), hi); }
  function fmt(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    var mm = h ? (m < 10 ? '0' : '') + m : String(m);
    return (h ? h + ':' : '') + mm + ':' + (x < 10 ? '0' : '') + x;
  }
  function el(tag, cls, attrs) {
    var n = d.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function svg(path, extra) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="24" height="24" fill="currentColor" aria-hidden="true" focusable="false"><path d="' + path + '"/>' + (extra || '') + '</svg>';
  }
  // Material Symbols (Apache 2.0), the set the site's button component draws from.
  var ICON = {
    play: 'M320-200v-560l440 280-440 280Z',
    pause: 'M520-200v-560h240v560H520Zm-320 0v-560h240v560H200Z',
    close: 'm256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z',
    expand: 'M120-120v-320h80v184l504-504H520v-80h320v320h-80v-184L256-200h184v80H120Z',
    listen: 'M360-120H200q-33 0-56.5-23.5T120-200v-280q0-75 28.5-140.5t77-114q48.5-48.5 114-77T480-840q75 0 140.5 28.5t114 77q48.5 48.5 77 114T840-480v280q0 33-23.5 56.5T760-120H600v-320h160v-40q0-117-81.5-198.5T480-760q-117 0-198.5 81.5T200-480v40h160v320Zm-80-240h-80v160h80v-160Zm400 0v160h80v-160h-80Zm-400 0h-80 80Zm400 0h80-80Z',
    watch: 'M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm0-80h640v-480H160v480Zm0 0v-480 480Zm240-40 240-160-240-160v320Z',
    back: 'M480-80q-75 0-140.5-28.5t-114-77q-48.5-48.5-77-114T120-440h80q0 117 81.5 198.5T480-160q117 0 198.5-81.5T760-440q0-117-81.5-198.5T480-720h-6l62 62-56 58-160-160 160-160 56 58-62 62h6q75 0 140.5 28.5t114 77q48.5 48.5 77 114T840-440q0 75-28.5 140.5t-77 114q-48.5 48.5-114 77T480-80Z',
    forward: 'M480-80q75 0 140.5-28.5t114-77q48.5-48.5 77-114T840-440h-80q0 117-81.5 198.5T480-160q-117 0-198.5-81.5T200-440q0-117 81.5-198.5T480-720h6l-62 62 56 58 160-160-160-160-56 58 62 62h-6q-75 0-140.5 28.5t-114 77q-48.5 48.5-77 114T120-440q0 75 28.5 140.5t77 114q48.5 48.5 114 77T480-80Z'
  };
  var SKIP_LABEL = '<text x="480" y="-380" text-anchor="middle" font-size="300" font-weight="700" font-family="JetBrains Mono, monospace" fill="currentColor">' + SKIP + '</text>';

  /* ---------- CSS: only what the states need; colours and sizes come from the site's tokens ---------- */
  function css() {
    if ($('style[data-player-style]')) return;
    var s = el('style', null, { 'data-player-style': '' });
    s.textContent = [
      '.video-embed[data-player-active]{aspect-ratio:auto;overflow:visible;border-radius:0;margin-bottom:0}',
      '.media-player{display:flex;flex-direction:column;gap:.5rem;width:100%;color:var(--_theme---text-01)}',
      '.media-player_video{position:relative;aspect-ratio:16/9;border-radius:var(--border-radius-medium);overflow:clip;background:var(--_theme---background-02)}',
      '.media-player_video iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}',
      '.media-player_bar{display:flex;align-items:center;gap:.25rem .5rem;flex-wrap:wrap;padding:.5rem .75rem;border:2px solid var(--_theme---border-02);border-radius:var(--border-radius-medium);background-color:var(--_theme---background-02)}',
      '.media-player_info{display:flex;flex-direction:column;flex:1 1 10rem;min-width:0;gap:.1rem}',
      '.media-player_title{font-weight:700;font-size:.9375rem;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.media-player_status{font-family:"JetBrains Mono",monospace;font-size:.75rem;line-height:1.3;text-transform:uppercase;color:var(--_theme---text-02);min-height:1em}',
      '.media-player_status:empty{display:none}',
      '.media-player_controls,.media-player_window{display:flex;align-items:center;gap:.25rem;flex:none}',
      '.media-player_window{display:none}',
      '.media-player_btn{display:inline-flex;align-items:center;justify-content:center;width:2.75rem;height:2.75rem;padding:0;border:0;border-radius:var(--border-radius-small);background:transparent;color:var(--_theme---text-01);cursor:pointer;font:inherit}',
      '.media-player_btn svg{width:1.5rem;height:1.5rem}',
      '.media-player_btn[data-size="large"]{background-color:var(--_theme---accent-01);color:var(--_theme---background-01);border-radius:100rem}',
      '.media-player_btn[data-size="large"] svg{width:1.75rem;height:1.75rem}',
      '.media-player_btn[aria-pressed="true"]{color:var(--_theme---accent-01)}',
      '@media (hover:hover){.media-player_btn:hover{background-color:var(--_theme---background-03)}.media-player_btn[data-size="large"]:hover{background-color:var(--_theme---accent-01);filter:brightness(1.08)}}',
      '.media-player_btn:focus-visible{outline:2px solid var(--_theme---accent-01);outline-offset:2px}',
      '.media-player_btn[disabled],.media-player_btn[aria-disabled="true"]{opacity:.4;cursor:default}',
      '.media-player_btn[data-on] [data-icon="off"],.media-player_btn:not([data-on]) [data-icon="on"]{display:none}',
      '.media-player_rate{font-family:"JetBrains Mono",monospace;font-size:.8125rem;font-weight:600;width:3rem}',
      '.media-player_time{font-family:"JetBrains Mono",monospace;font-size:.8125rem;font-variant-numeric:tabular-nums;color:var(--_theme---text-02);white-space:nowrap;padding:0 .25rem}',
      '.media-player[data-presentation="floating"]{position:fixed;z-index:95;right:1rem;bottom:calc(1rem + env(safe-area-inset-bottom,0px));width:min(26rem,calc(100vw - 2rem));margin:0;background-color:var(--_theme---background-02);border:2px solid var(--_theme---border-02);border-radius:var(--border-radius-medium);padding:.5rem;gap:.5rem}',
      '.media-player[data-presentation="floating"] .media-player_bar{border:0;padding:0 .25rem}',
      /* Floating: title and the expand/close pair share the first row, the transport sits centred below. */
      '.media-player[data-presentation="floating"] .media-player_window{display:flex;order:1}',
      '.media-player[data-presentation="floating"] .media-player_info{order:0;flex:1 1 8rem}',
      '.media-player[data-presentation="floating"] .media-player_controls{order:2;flex:1 1 100%;justify-content:center}',
      '.media-player[data-presentation="floating"][data-mode="listen"] .media-player_video{display:none}',
      '.media-player[data-presentation="floating"] .media-player_video{border-radius:var(--border-radius-small)}',
      '.media-player[data-presentation="hidden"]{display:none}',
      '.media-player[data-has-video="false"] .media-player_video{display:none}',
      /* Phones: an edge-to-edge strip at the bottom. YouTube requires a 200px-tall
         viewport, which a 16:9 box only reaches from ~356px wide, so the dock gives
         the video the whole width and keeps the controls under it. */
      '@media (max-width:991px){.media-player[data-presentation="floating"]{left:0;right:0;bottom:0;width:auto;padding:.25rem .25rem calc(.5rem + env(safe-area-inset-bottom,0px));border-bottom:0;border-radius:var(--border-radius-medium) var(--border-radius-medium) 0 0}.media-player[data-presentation="floating"] .media-player_bar{padding:0 .5rem}}',
      '@media (max-width:479px){.media-player_rate{display:none}}',
      '@keyframes media-player-rise{from{opacity:0;transform:translateY(.75rem)}to{opacity:1;transform:none}}',
      '.media-player[data-presentation="floating"][data-animate]{animation:media-player-rise 240ms cubic-bezier(.22,1,.36,1)}',
      '@media (prefers-reduced-motion:reduce){.media-player[data-presentation="floating"][data-animate]{animation:none}}',
      /* The footer's scroll-to-top button shares the dock's corner. */
      'body.has-player-dock .scroll-to-top_button{margin-bottom:calc(var(--player-dock-height,0px) + .5rem)}'
    ].join('\n');
    d.head.appendChild(s);
  }

  /* ---------- DOM ---------- */
  function button(name, label, icon, extra) {
    var b = el('button', 'media-player_btn', { type: 'button', 'aria-label': label, 'data-player': name });
    b.innerHTML = icon;
    if (extra) for (var k in extra) b.setAttribute(k, extra[k]);
    return b;
  }
  function build() {
    root = el('div', 'media-player', {
      'data-player': 'root', role: 'region', 'aria-label': 'Sermon player',
      'data-mode': S.mode, 'data-presentation': 'inline', 'data-status': 'idle',
      'data-has-video': String(!!videoId), 'data-has-audio': String(!!audioUrl)
    });
    videoBox = el('div', 'media-player_video', { 'data-player': 'video' });
    bar = el('div', 'media-player_bar', { 'data-player': 'bar' });

    var info = el('div', 'media-player_info');
    els.title = el('div', 'media-player_title', { 'data-player': 'title' });
    els.title.textContent = title;
    els.status = el('div', 'media-player_status', { 'data-player': 'status', role: 'status', 'aria-live': 'polite' });
    info.appendChild(els.title);
    info.appendChild(els.status);

    var controls = el('div', 'media-player_controls');
    els.mode = button('mode', 'Switch to audio',
      '<span data-icon="off">' + svg(ICON.listen) + '</span><span data-icon="on">' + svg(ICON.watch) + '</span>',
      { 'aria-pressed': 'false' });
    els.back = button('back', 'Back ' + SKIP + ' seconds', svg(ICON.back, SKIP_LABEL));
    els.play = button('play', 'Play', '<span data-icon="off">' + svg(ICON.play) + '</span><span data-icon="on">' + svg(ICON.pause) + '</span>', { 'data-size': 'large' });
    els.forward = button('forward', 'Forward ' + SKIP + ' seconds', svg(ICON.forward, SKIP_LABEL));
    els.rate = button('rate', 'Playback speed', '');
    els.rate.className += ' media-player_rate';
    els.time = el('span', 'media-player_time', { 'data-player': 'time', 'aria-hidden': 'true' });
    els.time.textContent = '0:00';
    if (videoId && audioUrl) controls.appendChild(els.mode);
    controls.appendChild(els.back);
    controls.appendChild(els.play);
    controls.appendChild(els.forward);
    controls.appendChild(els.rate);
    controls.appendChild(els.time);

    var win = el('div', 'media-player_window');
    els.expand = button('expand', 'Back to the sermon page', svg(ICON.expand));
    els.close = button('close', 'Close player', svg(ICON.close));
    win.appendChild(els.expand);
    win.appendChild(els.close);

    bar.appendChild(info);
    bar.appendChild(controls);
    bar.appendChild(win);
    root.appendChild(videoBox);
    root.appendChild(bar);
    stage.appendChild(root);
    stage.setAttribute('data-player-active', '');

    els.mode.addEventListener('click', function () { api.setMode(S.mode === 'listen' ? 'watch' : 'listen'); });
    els.back.addEventListener('click', function () { api.skip(-SKIP); });
    els.forward.addEventListener('click', function () { api.skip(SKIP); });
    els.play.addEventListener('click', function () { api.toggle(); });
    els.rate.addEventListener('click', function () {
      var i = RATES.indexOf(S.rate);
      api.setRate(RATES[(i + 1) % RATES.length]);
    });
    els.expand.addEventListener('click', function () { api.expand(); });
    els.close.addEventListener('click', function () { api.close(); });
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.presentation === 'floating') { e.preventDefault(); api.close(); }
    });
    paint();
  }

  function buildIframe() {
    if (!videoId) return;
    iframe = videoBox.querySelector('iframe') || $('iframe[src*="youtube.com/embed"], iframe[src*="youtube-nocookie.com/embed"]', stage);
    if (iframe) {
      if (iframe.parentNode !== videoBox) videoBox.appendChild(iframe); // one move, before the API attaches
      if (iframe.src.indexOf('enablejsapi=1') === -1) {
        iframe.src += (iframe.src.indexOf('?') === -1 ? '?' : '&') + 'enablejsapi=1&origin=' + encodeURIComponent(location.origin);
      }
      return;
    }
    iframe = d.createElement('iframe');
    iframe.src = 'https://www.youtube.com/embed/' + encodeURIComponent(videoId) +
      '?rel=0&modestbranding=1&playsinline=1&enablejsapi=1&origin=' + encodeURIComponent(location.origin);
    iframe.title = title || 'Sermon video';
    iframe.setAttribute('frameborder', '0');
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.allowFullscreen = true;
    videoBox.appendChild(iframe);
  }

  /* ---------- paint: state → DOM ---------- */
  function paint() {
    if (!root) return;
    var playing = S.status === 'playing' || S.status === 'loading';
    root.setAttribute('data-mode', S.mode);
    root.setAttribute('data-status', S.status);
    root.setAttribute('data-presentation', S.presentation);
    if (playing) els.play.setAttribute('data-on', ''); else els.play.removeAttribute('data-on');
    els.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    els.play.setAttribute('aria-disabled', String(!(audioUrl || iframe)));
    if (S.mode === 'listen') els.mode.setAttribute('data-on', ''); else els.mode.removeAttribute('data-on');
    els.mode.setAttribute('aria-pressed', String(S.mode === 'listen'));
    els.mode.setAttribute('aria-label', S.mode === 'listen' ? 'Switch to video' : 'Switch to audio');
    els.rate.textContent = (S.rate === 1 ? '1' : String(S.rate).replace(/^0/, '')) + '×';
    els.rate.setAttribute('aria-label', 'Playback speed ' + S.rate + '×');
    var dur = api.getDuration();
    els.time.textContent = fmt(api.getTime()) + (dur ? ' / ' + fmt(dur) : '');
    root.inert = S.presentation === 'hidden';
    d.body.classList.toggle('has-player-dock', S.presentation === 'floating');
    if (S.presentation === 'floating') {
      d.documentElement.style.setProperty('--player-dock-height', root.offsetHeight + 'px');
    } else {
      d.documentElement.style.removeProperty('--player-dock-height');
    }
  }
  function setStatus(status) {
    if (S.status === status) return;
    S.status = status;
    paint();
    tick();
  }
  function say(msg, sticky) {
    clearTimeout(statusTimer);
    els.status.textContent = msg || '';
    if (msg && !sticky) statusTimer = setTimeout(function () { els.status.textContent = ''; }, 4000);
  }
  function tick() {
    clearInterval(tickTimer);
    tickTimer = 0;
    if (!S.userStarted) return;
    tickTimer = setInterval(function () {
      paint();
      emit('time');
      savePosition(false);
    }, 400);
  }

  /* ---------- positions and preferences ---------- */
  function savePosition(force) {
    var now = Date.now();
    if (!force && now - saveAt < 5000) return;
    if (!S.userStarted) return;
    saveAt = now;
    var all = load(POS_KEY) || {};
    all[S.slug] = { t: Math.floor(api.getTime()), mode: S.mode, at: now };
    var keys = Object.keys(all).sort(function (a, b) { return all[b].at - all[a].at; });
    if (keys.length > 50) keys.slice(50).forEach(function (k) { delete all[k]; });
    store(POS_KEY, all);
  }
  function savePrefs() { store(PREF_KEY, { mode: S.mode, rate: S.rate }); }
  function resumePoint() {
    var all = load(POS_KEY) || {};
    var p = all[S.slug];
    if (!p || !(p.t > MIN_RESUME)) return 0;
    var dur = api.getDuration();
    if (dur && p.t > dur - END_SLACK) return 0;
    return p.t;
  }
  var resumed = false;
  function maybeResume() {
    if (resumed) return 0;
    resumed = true;
    var t = resumePoint();
    if (t) say('Resumed at ' + fmt(t));
    return t;
  }

  /* ---------- YouTube adapter ---------- */
  function ytTime() {
    if (yt && ytReady && yt.getCurrentTime) {
      var t = yt.getCurrentTime();
      if (typeof t === 'number' && !isNaN(t)) S.lastTime = t;
    }
    return S.lastTime;
  }
  function ytState() { return yt && ytReady && yt.getPlayerState ? yt.getPlayerState() : -1; }
  function ytPlaying() { var s = ytState(); return s === YT_PLAYING || s === YT_BUFFERING; }
  function loadYT() {
    if (!iframe) return;
    if (w.YT && w.YT.Player) return attachYT();
    var prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = function () {
      if (typeof prev === 'function') prev();
      attachYT();
    };
    if (!$('script[src*="youtube.com/iframe_api"]')) {
      var t = d.createElement('script');
      t.src = 'https://www.youtube.com/iframe_api';
      d.head.appendChild(t);
    }
  }
  function attachYT() {
    if (yt || !iframe) return;
    yt = new w.YT.Player(iframe, {
      events: {
        onReady: function () {
          ytReady = true;
          ytDuration = (yt.getDuration && yt.getDuration()) || 0;
          if (S.rate !== 1 && yt.setPlaybackRate) yt.setPlaybackRate(S.rate);
          api.ready = true;
          paint();
          emit('ready');
        },
        onStateChange: function (e) {
          var s = e.data;
          if (s === YT_PLAYING) {
            if (ytHoldPause) { ytHoldPause = false; yt.pauseVideo(); return; }
            if (!S.userStarted) {
              S.userStarted = true;
              var t = maybeResume();
              if (t) yt.seekTo(t, true);
            }
            if (S.mode === 'listen' && S.pending !== 'watch') {
              // Someone pressed YouTube's own play while listening: video wins.
              S.mode = 'watch';
              if (audio) audio.pause();
              savePrefs();
              emit('mode');
            }
            if (S.pending === 'watch') { S.pending = null; clearTimeout(switchTimer); if (audio) audio.pause(); }
            if (S.mode === 'watch') { setStatus('playing'); emit('play'); }
          } else if (s === YT_PAUSED) {
            if (S.mode === 'watch') { setStatus('paused'); savePosition(true); emit('pause'); }
          } else if (s === YT_BUFFERING) {
            if (S.mode === 'watch' && S.userStarted) setStatus('loading');
          } else if (s === YT_ENDED) {
            if (S.mode === 'watch') { setStatus('ended'); emit('ended'); }
          } else if (s === YT_CUED) {
            if (S.mode === 'watch' && !S.userStarted) setStatus('idle');
          }
          if (!ytDuration && yt.getDuration) ytDuration = yt.getDuration() || 0;
        },
        onPlaybackRateChange: function (e) {
          if (S.mode === 'watch' && RATES.indexOf(e.data) !== -1 && e.data !== S.rate) {
            S.rate = e.data; savePrefs(); paint();
          }
        },
        onError: function () {
          if (S.mode === 'watch') { setStatus('error'); say('Video unavailable', true); emit('error', { source: 'video' }); }
        }
      }
    });
  }

  /* ---------- audio adapter ---------- */
  function ensureAudio() {
    if (audio || !audioUrl) return audio;
    audio = new Audio();
    audio.preload = 'metadata';
    audio.setAttribute('playsinline', '');
    audio.src = audioUrl;
    audio.playbackRate = S.rate;
    audio.addEventListener('playing', function () {
      if (S.mode !== 'listen') { audio.pause(); return; }
      S.userStarted = true;
      if (S.pending === 'listen') {
        S.pending = null;
        clearTimeout(switchTimer);
        audio.muted = false;
        if (yt && ytReady) { yt.pauseVideo(); if (yt.unMute) yt.unMute(); }
      }
      setStatus('playing');
      session();
      emit('play');
    });
    audio.addEventListener('pause', function () {
      if (S.mode !== 'listen' || S.pending) return;
      setStatus(audio.ended ? 'ended' : 'paused');
      savePosition(true);
      emit(audio.ended ? 'ended' : 'pause');
    });
    audio.addEventListener('waiting', function () { if (S.mode === 'listen' && S.userStarted) setStatus('loading'); });
    audio.addEventListener('loadedmetadata', function () { audioDuration = audio.duration || audioDuration; paint(); });
    audio.addEventListener('ratechange', function () {
      if (S.mode === 'listen' && RATES.indexOf(audio.playbackRate) !== -1 && audio.playbackRate !== S.rate) {
        S.rate = audio.playbackRate; savePrefs(); paint();
      }
    });
    audio.addEventListener('error', function () {
      audioFailed('Audio unavailable');
    });
    audio.addEventListener('timeupdate', positionState);
    return audio;
  }
  function audioFailed(msg) {
    var wasSwitching = S.pending === 'listen';
    S.pending = null;
    clearTimeout(switchTimer);
    if (videoId) {
      S.mode = 'watch';
      if (yt && ytReady) {
        if (yt.unMute) yt.unMute();
        if (wasSwitching && S.status !== 'paused') yt.playVideo();
      }
      say(msg + ' — back to video', true);
      setStatus(ytPlaying() ? 'playing' : 'paused');
      emit('mode');
    } else {
      setStatus('error');
      say(msg, true);
    }
    emit('error', { source: 'audio' });
  }
  function audioTime() {
    return audio ? Math.max(0, audio.currentTime - S.offset) : S.lastTime;
  }
  function session() {
    if (!('mediaSession' in navigator)) return;
    try {
      var ms = navigator.mediaSession;
      if (w.MediaMetadata) {
        ms.metadata = new w.MediaMetadata({
          title: title || d.title,
          artist: artist || 'Christ the King Church',
          album: 'Christ the King Church',
          artwork: artwork ? [{ src: artwork, sizes: '480x360', type: 'image/jpeg' }] : []
        });
      }
      var handlers = {
        play: function () { api.play(); },
        pause: function () { api.pause(); },
        seekbackward: function (x) { api.skip(-((x && x.seekOffset) || SKIP)); },
        seekforward: function (x) { api.skip((x && x.seekOffset) || SKIP); },
        seekto: function (x) { if (x && typeof x.seekTime === 'number') api.seek(x.seekTime - S.offset); }
      };
      for (var k in handlers) { try { ms.setActionHandler(k, handlers[k]); } catch (e) { /* unsupported action */ } }
    } catch (e) { /* no media session */ }
  }
  function positionState() {
    if (!audio || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!(audio.duration > 0) || !isFinite(audio.duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate,
        position: clamp(audio.currentTime, 0, audio.duration)
      });
    } catch (e) { /* out of range */ }
  }

  /* ---------- presentation ---------- */
  var animateTimer = 0;
  function setPresentation(p) {
    if (S.presentation === p) return;
    if (p === 'floating') {
      stage.style.minHeight = root.offsetHeight + 'px';
      root.setAttribute('data-animate', '');
      clearTimeout(animateTimer);
      animateTimer = setTimeout(function () { root.removeAttribute('data-animate'); }, 300);
    } else {
      stage.style.minHeight = '';
      root.removeAttribute('data-animate');
    }
    S.presentation = p;
    paint();
    emit(p === 'floating' ? 'float' : p === 'inline' ? 'inline' : 'hidden');
  }
  function watchStage() {
    if (!('IntersectionObserver' in w)) return;
    var io = new IntersectionObserver(function (entries) {
      var ratio = entries[entries.length - 1].intersectionRatio;
      if (ratio >= FLOAT_IN) {
        S.dismissed = false;
        if (S.presentation !== 'inline') setPresentation('inline');
        return;
      }
      if (ratio < FLOAT_OUT && S.userStarted && S.presentation === 'inline' && !S.dismissed) {
        setPresentation('floating');
      }
    }, { threshold: [0, FLOAT_OUT, FLOAT_IN, 1] });
    io.observe(stage);
  }

  /* ---------- the API ---------- */
  var api = {
    ready: false,
    hasVideo: false,
    hasAudio: false,
    getMode: function () { return S.mode; },
    getStatus: function () { return S.status; },
    getPresentation: function () { return S.presentation; },
    isPlaying: function () { return S.status === 'playing' || S.status === 'loading'; },
    getTime: function () { return S.mode === 'listen' ? audioTime() : ytTime(); },
    getDuration: function () {
      if (S.mode === 'listen' && audio && audio.duration > 0 && isFinite(audio.duration)) return audio.duration - S.offset;
      return ytDuration || audioDuration || 0;
    },
    getRate: function () { return S.rate; },
    play: function () {
      if (S.mode === 'listen' && audioUrl) {
        ensureAudio();
        if (!S.userStarted) { var t0 = maybeResume(); if (t0) audio.currentTime = t0 + S.offset; }
        var p = audio.play();
        if (p && p.catch) p.catch(function () { audioFailed('Audio did not start'); });
        return;
      }
      if (yt && ytReady) {
        ytHoldPause = false;
        if (!S.userStarted) { var t1 = maybeResume(); if (t1) yt.seekTo(t1, true); }
        yt.playVideo();
      } else if (iframe) {
        setStatus('loading');
        loadYT();
      }
    },
    pause: function () {
      if (S.mode === 'listen') { if (audio) audio.pause(); return; }
      if (yt && ytReady) yt.pauseVideo();
    },
    toggle: function () { if (api.isPlaying()) api.pause(); else api.play(); },
    seek: function (s, opts) {
      opts = opts || {};
      s = Math.max(0, Number(s) || 0);
      if (S.mode === 'listen' && audioUrl) {
        ensureAudio();
        audio.currentTime = s + S.offset;
        if (opts.play) api.play();
      } else if (yt && ytReady) {
        var st = ytState();
        if (!opts.play && (st === -1 || st === YT_CUED)) ytHoldPause = true; // seekTo starts an unstarted player
        yt.seekTo(s, true);
        if (opts.play) { ytHoldPause = false; yt.playVideo(); }
      } else {
        S.lastTime = s;
      }
      S.userStarted = S.userStarted || !!opts.play;
      paint();
      emit('time');
    },
    skip: function (dx) { api.seek(clamp(api.getTime() + dx, 0, api.getDuration() || Infinity)); },
    setRate: function (r) {
      r = Number(r);
      if (!(r > 0)) return;
      S.rate = r;
      if (yt && ytReady && yt.setPlaybackRate) yt.setPlaybackRate(r);
      if (audio) audio.playbackRate = r;
      savePrefs();
      paint();
    },
    setMode: function (mode) {
      if (mode === S.mode) return;
      if (mode === 'listen' && !audioUrl) return;
      if (mode === 'watch' && !videoId) return;
      var t = api.getTime();
      var wasPlaying = api.isPlaying();
      clearTimeout(switchTimer);
      S.mode = mode;
      S.pending = wasPlaying ? mode : null;
      savePrefs();
      emit('mode');
      if (mode === 'listen') {
        ensureAudio();
        audio.playbackRate = S.rate;
        audio.currentTime = t + S.offset;
        if (wasPlaying) {
          setStatus('loading');
          if (yt && ytReady && yt.mute) yt.mute(); // no echo during the overlap
          audio.muted = true;                       // and no stray second of audio before the seek lands
          var p = audio.play();
          if (p && p.catch) p.catch(function () { audioFailed('Audio did not start'); });
          switchTimer = setTimeout(function () { if (S.pending === 'listen') audioFailed('Audio did not start'); }, SWITCH_TIMEOUT);
        } else {
          if (yt && ytReady && ytPlaying()) yt.pauseVideo();
          setStatus('paused');
        }
        say('Switched to audio');
      } else {
        if (audio && !wasPlaying) audio.pause();
        if (yt && ytReady) {
          var st = ytState();
          if (!wasPlaying && (st === -1 || st === YT_CUED)) ytHoldPause = true;
          yt.seekTo(t, true);
          if (wasPlaying) {
            setStatus('loading');
            ytHoldPause = false;
            yt.playVideo();
            switchTimer = setTimeout(function () {
              if (S.pending !== 'watch') return;
              // Video never started: keep the audio going rather than going silent.
              S.pending = null;
              S.mode = 'listen';
              say('Video did not start — still on audio', true);
              setStatus(audio && !audio.paused ? 'playing' : 'paused');
              savePrefs();
              emit('mode');
            }, SWITCH_TIMEOUT);
          } else {
            setStatus('paused');
          }
        } else {
          S.lastTime = t;
          setStatus(wasPlaying ? 'loading' : 'paused');
          loadYT();
        }
        say('Switched to video');
      }
      paint();
    },
    expand: function () {
      S.dismissed = false;
      stage.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'center' });
      var focus = els.play;
      setTimeout(function () { if (S.presentation === 'floating') setPresentation('inline'); focus.focus({ preventScroll: true }); }, reduced.matches ? 0 : 400);
    },
    close: function () {
      api.pause();
      S.dismissed = true;
      setPresentation('hidden');
      savePosition(true);
    },
    setAudio: function (url) {
      audioUrl = url || null;
      api.hasAudio = !!audioUrl;
      if (audio) { audio.pause(); audio = null; }
      if (root) {
        root.setAttribute('data-has-audio', String(!!audioUrl));
        var controls = $('.media-player_controls', root);
        if (audioUrl && videoId && !els.mode.parentNode) controls.insertBefore(els.mode, controls.firstChild);
        if (!audioUrl && els.mode.parentNode) els.mode.parentNode.removeChild(els.mode);
        paint();
      }
    },
    on: function (name, fn) {
      d.addEventListener('ctk:player:' + name, fn);
      listeners.push([name, fn]);
      return function () { d.removeEventListener('ctk:player:' + name, fn); };
    }
  };
  w.ctkPlayer = api;

  /* ---------- init ---------- */
  function init() {
    if (root) return true;
    stage = $('[data-player="stage"]') || $('[data-youtube-id]') || $('.video-embed[data-video]');
    if (!stage) return false;
    videoId = (stage.getAttribute('data-player-youtube') || stage.getAttribute('data-youtube-id') || '').trim() || null;
    var qs = null;
    try { qs = new URLSearchParams(location.search).get('ctk-audio'); } catch (e) { /* old browser */ }
    audioUrl = (qs || stage.getAttribute('data-player-audio') || stage.getAttribute('data-audio-url') || '').trim() || null;
    S.offset = Number(stage.getAttribute('data-audio-offset')) || 0;
    audioDuration = Number(stage.getAttribute('data-audio-duration')) || 0;
    api.hasVideo = !!videoId;
    api.hasAudio = !!audioUrl;
    if (!videoId && !audioUrl) { stage.style.display = 'none'; return true; }

    var h1 = $('h1');
    title = h1 ? h1.textContent.trim() : d.title;
    artist = Array.prototype.map.call(d.querySelectorAll('.media-byline .contributor_content > :first-child'), function (n) {
      return n.textContent.trim();
    }).filter(Boolean).join(', ');
    artwork = videoId ? 'https://i.ytimg.com/vi/' + encodeURIComponent(videoId) + '/hqdefault.jpg' : null;

    var prefs = load(PREF_KEY) || {};
    if (RATES.indexOf(prefs.rate) !== -1) S.rate = prefs.rate;
    if (prefs.mode === 'listen' && audioUrl) S.mode = 'listen';
    if (!videoId) S.mode = 'listen';
    if (!audioUrl) S.mode = 'watch';

    css();
    build();
    buildIframe();
    if (iframe) loadYT();
    if (S.mode === 'listen') { ensureAudio(); api.ready = true; emit('ready'); }
    watchStage();

    w.addEventListener('pagehide', function () { savePosition(true); });
    d.addEventListener('visibilitychange', function () { if (d.visibilityState === 'hidden') savePosition(true); });
    return true;
  }

  // The footer script runs after the page's markup has been parsed, so the
  // stage is normally there already; starting now (not at DOMContentLoaded)
  // means the transcript embed, whose own DOMContentLoaded handler was
  // registered first, finds a player that already knows its sources.
  if (!init() && d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init);
})();
