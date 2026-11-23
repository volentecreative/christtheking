// Livestream page: show the current stream (unlisted is fine) when one is live.
// Asks livestream.christtheking.build, a Cloudflare Worker signed in to the CTK
// YouTube channel. Reveals .livestream-live-only (the Watch on YouTube button)
// when live. While not live, re-checks every minute so early arrivals see
// the stream appear without refreshing.
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
        // "Watch on YouTube" button(s): hidden until live, then link straight to the stream.
        document.querySelectorAll('.livestream-live-only').forEach(function (el) {
          el.style.display = 'block';
          el.querySelectorAll('a').forEach(function (a) { a.href = t.url; });
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

  // Don't poll from background tabs; check right away when the tab comes back.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && offline.style.display !== 'none') check();
  });

  check();
})();
