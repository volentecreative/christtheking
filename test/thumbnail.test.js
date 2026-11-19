/**
 * Thumbnails are probed against i.ytimg.com rather than assumed, because which
 * qualities exist depends on the source upload. The probing order and the
 * never-throw contract are what the sync depends on, so both are pinned here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FORMATS, QUALITIES, preferWebp, resolveThumbnailUrl, thumbnailUrl } from '../lib/thumbnail.js';
import { isWebpThumbnail } from '../refresh-thumbnails.js';

function stubFetch(handler) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method });
    return handler(String(url));
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

test('thumbnailUrl builds the CDN path for a video, quality and format', () => {
  assert.equal(
    thumbnailUrl('Nj13WqtGjq0', 'maxresdefault'),
    'https://i.ytimg.com/vi/Nj13WqtGjq0/maxresdefault.jpg'
  );
  assert.equal(
    thumbnailUrl('Nj13WqtGjq0', 'maxresdefault', 'webp'),
    'https://i.ytimg.com/vi_webp/Nj13WqtGjq0/maxresdefault.webp'
  );
});

test('WebP is tried before JPEG', () => {
  assert.deepEqual(FORMATS, ['webp', 'jpg']);
});

test('qualities are ordered best first, ending on the one that always exists', () => {
  assert.deepEqual(QUALITIES, ['maxresdefault', 'sddefault', 'hqdefault']);
});

test('the best available quality wins, and nothing further is probed', async () => {
  const stub = stubFetch(() => new Response(null, { status: 200 }));
  try {
    const url = await resolveThumbnailUrl('abc');
    assert.equal(url, 'https://i.ytimg.com/vi_webp/abc/maxresdefault.webp');
    assert.equal(stub.seen.length, 1, 'stops at the first hit');
    assert.equal(stub.seen[0].method, 'HEAD', 'never downloads the image itself');
  } finally {
    stub.restore();
  }
});

test('a missing maxres falls through to the next quality', async () => {
  // Videos uploaded below 1080p have no maxresdefault; YouTube 404s it.
  const stub = stubFetch((url) =>
    url.includes('maxresdefault')
      ? new Response(null, { status: 404 })
      : new Response(null, { status: 200 })
  );
  try {
    assert.equal(await resolveThumbnailUrl('abc'), 'https://i.ytimg.com/vi_webp/abc/sddefault.webp');
    assert.equal(stub.seen.length, 3, 'maxres webp, maxres jpg, then sd webp');
  } finally {
    stub.restore();
  }
});

test('nothing available yields null, never a URL that 404s', async () => {
  const stub = stubFetch(() => new Response(null, { status: 404 }));
  try {
    assert.equal(await resolveThumbnailUrl('abc'), null);
    assert.equal(stub.seen.length, QUALITIES.length * FORMATS.length, 'every quality and format was tried');
  } finally {
    stub.restore();
  }
});

test('a network failure is absorbed, not thrown at the sync', async () => {
  // A thrown error here would abort a run that is otherwise landing videos
  // fine. A blank thumbnail is recoverable on the next run; a dead run is not.
  const stub = stubFetch(() => { throw new Error('ECONNRESET'); });
  try {
    assert.equal(await resolveThumbnailUrl('abc'), null);
  } finally {
    stub.restore();
  }
});

test('one failing quality does not stop the rest being tried', async () => {
  const stub = stubFetch((url) => {
    if (url.includes('maxresdefault')) throw new Error('ECONNRESET');
    return new Response(null, { status: 200 });
  });
  try {
    assert.equal(await resolveThumbnailUrl('abc'), 'https://i.ytimg.com/vi_webp/abc/sddefault.webp');
  } finally {
    stub.restore();
  }
});

test('a missing WebP falls back to the JPEG at the same quality', async () => {
  const stub = stubFetch((url) =>
    url.includes('vi_webp') ? new Response(null, { status: 404 }) : new Response(null, { status: 200 })
  );
  try {
    assert.equal(await resolveThumbnailUrl('abc'), 'https://i.ytimg.com/vi/abc/maxresdefault.jpg');
  } finally {
    stub.restore();
  }
});

test('preferWebp swaps a yt-dlp JPEG for its WebP twin when YouTube serves it', async () => {
  const stub = stubFetch(() => new Response(null, { status: 200 }));
  try {
    assert.equal(
      await preferWebp('https://i.ytimg.com/vi/Nj13WqtGjq0/maxresdefault.jpg'),
      'https://i.ytimg.com/vi_webp/Nj13WqtGjq0/maxresdefault.webp'
    );
    assert.equal(stub.seen[0].method, 'HEAD');
  } finally {
    stub.restore();
  }
});

test('preferWebp keeps the original when the WebP is missing or the probe fails', async () => {
  const jpg = 'https://i.ytimg.com/vi/Nj13WqtGjq0/sddefault.jpg';
  let stub = stubFetch(() => new Response(null, { status: 404 }));
  try {
    assert.equal(await preferWebp(jpg), jpg);
  } finally {
    stub.restore();
  }
  stub = stubFetch(() => { throw new Error('ECONNRESET'); });
  try {
    assert.equal(await preferWebp(jpg), jpg);
  } finally {
    stub.restore();
  }
});

test('preferWebp leaves non-YouTube URLs and empty values alone without a request', async () => {
  const stub = stubFetch(() => new Response(null, { status: 200 }));
  try {
    assert.equal(await preferWebp('https://example.com/a.jpg'), 'https://example.com/a.jpg');
    assert.equal(await preferWebp(null), null);
    assert.equal(stub.seen.length, 0);
  } finally {
    stub.restore();
  }
});

test('the backfill recognises an item that is already on WebP', () => {
  assert.equal(isWebpThumbnail({ thumbnail: { url: 'https://cdn.prod.website-files.com/x/y_maxresdefault.webp' } }), true);
  assert.equal(isWebpThumbnail({ thumbnail: { url: 'https://cdn.prod.website-files.com/x/y_maxresdefault.jpeg' } }), false);
  assert.equal(isWebpThumbnail({ thumbnail: null }), false);
  assert.equal(isWebpThumbnail({}), false);
});
