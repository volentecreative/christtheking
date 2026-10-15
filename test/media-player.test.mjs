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
const OTHER = read('./fixtures/media-player-other.html');
const EMBED = read('../webflow/embeds/media-template-transcript.html');
const PLAYER = read('../webflow/registered/media-player.js');
const STYLES = read('../webflow/styles/media-player.css');

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
    if (url.pathname === '/media-player.css') return res.writeHead(200, { 'content-type': 'text/css' }).end(STYLES);
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
    if (url.pathname.startsWith('/other')) return res.writeHead(200, { 'content-type': 'text/html' }).end(OTHER);
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

// The fixture's navbar is sticky like the site's, so a link scrolled to the top edge sits under it.
const play = (page) => page.evaluate(() => ctkPlayer.play());
// The bar slides in over 240ms; geometry is measured once it has settled.
const barSettled = (page) => page.waitForFunction(() => getComputedStyle(document.querySelector('[data-player="bar"]')).transform === 'none');
const clickLink = async (page, sel) => {
  await page.$eval(sel, (el) => el.scrollIntoView({ block: 'center' }));
  await page.click(sel);
};

const state = (page) => page.evaluate(() => ({
  mode: ctkPlayer.getMode(), status: ctkPlayer.getStatus(), presentation: ctkPlayer.getPresentation(),
  time: ctkPlayer.getTime(), playing: ctkPlayer.isPlaying(), rate: ctkPlayer.getRate(),
  yt: window.__yt ? { state: __yt.state, t: __yt.t, seeks: __yt.seeks, rate: __yt.rate, muted: __yt.muted } : null,
}));

