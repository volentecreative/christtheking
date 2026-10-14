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
 * WHAT IT BUILDS (on <body>)
 *   .media-player [data-player="root"] [data-mode] [data-presentation] [data-status] [data-bar]
 *     .media-player_video   the 16:9 box that owns the YouTube iframe for the page's life,
 *                           laid over the stage while it is in view and hidden otherwise.
 *                           A video never plays off-screen: scrolling away or leaving the
 *                           page hands over to the audio, or pauses a sermon without any
 *     .media-player_bar     a floating card (bottom-right on desktop, across the bottom on
 *                           phones) from the first play until closed: progress edge · title ·
 *                           speaker · time · Listen/Watch · play/pause · close
 *   .media-player_listen    a "Listen" icon button added to the page's "Listen on" row
 *   The iframe is never moved in the DOM (moving an iframe reloads it).
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
 *         active) · mode · float · inline · hidden · error · navigate — detail { player, mode, time }
 *
 * NAVIGATION  While the player is active (started and not closed), same-site links
 *         swap the next page's content in place instead of unloading the document,
 *         so playback carries on: see the navigation section. data-player-nav="off"
 *         on a link or an ancestor opts it out. Closing the player restores normal
 *         navigation. The root is a child of <body>, outside the swapped content.
 * STORAGE localStorage ctk-player:prefs { mode, rate, handoff } · ctk-player:positions { slug: { t, mode, at } }
 *         · ctk-player:handoff-log (the last 40 hand-off attempts, for testing on phones)
 * HAND-OFF  Leaving the browser (tab switch, app switch, lock) while a video plays hands
 *         over to the audio when the sermon has any: see the hand-off section. Default
 *         on; ctkPlayer.setHandoff(false) turns it off (remembered).
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
    lastTime: 0,
    ratio: 1,                // how much of the stage is on screen
    sheet: false,            // the transcript sheet is open over the page
    anchor: 0,               // the stage's top in document coordinates, last placed
    href: '',                // the sermon page this item came from
    autoPaused: false,       // the video was paused because it left the screen (no audio to hand to)
    unlocked: false,         // the <audio> has been played once inside a user gesture (iOS needs this)
    unlocking: false,        // that muted unlock play is in flight
    handoff: true,           // switch a playing video to audio when the page is hidden
    autoLeave: false,        // an automatic hand-over to audio is in flight
    playOnInline: false      // play the video once it is back on screen
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
    watch: 'M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm0-80h640v-480H160v480Zm0 0v-480 480Zm240-40 240-160-240-160v320Z'
  };

  /* ---------- CSS: the bar is a series-playlist row (same padding, radius, border and type
     styles as .media-playlist_item.small), on the card surface, with a progress edge. ---------- */
  function css() {
    if ($('style[data-player-style]')) return;
    var s = el('style', null, { 'data-player-style': '' });
    s.textContent = [
      /* The root is a child of <body>, never of the page content, so a content swap never touches it.
         It has no box of its own: the video box is laid over the stage (or fixed above the bar), and
         the bar is fixed to the bottom of the screen while a sermon plays. */
      '.media-player{display:contents;color:var(--_theme---text-01)}',
      '.video-embed[data-player-active]{aspect-ratio:auto;overflow:visible;border-radius:0;margin-bottom:0;transition:none}',
      '.media-player_video{position:absolute;z-index:3;aspect-ratio:16/9;border-radius:var(--border-radius-medium);overflow:clip;background:var(--_theme---background-02)}',
      '.media-player_video iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block}',
      '.media-player[data-has-video="false"] .media-player_video{display:none}',
      /* Away from the stage there is never a video on screen: the bar is all there is. A video
         cannot keep playing hidden (YouTube policy, and iOS pauses it anyway), so leaving the
         stage hands over to the audio, or pauses a sermon that has none. */
      '.media-player[data-presentation="floating"] .media-player_video,.media-player[data-presentation="hidden"] .media-player_video{display:none}',
      /* The bar: a floating card like the section selector on the Beliefs pages (2px border, small
         radius, card surface), inset from the edges, with the progress edge along its top. */
      '.media-player_bar{position:fixed;z-index:95;box-sizing:border-box;left:var(--_spacing---gutter,1rem);right:var(--_spacing---gutter,1rem);bottom:calc(1rem + env(safe-area-inset-bottom,0px));display:flex;align-items:center;gap:.5rem .75rem;padding:.75rem 1rem .625rem;border:2px solid var(--_theme---border-02);border-radius:var(--border-radius-small);background-color:var(--_theme---background-02);box-shadow:0 8px 20px -6px #00000080;overflow:hidden;transform:translateY(calc(100% + 1.5rem));opacity:0;visibility:hidden;transition:transform 240ms cubic-bezier(.22,1,.36,1),opacity 200ms ease-out,visibility 0s linear 240ms}',
      '@media (min-width:992px){.media-player_bar{left:auto;width:26rem;right:1.5rem;bottom:1.5rem}}',
      '.media-player[data-bar="on"] .media-player_bar{transform:none;opacity:1;visibility:visible;transition-delay:0s}',
      '.media-player[data-over-sheet] .media-player_bar{z-index:1002}',
      '@media (prefers-reduced-motion:reduce){.media-player_bar{transition:none}}',
      '.media-player_info{display:flex;flex-direction:column;flex:1 1 8rem;min-width:0;gap:.4rem;cursor:pointer}',
      '.media-player_info:focus-visible{outline:2px solid var(--_theme---accent-01);outline-offset:2px;border-radius:.25rem}',
      '.media-player_title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.media-player_meta{min-width:0}',
      '.media-player_meta > [data-empty],.media-player_meta > [data-empty] + .meta-divider,.media-player_meta > .meta-divider:has(+ [data-empty]){display:none}',
      '.media-player_meta > .meta-divider:first-child{display:none}',
      '.media-player_controls{display:flex;align-items:center;gap:.25rem;flex:none}',
      '.media-player_btn{display:inline-flex;align-items:center;justify-content:center;width:2.75rem;height:2.75rem;padding:0;border:0;border-radius:var(--border-radius-small);background:transparent;color:var(--_theme---text-01);cursor:pointer;font:inherit}',
      '.media-player_btn svg{width:1.5rem;height:1.5rem}',
      /* Play/pause is the back-to-top button in gold: 2.75rem, 2px border, round, the same shadow and press. */
      '.media-player_btn[data-size="large"]{background-color:var(--_theme---accent-01);color:var(--_theme---background-01);border:2px solid var(--_theme---border-02);border-radius:100rem;box-shadow:0 8px 20px -6px #00000080;transition:transform .15s ease,background-color .15s ease}',
      '.media-player_btn[data-size="large"]:active{transform:scale(.92)}',
      '.media-player_btn[data-size="large"] svg{width:1.5rem;height:1.5rem}',
      '.media-player_btn[aria-pressed="true"]{color:var(--_theme---accent-01)}',
      '@media (hover:hover){.media-player_btn:hover{background-color:var(--_theme---background-03)}.media-player_btn[data-size="large"]:hover{background-color:var(--_theme---accent-01);filter:brightness(1.06)}}',
      '.media-player_btn:focus-visible{outline:2px solid var(--_theme---accent-01);outline-offset:2px}',
      '.media-player_btn[data-on] [data-icon="off"],.media-player_btn:not([data-on]) [data-icon="on"]{display:none}',
      '.media-player_btn[data-player="close"]{width:2rem;height:2rem;color:var(--_theme---text-02)}',
      '.media-player_btn[data-player="close"] svg{width:1.25rem;height:1.25rem}',
      /* Progress: a 12px touch strip along the top edge, drawn as a 3px track with a gold fill. */
      '.media-player_progress{position:absolute;left:0;right:0;top:0;height:.75rem;cursor:pointer;touch-action:none}',
      '.media-player_progress::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background-color:var(--_theme---border-02)}',
      '.media-player_progress_fill{position:absolute;left:0;top:0;height:3px;width:var(--player-progress,0%);background-color:var(--_theme---accent-01)}',
      '.media-player_progress:focus-visible{outline:2px solid var(--_theme---accent-01);outline-offset:-2px}',
      '.media-player_progress:focus-visible::before,.media-player_progress:hover::before,.media-player_progress:focus-visible .media-player_progress_fill,.media-player_progress:hover .media-player_progress_fill{height:5px}',
      /* The "Listen" entry point next to the Spotify / Apple icons (or after the stage when that row is absent). */
      '.media-player_listen svg{width:100%;height:100%}',
      '.media-player_listen[aria-pressed="true"]{color:var(--_theme---accent-01)}',
      '.media-player_listen.is-fallback{display:inline-flex;align-items:center;gap:.5rem;width:auto;padding:.5rem .75rem;margin-top:.75rem;border:2px solid var(--_theme---border-02);border-radius:var(--border-radius-small);color:var(--_theme---text-01);font-weight:700;text-decoration:none}',
      '.media-player_listen.is-fallback svg{width:1.25rem;height:1.25rem}',
      'html[data-player-navigating] .page-wrapper{cursor:progress}',
      /* Things that share the bottom edge with the bar move up by its height. */
      'body.has-player-dock .scroll-to-top_button{margin-bottom:calc(var(--player-dock-height,0px) + .5rem)}',
      '.media-transcript.is-visible [data-transcript-sync]{bottom:calc(1rem + var(--player-dock-height,0px))}',
      '.media-transcript.is-visible .media-transcript_body{padding-bottom:calc(1.5rem + var(--player-dock-height,0px))}'
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
  function metaItem(name, extra) {
    var n = el('div', 'text-style-media-meta', { 'data-player': name });
    if (extra) for (var k in extra) n.setAttribute(k, extra[k]);
    return n;
  }
  function divider() { return el('div', 'meta-divider', { 'aria-hidden': 'true' }); }
  function build() {
    root = el('div', 'media-player', {
      'data-player': 'root', role: 'region', 'aria-label': 'Sermon player',
      'data-mode': S.mode, 'data-presentation': 'inline', 'data-status': 'idle', 'data-bar': 'off',
      'data-has-video': String(!!videoId), 'data-has-audio': String(!!audioUrl)
    });
    videoBox = el('div', 'media-player_video', { 'data-player': 'video' });
    bar = el('div', 'media-player_bar', { 'data-player': 'bar' });

    // Title + meta line, the way a series-playlist row shows them. The title goes to the sermon page.
    els.info = el('div', 'media-player_info', { 'data-player': 'info', role: 'button', tabindex: '0' });
    els.title = el('div', 'text-style-title-small media-player_title', { 'data-player': 'title' });
    els.title.textContent = title;
    els.meta = el('div', 'media-meta media-player_meta');
    els.artist = metaItem('speaker');
    els.artist.textContent = artist;
    els.time = metaItem('time', { 'aria-hidden': 'true' });
    els.status = metaItem('status', { role: 'status', 'aria-live': 'polite' });
    els.meta.appendChild(els.artist);
    els.meta.appendChild(divider());
    els.meta.appendChild(els.time);
    els.meta.appendChild(divider());
    els.meta.appendChild(els.status);
    els.info.appendChild(els.title);
    els.info.appendChild(els.meta);

    var controls = el('div', 'media-player_controls');
    els.mode = button('mode', 'Switch to audio',
      '<span data-icon="off">' + svg(ICON.listen) + '</span><span data-icon="on">' + svg(ICON.watch) + '</span>',
      { 'aria-pressed': 'false' });
    els.play = button('play', 'Play', '<span data-icon="off">' + svg(ICON.play) + '</span><span data-icon="on">' + svg(ICON.pause) + '</span>', { 'data-size': 'large' });
    if (videoId && audioUrl) controls.appendChild(els.mode);
    controls.appendChild(els.play);
    els.close = button('close', 'Close player', svg(ICON.close));
    controls.appendChild(els.close);

    // Progress edge: a slider for the keyboard, a strip for a finger.
    els.progress = el('div', 'media-player_progress', {
      'data-player': 'progress', role: 'slider', tabindex: '0', 'aria-label': 'Position',
      'aria-valuemin': '0', 'aria-valuemax': '0', 'aria-valuenow': '0'
    });
    els.fill = el('div', 'media-player_progress_fill');
    els.progress.appendChild(els.fill);

    bar.appendChild(els.progress);
    bar.appendChild(els.info);
    bar.appendChild(controls);
    root.appendChild(videoBox);
    root.appendChild(bar);
    d.body.appendChild(root);

    els.mode.addEventListener('click', function () { api.setMode(S.mode === 'listen' ? 'watch' : 'listen'); });
    els.play.addEventListener('click', function () { api.toggle(); });
    els.close.addEventListener('click', function () { api.close(); });
    els.info.addEventListener('click', function () { api.expand(); });
    els.info.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); api.expand(); }
    });
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.barShown) { e.preventDefault(); api.close(); }
    });
    scrub();
    paint();
  }

  /* The "Listen" entry point on the sermon page: joins the "Listen on" Spotify / Apple
     row as another icon button, or sits after the stage when that row is not there.
     Pressing it starts the MP3 (and switches a playing video to audio). */
  function injectListen() {
    var old = $('[data-player="listen"]');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    els.listen = null;
    if (!audioUrl) return;
    var row = $('.media_platform-buttons .horz-flex') || $('.media_platform-buttons');
    var a = el('a', 'icon-button media-player_listen', {
      href: '#', role: 'button', 'aria-label': 'Listen here', 'aria-pressed': 'false', 'data-player': 'listen', 'data-player-nav': 'off'
    });
    a.innerHTML = svg(ICON.listen) + (row ? '' : '<span>Listen</span>');
    if (row) row.insertBefore(a, row.firstChild);
    else { a.className += ' is-fallback'; if (stage && stage.parentNode) stage.parentNode.insertBefore(a, stage.nextSibling); }
    a.addEventListener('click', function (e) {
      e.preventDefault();
      if (S.mode === 'listen' && api.isPlaying()) { api.pause(); return; }
      if (S.mode !== 'listen') api.setMode('listen');
      if (!api.isPlaying()) api.play();
    });
    els.listen = a;
  }

  /* The progress edge: pointer scrubbing (seek on release, fill follows the finger) and arrow keys. */
  var scrubbing = null;
  function fractionAt(e) {
    var r = els.progress.getBoundingClientRect();
    return r.width ? clamp((e.clientX - r.left) / r.width, 0, 1) : 0;
  }
  function scrub() {
    var pr = els.progress;
    pr.addEventListener('pointerdown', function (e) {
      if (!api.getDuration()) return;
      scrubbing = fractionAt(e);
      pr.setPointerCapture && pr.setPointerCapture(e.pointerId);
      paint();
      e.preventDefault();
    });
    pr.addEventListener('pointermove', function (e) {
      if (scrubbing === null) return;
      scrubbing = fractionAt(e);
      paint();
    });
    function release(e) {
      if (scrubbing === null) return;
      var f = fractionAt(e);
      scrubbing = null;
      api.seek(f * api.getDuration(), { play: false });
    }
    pr.addEventListener('pointerup', release);
    pr.addEventListener('pointercancel', function () { scrubbing = null; paint(); });
    pr.addEventListener('keydown', function (e) {
      var dur = api.getDuration();
      if (!dur) return;
      var t = api.getTime(), step = e.shiftKey ? 30 : 5;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') t += step;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') t -= step;
      else if (e.key === 'Home') t = 0;
      else if (e.key === 'End') t = dur;
      else return;
      e.preventDefault();
      api.seek(clamp(t, 0, dur));
    });
  }

  function buildIframe() {
    if (!videoId) return;
    iframe = videoBox.querySelector('iframe') || (stage && $('iframe[src*="youtube.com/embed"], iframe[src*="youtube-nocookie.com/embed"]', stage));
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
    S.barShown = S.userStarted && !S.dismissed && S.status !== 'idle' && S.status !== 'ended';
    root.setAttribute('data-mode', S.mode);
    root.setAttribute('data-status', S.status);
    root.setAttribute('data-presentation', S.presentation);
    root.setAttribute('data-bar', S.barShown ? 'on' : 'off');
    if (playing) els.play.setAttribute('data-on', ''); else els.play.removeAttribute('data-on');
    els.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (S.mode === 'listen') els.mode.setAttribute('data-on', ''); else els.mode.removeAttribute('data-on');
    els.mode.setAttribute('aria-pressed', String(S.mode === 'listen'));
    els.mode.setAttribute('aria-label', S.mode === 'listen' ? 'Switch to video' : 'Switch to audio');
    if (els.listen) {
      var listening = S.mode === 'listen' && playing;
      els.listen.setAttribute('aria-pressed', String(listening));
      els.listen.setAttribute('aria-label', listening ? 'Pause audio' : 'Listen here');
    }
    els.info.setAttribute('aria-label', title + ' — back to the sermon page');

    var dur = api.getDuration();
    var t = scrubbing === null ? api.getTime() : scrubbing * dur;
    els.time.textContent = fmt(t) + (dur ? ' / ' + fmt(dur) : '');
    var pct = dur ? clamp(t / dur, 0, 1) * 100 : 0;
    els.progress.style.setProperty('--player-progress', pct.toFixed(2) + '%');
    els.progress.setAttribute('aria-valuemax', String(Math.round(dur)));
    els.progress.setAttribute('aria-valuenow', String(Math.round(t)));
    els.progress.setAttribute('aria-valuetext', fmt(t) + (dur ? ' of ' + fmt(dur) : ''));
    [els.artist, els.time, els.status].forEach(function (n) { n.toggleAttribute('data-empty', !n.textContent); });

    bar.inert = !S.barShown;
    d.body.classList.toggle('has-player-dock', S.barShown);
    if (S.barShown) {
      d.documentElement.style.setProperty('--player-dock-height', bar.offsetHeight + 'px');
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
  function savePrefs() { store(PREF_KEY, { mode: S.mode, rate: S.rate, handoff: S.handoff }); }
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
            var first = started();
            if (first) {
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
      if (S.unlocking) { audio.pause(); return; }
      if (S.mode !== 'listen') { audio.pause(); return; }
      started();
      if (S.pending === 'listen') {
        S.pending = null;
        if (S.autoLeave) logHandoff('audio playing');
        S.autoLeave = false;
        clearTimeout(switchTimer);
        audio.muted = false;
        if (yt && ytReady) { yt.pauseVideo(); if (yt.unMute) yt.unMute(); }
      }
      setStatus('playing');
      session();
      emit('play');
    });
    audio.addEventListener('pause', function () {
      if (S.unlocking) { S.unlocking = false; S.unlocked = true; audio.muted = false; logHandoff('unlocked'); return; }
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
    if (S.autoLeave) {
      S.autoLeave = false;
      logHandoff('audio failed: ' + msg);
      S.mode = videoId ? 'watch' : 'listen';
      if (yt && ytReady) { if (yt.unMute) yt.unMute(); yt.pauseVideo(); }
      S.autoPaused = true;
      say(msg + ' — paused', true);
      setStatus('paused');
      emit('mode');
      emit('error', { source: 'audio' });
      return;
    }
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

  /* ---------- leaving the browser: video → audio hand-off ----------
     A YouTube video stops when the tab is hidden or the phone locks, and may not
     be played in the background anyway. The MP3 can carry on — if the browser
     lets a hidden page start it. iOS only lets an <audio> element play from code
     once it has been played inside a real user gesture, so the first tap, touch
     or key on the page plays it muted for an instant (the "unlock"); while the
     video plays, the paused audio is kept cued near the video's position so the
     hand-over has little to fetch. On visibilitychange → hidden a playing video
     hands over exactly like scrolling away does. If the audio cannot start, the
     video is paused and the bar says so on return; nothing restarts on its own.
     Attempts are logged to localStorage (ctkPlayer.handoffLog()) for testing on
     real phones. */
  var HANDOFF_LOG = 'ctk-player:handoff-log';
  function logHandoff(what) {
    var log = load(HANDOFF_LOG) || [];
    log.push({ at: new Date().toISOString(), what: what, mode: S.mode, status: S.status, visible: d.visibilityState, slug: S.slug });
    store(HANDOFF_LOG, log.slice(-40));
  }
  function unlockAudio() {
    if (!audioUrl || S.unlocked || S.unlocking) return;
    var a = ensureAudio();
    if (!a || !a.paused) return;
    S.unlocking = true;
    a.muted = true;
    var p = a.play();
    if (p && p.catch) p.catch(function () { S.unlocking = false; a.muted = false; logHandoff('unlock refused'); });
  }
  // A real play from the same gesture takes over the unlock: it is the unlock.
  function claimAudio() {
    if (!S.unlocking) return;
    S.unlocking = false;
    S.unlocked = true;
    if (audio) audio.muted = false;
  }
  var cueTimer = 0;
  function cueAudio() {
    if (!audio || !audioUrl || S.mode !== 'watch' || !ytPlaying() || !audio.paused || S.unlocking) return;
    if (audio.readyState < 1) return;
    var t = ytTime() + S.offset;
    if (Math.abs(audio.currentTime - t) > 10) audio.currentTime = t;
  }
  function onHidden() {
    if (d.visibilityState !== 'hidden') return;
    savePosition(true);
    if (!S.handoff || S.mode !== 'watch' || !(S.status === 'playing' || S.status === 'loading')) return;
    if (!audioUrl) { logHandoff('hidden, no audio'); return; }
    logHandoff(S.unlocked ? 'hidden, handing over' : 'hidden, handing over (not unlocked)');
    leaveVideo();
  }
  function watchVisibility() {
    ['pointerdown', 'touchend', 'keydown'].forEach(function (ev) {
      d.addEventListener(ev, unlockAudio, { capture: true, passive: true });
    });
    cueTimer = setInterval(cueAudio, 20000);
    d.addEventListener('visibilitychange', onHidden);
  }

  /* ---------- presentation ---------- */
  // Inline = the root laid over the stage in document coordinates (it scrolls
  // with the page like any absolute box); the stage holds the root's height.
  // Floating = position:fixed from the stylesheet. The root never moves in the
  // DOM, so neither the iframe nor the audio is ever interrupted.
  function place() {
    if (!root || !stage || S.presentation !== 'inline') return;
    var r = stage.getBoundingClientRect();
    videoBox.style.left = Math.round(r.left + w.scrollX) + 'px';
    videoBox.style.top = Math.round(r.top + w.scrollY) + 'px';
    videoBox.style.width = Math.round(r.width) + 'px';
    stage.style.height = videoBox.offsetHeight + 'px';
    S.anchor = r.top + w.scrollY;
  }
  function setPresentation(p) {
    if (S.presentation === p) return;
    if (p === 'floating') videoBox.style.left = videoBox.style.top = videoBox.style.width = '';
    S.presentation = p;
    paint();
    if (p === 'inline') place();
    emit(p === 'floating' ? 'float' : p === 'inline' ? 'inline' : 'hidden');
  }
  // The video is leaving the screen (scrolled away, a link clicked). It may not keep
  // playing hidden, so the audio takes over where there is any; otherwise it pauses
  // and the bar stays, offering to bring you back.
  function leaveVideo() {
    if (S.mode !== 'watch' || !(S.status === 'playing' || S.status === 'loading')) return;
    if (audioUrl) {
      S.autoLeave = true;
      api.setMode('listen');
      if (S.pending !== 'listen') S.autoLeave = false;
      return;
    }
    if (yt && ytReady) yt.pauseVideo();
    S.autoPaused = true;
    say('Paused — scroll back to the video');
    paint();
  }
  // Where the stage is decides inline vs floating. The video only ever shows inline.
  function applyRatio() {
    if (!stage) {
      if (S.presentation !== 'floating') setPresentation('floating');
      return;
    }
    var ratio = S.ratio;
    if (ratio >= FLOAT_IN) {
      S.dismissed = false;
      if (S.presentation !== 'inline') setPresentation('inline');
      if (S.autoPaused && S.mode === 'watch') {
        S.autoPaused = false;
        say('');
        if (yt && ytReady) { ytHoldPause = false; yt.playVideo(); }
      }
      if (S.playOnInline) { S.playOnInline = false; api.play(); }
      paint();
      return;
    }
    if (ratio < FLOAT_OUT && S.presentation === 'inline') {
      if (S.barShown || S.userStarted) {
        leaveVideo();
        setPresentation('floating');
      }
    }
  }
  var io = null, ro = null, placeTick = 0;
  function observeStage() {
    if (io) io.disconnect();
    if (ro) ro.disconnect();
    if (!stage) return;
    stage.setAttribute('data-player-active', '');
    if ('IntersectionObserver' in w) {
      io = new IntersectionObserver(function (entries) {
        S.ratio = entries[entries.length - 1].intersectionRatio;
        applyRatio();
      }, { threshold: [0, FLOAT_OUT, FLOAT_IN, 1] });
      io.observe(stage);
    }
    if ('ResizeObserver' in w) {
      ro = new ResizeObserver(function () { place(); paint(); });
      ro.observe(stage);
      ro.observe(bar);
    }
    place();
  }
  function attachStage(el) {
    stage = el || null;
    S.ratio = stage ? 1 : 0;
    observeStage();
    applyRatio();
  }
  function watchPage() {
    w.addEventListener('resize', place);
    w.addEventListener('load', place);
    if (d.fonts && d.fonts.ready) d.fonts.ready.then(place);
    // Anything above the stage changing height moves it: a cheap check per scroll frame.
    w.addEventListener('scroll', function () {
      if (placeTick || !stage || S.presentation !== 'inline') return;
      placeTick = requestAnimationFrame(function () {
        placeTick = 0;
        var top = stage.getBoundingClientRect().top + w.scrollY;
        if (Math.abs(top - S.anchor) > 1) place();
      });
    }, { passive: true });
    d.addEventListener('vci:modal:open', function (e) {
      if (!e.detail || e.detail.key !== 'transcript') return;
      S.sheet = true;
      root.setAttribute('data-over-sheet', '');
      if (audioUrl) leaveVideo(); // the sheet covers the video; audio carries on underneath
      paint();
    });
    d.addEventListener('vci:modal:close', function (e) {
      if (!e.detail || e.detail.key !== 'transcript') return;
      S.sheet = false;
      root.removeAttribute('data-over-sheet');
      paint();
    });
  }
  // Playback has started: the bar may now float (and must, over an open sheet).
  function started() {
    S.dismissed = false;
    if (S.userStarted) return false;
    S.userStarted = true;
    applyRatio();
    return true;
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
      if (S.mode === 'watch' && videoId && S.presentation !== 'inline') {
        if (audioUrl) { S.autoPaused = false; api.setMode('listen'); api.play(); return; }
        S.playOnInline = true;
        api.expand();
        return;
      }
      S.autoPaused = false;
      if (S.mode === 'listen' && audioUrl) {
        ensureAudio();
        claimAudio();
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
      S.autoPaused = false;
      S.playOnInline = false;
      if (S.mode === 'listen') { if (audio) audio.pause(); paint(); return; }
      if (yt && ytReady) yt.pauseVideo();
      paint();
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
      if (opts.play) started();
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
      if (mode === 'watch' && S.presentation !== 'inline') {
        // Watch only happens on screen: go back to the video and switch there.
        S.playOnInline = api.isPlaying();
        if (S.playOnInline) api.pause();
        S.mode = 'watch';
        savePrefs();
        emit('mode');
        api.expand();
        return;
      }
      var t = api.getTime();
      var wasPlaying = api.isPlaying();
      clearTimeout(switchTimer);
      S.mode = mode;
      S.pending = wasPlaying ? mode : null;
      savePrefs();
      emit('mode');
      if (mode === 'listen') {
        ensureAudio();
        claimAudio();
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
      if (!stage) {
        // Away from the sermon page: the title takes you back to it.
        if (S.href) nav.go(S.href, true);
        return;
      }
      stage.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'center' });
      setTimeout(function () { if (S.presentation === 'floating' && !S.sheet) setPresentation('inline'); }, reduced.matches ? 0 : 400);
    },
    close: function () {
      api.pause();
      S.dismissed = true;
      savePosition(true);
      paint();
    },
    setHandoff: function (on) { S.handoff = !!on; savePrefs(); },
    getHandoff: function () { return S.handoff; },
    handoffLog: function () { return load(HANDOFF_LOG) || []; },
    setAudio: function (url) {
      audioUrl = url || null;
      api.hasAudio = !!audioUrl;
      if (audio) { audio.pause(); audio = null; }
      if (root) {
        root.setAttribute('data-has-audio', String(!!audioUrl));
        var controls = $('.media-player_controls', root);
        if (audioUrl && videoId && !els.mode.parentNode) controls.insertBefore(els.mode, controls.firstChild);
        if (!audioUrl && els.mode.parentNode) els.mode.parentNode.removeChild(els.mode);
        injectListen();
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

  /* ---------- items ---------- */
  function readStage(el) {
    var qs = null;
    try { qs = new URLSearchParams(location.search).get('ctk-audio'); } catch (e) { /* old browser */ }
    return {
      videoId: (el.getAttribute('data-player-youtube') || el.getAttribute('data-youtube-id') || '').trim() || null,
      audioUrl: (qs || el.getAttribute('data-player-audio') || el.getAttribute('data-audio-url') || '').trim() || null,
      offset: Number(el.getAttribute('data-audio-offset')) || 0,
      audioDuration: Number(el.getAttribute('data-audio-duration')) || 0
    };
  }
  function readPage() {
    var h1 = $('h1');
    title = h1 ? h1.textContent.trim() : d.title;
    artist = Array.prototype.map.call(d.querySelectorAll('.media-byline .contributor_content > :first-child'), function (n) {
      return n.textContent.trim();
    }).filter(Boolean).join(', ');
    artwork = videoId ? 'https://i.ytimg.com/vi/' + encodeURIComponent(videoId) + '/hqdefault.jpg' : null;
    if (els.title) els.title.textContent = title;
    if (els.artist) els.artist.textContent = artist;
  }
  // Load the sermon on this page into the player (first load, or a new sermon reached by navigation).
  function mount(el) {
    var src = readStage(el);
    if (!src.videoId && !src.audioUrl) { el.style.display = 'none'; return false; }
    clearTimeout(switchTimer);
    clearInterval(tickTimer); tickTimer = 0;
    if (audio) { audio.pause(); audio = null; }
    if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
    iframe = null; yt = null; ytReady = false; ytHoldPause = false; ytDuration = 0;
    videoId = src.videoId; audioUrl = src.audioUrl; S.offset = src.offset; audioDuration = src.audioDuration;
    api.hasVideo = !!videoId; api.hasAudio = !!audioUrl; api.ready = false;
    S.slug = location.pathname.replace(/\/+$/, '').split('/').pop() || 'home';
    S.href = location.pathname + location.search;
    S.mode = 'watch'; S.status = 'idle'; S.userStarted = false; S.dismissed = false; S.pending = null; S.lastTime = 0; S.sheet = false;
    S.autoPaused = false; S.autoLeave = false; S.playOnInline = false; S.unlocked = false; S.unlocking = false;
    resumed = false; scrubbing = null;
    var prefs = load(PREF_KEY) || {};
    if (RATES.indexOf(prefs.rate) !== -1) S.rate = prefs.rate;
    if (prefs.mode === 'listen' && audioUrl) S.mode = 'listen';
    if (prefs.handoff === false) S.handoff = false;
    if (!videoId) S.mode = 'listen';
    if (!audioUrl) S.mode = 'watch';
    if (!root) { css(); build(); }
    root.removeAttribute('data-over-sheet');
    root.setAttribute('data-has-video', String(!!videoId));
    root.setAttribute('data-has-audio', String(!!audioUrl));
    var controls = $('.media-player_controls', root);
    if (videoId && audioUrl) { if (!els.mode.parentNode) controls.insertBefore(els.mode, controls.firstChild); }
    else if (els.mode.parentNode) els.mode.parentNode.removeChild(els.mode);
    readPage();
    say('');
    buildIframe();
    if (iframe) loadYT();
    if (S.mode === 'listen') { ensureAudio(); api.ready = true; }
    if (S.presentation === 'hidden') S.presentation = 'inline';
    attachStage(el);
    injectListen();
    if (!videoId) el.style.display = 'none';
    paint();
    emit('ready');
    return true;
  }
  // A page was swapped in: the same sermon re-anchors, a different one loads, none leaves the bar floating.
  function adopt() {
    var el = $('[data-player="stage"]') || $('[data-youtube-id]') || $('.video-embed[data-video]');
    if (!el) { attachStage(null); return; }
    var src = readStage(el);
    if (src.videoId === videoId && src.audioUrl === audioUrl) {
      S.sheet = false;
      root.removeAttribute('data-over-sheet');
      S.href = location.pathname + location.search;
      readPage();
      attachStage(el);
      injectListen();
      if (!videoId) el.style.display = 'none';
      paint();
      return;
    }
    savePosition(true);
    api.pause();
    mount(el);
  }

  /* ---------- navigation: keep the page alive while the sermon plays ----------
     A normal link unloads the document and everything in it, the audio included.
     While the player is active (started and not closed), same-site links fetch the
     next page and swap its content in place: the announcement bar, navbar and
     footer stay (they are the same on every page), the sections between them are
     replaced, the new page's own scripts run, and Webflow, Finsweet and narthex
     are told about the new content. Closing the player returns the site to
     ordinary navigation. Modifier-clicks, new-tab links, hashes, downloads and
     files are always left to the browser. */
  var nav = (function () {
    var ctl = null;
    var current = location.pathname + location.search;
    var seenScripts = {};
    var seenStyles = {};
    var FILE = /\.(pdf|mp3|m4a|wav|zip|jpe?g|png|gif|svg|webp|avif|vtt|txt|csv|xml|rss|json|ics)$/i;
    var KEEP = '.announcement-bar, nav.navbar, [vci-nav="header"], footer.footer, footer';

    function active() { return !!root && S.barShown && (S.mode === 'listen' || !!audioUrl); }
    function remember() {
      Array.prototype.forEach.call(d.body.querySelectorAll(':scope > script:not([src])'), function (sc) { seenScripts[sc.textContent] = true; });
      Array.prototype.forEach.call(d.querySelectorAll('style'), function (st) { seenStyles[st.textContent] = true; });
    }
    function cloneScript(old) {
      var sc = d.createElement('script');
      Array.prototype.forEach.call(old.attributes, function (a) { sc.setAttribute(a.name, a.value); });
      sc.textContent = old.textContent;
      return sc;
    }
    function hasScript(src) {
      return !!Array.prototype.some.call(d.scripts, function (x) { return x.src === src; });
    }
    function onClick(e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || !active()) return;
      if ((a.target && a.target !== '_self') || a.hasAttribute('download') || a.closest('[data-player-nav="off"]')) return;
      if (root.contains(a)) return;
      var url;
      try { url = new URL(a.href, location.href); } catch (x) { return; }
      if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return;
      if (FILE.test(url.pathname)) return;
      if (url.pathname === location.pathname && url.search === location.search) return; // same page or a hash
      e.preventDefault();
      leaveVideo();
      go(url.href, true);
    }
    function go(href, push) {
      if (ctl) ctl.abort();
      var mine = ctl = ('AbortController' in w) ? new AbortController() : null;
      d.documentElement.setAttribute('data-player-navigating', '');
      fetch(href, { credentials: 'same-origin', headers: { Accept: 'text/html' }, signal: mine && mine.signal })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text().then(function (html) { return { html: html, url: r.url || href }; });
        })
        .then(function (res) {
          if (mine !== ctl) return;
          ctl = null;
          swap(new DOMParser().parseFromString(res.html, 'text/html'), res.url, push);
        })
        .catch(function (err) {
          if (err && err.name === 'AbortError') return;
          d.documentElement.removeAttribute('data-player-navigating');
          location.href = href; // the page the browser would have shown anyway
        });
    }
    function swap(doc, url, push) {
      var oldWrap = $('.page-wrapper'), newWrap = doc.querySelector('.page-wrapper');
      if (!oldWrap || !newWrap) { location.href = url; return; }
      savePosition(true);

      if (push) history.pushState({ ctkPlayer: true }, '', url);
      current = location.pathname + location.search;

      d.title = doc.title;
      ['meta[name="description"]', 'meta[property="og:title"]', 'meta[property="og:description"]', 'meta[property="og:image"]', 'meta[property="og:url"]', 'link[rel="canonical"]'].forEach(function (sel) {
        var from = doc.querySelector(sel), to = $(sel);
        if (from && to) { if (from.hasAttribute('content')) to.setAttribute('content', from.getAttribute('content')); if (from.hasAttribute('href')) to.setAttribute('href', from.getAttribute('href')); }
      });
      ['data-wf-page', 'data-wf-collection', 'data-wf-item-slug', 'data-wf-item-id'].forEach(function (name) {
        var v = doc.documentElement.getAttribute(name);
        if (v === null) d.documentElement.removeAttribute(name); else d.documentElement.setAttribute(name, v);
      });
      d.body.className = doc.body.className;
      paint(); // puts the dock class back on the new body class

      // Stylesheets and page-level styles the new page brings.
      Array.prototype.forEach.call(doc.querySelectorAll('link[rel="stylesheet"]'), function (l) {
        if (!$('link[rel="stylesheet"][href="' + l.getAttribute('href') + '"]')) d.head.appendChild(d.adoptNode(l));
      });
      Array.prototype.forEach.call(doc.querySelectorAll('head style, body > style'), function (st) {
        if (seenStyles[st.textContent]) return;
        seenStyles[st.textContent] = true;
        d.head.appendChild(d.adoptNode(st));
      });

      // Content: everything between the kept navbar and footer.
      var footer = null;
      Array.prototype.slice.call(oldWrap.children).forEach(function (c) {
        if (c.matches(KEEP)) { if (c.matches('footer, footer.footer')) footer = c; return; }
        oldWrap.removeChild(c);
      });
      var scripts = [];
      Array.prototype.slice.call(newWrap.children).forEach(function (c) {
        if (c.matches(KEEP)) return;
        var node = d.adoptNode(c);
        if (footer) oldWrap.insertBefore(node, footer); else oldWrap.appendChild(node);
        Array.prototype.push.apply(scripts, node.querySelectorAll ? node.querySelectorAll('script') : []);
        if (node.tagName === 'SCRIPT') scripts.push(node);
      });
      // Scripts arriving by DOM insertion are inert; replace each with a live copy, in order.
      scripts.forEach(function (sc) {
        if (sc.src && hasScript(sc.src)) { sc.parentNode.removeChild(sc); return; }
        sc.parentNode.replaceChild(cloneScript(sc), sc);
      });
      // The new page's own body-level code (page custom code), and the site's
      // registered scripts that bind to elements at load.
      Array.prototype.forEach.call(doc.body.querySelectorAll(':scope > script'), function (sc) {
        if (sc.src) {
          if (/website-files\.com\/.*%2F.*\.js/.test(sc.src) && !/media-player/.test(sc.src)) {
            // registered scripts re-run so they bind to the new content
            d.body.appendChild(cloneScript(sc));
          } else if (!hasScript(sc.src)) {
            d.body.appendChild(cloneScript(sc));
          }
          return;
        }
        if (seenScripts[sc.textContent]) return;
        seenScripts[sc.textContent] = true;
        d.body.appendChild(cloneScript(sc));
      });

      // Current-page marks on nav links.
      Array.prototype.forEach.call(d.querySelectorAll('a.w--current'), function (a) { a.classList.remove('w--current'); a.removeAttribute('aria-current'); });
      Array.prototype.forEach.call(d.querySelectorAll('nav a[href], footer a[href]'), function (a) {
        var u; try { u = new URL(a.href, location.href); } catch (x) { return; }
        if (u.origin === location.origin && u.pathname === location.pathname) { a.classList.add('w--current'); a.setAttribute('aria-current', 'page'); }
      });

      // Libraries that scan the page at load.
      try {
        var W = w.Webflow;
        if (W && W.destroy && W.ready) { W.destroy(); W.ready(); var ix = W.require && W.require('ix2'); if (ix && ix.init) ix.init(); }
      } catch (e) { /* Webflow runtime changed */ }
      try {
        var fa = w.FinsweetAttributes;
        if (fa && fa.modules) {
          for (var k in fa.modules) { if (fa.modules[k] && typeof fa.modules[k].restart === 'function') fa.modules[k].restart(); }
          if (typeof fa.load === 'function' && $('[fs-list-element]') && !fa.modules.list) fa.load('list');
        }
      } catch (e) { /* Finsweet runtime changed */ }
      try {
        var v = w.vci;
        if (v && v.accordion && v.accordion.init) v.accordion.init();
        if (v && v.nav && v.nav.measure) v.nav.measure();
      } catch (e) { /* narthex changed */ }

      // Scroll like a new page would, then hand focus to the heading.
      var hash = location.hash && $(location.hash);
      if (hash) hash.scrollIntoView(); else w.scrollTo(0, 0);
      var h1 = $('.page-wrapper h1');
      if (h1) { if (!h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); }

      adopt();
      d.documentElement.removeAttribute('data-player-navigating');
      emit('navigate', { url: url });
    }
    function onPop() {
      var here = location.pathname + location.search;
      if (here === current) return; // a hash change
      if (active()) go(location.href, false);
      else location.reload();
    }
    function start() {
      remember();
      d.addEventListener('click', onClick);
      w.addEventListener('popstate', onPop);
    }
    return { go: go, start: start, active: active };
  })();

  /* ---------- init ---------- */
  var booted = false;
  function init() {
    if (booted) return true;
    var el = $('[data-player="stage"]') || $('[data-youtube-id]') || $('.video-embed[data-video]');
    if (!el) return false;
    booted = true;
    css();
    build();
    watchPage();
    watchVisibility();
    nav.start();
    w.addEventListener('pagehide', function () { savePosition(true); });
    mount(el);
    return true;
  }

  // The footer script runs after the page's markup has been parsed, so the
  // stage is normally there already; starting now (not at DOMContentLoaded)
  // means the transcript embed, whose own DOMContentLoaded handler was
  // registered first, finds a player that already knows its sources.
  if (!init() && d.readyState === 'loading') d.addEventListener('DOMContentLoaded', init);
})();
