/**
 * Browser test for webflow/registered/media-player.js, with the transcript
 * embed (webflow/embeds/media-template-transcript.html) riding along as its
 * one existing consumer.
 *
 * YouTube is stubbed: the iframe_api URL is answered with a fake YT.Player
 * that keeps time, and the embed URL with an empty page, so nothing leaves
 * the machine. The audio is a generated silent WAV served locally.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const FIXTURE = read('./fixtures/media-player.html');
const EMBED = read('../webflow/embeds/media-template-transcript.html');
const PLAYER = read('../webflow/registered/media-player.js');

// Five minutes of 8 kHz 8-bit silence (2.4 MB) — long enough to seek to any transcript row.
function wav(seconds = 300) {
  const rate = 8000, n = rate * seconds;
  const b = Buffer.alloc(44 + n, 0x80);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
}
const AUDIO = wav();

// A YouTube IFrame API stand-in. Keeps state and a clock, records seeks and rate changes.
const FAKE_YT = `
(function () {
  function Player(el, opts) {
    var self = this;
    this.el = el; this.events = (opts && opts.events) || {};
    this.state = -1; this.t = 0; this.rate = 1; this.muted = false; this.seeks = []; this.rates = [];
    this.timer = null;
    window.__yt = this;
    setTimeout(function () { self.events.onReady && self.events.onReady({ target: self }); }, 0);
  }
  Player.prototype.set = function (s) { this.state = s; var e = this.events.onStateChange; if (e) e({ data: s, target: this }); };
  Player.prototype.playVideo = function () {
    var self = this;
    if (this.state === 1) return;
    clearInterval(this.timer);
    this.timer = setInterval(function () { self.t += 0.1 * self.rate; }, 100);
    this.set(1);
  };
  Player.prototype.pauseVideo = function () { clearInterval(this.timer); this.timer = null; if (this.state !== 2) this.set(2); };
  Player.prototype.seekTo = function (s) { this.seeks.push(s); this.t = s; if (this.state === -1 || this.state === 5) this.playVideo(); };
  Player.prototype.getCurrentTime = function () { return this.t; };
  Player.prototype.getDuration = function () { return 3600; };
  Player.prototype.getPlayerState = function () { return this.state; };
  Player.prototype.setPlaybackRate = function (r) { this.rate = r; this.rates.push(r); var e = this.events.onPlaybackRateChange; if (e) e({ data: r }); };
  Player.prototype.getPlaybackRate = function () { return this.rate; };
  Player.prototype.mute = function () { this.muted = true; };
  Player.prototype.unMute = function () { this.muted = false; };
  window.YT = { Player: Player, PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } };
  setTimeout(function () { window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(); }, 0);
})();`;

let server, base, browser;

function pageHtml({ video = '2qsHQo0xGP8', audio = '/audio.wav', embed = true, offset = 0 } = {}) {
  let attrs = '';
  if (video) attrs += ` data-youtube-id="${video}"`;
  if (audio) attrs += ` data-audio-url="${audio}"`;
  if (offset) attrs += ` data-audio-offset="${offset}"`;
  return FIXTURE.replace('{{STAGE_ATTRS}}', attrs).replace('{{EMBED}}', embed ? EMBED : '');
}

test.before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/media-player.js') return res.writeHead(200, { 'content-type': 'application/javascript' }).end(PLAYER);
    if (url.pathname === '/audio.wav') {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = Number(range[1]), end = range[2] ? Number(range[2]) : AUDIO.length - 1;
        res.writeHead(206, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${AUDIO.length}`, 'content-length': end - start + 1 });
        return res.end(AUDIO.subarray(start, end + 1));
      }
      return res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': AUDIO.length }).end(AUDIO);
    }
    if (url.pathname === '/missing.mp3') return res.writeHead(404).end();
    if (url.pathname.startsWith('/sermon')) {
      const opts = {};
      if (url.searchParams.has('video')) opts.video = url.searchParams.get('video') || null;
      if (url.searchParams.has('audio')) opts.audio = url.searchParams.get('audio') || null;
      if (url.searchParams.has('embed')) opts.embed = url.searchParams.get('embed') !== '0';
      if (url.searchParams.has('offset')) opts.offset = Number(url.searchParams.get('offset'));
      return res.writeHead(200, { 'content-type': 'text/html' }).end(pageHtml(opts));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
});

test.after(async () => {
  await browser?.close();
  server?.close();
});

async function open(path = '/sermon/love-the-standard', { viewport } = {}) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let embedLoads = 0;
  await page.route(/youtube\.com\/iframe_api/, (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_YT }));
  await page.route(/youtube(-nocookie)?\.com\/embed\//, (r) => { embedLoads++; r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>yt</title>' }); });
  await page.route(/i\.ytimg\.com/, (r) => r.fulfill({ status: 204 }));
  await page.goto(base + path);
  await page.waitForFunction(() => window.ctkPlayer && window.ctkPlayer.ready);
  return { page, ctx, errors, loads: () => embedLoads };
}

const state = (page) => page.evaluate(() => ({
  mode: ctkPlayer.getMode(), status: ctkPlayer.getStatus(), presentation: ctkPlayer.getPresentation(),
  time: ctkPlayer.getTime(), playing: ctkPlayer.isPlaying(), rate: ctkPlayer.getRate(),
  yt: window.__yt ? { state: __yt.state, t: __yt.t, seeks: __yt.seeks, rate: __yt.rate, muted: __yt.muted } : null,
}));

test('renders one player inside the stage: video box, bar, both-source controls, iframe with the JS API', async () => {
  const { page, ctx, errors, loads } = await open();
  assert.equal(await page.$$eval('[data-player="root"]', (e) => e.length), 1);
  assert.ok(await page.$('.video-embed[data-player-active] > .media-player > .media-player_video > iframe'));
  const src = await page.$eval('.media-player_video iframe', (f) => f.src);
  assert.match(src, /youtube\.com\/embed\/2qsHQo0xGP8\?.*enablejsapi=1.*origin=/);
  assert.ok(await page.$('[data-player="mode"]'), 'Listen/Watch toggle present when both sources exist');
  assert.equal(await page.$eval('[data-player="root"]', (r) => r.getAttribute('role')), 'region');
  assert.equal(await page.$eval('[data-player="play"]', (b) => b.getAttribute('aria-label')), 'Play');
  // Only one YT.Player is attached: the embed defers to ctkPlayer (its play button is wired, not its own iframe).
  assert.equal(await page.$eval('iframe', () => document.querySelectorAll('iframe').length), 1);
  assert.equal(loads(), 1, 'the iframe loaded exactly once');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('watch-only and listen-only items render the right controls', async () => {
  let { page, ctx } = await open('/sermon/x?audio=');
  assert.equal(await page.$('[data-player="mode"]'), null, 'no mode toggle without audio');
  assert.ok(await page.$('.media-player_video iframe'));
  await ctx.close();
  ({ page, ctx } = await open('/sermon/y?video='));
  assert.equal(await page.$('[data-player="mode"]'), null);
  assert.equal(await page.$eval('[data-player="root"]', (r) => r.getAttribute('data-has-video')), 'false');
  assert.equal(await page.$eval('[data-player="root"]', (r) => r.getAttribute('data-mode')), 'listen');
  assert.equal(await page.$eval('.media-player_video', (v) => getComputedStyle(v).display), 'none');
  await page.click('[data-player="play"]');
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.waitForFunction(() => ctkPlayer.getTime() > 0.3);
  await ctx.close();
});

test('floats when the stage scrolls away after playback started, keeps the same iframe, and comes back', async () => {
  const { page, ctx, loads } = await open();
  await page.evaluate(() => { document.querySelector('iframe').__token = 'same'; });
  // Scrolling before anyone pressed play changes nothing.
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForTimeout(150);
  assert.equal((await state(page)).presentation, 'inline');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('[data-player="play"]');
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  const inlineHeight = await page.$eval('[data-player="root"]', (r) => r.offsetHeight);
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForFunction(() => ctkPlayer.getPresentation() === 'floating');
  await page.waitForFunction(() => !document.querySelector('[data-player="root"]').hasAttribute('data-animate')); // the rise has landed
  const floating = await page.evaluate(() => {
    const r = document.querySelector('[data-player="root"]');
    const cs = getComputedStyle(r);
    const box = r.getBoundingClientRect();
    return { position: cs.position, z: cs.zIndex, token: document.querySelector('iframe').__token,
      stageMin: document.querySelector('.video-embed').style.minHeight, bottomGap: innerHeight - box.bottom,
      rightGap: innerWidth - box.right, videoH: document.querySelector('.media-player_video').getBoundingClientRect().height,
      dockClass: document.body.classList.contains('has-player-dock'), windowVisible: getComputedStyle(r.querySelector('.media-player_window')).display };
  });
  assert.equal(floating.position, 'fixed');
  assert.equal(floating.z, '95', 'under the sticky navbar (100), over scroll-to-top (90)');
  assert.equal(floating.token, 'same', 'the iframe element was not replaced');
  assert.equal(loads(), 1, 'and never reloaded');
  assert.equal(floating.stageMin, `${inlineHeight}px`, 'the stage holds its height');
  assert.ok(floating.videoH >= 200, `floating video is at least 200px tall (got ${floating.videoH})`);
  assert.ok(floating.bottomGap >= 10 && floating.rightGap >= 10);
  assert.equal(floating.dockClass, true);
  assert.equal(floating.windowVisible, 'flex', 'expand/close show while floating');
  assert.ok((await state(page)).playing, 'still playing through the transition');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => ctkPlayer.getPresentation() === 'inline');
  assert.equal(await page.$eval('.video-embed', (s) => s.style.minHeight), '');
  await ctx.close();
});

test('on a phone the floating video is a full-width strip that still clears 200px', async () => {
  const { page, ctx } = await open('/sermon/love-the-standard', { viewport: { width: 390, height: 844 } });
  await page.click('[data-player="play"]');
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.evaluate(() => window.scrollTo(0, 2500));
  await page.waitForFunction(() => ctkPlayer.getPresentation() === 'floating');
  await page.waitForFunction(() => !document.querySelector('[data-player="root"]').hasAttribute('data-animate'));
  const box = await page.$eval('.media-player_video', (v) => v.getBoundingClientRect().toJSON());
  assert.ok(box.width >= 355 && box.height >= 200, `video ${box.width}x${box.height} must clear YouTube's 200px minimum`);
  const dock = await page.$eval('[data-player="root"]', (r) => r.getBoundingClientRect().toJSON());
  assert.ok(dock.left <= 1 && dock.right >= 389 && dock.bottom >= 843, `edge-to-edge at the bottom (${JSON.stringify(dock)})`);
  await ctx.close();
});

test('Watch → Listen keeps the position and speed; Listen → Watch comes back to the same place', async () => {
  const { page, ctx } = await open();
  await page.click('[data-player="play"]');
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.click('[data-player="rate"]'); // 1 → 1.25
  await page.evaluate(() => { __yt.t = 42; });
  await page.click('[data-player="mode"]');
  await page.waitForFunction(() => ctkPlayer.getMode() === 'listen' && ctkPlayer.getStatus() === 'playing');
  let s = await state(page);
  assert.ok(Math.abs(s.time - 42) < 2, `audio took over near 42s (got ${s.time})`);
  assert.equal(s.yt.state, 2, 'YouTube paused once the audio was playing');
  assert.equal(s.yt.muted, false, 'and unmuted again for later');
  assert.equal(s.rate, 1.25);
  assert.equal(await page.evaluate(() => document.querySelector('[data-player="root"]').getAttribute('data-mode')), 'listen');
  assert.equal(await page.$eval('[data-player="mode"]', (b) => b.getAttribute('aria-pressed')), 'true');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ctk-player:prefs')).mode), 'listen');
  // Only one source is audible.
  const audible = await page.evaluate(() => ({ audioPaused: document.querySelector('audio') ? false : null }));
  assert.equal(audible.audioPaused, null, 'the <audio> element is not in the DOM; it lives in JS');
  // Back to video.
  await page.evaluate(() => { ctkPlayer.seek(50); });
  await page.click('[data-player="mode"]');
  await page.waitForFunction(() => ctkPlayer.getMode() === 'watch' && ctkPlayer.getStatus() === 'playing');
  s = await state(page);
  assert.ok(Math.abs(s.yt.seeks[s.yt.seeks.length - 1] - 50) < 2, `video sought to ~50 (got ${s.yt.seeks})`);
  assert.equal(s.yt.state, 1);
  await ctx.close();
});

test('switching while paused stays paused, and a bad audio file falls back to video with a message', async () => {
  const { page, ctx } = await open();
  await page.click('[data-player="play"]');
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.click('[data-player="play"]');
  await page.waitForFunction(() => ctkPlayer.getStatus() === 'paused');
  await page.click('[data-player="mode"]');
  await page.waitForFunction(() => ctkPlayer.getMode() === 'listen');
  assert.equal((await state(page)).status, 'paused');
  await ctx.close();

  const bad = await open('/sermon/bad?audio=/missing.mp3');
  await bad.page.click('[data-player="play"]');
  await bad.page.waitForFunction(() => ctkPlayer.isPlaying());
  await bad.page.click('[data-player="mode"]');
  await bad.page.waitForFunction(() => ctkPlayer.getMode() === 'watch' && /Audio/.test(document.querySelector('[data-player="status"]').textContent));
  const s = await state(bad.page);
  assert.equal(s.yt.state, 1, 'video resumed');
  assert.equal(s.yt.muted, false);
  await bad.ctx.close();
});

test('±15, speed cycling and keyboard operate the active source', async () => {
  const { page, ctx } = await open();
  await page.click('[data-player="play"]');
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.evaluate(() => { __yt.t = 100; });
  await page.click('[data-player="forward"]');
  assert.ok(Math.abs((await state(page)).yt.t - 115) < 1);
  await page.click('[data-player="back"]');
  await page.click('[data-player="back"]');
  assert.ok(Math.abs((await state(page)).yt.t - 85) < 1);
  await page.focus('[data-player="rate"]');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const s = await state(page);
  assert.equal(s.rate, 1.5);
  assert.equal(s.yt.rate, 1.5);
  assert.equal(await page.$eval('[data-player="rate"]', (b) => b.textContent), '1.5×');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ctk-player:prefs')).rate), 1.5);
  await ctx.close();
});

test('close pauses and hides the dock; coming back to the stage shows the player again', async () => {
  const { page, ctx } = await open();
  await page.click('[data-player="play"]');
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForFunction(() => ctkPlayer.getPresentation() === 'floating');
  await page.focus('[data-player="close"]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => ctkPlayer.getPresentation() === 'hidden');
  let s = await state(page);
  assert.equal(s.status, 'paused');
  assert.equal(await page.$eval('[data-player="root"]', (r) => getComputedStyle(r).display), 'none');
  assert.equal(await page.evaluate(() => document.body.classList.contains('has-player-dock')), false);
  await page.evaluate(() => window.scrollTo(0, 2500));
  await page.waitForTimeout(150);
  assert.equal((await state(page)).presentation, 'hidden', 'stays dismissed while scrolled away');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => ctkPlayer.getPresentation() === 'inline');
  await ctx.close();
});

test('remembers the position per sermon and resumes there on the next visit', async () => {
  const { page, ctx } = await open('/sermon/remember-me');
  await page.click('[data-player="play"]');
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.evaluate(() => { __yt.t = 600; });
  await page.click('[data-player="play"]'); // pause saves
  await page.waitForFunction(() => ctkPlayer.getStatus() === 'paused');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ctk-player:positions'))['remember-me']);
  assert.ok(saved && Math.abs(saved.t - 600) <= 1 && saved.mode === 'watch');
  await page.reload();
  await page.waitForFunction(() => window.ctkPlayer && window.ctkPlayer.ready);
  await page.click('[data-player="play"]');
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  const s = await state(page);
  assert.ok(s.yt.seeks.some((x) => Math.abs(x - 600) <= 1), `resumed near 600 (seeks ${s.yt.seeks})`);
  assert.match(await page.$eval('[data-player="status"]', (e) => e.textContent), /Resumed at 10:00/);
  await ctx.close();
});

test('the transcript embed follows the shared player: rows seek it, its play button toggles it, highlights track time', async () => {
  const { page, ctx, errors } = await open();
  assert.equal(await page.$eval('[data-transcript-play]', (b) => getComputedStyle(b).display !== 'none'), true);
  await page.click('[data-transcript-play]');
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.waitForFunction(() => document.querySelector('[data-transcript-play]').hasAttribute('data-playing'));
  await page.click('.media-secondary [data-t-row]:nth-of-type(3)');
  await page.waitForFunction(() => ctkPlayer.getTime() >= 120);
  await page.waitForFunction(() => document.querySelector('.media-secondary [data-t-row]:nth-of-type(3)').hasAttribute('data-t-active'));
  // Switching to audio keeps the transcript in step, on the video timeline.
  await page.click('[data-player="mode"]');
  await page.waitForFunction(() => ctkPlayer.getMode() === 'listen' && ctkPlayer.getStatus() === 'playing');
  await page.waitForFunction(() => Math.abs(ctkPlayer.getTime() - 120) < 3);
  assert.ok(await page.$eval('.media-secondary [data-t-row]:nth-of-type(3)', (r) => r.hasAttribute('data-t-active')));
  await page.click('[data-transcript-play]');
  await page.waitForFunction(() => ctkPlayer.getStatus() === 'paused');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('without the registered script the embed still drives YouTube itself', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/youtube\.com\/iframe_api/, (r) => r.fulfill({ contentType: 'application/javascript', body: FAKE_YT }));
  await page.route(/youtube(-nocookie)?\.com\/embed\//, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.route(/\/media-player\.js$/, (r) => r.fulfill({ contentType: 'application/javascript', body: '/* not applied */' }));
  await page.goto(`${base}/sermon/standalone`);
  await page.waitForFunction(() => window.__yt && __yt.state !== undefined);
  assert.ok(await page.$('.video-embed > iframe'), 'embed built the iframe directly into the stage');
  await page.click('[data-transcript-play]');
  await page.waitForFunction(() => __yt.state === 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});
