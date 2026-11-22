// Livestream page: asks livestream.christtheking.build (CTK Worker) what is live.
// Spinner until the first answer; then the player + live-only UI, or the offline message.
(function () {
  var iframe = document.getElementById('livestream-iframe');
  var player = document.querySelector('.livestream-player');
  var offline = document.querySelector('.livestream-offline');
  if (!iframe || !player || !offline) return;
  var loading = offline.querySelector('.livestream-loading');
  var message = offline.querySelector('.livestream-offline-content');
  var timer;

  function show(sel, display) {
    document.querySelectorAll(sel).forEach(function (el) { el.style.display = display; });
  }

  function showOffline() {
    if (loading) loading.style.display = 'none';
    if (message) message.style.display = 'flex';
  }

  function check() {
    fetch('https://livestream.christtheking.build/status', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (t) {
        if (!t || t.state !== 'live' || !t.videoId) { showOffline(); return schedule(); }
        player.style.display = 'block';
        offline.style.display = 'none';
        show('.livestream-live-only', 'block');
        show('.live-badge', 'flex');
        show('[data-livestream="offline-only"]', 'none');
        document.querySelectorAll('.livestream-live-only a').forEach(function (a) { a.href = t.url; });
        iframe.src = 'https://www.youtube.com/embed/' + t.videoId +
          '?autoplay=1&mute=1&controls=0&rel=0&playsinline=1';
      })
      .catch(function () { showOffline(); schedule(); });
  }

  function schedule() {
    clearTimeout(timer);
    if (!document.hidden) timer = setTimeout(check, 60000);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && offline.style.display !== 'none') check();
  });

  setTimeout(showOffline, 8000);
  check();
})();
