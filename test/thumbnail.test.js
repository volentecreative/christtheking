/**
 * Thumbnails are probed against i.ytimg.com rather than assumed, because which
 * qualities exist depends on the source upload. The probing order and the
 * never-throw contract are what the sync depends on, so both are pinned here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { QUALITIES, resolveThumbnailUrl, thumbnailUrl } from '../lib/thumbnail.js';

function stubFetch(handler) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method });
    return handler(String(url));
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

test('thumbnailUrl builds the CDN path for a video and quality', () => {
  assert.equal(
    thumbnailUrl('Nj13WqtGjq0', 'maxresdefault'),
    'https://i.ytimg.com/vi/Nj13WqtGjq0/maxresdefault.jpg'
  );
});

test('qualities are ordered best first, ending on the one that always exists', () => {
  assert.deepEqual(QUALITIES, ['maxresdefault', 'sddefault', 'hqdefault']);
});

test('the best available quality wins, and nothing further is probed', async () => {
  const stub = stubFetch(() => new Response(null, { status: 200 }));
  try {
    const url = await resolveThumbnailUrl('abc');
    assert.equal(url, 'https://i.ytimg.com/vi/abc/maxresdefault.jpg');
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
    assert.equal(await resolveThumbnailUrl('abc'), 'https://i.ytimg.com/vi/abc/sddefault.jpg');
    assert.equal(stub.seen.length, 2);
  } finally {
    stub.restore();
  }
});

test('nothing available yields null, never a URL that 404s', async () => {
  const stub = stubFetch(() => new Response(null, { status: 404 }));
  try {
    assert.equal(await resolveThumbnailUrl('abc'), null);
    assert.equal(stub.seen.length, QUALITIES.length, 'every quality was tried');
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
    assert.equal(await resolveThumbnailUrl('abc'), 'https://i.ytimg.com/vi/abc/sddefault.jpg');
  } finally {
    stub.restore();
  }
});
