/**
 * Browser test for webflow/registered/navbar-speaker-names.js.
 *
 * Exercises the three paths that matter on the live site: the source page
 * (/media harvests its own hidden list), a second page (fetches /media and
 * caches), and cards that Finsweet appends after load.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const read = (p) => readFileSync(new URL(p, import.meta.url));
const ROUTES = {
  '/media': ['text/html', read('./fixtures/media.html')],
  '/other': ['text/html', read('./fixtures/other.html')],
  '/global': ['text/html', read('./fixtures/global-source.html')],
  '/navbar-speaker-names.js': [
    'application/javascript',
    read('../webflow/registered/navbar-speaker-names.js'),
  ],
};

let server, base, browser;

test.before(async () => {
  server = createServer((req, res) => {
    const route = ROUTES[req.url.replace(/\?.*$/, '')];
    if (!route) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': route[0] }).end(route[1]);
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

test.after(async () => {
  await browser?.close();
  server?.close();
});

const speakers = (page) =>
  page.$$eval('[data-speakers-target]', (els) => els.map((e) => e.textContent));

test('on /media, cards fill from the hidden source list', async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/media`);
  await page.waitForFunction(
    () => !document.querySelector('[data-speakers-target]:not([data-speakers-done])')
      || document.querySelectorAll('[data-speakers-done]').length > 0
  );
  assert.deepEqual(await speakers(page), ['Nathan Colestock', '[Speaker]']);
  await page.close();
});

test('an item with no speakers is left alone, not blanked', async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/media`);
  await page.waitForSelector('[data-speakers-done]');
  const last = await page.$$eval('[data-speakers-target]', (e) => e.at(-1).textContent);
  assert.equal(last, '[Speaker]', 'no source row means the placeholder stays, not ""');
  await page.close();
});

test('cards Finsweet appends after load get painted too', async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/media`);
  await page.waitForSelector('[data-speakers-done]');
  await page.evaluate(() => {
    const item = document.createElement('div');
    item.className = 'w-dyn-item';
    item.innerHTML =
      '<a class="media-card" href="/media/union-with-christ">' +
      '<div class="media-card-content"><div data-media-title>Union with Christ</div>' +
      '<div data-speakers-target>[Speaker]</div></div></a>';
    document.querySelector('.sermons_list').appendChild(item);
  });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-speakers-done]').length === 2
  );
  assert.deepEqual(await speakers(page), [
    'Nathan Colestock',
    '[Speaker]',
    'Andy Naselli, Clint Manley',
  ]);
  await page.close();
});

test('another page fetches /media, and the next navigation uses the cache', async () => {
  const context = await browser.newContext();
  const fetches = [];
  await context.route('**/media', (route) => {
    fetches.push(route.request().url());
    route.continue();
  });

  // One tab, navigated twice — sessionStorage is per-tab, so this is the only
  // shape in which the cache is ever read.
  const page = await context.newPage();
  await page.goto(`${base}/other`);
  await page.waitForSelector('[data-speakers-done]');
  assert.deepEqual(await speakers(page), ['Andy Naselli, Clint Manley']);
  assert.equal(fetches.length, 1, 'first page fetches the source once');

  await page.goto(`${base}/other`);
  await page.waitForSelector('[data-speakers-done]');
  assert.deepEqual(await speakers(page), ['Andy Naselli, Clint Manley']);
  assert.equal(fetches.length, 1, 'second view reads sessionStorage, no refetch');
  await context.close();
});

test('an empty harvest is never cached, so a later view still recovers', async () => {
  const context = await browser.newContext();
  let sourceIsEmpty = true;
  await context.route('**/media', async (route) => {
    if (sourceIsEmpty) return route.fulfill({ contentType: 'text/html', body: '<html></html>' });
    return route.continue();
  });

  const page = await context.newPage();
  await page.goto(`${base}/other`);
  assert.deepEqual(await speakers(page), ['[Speaker]'], 'nothing to paint yet');
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem('ctk-speakers-2')),
    null,
    'an empty map must not poison the session'
  );

  // Same tab. The old script cached "{}" here and never refetched.
  sourceIsEmpty = false;
  await page.goto(`${base}/other`);
  await page.waitForSelector('[data-speakers-done]');
  assert.deepEqual(await speakers(page), ['Andy Naselli, Clint Manley']);
  await context.close();
});

test('a source list on the current page is used without fetching /media', async () => {
  const context = await browser.newContext();
  const fetches = [];
  await context.route('**/media', (route) => {
    fetches.push(route.request().url());
    route.continue();
  });

  // The source list lives in the navbar here, so it is present on every page.
  const page = await context.newPage();
  await page.goto(`${base}/global`);
  await page.waitForSelector('[data-speakers-done]');
  assert.deepEqual(await speakers(page), ['Andy Naselli, Clint Manley']);
  assert.equal(fetches.length, 0, 'a local source means no cross-page fetch');
  await context.close();
});

test('on the source page itself, no pointless fetch of itself', async () => {
  const context = await browser.newContext();
  const fetches = [];
  await context.route('**/media', (route) => {
    fetches.push(route.request().url());
    route.continue();
  });
  const page = await context.newPage();
  await page.goto(`${base}/media`);
  await page.waitForSelector('[data-speakers-done]');
  assert.equal(fetches.length, 1, 'only the navigation itself, no extra fetch');
  await context.close();
});
