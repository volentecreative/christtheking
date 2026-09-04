/**
 * The channel Atom feed is what gives a partial item its real upload date, so
 * the parsing is worth pinning down offline — the network half is one fetch.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchChannelFeed, parseFeed } from '../lib/feed.js';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <yt:channelId>UCabcdefghijklmnopqrstuv</yt:channelId>
  <title>Christ the King</title>
  <entry>
    <id>yt:video:Nj13WqtGjq0</id>
    <yt:videoId>Nj13WqtGjq0</yt:videoId>
    <title>Main Session 1 - Dating | Doug Wilson</title>
    <published>2026-08-30T14:05:00+00:00</published>
    <updated>2026-09-02T11:00:00+00:00</updated>
    <media:group>
      <media:thumbnail url="https://i.ytimg.com/vi/Nj13WqtGjq0/hqdefault.jpg" width="480" height="360"/>
    </media:group>
  </entry>
  <entry>
    <id>yt:video:XhDY8Bs-bwk</id>
    <yt:videoId>XhDY8Bs-bwk</yt:videoId>
    <title>Honor God&#39;s Name</title>
    <published>2026-09-01T18:30:00+00:00</published>
    <updated>2026-09-01T18:30:00+00:00</updated>
  </entry>
</feed>`;

test('parseFeed pulls an exact timestamp per video', () => {
  const entries = parseFeed(FEED);

  assert.equal(entries.size, 2);
  assert.equal(entries.get('Nj13WqtGjq0').publishedAt, '2026-08-30T14:05:00.000Z');
  assert.equal(entries.get('XhDY8Bs-bwk').publishedAt, '2026-09-01T18:30:00.000Z');
});

test('parseFeed reads published, never updated', () => {
  // The first entry was edited three days after upload. Taking `updated` would
  // silently redate the sermon.
  assert.equal(parseFeed(FEED).get('Nj13WqtGjq0').publishedAt, '2026-08-30T14:05:00.000Z');
});

test('parseFeed picks up the thumbnail YouTube advertises', () => {
  const entries = parseFeed(FEED);

  assert.equal(
    entries.get('Nj13WqtGjq0').thumbnail,
    'https://i.ytimg.com/vi/Nj13WqtGjq0/hqdefault.jpg'
  );
  assert.equal(entries.get('XhDY8Bs-bwk').thumbnail, null, 'absent is null, not undefined');
});

test('parseFeed ignores junk rather than throwing', () => {
  assert.equal(parseFeed('').size, 0);
  assert.equal(parseFeed(null).size, 0);
  assert.equal(parseFeed('<html>404</html>').size, 0);
  assert.equal(
    parseFeed('<feed><entry><yt:videoId>a</yt:videoId></entry></feed>').get('a').publishedAt,
    null,
    'an entry with no <published> yields a null date, never an invalid one'
  );
  assert.equal(
    parseFeed(
      '<feed><entry><yt:videoId>a</yt:videoId><published>whenever</published></entry></feed>'
    ).get('a').publishedAt,
    null,
    'an unparseable date is dropped'
  );
});

test('fetchChannelFeed skips the request without a channel id', async () => {
  const entries = await fetchChannelFeed(null);
  assert.equal(entries.size, 0);
});

test('fetchChannelFeed requests the feed by channel id', async () => {
  const original = globalThis.fetch;
  let requested = null;
  globalThis.fetch = async (url) => {
    requested = String(url);
    return new Response(FEED, { status: 200 });
  };

  try {
    const entries = await fetchChannelFeed('UCabcdefghijklmnopqrstuv');
    assert.equal(
      requested,
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv'
    );
    assert.equal(entries.size, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchChannelFeed throws on a bad response, for the caller to absorb', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 429 });

  try {
    await assert.rejects(() => fetchChannelFeed('UCabcdefghijklmnopqrstuv'), /429/);
  } finally {
    globalThis.fetch = original;
  }
});