test('renders the video over the stage, no bar until something plays, a Listen button in the "Listen on" row', async () => {
  const { page, ctx, errors, loads } = await open();
  assert.equal(await page.$$eval('[data-player="root"]', (e) => e.length), 1);
  assert.ok(await page.$('body > .media-player > .media-player_video > iframe'), 'the root is a child of body, not of the page content');
  assert.equal(await page.$$eval('[data-player-mockup], .page-wrapper .media-player_bar', (e) => e.length), 0, 'the Designer mockup of the bar is dropped from the live page');
  const laid = await page.evaluate(() => {
    const s = document.querySelector('.video-embed').getBoundingClientRect(), r = document.querySelector('.media-player_video').getBoundingClientRect();
    return { dx: Math.abs(s.left - r.left), dy: Math.abs(s.top - r.top), dw: Math.abs(s.width - r.width), dh: Math.abs(s.height - r.height) };
  });
  assert.ok(laid.dx < 1 && laid.dy < 1 && laid.dw < 1 && laid.dh < 1, `video laid exactly over the stage ${JSON.stringify(laid)}`);
  const src = await page.$eval('.media-player_video iframe', (f) => f.src);
  assert.match(src, /youtube\.com\/embed\/2qsHQo0xGP8\?.*enablejsapi=1.*origin=/);
  const bar = await page.evaluate(() => { const b = document.querySelector('[data-player="bar"]'); const cs = getComputedStyle(b); return { visibility: cs.visibility, position: cs.position, bottom: cs.bottom, bar: document.querySelector('[data-player="root"]').getAttribute('data-bar'), inert: b.inert }; });
  assert.equal(bar.bar, 'off');
  assert.equal(bar.visibility, 'hidden', 'no bar while nothing plays');
  assert.equal(bar.position, 'fixed');
  assert.equal(bar.inert, true);
  assert.equal(await page.$('[data-player="mode"]'), null, 'no Listen/Watch on the bar: the page\'s Listen button and setMode() switch sources');
  assert.deepEqual(await page.$$eval('[data-player="bar"] > .media-player_info > *', (n) => n.map((e) => e.className)), ['text-style-title-small media-player_title', 'media-player_time'], 'the mockup\'s tree: title over the time row');
  assert.deepEqual(await page.$$eval('.media-player_time > *', (n) => n.map((e) => e.getAttribute('data-player'))), ['time', 'progress', 'duration'], 'elapsed · progress · duration');
  assert.deepEqual(await page.$$eval('.media-player_controls > *', (n) => n.map((e) => e.tagName.toLowerCase() + '.' + e.className.replace(/ /g, '.'))), ['button.media-player_btn.is-play', 'a.icon-button'], 'play/pause and the site\'s icon-button close');
  assert.equal(await page.$eval('.media_platform-buttons .horz-flex > a:first-child', (a) => a.getAttribute('data-player') + ' ' + a.className), 'listen icon-button media-player_listen', 'Listen joins the Spotify / Apple row, first');
  assert.equal(await page.$('[data-player="back"], [data-player="forward"], [data-player="rate"]'), null, 'no skip or speed buttons');
  assert.equal(await page.evaluate(() => document.querySelectorAll('iframe').length), 1);
  assert.equal(loads(), 1, 'the iframe loaded exactly once');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the bar appears on play, stays while paused, and goes away when closed', async () => {
  const { page, ctx } = await open();
  await play(page);
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await barSettled(page);
  const on = await page.evaluate(() => { const el = document.querySelector('[data-player="bar"]'); const b = el.getBoundingClientRect(), cs = getComputedStyle(el); return { bottom: innerHeight - b.bottom, left: b.left, right: innerWidth - b.right, width: b.width, border: cs.borderTopWidth + ' ' + cs.borderTopStyle, radius: cs.borderTopLeftRadius, dock: getComputedStyle(document.documentElement).getPropertyValue('--player-dock-height').trim(), body: document.body.classList.contains('has-player-dock') }; });
  assert.ok(on.bottom === 16 && on.right === 16 && on.left > 16 && on.width <= 420, `a floating card in the corner, inset by half the gutter ${JSON.stringify(on)}`);
  assert.equal(on.border, '2px solid'); assert.equal(on.radius, '8px');
  assert.match(on.dock, /^\d+px$/); assert.equal(on.body, true);
  assert.equal(await page.$eval('[data-player="duration"]', (e) => e.textContent), '1:00:00');
  assert.equal(await page.$('[data-player="speaker"]'), null, 'no speaker on the bar');
  await page.click('.media-player_bar [data-player="play"]');
  await page.waitForFunction(() => ctkPlayer.getStatus() === 'paused');
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-player="bar"]')).visibility), 'visible', 'paused keeps the bar');
  assert.equal(await page.$eval('.media-player_bar [data-player="play"]', (b) => b.getAttribute('aria-label')), 'Play');
  const playBtn = await page.$eval('.media-player_bar [data-player="play"]', (b) => { const cs = getComputedStyle(b); return { w: b.offsetWidth, h: b.offsetHeight, radius: cs.borderTopLeftRadius, border: cs.borderTopWidth, shadow: cs.boxShadow !== 'none' }; });
  assert.equal(playBtn.w, 44); assert.equal(playBtn.h, 44); assert.equal(playBtn.border, '2px'); assert.equal(playBtn.shadow, true, 'styled like the back-to-top button');
  await page.click('.media-player_bar [data-player="close"]');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-player="bar"]')).visibility === 'hidden');
  assert.equal(await page.evaluate(() => document.body.classList.contains('has-player-dock')), false);
  assert.equal(await page.evaluate(() => document.querySelector('.media-player_video').getBoundingClientRect().height > 100), true, 'the video stays in the page');
  await ctx.close();
});

