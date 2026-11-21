// Livestream page: show the current Sunday stream, even though it's unlisted.
// Asks livestream.christtheking.build (Cloudflare Worker, signed in to the CTK
// YouTube channel) what's live. No API key in the browser, no search quota.
(async function () {
  const iframe  = document.getElementById('livestream-iframe');
  const player  = document.querySelector('.livestream-player');
  const offline = document.querySelector('.livestream-offline');
  if (!iframe || !player || !offline) return;

  try {
    const res = await fetch('https://livestream.christtheking.build/status', { cache: 'no-store' });
    if (!res.ok) return console.error('Livestream lookup error:', res.status);

    const { state, videoId } = await res.json();
    if (state !== 'live' || !videoId) return console.log('No active livestream found.');

    // Reveal before setting src so the player lays out correctly.
    player.style.display  = 'block';
    offline.style.display = 'none';

    iframe.src =
      `https://www.youtube.com/embed/${videoId}` +
      `?autoplay=1&mute=1&controls=0&rel=0&playsinline=1`;
  } catch (error) {
    console.error('Livestream check failed:', error);
  }
})();
