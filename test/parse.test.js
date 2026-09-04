import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFieldData,
  buildPlaceholderFieldData,
  buildUpdatePatch,
  classifyType,
  cuesToRichText,
  descriptionToRichText,
  formatTimestamp,
  matchSeries,
  matchSpeakers,
  needsWork,
  normalizeTitle,
  parseIgnoreList,
  parseScripture,
  parseVtt,
  pickThumbnail,
  resolveDate,
  slugify,
  uniqueSlug,
} from '../lib/parse.js';

/* ---------------------------------------------------------------- *
 * Fixtures drawn from the real CTK collections
 * ---------------------------------------------------------------- */

const SPEAKERS = [
  { id: 'sp-boaz', name: 'Boaz Prince' },
  { id: 'sp-cole', name: 'Cole Johnson' },
  { id: 'sp-tom', name: 'Tom Dodds' },
  { id: 'sp-andrew', name: 'Andrew Wittenburg' },
  { id: 'sp-clint', name: 'Clint Manley' },
  { id: 'sp-dustin', name: 'Dustin Williams' },
  { id: 'sp-nathan', name: 'Nathan Colestock' },
  { id: 'sp-andy', name: 'Andy Naselli' },
];

const SERIES = [
  { id: 'se-ezra', name: 'Ezra-Nehemiah' },
  { id: 'se-tim', name: '1 Timothy' },
  { id: 'se-worship', name: 'Congregational Worship' },
];

// Rolling auto-captions, exactly the shape YouTube emits.
const AUTO_VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.080 --> 00:00:03.520 align:start position:0%
Let's pray together. Father, as we

00:00:03.520 --> 00:00:06.240 align:start position:0%
Let's pray together. Father, as we
consider how our <c>hearts</c> are prone to

00:00:06.240 --> 00:00:09.910 align:start position:0%
consider how our hearts are prone to
wander, we ask for mercy.

00:00:09.910 --> 00:00:14.000 align:start position:0%
wander, we ask for mercy.
[Music]