test('watch-only and listen-only items render the right controls', async () => {
  let { page, ctx } = await open('/sermon/x?audio=');
  assert.equal(await page.$('[data-player="mode"]'), null, 'no mode toggle without audio');
  assert.equal(await page.$('[data-player="listen"]'), null, 'no Listen button without audio');
  assert.ok(await page.$('.media-player_video iframe'));
  await ctx.close();
  ({ page, ctx } = await open('/sermon/y?video='));
  assert.equal(await page.$('[data-player="mode"]'), null);
  assert.equal(await page.$eval('[data-player="root"]', (r) => r.getAttribute('data-has-video')), 'false');
  assert.equal(await page.$eval('.video-embed', (v) => getComputedStyle(v).display), 'none', 'no stage without a video');
  assert.equal(await page.$eval('.media-player_video', (v) => getComputedStyle(v).display), 'none');
  await page.click('[data-player="listen"]');
  await page.waitForFunction(() => ctkPlayer.isPlaying() && ctkPlayer.getMode() === 'listen');
  await page.waitForFunction(() => ctkPlayer.getTime() > 0.3);
  assert.equal(await page.$eval('[data-player="listen"]', (a) => a.getAttribute('aria-pressed')), 'true');
  await ctx.close();
});

test('the Listen button starts the audio, and switches a playing video to audio at the same place', async () => {
  const { page, ctx } = await open();
  await play(page);
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.evaluate(() => { __yt.t = 42; });
  await page.click('[data-player="listen"]');
  await page.waitForFunction(() => ctkPlayer.getMode() === 'listen' && ctkPlayer.getStatus() === 'playing');
  const s = await state(page);
  assert.ok(Math.abs(s.time - 42) < 2, `audio took over near 42s (got ${s.time})`);
  assert.equal(s.yt.state, 2, 'YouTube paused');
  await page.click('[data-player="listen"]');
  await page.waitForFunction(() => ctkPlayer.getStatus() === 'paused');
  await ctx.close();
});

test('scrolling a playing video away hands over to the audio; scrolling back shows the (paused) video again', async () => {
  const { page, ctx, loads } = await open();
  await page.evaluate(() => { document.querySelector('iframe').__token = 'same'; });
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForTimeout(150);
  assert.equal((await state(page)).presentation, 'inline', 'nothing floats before playback');
  await page.evaluate(() => window.scrollTo(0, 0));
  await play(page);
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.evaluate(() => { __yt.t = 120; });
  const stageHeight = await page.$eval('.video-embed', (s) => s.style.height);
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForFunction(() => ctkPlayer.getPresentation() === 'floating' && ctkPlayer.getMode() === 'listen' && ctkPlayer.getStatus() === 'playing');
  const away = await page.evaluate(() => ({ video: getComputedStyle(document.querySelector('.media-player_video')).display, yt: __yt.state, time: ctkPlayer.getTime(), token: document.querySelector('iframe').__token,
    stageH: document.querySelector('.video-embed').style.height, bar: getComputedStyle(document.querySelector('[data-player="bar"]')).visibility }));
  assert.equal(away.video, 'none', 'no video off-screen');
  assert.equal(away.yt, 2, 'YouTube paused');
  assert.ok(Math.abs(away.time - 120) < 3, `audio took over at the same place (${away.time})`);
  assert.equal(away.token, 'same'); assert.equal(loads(), 1);
  assert.equal(away.stageH, stageHeight); assert.equal(away.bar, 'visible');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => ctkPlayer.getPresentation() === 'inline');
  const back = await page.evaluate(() => ({ video: getComputedStyle(document.querySelector('.media-player_video')).display, mode: ctkPlayer.getMode(), playing: ctkPlayer.isPlaying() }));
  assert.deepEqual(back, { video: 'block', mode: 'listen', playing: true }, 'still listening; the paused video is back in the page');
  await ctx.close();
});

