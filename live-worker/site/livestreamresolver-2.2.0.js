// Livestream page. Asks livestream.christtheking.build (CTK Worker) what is live.
// When live: shows the player and .livestream-live-only (Watch on YouTube),
// hides [data-livestream="offline-only"] (See Sermons). Otherwise re-checks each minute.
(function () {
  var iframe = document.getElementById('livestream-iframe');
  var player = document.querySelector('.livestream-player');
  var offline = document.querySelector('.livestream-offline');
  if (!iframe || !player || !offline) return;

  var RECHECK_MS = 60000;
  var timer;

  function check() {
    fetch('https://livestream.christtheking.build/status', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (t) {
        if (!t || t.state !== 'live' || !t.videoId) return schedule();
        player.style.display = 'block';
        offline.style.display = 'none';
        document.querySelectorAll('.livestream-live-only').forEach(function (el) {
          el.style.display = 'block';
          el.querySelectorAll('a').forEach(function (a) { a.href = t.url; });
        });
        document.querySelectorAll('[data-livestream="offline-only"]').forEach(function (el) {
          el.style.display = 'none';
        });
        iframe.src = 'https://www.youtube.com/embed/' + t.videoId +
          '?autoplay=1&mute=1&controls=0&rel=0&playsinline=1';
      })
      .catch(schedule);
  }

  function schedule() {
    clearTimeout(timer);
    if (!document.hidden) timer = setTimeout(check, RECHECK_MS);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && offline.style.display !== 'none') check();
  });

  check();
})();
