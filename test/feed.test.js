/**
 * The channel Atom feed is what gives a partial item its real upload date, so
 * the parsing is worth pinning down offline — the network half is one fetch.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchChannelFeedDates, parseFeedDates } from '../lib/feed.js';

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
  </entry>
  <entry>
    <id>yt:video:XhDY8Bs-bwk</id>
    <yt:videoId>XhDY8Bs-bwk</yt:videoId>
    <title>Honor God&#39;s Name</title>
    <published>2026-09-01T18:30:00+00:00</published>
    <updated>2026-09-01T18:30:00+00:00</updated>
  </entry>
</feed>`;

test('parseFeedDates pulls an exact timestamp per video', () => {
  const dates = parseFeedDates(FEED);

  assert.equal(dates.size, 2);
  assert.equal(dates.get('Nj13WqtGjq0'), '2026-08-30T14:05:00.000Z');
  assert.equal(dates.get('XhDY8Bs-bwk'), '2026-09-01T18:30:00.000Z');
});

test('parseFeedDates reads published, never updated', () => {
  // The first entry was edited three days after upload. Taking `updated` would
  // silently redate the sermon.
  assert.equal(parseFeedDates(FEED).get('Nj13WqtGjq0'), '2026-08-30T14:05:00.000Z');
});

test('parseFeedDates ignores junk rather than throwing', () => {
  assert.equal(parseFeedDates('').size, 0);
  assert.equal(parseFeedDates(null).size, 0);
  assert.equal(parseFeedDates('<html>404</html>').size, 0);
  assert.equal(
    parseFeedDates('<feed><entry><yt:videoId>a</yt:videoId></entry></feed>').size,
    0,
    'an entry with no <published> is skipped, not stored as an invalid date'
  );
  assert.equal(
    parseFeedDates(
      '<feed><entry><yt:videoId>a</yt:videoId><published>whenever</published></entry></feed>'
    ).size,
    0,
    'an unparseable date is skipped'
  );
});

test('fetchChannelFeedDates skips the request without a channel id', async () => {
  const dates = await fetchChannelFeedDates(null);
  assert.equal(dates.size, 0);
});

test('fetchChannelFeedDates requests the feed by channel id', async () => {
  const original = globalThis.fetch;
  let requested = null;
  globalThis.fetch = async (url) => {
    requested = String(url);
    return new Response(FEED, { status: 200 });
  };

  try {
    const dates = await fetchChannelFeedDates('UCabcdefghijklmnopqrstuv');
    assert.equal(
      requested,
      'https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv'
    );
    assert.equal(dates.size, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchChannelFeedDates throws on a bad response, for the caller to absorb', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 429 });

  try {
    await assert.rejects(() => fetchChannelFeedDates('UCabcdefghijklmnopqrstuv'), /429/);
  } finally {
    globalThis.fetch = original;
  }
});