test('a video-only sermon pauses when it scrolls away, keeps the bar, and resumes when scrolled back', async () => {
  const { page, ctx } = await open('/sermon/x?audio=');
  await play(page);
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForFunction(() => ctkPlayer.getPresentation() === 'floating' && ctkPlayer.getStatus() === 'paused');
  const away = await page.evaluate(() => ({ bar: document.querySelector('[data-player="root"]').getAttribute('data-bar'), msg: document.querySelector('[data-player="status"]').textContent, video: getComputedStyle(document.querySelector('.media-player_video')).display }));
  assert.equal(away.bar, 'on', 'the bar stays to bring you back');
  assert.match(away.msg, /Paused/);
  assert.equal(away.video, 'none');
  // Play from the bar: it goes back to the video and plays there.
  await page.click('.media-player_bar [data-player="play"]');
  await page.waitForFunction(() => ctkPlayer.getPresentation() === 'inline' && ctkPlayer.isPlaying());
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForFunction(() => ctkPlayer.getStatus() === 'paused');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => ctkPlayer.getPresentation() === 'inline' && ctkPlayer.isPlaying(), null, { timeout: 5000 });
  // And a link while it is paused away is an ordinary navigation (video cannot travel).
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForFunction(() => ctkPlayer.getStatus() === 'paused');
  await Promise.all([page.waitForNavigation(), clickLink(page, '[data-test="content-other"]')]);
  assert.equal(await page.evaluate(() => window.__sitewideRan), 1);
  await ctx.close();
});