00:00:14.000 --> 00:00:18.500 align:start position:0%
Turn with me to Nehemiah chapter 4.
`;

/* ---------------------------------------------------------------- *
 * Text helpers
 * ---------------------------------------------------------------- */

test('slugify handles punctuation, apostrophes and ampersands', () => {
  assert.equal(slugify("Anchor your soul in God's promises"), 'anchor-your-soul-in-gods-promises');
  assert.equal(slugify('Read God’s Words, and Teach and Preach God’s Words'),
    'read-gods-words-and-teach-and-preach-gods-words');
  assert.equal(slugify('Pray & Give'), 'pray-and-give');
  assert.equal(slugify('  ---  '), 'untitled');
});

test('uniqueSlug avoids collisions with existing items', () => {
  const taken = new Set(['pray-and-give', 'pray-and-give-2']);
  assert.equal(uniqueSlug('pray-and-give', taken), 'pray-and-give-3');
  assert.equal(uniqueSlug('love-one-another', taken), 'love-one-another');
});

test('formatTimestamp switches to hours past 3600s', () => {
  assert.equal(formatTimestamp(0), '0:00');
  assert.equal(formatTimestamp(7), '0:07');
  assert.equal(formatTimestamp(245), '4:05');
  assert.equal(formatTimestamp(3725), '1:02:05');
});

/* ---------------------------------------------------------------- *
 * Captions
 * ---------------------------------------------------------------- */

test('parseVtt collapses rolling auto-caption duplication', () => {
  const cues = parseVtt(AUTO_VTT);
  const text = cues.map((c) => c.text).join(' ');

  assert.equal(text.match(/Let's pray together/g).length, 1, 'no repeated opening line');
  assert.equal(text.match(/wander, we ask for mercy/g).length, 1, 'no repeated rolled line');
  assert.ok(!text.includes('<c>'), 'inline cue markup stripped');
  assert.ok(!text.includes('[Music]'), 'sound tags dropped');
  assert.equal(cues[0].start, 0.08);
  assert.ok(text.includes('Turn with me to Nehemiah chapter 4.'));
});

test('cuesToRichText matches the anchor format already in Webflow', () => {
  const html = cuesToRichText(parseVtt(AUTO_VTT));
  assert.match(html, /^<p><a href="#t=0\.1">0:00<\/a> /);
  assert.ok(html.startsWith('<p>') && html.endsWith('</p>'));
  assert.ok(!/<a href="#t=NaN/.test(html));
});

test('cuesToRichText breaks long transcripts into multiple paragraphs', () => {
  const cues = Array.from({ length: 60 }, (_, i) => ({
    start: i * 5,
    text: 'This is a sentence of roughly forty characters.',
  }));
  const paragraphs = cuesToRichText(cues).split('\n');
  assert.ok(paragraphs.length > 5, `expected several paragraphs, got ${paragraphs.length}`);
  for (const p of paragraphs) assert.match(p, /^<p><a href="#t=\d+\.\d">/);
});

test('cuesToRichText escapes HTML in caption text', () => {
  const html = cuesToRichText([{ start: 0, text: 'Ampersands & <angles> matter' }]);
  assert.ok(html.includes('&amp;') && html.includes('&lt;angles&gt;'));
});

test('empty captions produce an empty string, not junk markup', () => {
  assert.equal(cuesToRichText([]), '');
  assert.equal(cuesToRichText(parseVtt('WEBVTT\n\n')), '');
});

/* ---------------------------------------------------------------- *
 * Descriptions
 * ---------------------------------------------------------------- */

test('descriptionToRichText paragraphs and links plain text', () => {
  const html = descriptionToRichText(
    'Sunday service.\nSecond line.\n\nMore info: https://christtheking.build/give'
  );
  assert.ok(html.includes('<br>'), 'single newlines become breaks');
  assert.equal(html.split('\n').length, 2, 'blank lines split paragraphs');
  assert.ok(html.includes('<a href="https://christtheking.build/give">'));
});

/* ---------------------------------------------------------------- *
 * Scripture
 * ---------------------------------------------------------------- */

test('parseScripture pulls references out of titles', () => {
  assert.equal(parseScripture('Beware Men Like Tobiah | Nehemiah 6:1-14'), 'Nehemiah 6:1-14');
  assert.equal(parseScripture('Five Charges to the Man of God (1 Timothy 6:11-16)'), '1 Timothy 6:11-16');
  assert.equal(parseScripture('Four Charges to the Rich — 1 Tim. 6:17'), '1 Timothy 6:17');
  assert.equal(parseScripture('Pray and Give – Nehemiah 1'), 'Nehemiah 1');
  assert.equal(parseScripture('A sermon on Psalm 23:1-6'), 'Psalm 23:1-6');
  assert.equal(parseScripture('II Corinthians 5:17 — New Creation'), '2 Corinthians 5:17');
});

test('parseScripture keeps cross-chapter ranges whole', () => {
  // Regression: this used to truncate to "Nehemiah 1:1-2", silently dropping the ":8".
  assert.equal(
    parseScripture('How Can I Start Building and Fighting? (Nehemiah 1:1-2:8)'),
    'Nehemiah 1:1-2:8'
  );
  assert.equal(parseScripture('Ezra 1:5-3:2'), 'Ezra 1:5-3:2');
});

test('parseScripture normalises en/em dashes to hyphens', () => {
  assert.equal(parseScripture('Andy Naselli - 1 Timothy 2:11\u201314'), '1 Timothy 2:11-14');
  assert.equal(parseScripture('Ezra 7\u20138'), 'Ezra 7-8');
});

test('parseScripture falls back to the description', () => {
  assert.equal(parseScripture('Love One Another', 'Text: John 13:34-35'), 'John 13:34-35');
});

test('parseScripture returns empty rather than guessing', () => {
  assert.equal(parseScripture('Be Hard to Offend'), '');
  assert.equal(parseScripture('Congregational Worship Q&A'), '');
});

/* ---------------------------------------------------------------- *
 * Speaker / series matching
 * ---------------------------------------------------------------- */

test('matchSpeakers finds a full name in the title', () => {
  assert.deepEqual(matchSpeakers('Pray and Give | Boaz Prince', '', SPEAKERS), ['sp-boaz']);
});

test('matchSpeakers falls back to a unique surname', () => {
  assert.deepEqual(matchSpeakers('Sermon by Pastor Naselli', '', SPEAKERS), ['sp-andy']);
});

test('matchSpeakers stays empty when ambiguous or absent', () => {
  assert.deepEqual(matchSpeakers('Sunday Service', '', SPEAKERS), []);
  assert.deepEqual(
    matchSpeakers('Panel with Boaz Prince and Cole Johnson', '', SPEAKERS),
    [],
    'two matches is ambiguous — leave it for a human'
  );
});

test('matchSeries matches existing series and never invents one', () => {
  assert.equal(matchSeries('Beware Men Like Tobiah | Ezra-Nehemiah', SERIES), 'se-ezra');
  assert.equal(matchSeries('Ezra–Nehemiah week 4 (en dash)', SERIES), 'se-ezra');
  assert.equal(matchSeries('Five Charges | 1 Timothy 6', SERIES), 'se-tim');
  assert.equal(matchSeries('Some brand new series', SERIES), null);
});

/* ---------------------------------------------------------------- *
 * Type classification — calibrated against the live collection
 * ---------------------------------------------------------------- */

test('classifyType reproduces every existing CTK label at the 900s threshold', () => {
  const live = [
    [157, 'Exhortation'], [190, 'Exhortation'], [205, 'Exhortation'], [210, 'Exhortation'],
    [266, 'Exhortation'], [271, 'Exhortation'], [306, 'Exhortation'], [313, 'Exhortation'],
    [317, 'Exhortation'], [317, 'Exhortation'], [332, 'Exhortation'], [338, 'Exhortation'],
    [1417, 'Sermon'], [1772, 'Sermon'], [1860, 'Sermon'], [2220, 'Sermon'], [2266, 'Sermon'],
    [2277, 'Sermon'], [2394, 'Sermon'], [2671, 'Sermon'], [2865, 'Sermon'], [3052, 'Sermon'],
    [3148, 'Sermon'], [3240, 'Sermon'], [3458, 'Sermon'],
  ];
  for (const [duration, expected] of live) {
    assert.equal(classifyType(duration, 900), expected, `${duration}s should be ${expected}`);
  }
});

/* ---------------------------------------------------------------- *
 * Metadata mapping
 * ---------------------------------------------------------------- */

test('resolveDate prefers the epoch timestamp, falls back to upload_date', () => {
  assert.equal(resolveDate({ timestamp: 1783619659 }), new Date(1783619659000).toISOString());
  assert.equal(resolveDate({ upload_date: '20260707' }), '2026-07-07T12:00:00.000Z');
  assert.equal(resolveDate({}), null);
});

test('pickThumbnail takes the widest available image', () => {
  assert.equal(
    pickThumbnail({ thumbnails: [{ url: 'small', width: 120 }, { url: 'big', width: 1280 }] }),
    'big'
  );
  assert.equal(pickThumbnail({ thumbnail: 'direct' }), 'direct');
  assert.equal(pickThumbnail({}), null);
});

test('buildFieldData maps a sermon end to end', () => {
  const data = buildFieldData(
    {
      id: 'lQXc-tgNQ5A',
      title: 'Pray and Give | Nehemiah 1 | Boaz Prince',
      description: 'Sunday service at Christ the King.',
      duration: 2865,
      timestamp: 1783619659,
      thumbnail: 'https://i.ytimg.com/vi/lQXc-tgNQ5A/maxresdefault.jpg',
    },
    {
      transcriptHtml: '<p><a href="#t=0.0">0:00</a> Let us pray.</p>',
      speakers: SPEAKERS,
      series: SERIES,
      sermonMinSeconds: 900,
      now: '2026-08-12T00:00:00.000Z',
    }
  );

  assert.equal(data['youtube-video-id'], 'lQXc-tgNQ5A');
  assert.equal(data['video-url'], 'https://www.youtube.com/watch?v=lQXc-tgNQ5A');
  assert.equal(data.type, 'Sermon');
  assert.equal(data['duration-seconds'], 2865);
  assert.equal(data['scripture-raw'], 'Nehemiah 1');
  assert.deepEqual(data['speaker-s'], ['sp-boaz']);
  assert.equal(data['last-synced'], '2026-08-12T00:00:00.000Z');
  assert.ok(data.transcript.startsWith('<p><a href="#t=0.0">'));
});

test('buildFieldData classifies a short clip as an exhortation', () => {
  const data = buildFieldData(
    { id: 'abc', title: 'Be Hard to Offend', duration: 157, upload_date: '20260401' },
    { speakers: SPEAKERS, series: SERIES, sermonMinSeconds: 900, now: 'now' }
  );
  assert.equal(data.type, 'Exhortation');
  assert.equal(data.series, null);
});

/* ---------------------------------------------------------------- *
 * Partial items — what a blocked YouTube fetch can still produce
 * ---------------------------------------------------------------- */

const LISTING_CONTEXT = {
  speakers: SPEAKERS,
  series: SERIES,
  sermonMinSeconds: 900,
  now: '2026-09-04T00:00:00.000Z',
};

test('buildPlaceholderFieldData builds a real item from listing data alone', () => {
  const data = buildPlaceholderFieldData(
    {
      id: 'Nj13WqtGjq0',
      title: 'Boaz Prince - Pray and Give | Nehemiah 1',
      duration: 2865,
    },
    LISTING_CONTEXT
  );

  assert.equal(data.name, 'Pray and Give');
  assert.equal(data['youtube-video-id'], 'Nj13WqtGjq0');
  assert.equal(data['video-url'], 'https://www.youtube.com/watch?v=Nj13WqtGjq0');
  assert.equal(data['duration-seconds'], 2865);
  assert.equal(data.type, 'Sermon');
  // The reference is read off the raw title, so it survives the fetch failing.
  assert.equal(data['scripture-raw'], 'Nehemiah 1');
  assert.deepEqual(data['speaker-s'], ['sp-boaz']);
});

test('buildPlaceholderFieldData leaves what only a full fetch knows empty', () => {
  const data = buildPlaceholderFieldData(
    { id: 'abc', title: 'Honor God’s Name', duration: 400 },
    LISTING_CONTEXT
  );

  assert.equal(data.thumbnail, null);
  assert.equal(data.description, '');
  assert.equal(data.transcript, '');
  assert.equal(data.type, 'Exhortation');
  // No feed date offered, so no date at all — `date` is fill-only, so a guess
  // would stick forever.
  assert.equal(data.date, null);
});

test('buildPlaceholderFieldData takes a resolved thumbnail', () => {
  const data = buildPlaceholderFieldData(
    {
      id: 'abc',
      title: 'Run to Win',
      duration: 1200,
      thumbnailUrl: 'https://i.ytimg.com/vi/abc/maxresdefault.jpg',
    },
    LISTING_CONTEXT
  );

  assert.equal(data.thumbnail, 'https://i.ytimg.com/vi/abc/maxresdefault.jpg');
});

test('buildPlaceholderFieldData takes the upload date from the channel feed', () => {
  const data = buildPlaceholderFieldData(
    {
      id: 'abc',
      title: 'Honor God’s Name',
      duration: 400,
      publishedAt: '2026-09-01T18:30:00.000Z',
    },
    LISTING_CONTEXT
  );

  assert.equal(data.date, '2026-09-01T18:30:00.000Z');
});

test('an unusable feed date leaves the field blank rather than writing garbage', () => {
  for (const publishedAt of ['', 'sometime', null, undefined]) {
    const data = buildPlaceholderFieldData(
      { id: 'abc', title: 'Run to Win', duration: 1200, publishedAt },
      LISTING_CONTEXT
    );
    assert.equal(data.date, null, `publishedAt ${JSON.stringify(publishedAt)}`);
  }
});

test('a feed-dated partial item keeps its date on the later full fetch', () => {
  // `date` is fill-only, so whatever the partial item wrote is permanent. That
  // is safe only because the feed date is exact, not approximated.
  const partial = buildPlaceholderFieldData(
    { id: 'abc', title: 'Run to Win', duration: 1200, publishedAt: '2026-09-01T18:30:00.000Z' },
    LISTING_CONTEXT
  );

  const full = buildFieldData(
    { id: 'abc', title: 'Run to Win', duration: 1200, timestamp: 1788000000 },
    { ...LISTING_CONTEXT, transcriptHtml: '' }
  );

  const { patch } = buildUpdatePatch(full, partial, { force: true });
  assert.equal('date' in patch, false);
});

test('a partial item carries no last-synced, so it stays eligible for a re-fetch', () => {
  const data = buildPlaceholderFieldData(
    { id: 'abc', title: 'Run to Win', duration: 1200 },
    LISTING_CONTEXT
  );

  assert.equal('last-synced' in data, false);
  // This is the whole mechanism: needsWork() reads it as never synced.
  assert.equal(needsWork({ fieldData: data }), true);
});

test('a re-fetch fills a partial item in without --force', () => {
  const partial = buildPlaceholderFieldData(
    { id: 'abc', title: 'Run to Win', duration: 1200 },
    LISTING_CONTEXT
  );

  const full = buildFieldData(
    {
      id: 'abc',
      title: 'Run to Win',
      duration: 1200,
      description: 'Sunday service.',
      timestamp: 1783619659,
      thumbnail: 'https://i.ytimg.com/vi/abc/maxresdefault.jpg',
    },
    { ...LISTING_CONTEXT, transcriptHtml: '<p>words</p>' }
  );

  const { patch, changed } = buildUpdatePatch(full, partial);
  assert.equal(changed, true);
  assert.equal(patch.thumbnail, 'https://i.ytimg.com/vi/abc/maxresdefault.jpg');
  assert.equal(patch.transcript, '<p>words</p>');
  assert.ok(patch.date);
  assert.ok(patch.description);
  // type is first-sync-only: the partial item already classified it.
  assert.equal('type' in patch, false);
});

/* ---------------------------------------------------------------- *
 * Update safety — the part that protects manual edits
 * ---------------------------------------------------------------- */

const desired = {
  name: 'Corrected Title',
  transcript: '<p>fresh transcript</p>',
  description: '<p>from youtube</p>',
  type: 'Sermon',
  'speaker-s': ['sp-boaz'],
  series: 'se-ezra',
  'scripture-raw': 'Nehemiah 1',
  thumbnail: 'https://img/new.jpg',
  'last-synced': '2026-08-12T00:00:00.000Z',
};

test('update fills empty fields only, and never touches type', () => {
  const existing = {
    name: 'Hand-edited Title',
    transcript: '',
    description: '<p>hand written</p>',
    type: 'Exhortation',
    'speaker-s': [],
    series: null,
    'scripture-raw': '',
    thumbnail: { url: 'https://img/old.jpg' },
  };

  const { patch, changed, changedFields } = buildUpdatePatch(desired, existing);

  assert.ok(changed);
  assert.deepEqual(changedFields.sort(), ['scripture-raw', 'series', 'speaker-s', 'transcript']);
  assert.equal(patch.name, undefined, 'a hand-edited title is never overwritten');
  assert.equal(patch.description, undefined, 'existing description preserved');
  assert.equal(patch.thumbnail, undefined, 'existing thumbnail preserved');
  assert.equal(patch.type, undefined, 'type is first-sync-only');
  assert.deepEqual(patch['speaker-s'], ['sp-boaz'], 'an EMPTY speaker is backfilled');
  assert.equal(patch.series, 'se-ezra', 'an EMPTY series is backfilled');
  assert.equal(patch['last-synced'], '2026-08-12T00:00:00.000Z', 'heartbeat always written');
});

test('a speaker assigned by hand is never overwritten, even with --force', () => {
  const existing = { 'speaker-s': ['sp-cole'], series: 'se-tim', type: 'Sermon' };
  for (const force of [false, true]) {
    const { patch } = buildUpdatePatch(desired, existing, { force });
    assert.deepEqual(patch['speaker-s'], undefined, `force=${force} must not touch a set speaker`);
    assert.equal(patch.series, undefined, `force=${force} must not touch a set series`);
  }
});

test('adding a missing speaker to the collection backfills it on the next run', () => {
  // The real workflow: item created with no speaker match, speaker added later.
  const existing = { name: 'John Piper - Sustaining Grace', 'speaker-s': [], transcript: '<p>x</p>' };
  const { patch } = buildUpdatePatch(
    { 'speaker-s': ['sp-piper'], 'last-synced': 'now' },
    existing
  );
  assert.deepEqual(patch['speaker-s'], ['sp-piper']);
});

test('force refreshes YouTube-owned fields but spares type/speaker/series/name', () => {
  const existing = {
    name: 'Old Title',
    transcript: '<p>old</p>',
    type: 'Exhortation',
    'speaker-s': ['sp-cole'],
    series: 'se-tim',
    thumbnail: { url: 'https://img/old.jpg' },
  };

  const { patch, changedFields } = buildUpdatePatch(desired, existing, { force: true });

  // `name` used to be refreshed here. It no longer is: titles are curated from
  // the worship service guides, so YouTube must not win them back.
  assert.equal(patch.name, undefined);
  assert.equal(patch.transcript, '<p>fresh transcript</p>');
  assert.equal(patch.thumbnail, 'https://img/new.jpg');
  assert.equal(patch.type, undefined);
  assert.equal(patch['speaker-s'], undefined);
  assert.equal(patch.series, undefined);
  assert.ok(!changedFields.includes('last-synced'));
});

test('an up-to-date item reports no meaningful change', () => {
  const existing = {
    name: 'Corrected Title',
    transcript: '<p>fresh transcript</p>',
    description: '<p>from youtube</p>',
    type: 'Sermon',
    'speaker-s': ['sp-boaz'],
    series: 'se-ezra',
    'scripture-raw': 'Nehemiah 1',
    thumbnail: { url: 'https://img/new.jpg' },
  };

  const { changed } = buildUpdatePatch(desired, existing);
  assert.equal(changed, false, 'a synced item must not be rewritten every run');
});

test('empty desired values never blank out populated Webflow fields', () => {
  const sparse = { ...desired, transcript: '', 'scripture-raw': '', 'last-synced': 'now' };
  const existing = { transcript: '<p>keep me</p>', 'scripture-raw': 'John 3:16' };
  const { patch } = buildUpdatePatch(sparse, existing, { force: true });
  assert.equal(patch.transcript, undefined);
  assert.equal(patch['scripture-raw'], undefined);
});

/* ---------------------------------------------------------------- *
 * Re-fetch eligibility — the check that decides what a run works on
 * ---------------------------------------------------------------- */

const DAY = 86_400_000;
const NOW = new Date('2026-08-14T12:00:00Z').getTime();
const item = (fieldData) => ({ fieldData });

test('an item this script has never synced is always eligible', () => {
  assert.equal(needsWork(item({ name: 'From the old import' }), { now: NOW }), true);
});

test('a synced item with a transcript is done', () => {
  const synced = item({
    'last-synced': new Date(NOW - DAY).toISOString(),
    transcript: '<p>words</p>',
  });
  assert.equal(needsWork(synced, { now: NOW }), false);
});

test('an EMPTY description does not make an item eligible forever', () => {
  // 90 of CTK's 92 videos have no YouTube description at all. Treating that as
  // "incomplete" made every item eligible on every run and wasted two --max-work
  // budgets re-fetching videos that were already finished.
  const synced = item({
    'last-synced': new Date(NOW - DAY).toISOString(),
    transcript: '<p>words</p>',
    description: '',
    series: null,
    'speaker-s': [],
    'scripture-raw': '',
  });
  assert.equal(needsWork(synced, { now: NOW }), false);
});

test('a missing transcript keeps the item eligible — captions arrive late', () => {
  const fresh = item({ 'last-synced': new Date(NOW - 2 * DAY).toISOString(), transcript: '' });
  assert.equal(needsWork(fresh, { now: NOW }), true);
});

test('but the sync gives up on transcripts that never appear', () => {
  const stale = item({ 'last-synced': new Date(NOW - 30 * DAY).toISOString(), transcript: '' });
  assert.equal(needsWork(stale, { now: NOW }), false, 'no captions after 30 days: stop retrying');
});

test('--no-transcripts means a synced item is never re-fetched', () => {
  const noTranscript = item({ 'last-synced': new Date(NOW - DAY).toISOString(), transcript: '' });
  assert.equal(needsWork(noTranscript, { now: NOW, transcripts: false }), false);
});

test('a corrupt last-synced value is treated as never synced', () => {
  assert.equal(needsWork(item({ 'last-synced': 'not a date' }), { now: NOW }), true);
});

/* ---------------------------------------------------------------- *
 * Ignore list
 * ---------------------------------------------------------------- */

test('parseIgnoreList reads the documented object form', () => {
  const ids = parseIgnoreList({
    _comment: 'ignored',
    ignore: [
      { id: 'bezHcAlVmtw', why: 'duplicate re-upload' },
      { id: 'GEkFNEXwu9Y', why: 'duplicate re-upload' },
    ],
  });
  assert.equal(ids.size, 2);
  assert.ok(ids.has('bezHcAlVmtw'));
});

test('parseIgnoreList also accepts a plain array of ids', () => {
  const ids = parseIgnoreList(['abc123', 'def456']);
  assert.deepEqual([...ids].sort(), ['abc123', 'def456']);
});

test('parseIgnoreList is safe on empty, missing, or malformed input', () => {
  assert.equal(parseIgnoreList(null).size, 0);
  assert.equal(parseIgnoreList({}).size, 0);
  assert.equal(parseIgnoreList({ ignore: [] }).size, 0);
  assert.equal(parseIgnoreList({ ignore: [{ why: 'no id here' }, null] }).size, 0);
});






test('guide-sourced fields survive a --force run', () => {
  // date, name and scripture-raw come from the worship service guides. A forced
  // re-sync refreshes YouTube metadata but must not touch these.
  const desired = {
    name: 'Andy Naselli - Some Youtube Title',
    date: '2026-08-12T18:00:00.000Z',
    'scripture-raw': 'Nehemiah 8',
    description: '<p>fresh</p>',
  };
  const existing = {
    name: 'From Confusion to Obedience',
    date: '2026-08-09T15:30:00.000Z',
    'scripture-raw': 'Nehemiah 8:9-18',
    description: '<p>old</p>',
  };
  const { patch } = buildUpdatePatch(desired, existing, { force: true });
  assert.equal(patch.name, undefined);
  assert.equal(patch.date, undefined);
  assert.equal(patch['scripture-raw'], undefined);
  assert.equal(patch.description, '<p>fresh</p>', 'non-guide fields still refresh');
});

test('guide-sourced fields still fill when the item has none', () => {
  const desired = { name: 'A Title', date: '2026-08-12T18:00:00.000Z', 'scripture-raw': 'Psalm 1' };
  const { patch } = buildUpdatePatch(desired, {});
  assert.equal(patch.name, 'A Title');
  assert.equal(patch.date, '2026-08-12T18:00:00.000Z');
  assert.equal(patch['scripture-raw'], 'Psalm 1');
});


test('normalizeTitle strips the speaker prefix, series suffix and lead label', () => {
  const speakers = [{ name: 'Andy Naselli' }, { name: 'Nathan Colestock' }];
  assert.equal(
    normalizeTitle('Andy Naselli - What Shepherds Do | 1 Timothy - Part 19', speakers),
    'What Shepherds Do'
  );
  assert.equal(normalizeTitle('Exhortation - fret not, sing psalms.', speakers), 'Fret Not, Sing Psalms');
});

test('normalizeTitle only strips a prefix that is a real speaker', () => {
  const speakers = [{ name: 'Andy Naselli' }];
  assert.equal(
    normalizeTitle('Fear to Faith - Faith to Favor', speakers),
    'Fear to Faith - Faith to Favor'
  );
});

test('normalizeTitle pulls a trailing scripture reference out of the title', () => {
  assert.equal(normalizeTitle('Make War, Not Peace (Ezra 9-10)'), 'Make War, Not Peace');
  assert.equal(
    normalizeTitle('How Can I Start Building and Fighting? (Nehemiah 1:1-2:8)'),
    'How Can I Start Building and Fighting?'
  );
  assert.equal(normalizeTitle('Win the World Through the Word (Ezra 7\u20138)'), 'Win the World Through the Word');
});

test('normalizeTitle keeps a part marker that shared the reference parentheses', () => {
  assert.equal(
    normalizeTitle('What Must Deacons Be? (1 Timothy 3:8-13, Part 2 of 2)'),
    'What Must Deacons Be? (Part 2 of 2)'
  );
});

test('normalizeTitle leaves a reference that is part of the sentence', () => {
  // Stripping this one would leave "11 Questions About" dangling.
  assert.equal(
    normalizeTitle('God Loved the World: 11 Questions About John 3:16'),
    'God Loved the World: 11 Questions About John 3:16'
  );
  // A digit must follow the book name, so a parenthetical name survives.
  assert.equal(normalizeTitle('Preaching Christ (John Piper)'), 'Preaching Christ (John Piper)');
});

test('normalizeTitle title-cases without flattening author-shaped words', () => {
  assert.equal(normalizeTitle('the LORD is my shepherd (Psalm 23)'), 'The LORD Is My Shepherd');
  assert.equal(normalizeTitle('robert murray mccheyne on prayer'), 'Robert Murray Mccheyne on Prayer');
  assert.equal(normalizeTitle('a word to the church'), 'A Word to the Church');
});

test('normalizeTitle drops a trailing period but keeps an ellipsis', () => {
  assert.equal(normalizeTitle('Be on the Beauty Hunt.'), 'Be on the Beauty Hunt');
  // Only a title long enough to have been cut off keeps a lowercase last word;
  // in a short title the final word is capitalized as usual.
  const truncated =
    'Three Ways the Church Guards the Good Deposit, Two Kinds of Elders, and Two Types of Deacons and Two Types of\u2026';
  assert.equal(normalizeTitle(truncated), truncated);
  assert.equal(normalizeTitle('And Two Types of'), 'And Two Types Of');
});

test('buildFieldData normalizes the name but reads scripture from the raw title', () => {
  const data = buildFieldData(
    {
      id: 'abcdefghijk',
      title: 'Andy Naselli - what shepherds do (1 Timothy 3:1) | 1 Timothy - Part 19',
      duration: 2400,
      description: '',
      upload_date: '20250810',
    },
    { transcriptHtml: '', speakers: [{ id: 's1', name: 'Andy Naselli' }], series: [], now: 'now' }
  );
  assert.equal(data.name, 'What Shepherds Do');
  assert.equal(data['scripture-raw'], '1 Timothy 3:1');
});
