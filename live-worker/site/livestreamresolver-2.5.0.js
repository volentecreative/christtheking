// Livestream page: asks livestream.christtheking.build (CTK Worker) what is live.
// Spinner until the first answer; then the player + live-only UI, or the offline message.
// 2.5.0: keeps checking every minute while live too, and switches back to the
// offline message when the stream ends (2.4.0 stopped checking once live).
(function () {
  var iframe = document.getElementById('livestream-iframe');
  var player = document.querySelector('.livestream-player');
  var offline = document.querySelector('.livestream-offline');
  if (!iframe || !player || !offline) return;
  var loading = offline.querySelector('.livestream-loading');
  var message = offline.querySelector('.livestream-offline-content');
  var timer;
  var liveId = null;

  function show(sel, display) {
    document.querySelectorAll(sel).forEach(function (el) { el.style.display = display; });
  }

  function showOffline() {
    if (liveId) {
      liveId = null;
      iframe.removeAttribute('src');
      player.style.display = 'none';
      offline.style.display = 'flex';
      show('.livestream-live-only', 'none');
      show('.live-badge', 'none');
      show('[data-livestream="offline-only"]', '');
    }
    if (loading) loading.style.display = 'none';
    if (message) message.style.display = 'flex';
  }

  function showLive(t) {
    player.style.display = 'block';
    offline.style.display = 'none';
    show('.livestream-live-only', 'block');
    show('.live-badge', 'flex');
    show('[data-livestream="offline-only"]', 'none');
    document.querySelectorAll('.livestream-live-only a').forEach(function (a) { a.href = t.url; });
    // Only (re)load the player when the stream changes, so a viewer isn't interrupted.
    if (liveId !== t.videoId) {
      liveId = t.videoId;
      iframe.src = 'https://www.youtube.com/embed/' + t.videoId +
        '?autoplay=1&mute=1&controls=0&rel=0&playsinline=1';
    }
  }

  function check() {
    fetch('https://livestream.christtheking.build/status', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (t) {
        if (t && t.state === 'live' && t.videoId) showLive(t);
        // A failed check while live keeps the player up; only a clear answer ends it.
        else if (t || !liveId) showOffline();
        schedule();
      })
      .catch(function () { if (!liveId) showOffline(); schedule(); });
  }

  function schedule() {
    clearTimeout(timer);
    if (!document.hidden) timer = setTimeout(check, 60000);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) check();
  });

  setTimeout(function () { if (!liveId) showOffline(); }, 8000);
  check();
})();