test('while the player is active, links swap the page in place and playback carries on', async () => {
  const { page, ctx, errors, loads } = await open();
  // Not active yet: a link is a normal navigation (the whole document reloads).
  await Promise.all([page.waitForNavigation(), clickLink(page, '[data-test="content-other"]')]);
  assert.equal(await page.evaluate(() => document.querySelector('h1').textContent), 'Other page');
  assert.equal(await page.evaluate(() => window.__sitewideRan), 1, 'a fresh document');
  await page.goBack();
  await page.waitForFunction(() => window.ctkPlayer && ctkPlayer.ready);
  const loadsBefore = loads(); // the full reload above loaded the iframe once more
  await page.evaluate(() => { document.querySelector('iframe').__token = 'same'; });
  await play(page);
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.evaluate(() => { __yt.t = 120; });
  // Active: the same link now swaps content, and the video keeps playing above the bar.
  await clickLink(page, '[data-test="content-other"]');
  await page.waitForFunction(() => document.querySelector('h1') && document.querySelector('h1').textContent === 'Other page');
  const after = await page.evaluate(() => ({
    url: location.pathname, title: document.title, bodyClass: document.body.className, wfPage: document.documentElement.getAttribute('data-wf-page'),
    sitewide: window.__sitewideRan, otherRan: window.__otherRan, pageCode: window.__otherPageCode, calls: window.__calls,
    playing: ctkPlayer.isPlaying(), time: ctkPlayer.getTime(), presentation: ctkPlayer.getPresentation(),
    token: document.querySelector('iframe') && document.querySelector('iframe').__token,
    navbars: document.querySelectorAll('nav.navbar').length, footers: document.querySelectorAll('footer').length, roots: document.querySelectorAll('[data-player="root"]').length,
    current: document.querySelector('a.w--current') && document.querySelector('a.w--current').getAttribute('href'),
    headStyle: !!Array.from(document.querySelectorAll('style')).find((s) => /page-level head style/.test(s.textContent)),
    focus: document.activeElement && document.activeElement.tagName, scrollY: window.scrollY,
    barVisible: getComputedStyle(document.querySelector('[data-player="bar"]')).visibility, listenButtons: document.querySelectorAll('[data-player="listen"]').length,
  }));
  assert.equal(after.url, '/other/page');
  assert.equal(after.title, 'Other | Christ the King Church');
  assert.ok(/\bbody\b/.test(after.bodyClass) && /has-player-dock/.test(after.bodyClass), `new page's body class, plus the dock (${after.bodyClass})`);
  assert.equal(after.wfPage, 'PAGE_OTHER');
  assert.equal(after.sitewide, 1, 'site-wide footer code did not run again');
  assert.equal(after.otherRan, 1, "the new page's inline content script ran");
  assert.equal(after.pageCode, 1, "the new page's own body-level code ran");
  assert.deepEqual(after.calls, ['wf:destroy', 'wf:ready', 'ix2:init', 'fs:list:restart'], 'Webflow and Finsweet re-initialised');
  assert.equal(after.playing, true, 'still playing');
  assert.ok(after.time >= 119, `time kept (${after.time})`);
  assert.equal(await page.evaluate(() => ctkPlayer.getMode()), 'listen', 'the audio took over for the trip');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.media-player_video')).display), 'none', 'no video away from the page');
  assert.equal(after.presentation, 'floating');
  assert.equal(after.barVisible, 'visible');
  assert.equal(after.listenButtons, 0, 'no Listen button on a page without the row');
  assert.equal(after.token, 'same', 'same iframe element');
  assert.equal(loads(), loadsBefore, 'never reloaded');
  assert.equal(after.navbars, 1); assert.equal(after.footers, 1); assert.equal(after.roots, 1);
  assert.equal(after.current, '/other/page');
  assert.equal(after.headStyle, true);
  assert.equal(after.focus, 'H1');
  assert.equal(after.scrollY, 0);
  // The bar's title takes you back to the sermon page; the video re-anchors inline, audio still playing.
  await page.click('.media-player_bar [data-player="info"]');
  await page.waitForFunction(() => location.pathname === '/sermon/love-the-standard' && ctkPlayer.getPresentation() === 'inline');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.media-player_video')).display === 'block');
  const back = await page.evaluate(() => ({ playing: ctkPlayer.isPlaying(), token: document.querySelector('iframe').__token, iframes: document.querySelectorAll('iframe').length,
    stageH: document.querySelector('.video-embed').style.height, transcriptPlaying: document.querySelector('[data-transcript-play]').hasAttribute('data-playing'),
    listenButtons: document.querySelectorAll('[data-player="listen"]').length }));
  assert.equal(back.playing, true);
  assert.equal(back.token, 'same');
  assert.equal(back.iframes, 1);
  assert.match(back.stageH, /^\d+px$/);
  assert.equal(back.transcriptPlaying, true, "the new page's transcript embed attached to the live player");
  assert.equal(back.listenButtons, 1);
  assert.equal(loads(), loadsBefore);
  // History works: back goes to the other page without unloading.
  await page.goBack();
  await page.waitForFunction(() => location.pathname === '/other/page' && document.querySelector('h1').textContent === 'Other page');
  assert.equal(await page.evaluate(() => ctkPlayer.isPlaying() && window.__sitewideRan === 1), true);
  // Links the browser must keep: hash, file, external, modifier-click.
  await page.goBack();
  await page.waitForFunction(() => location.pathname === '/sermon/love-the-standard' && document.querySelector('[data-test="hash"]'));
  await clickLink(page, '[data-test="hash"]');
  assert.equal(await page.evaluate(() => location.hash), '#notes');
  assert.equal(await page.evaluate(() => window.__sitewideRan), 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('navigating to a different sermon loads it into the player, paused', async () => {
  const { page, ctx } = await open();
  await play(page);
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await clickLink(page, '[data-test="content-another"]');
  await page.waitForFunction(() => location.pathname === '/sermon/another' && ctkPlayer.hasVideo && !ctkPlayer.hasAudio);
  const s = await page.evaluate(() => ({ src: document.querySelector('iframe').src, status: ctkPlayer.getStatus(), modeBtn: !!document.querySelector('[data-player="mode"]'), iframes: document.querySelectorAll('iframe').length,
    bar: document.querySelector('[data-player="root"]').getAttribute('data-bar'), saved: JSON.parse(localStorage.getItem('ctk-player:positions'))['love-the-standard'] }));
  assert.match(s.src, /embed\/zzzzzzzzzzz/);
  assert.equal(s.status, 'idle');
  assert.equal(s.bar, 'off');
  assert.equal(s.modeBtn, false, 'the new sermon is video-only');
  assert.equal(s.iframes, 1);
  assert.ok(s.saved && s.saved.t >= 0, "the previous sermon's position was saved");
  await ctx.close();
});

test('pausing restores ordinary navigation', async () => {
  const { page, ctx } = await open();
  await play(page);
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.evaluate(() => ctkPlayer.pause());
  await page.waitForFunction(() => ctkPlayer.getStatus() === 'paused');
  await Promise.all([page.waitForNavigation(), clickLink(page, '[data-test="content-other"]')]);
  assert.equal(await page.evaluate(() => window.__sitewideRan), 1, 'a fresh document loaded');
  await ctx.close();
});

test('on a phone the bar is an inset floating card and nothing else is on screen', async () => {
  const { page, ctx } = await open('/sermon/love-the-standard', { viewport: { width: 390, height: 844 } });
  await play(page);
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.evaluate(() => window.scrollTo(0, 2500));
  await page.waitForFunction(() => ctkPlayer.getPresentation() === 'floating' && ctkPlayer.getMode() === 'listen');
  await barSettled(page);
  const bar = await page.$eval('[data-player="bar"]', (b) => { const r = b.getBoundingClientRect(), cs = getComputedStyle(b); return { left: r.left, right: innerWidth - r.right, bottom: innerHeight - r.bottom, border: cs.borderLeftWidth, radius: cs.borderTopLeftRadius }; });
  assert.ok(bar.left === 16 && bar.right === 16 && bar.bottom === 16, `inset by half the gutter on every side ${JSON.stringify(bar)}`);
  assert.equal(bar.border, '2px'); assert.equal(bar.radius, '8px');
  assert.equal(await page.$eval('.media-player_video', (v) => getComputedStyle(v).display), 'none');
  await ctx.close();
});

test('Watch → Listen keeps the position and speed; Listen → Watch comes back to the same place', async () => {
  const { page, ctx } = await open();
  await play(page);
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.evaluate(() => { ctkPlayer.setRate(1.25); __yt.t = 42; });
  await page.evaluate(() => ctkPlayer.setMode('listen'));
  await page.waitForFunction(() => ctkPlayer.getMode() === 'listen' && ctkPlayer.getStatus() === 'playing');
  let s = await state(page);
  assert.ok(Math.abs(s.time - 42) < 2, `audio took over near 42s (got ${s.time})`);
  assert.equal(s.yt.state, 2, 'YouTube paused once the audio was playing');
  assert.equal(s.yt.muted, false, 'and unmuted again for later');
  assert.equal(s.rate, 1.25);
  assert.equal(await page.$eval('[data-player="listen"]', (b) => b.getAttribute('aria-pressed')), 'true', 'the page\'s Listen button shows the state');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ctk-player:prefs')).mode), 'listen');
  assert.equal(await page.$eval('.media-player_video', (v) => getComputedStyle(v).display), 'block', 'inline, the paused video stays in the page');
  await page.evaluate(() => { ctkPlayer.seek(50); });
  await page.evaluate(() => ctkPlayer.setMode('watch'));
  await page.waitForFunction(() => ctkPlayer.getMode() === 'watch' && ctkPlayer.getStatus() === 'playing');
  s = await state(page);
  assert.ok(Math.abs(s.yt.seeks[s.yt.seeks.length - 1] - 50) < 2, `video sought to ~50 (got ${s.yt.seeks})`);
  assert.equal(s.yt.state, 1);
  await ctx.close();
});

test('switching while paused stays paused, and a bad audio file falls back to video with a message', async () => {
  const { page, ctx } = await open();
  await play(page);
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.evaluate(() => ctkPlayer.pause());
  await page.waitForFunction(() => ctkPlayer.getStatus() === 'paused');
  await page.evaluate(() => ctkPlayer.setMode('listen'));
  await page.waitForFunction(() => ctkPlayer.getMode() === 'listen');
  assert.equal((await state(page)).status, 'paused');
  await ctx.close();

  const bad = await open('/sermon/bad?audio=/missing.mp3');
  await play(bad.page);
  await bad.page.waitForFunction(() => ctkPlayer.isPlaying());
  await bad.page.evaluate(() => ctkPlayer.setMode('listen'));
  await bad.page.waitForFunction(() => ctkPlayer.getMode() === 'watch' && /Audio/.test(document.querySelector('[data-player="status"]').textContent));
  const s = await state(bad.page);
  assert.equal(s.yt.state, 1, 'video resumed');
  assert.equal(s.yt.muted, false);
  await bad.ctx.close();
});

test('skip and speed still work through the API (lock-screen controls use them) and the keyboard', async () => {
  const { page, ctx } = await open();
  await play(page);
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.evaluate(() => { __yt.t = 100; ctkPlayer.skip(15); });
  assert.ok(Math.abs((await state(page)).yt.t - 115) < 1);
  await page.evaluate(() => { ctkPlayer.skip(-30); });
  assert.ok(Math.abs((await state(page)).yt.t - 85) < 1);
  await page.evaluate(() => ctkPlayer.setRate(1.5));
  const s = await state(page);
  assert.equal(s.rate, 1.5);
  assert.equal(s.yt.rate, 1.5);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ctk-player:prefs')).rate), 1.5);
  // Escape on the bar pauses (and so hides) it.
  await page.focus('.media-player_bar [data-player="play"]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => ctkPlayer.getStatus() === 'paused');
  await ctx.close();
});

test('the progress edge seeks by pointer and keyboard, and the time reads along the meta line', async () => {
  const { page, ctx } = await open();
  await play(page);
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await barSettled(page);
  await page.waitForFunction(() => document.querySelector('[data-player="duration"]').textContent === '1:00:00', null, { timeout: 5000 }); // the track settles once the duration is on the row
  const track = await page.$('[data-player="progress"]');
  let box = await track.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  let s = await state(page);
  assert.ok(Math.abs(s.yt.seeks[s.yt.seeks.length - 1] - 1800) < 40, `clicked halfway → ~1800s (${s.yt.seeks})`);
  await page.focus('[data-player="progress"]');
  await page.keyboard.press('ArrowRight');
  s = await state(page);
  assert.ok(Math.abs(s.yt.seeks[s.yt.seeks.length - 1] - 1805) < 40, `arrow → +5s (${s.yt.seeks})`);
  assert.match(await page.$eval('[data-player="time"]', (e) => e.textContent), /^30:0\d$/);
  assert.equal(await page.$eval('[data-player="duration"]', (e) => e.textContent), '1:00:00');
  const share = await page.$eval('[data-player="progress"]', (e) => ({ fill: e.firstChild.getBoundingClientRect().width, track: e.getBoundingClientRect().width, v: e.style.getPropertyValue('--player-progress'), flex: getComputedStyle(e.firstChild).flex }));
  assert.ok(Math.abs(share.fill / share.track - 0.5) < 0.02, `the fill is the played share of the track ${JSON.stringify(share)}`);
  assert.ok(Math.abs(await page.$eval('[data-player="progress"]', (e) => e.firstChild.getBoundingClientRect().left - e.getBoundingClientRect().left)) < 1, 'the fill starts at the left edge of the track');
  assert.match(await page.$eval('[data-player="progress"]', (e) => e.style.getPropertyValue('--player-progress')), /^50\.\d+%$/);
  // A click on the track seeks; it must not also act as the title's "back to the sermon page".
  await page.evaluate(() => (window.__nav = 0, document.addEventListener('ctk:player:navigate', () => window.__nav++)));
  box = await track.boundingBox();
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
  assert.equal(await page.evaluate(() => window.__nav), 0);
  await page.waitForFunction(() => /^25\.\d+%$/.test(document.querySelector('[data-player="progress"]').style.getPropertyValue('--player-progress')), null, { timeout: 3000 });
  await ctx.close();
});

test('with the transcript sheet open the bar sits above it and pushes Synchronize up', async () => {
  const { page, ctx } = await open('/sermon/love-the-standard', { viewport: { width: 390, height: 844 } });
  await play(page);
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.evaluate(() => {
    document.querySelector('.media-transcript').classList.add('is-visible');
    document.dispatchEvent(new CustomEvent('vci:modal:open', { bubbles: true, detail: { key: 'transcript' } }));
  });
  await page.waitForFunction(() => ctkPlayer.getMode() === 'listen' && ctkPlayer.getStatus() === 'playing');
  const over = await page.evaluate(() => {
    const r = document.querySelector('[data-player="root"]');
    return { z: getComputedStyle(r.querySelector('[data-player="bar"]')).zIndex, attr: r.hasAttribute('data-over-sheet'),
      dock: getComputedStyle(document.documentElement).getPropertyValue('--player-dock-height').trim(),
      sync: getComputedStyle(document.querySelector('[data-transcript-sync]')).bottom };
  });
  assert.equal(over.z, '1002', 'above the sheet (1001)');
  assert.equal(over.attr, true);
  assert.match(over.dock, /^\d+px$/);
  assert.ok(parseFloat(over.sync) >= parseFloat(over.dock) + 16, `Synchronize sits above the bar (${over.sync} vs dock ${over.dock})`);
  await page.evaluate(() => {
    document.querySelector('.media-transcript').classList.remove('is-visible');
    document.dispatchEvent(new CustomEvent('vci:modal:close', { bubbles: true, detail: { key: 'transcript' } }));
  });
  await page.waitForFunction(() => !document.querySelector('[data-player="root"]').hasAttribute('data-over-sheet'));
  await ctx.close();
});

test('hiding the page while a video plays hands over to the audio at the same place, and logs it', async () => {
  const { page, ctx } = await open();
  // The first touch unlocks the audio element (a muted instant of play), without starting anything.
  await page.mouse.click(5, 300);
  await page.waitForFunction(() => (ctkPlayer.handoffLog() || []).some((e) => e.what === 'unlocked'));
  assert.equal((await state(page)).status, 'idle', 'the unlock did not start playback');
  await play(page);
  await page.waitForFunction(() => ctkPlayer.isPlaying() && ctkPlayer.getMode() === 'watch');
  await page.evaluate(() => { __yt.t = 90; });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => ctkPlayer.getMode() === 'listen' && ctkPlayer.getStatus() === 'playing');
  const s = await state(page);
  assert.ok(Math.abs(s.time - 90) < 3, `audio continues from the video's position (${s.time})`);
  assert.equal(s.yt.state, 2, 'the video is paused');
  const log = await page.evaluate(() => ctkPlayer.handoffLog().map((e) => e.what));
  assert.ok(log.includes('hidden, handing over') && log[log.length - 1] === 'audio playing', `logged: ${log}`);
  // Back: still listening, nothing restarted.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);
  assert.equal((await state(page)).mode, 'listen');
  // Turned off, hiding does nothing to a playing video.
  await page.evaluate(() => { ctkPlayer.setHandoff(false); ctkPlayer.setMode('watch'); });
  await page.waitForFunction(() => ctkPlayer.getMode() === 'watch' && ctkPlayer.isPlaying());
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);
  assert.equal((await state(page)).mode, 'watch');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ctk-player:prefs')).handoff), false);
  await ctx.close();
});

test('remembers the position per sermon and resumes there on the next visit', async () => {
  const { page, ctx } = await open('/sermon/remember-me');
  await play(page);
  await page.waitForFunction(() => ctkPlayer.isPlaying());
  await page.evaluate(() => { __yt.t = 600; ctkPlayer.pause(); });
  await page.waitForFunction(() => ctkPlayer.getStatus() === 'paused');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ctk-player:positions'))['remember-me']);
  assert.ok(saved && Math.abs(saved.t - 600) <= 1 && saved.mode === 'watch');
  await page.reload();
  await page.waitForFunction(() => window.ctkPlayer && window.ctkPlayer.ready);
  await play(page);
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
  // Reaching the transcript scrolled the stage away, so the audio has already taken over; otherwise switch.
  if (await page.evaluate(() => ctkPlayer.getMode()) !== 'listen') await page.evaluate(() => ctkPlayer.setMode('listen'));
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
