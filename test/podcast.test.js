import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appleEpisodeUrl,
  daysApart,
  findSpeaker,
  matchEpisodes,
  normalizeTitle,
  parseAppleEpisodes,
  parseSpotifyEpisodes,
  splitPodcastTitle,
  stripSeriesSuffix,
  titleSimilarity,
} from '../lib/podcast.js';

const SPEAKERS = [
  { id: 'sp-andy', name: 'Andy Naselli' },
  { id: 'sp-nathan', name: 'Nathan Colestock' },
  { id: 'sp-clint', name: 'Clint Manley' },
  { id: 'sp-tom', name: 'Tom Dodds' },
];

/* Real pairs from the live data, YouTube side and podcast side. */
const REAL_PAIRS = [
  {
    yt: 'From Confusion to Obedience | Ezra-Nehemiah - Part 15',
    ytDur: 2598,
    ytDate: '2026-08-09T14:31:00.000Z',
    pod: 'Nathan Colestock - From Confusion to Obedience',
    podDur: 2597,
    podDate: '2026-08-09T10:00:00Z',
    speaker: 'Nathan Colestock',
  },
  {
    yt: 'Redeem the Time',
    ytDur: 325,
    ytDate: '2026-08-09T14:20:00.000Z',
    pod: 'Exhortation - Redeem the Time',
    podDur: 324,
    podDate: '2026-08-09T10:00:00Z',
    speaker: null,
  },
  {
    yt: 'Sing: Part 2 of 3 | Congregational Worship - Part 6',
    ytDur: 2232,
    ytDate: '2026-08-02T15:02:00.000Z',
    pod: 'Andy Naselli - Sing: Part 2 of 3—Why Should a Church Continually Sing the Psalms?',
    podDur: 2231,
    podDate: '2026-08-02T10:00:00Z',
    speaker: 'Andy Naselli',
  },
  {
    yt: 'Attend and Adore',
    ytDur: 1500,
    ytDate: '2026-07-12T16:00:00.000Z',
    pod: 'Clint Manley - Attend and Adore',
    podDur: 1499,
    podDate: '2026-07-12T10:00:00Z',
    speaker: 'Clint Manley',
  },
];

const toItems = (pairs) =>
  pairs.map((p, i) => ({ id: `item-${i}`, title: p.yt, durationSeconds: p.ytDur, date: p.ytDate }));
const toEpisodes = (pairs) =>
  pairs.map((p, i) => ({
    guid: `guid-${i}`,
    title: p.pod,
    durationSeconds: p.podDur,
    date: p.podDate,
  }));

/* ---------------------------------------------------------------- *
 * Title handling
 * ---------------------------------------------------------------- */

test('splitPodcastTitle pulls a known speaker off the front', () => {
  const { speaker, title } = splitPodcastTitle(
    'Nathan Colestock - From Confusion to Obedience',
    SPEAKERS.map((s) => s.name)
  );
  assert.equal(speaker, 'Nathan Colestock');
  assert.equal(title, 'From Confusion to Obedience');
});

test('splitPodcastTitle treats "Exhortation" as a category, not a person', () => {
  const { speaker, title } = splitPodcastTitle(
    'Exhortation - Redeem the Time',
    SPEAKERS.map((s) => s.name)
  );
  assert.equal(speaker, null);
  assert.equal(title, 'Redeem the Time');
});

test('splitPodcastTitle leaves an unknown prefix alone rather than guessing', () => {
  const { speaker, title } = splitPodcastTitle(
    'Build and Fight - Part Two',
    SPEAKERS.map((s) => s.name)
  );
  assert.equal(speaker, null, 'must not invent a speaker from arbitrary words');
  assert.equal(title, 'Build and Fight - Part Two', 'and must not eat real title words');
});

test('stripSeriesSuffix drops the YouTube series tail', () => {
  assert.equal(
    stripSeriesSuffix('Sing: Part 2 of 3 | Congregational Worship - Part 6'),
    'Sing: Part 2 of 3'
  );
  assert.equal(stripSeriesSuffix('Redeem the Time'), 'Redeem the Time');
});

test('normalizeTitle folds smart quotes, dashes and ampersands', () => {
  assert.equal(normalizeTitle('God’s Design—Part 1 & 2'), "god's design part 1 and 2");
});

test('titleSimilarity is high for the same sermon, low for different ones', () => {
  assert.ok(titleSimilarity('Attend and Adore', 'Attend and Adore') === 1);
  assert.ok(titleSimilarity('Honor Widows', 'Pay Your Elders') < 0.2);
});

test('daysApart handles the Sunday-vs-upload-time drift', () => {
  assert.ok(daysApart('2026-07-07T17:54:00Z', '2026-07-05T10:00:00Z') < 3);
  assert.equal(daysApart('nonsense', '2026-07-05T10:00:00Z'), Infinity);
});

/* ---------------------------------------------------------------- *
 * Matching — the part that can corrupt data if it's wrong
 * ---------------------------------------------------------------- */

test('every real pair matches, on duration + date + title', () => {
  const { matches, ambiguous, unmatchedItems } = matchEpisodes(
    toItems(REAL_PAIRS),
    toEpisodes(REAL_PAIRS),
    { speakers: SPEAKERS }
  );

  assert.equal(matches.length, REAL_PAIRS.length);
  assert.equal(ambiguous.length, 0);
  assert.equal(unmatchedItems.length, 0);

  for (const m of matches) {
    const i = Number(m.item.id.split('-')[1]);
    assert.equal(m.ep.guid, `guid-${i}`, `${m.item.title} matched the wrong episode`);
    assert.equal(m.basis, 'duration+date+title');
  }
});

test('the speaker comes back with the match', () => {
  const { matches } = matchEpisodes(toItems(REAL_PAIRS), toEpisodes(REAL_PAIRS), {
    speakers: SPEAKERS,
  });
  const byTitle = Object.fromEntries(matches.map((m) => [m.item.title, m.ep.speaker]));
  assert.equal(byTitle['From Confusion to Obedience | Ezra-Nehemiah - Part 15'], 'Nathan Colestock');
  assert.equal(byTitle['Redeem the Time'], null, 'exhortations have no named preacher');
});

test('matching is strictly one-to-one', () => {
  // Two sermons of identical length on the same day — the classic corruption case.
  const items = [
    { id: 'a', title: 'There Arose a Reasoning Among Them', durationSeconds: 226, date: '2026-08-14T12:00:00Z' },
    { id: 'b', title: 'Do not be Dull of Hearing', durationSeconds: 226, date: '2026-08-14T12:00:00Z' },
  ];
  const episodes = [
    { guid: 'g1', title: 'Exhortation - There Arose a Reasoning Among Them', durationSeconds: 226, date: '2026-08-14T10:00:00Z' },
    { guid: 'g2', title: 'Exhortation - Do not be Dull of Hearing', durationSeconds: 226, date: '2026-08-14T10:00:00Z' },
  ];

  const { matches } = matchEpisodes(items, episodes, { speakers: SPEAKERS });
  assert.equal(matches.length, 2);
  const pairs = Object.fromEntries(matches.map((m) => [m.item.id, m.ep.guid]));
  assert.equal(pairs.a, 'g1', 'title must break the duration tie');
  assert.equal(pairs.b, 'g2');
});

test('an episode with no counterpart is reported, not force-matched', () => {
  const items = toItems(REAL_PAIRS.slice(0, 2));
  const episodes = [
    ...toEpisodes(REAL_PAIRS.slice(0, 2)),
    { guid: 'orphan', title: 'Andy Naselli - A Conference Session', durationSeconds: 4000, date: '2024-01-01T10:00:00Z' },
  ];
  const { matches, unmatchedEpisodes } = matchEpisodes(items, episodes, { speakers: SPEAKERS });
  assert.equal(matches.length, 2);
  assert.deepEqual(unmatchedEpisodes.map((e) => e.guid), ['orphan']);
});

test('a wrong-duration, wrong-date episode never matches on title alone', () => {
  const items = [{ id: 'a', title: 'Honor Widows', durationSeconds: 2000, date: '2026-01-18T12:00:00Z' }];
  const episodes = [
    { guid: 'g', title: 'Andy Naselli - Honor Widows', durationSeconds: 300, date: '2024-05-01T10:00:00Z' },
  ];
  const { matches, unmatchedItems } = matchEpisodes(items, episodes, { speakers: SPEAKERS });
  assert.equal(matches.length, 0, 'a year apart is not the same sermon');
  assert.equal(unmatchedItems.length, 1);
});

test('title-only fallback works when duration is missing', () => {
  const items = [{ id: 'a', title: 'Honor Widows', durationSeconds: null, date: '2026-01-18T12:00:00Z' }];
  const episodes = [
    { guid: 'g', title: 'Andy Naselli - Honor Widows', durationSeconds: null, date: '2026-01-18T10:00:00Z' },
  ];
  const { matches } = matchEpisodes(items, episodes, { speakers: SPEAKERS });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].basis, 'date+title');
});

/* ---------------------------------------------------------------- *
 * Payload parsing
 * ---------------------------------------------------------------- */

test('parseAppleEpisodes reads the real lookup shape and drops the show row', () => {
  const episodes = parseAppleEpisodes({
    resultCount: 2,
    results: [
      { wrapperType: 'track', kind: 'podcast', collectionName: 'Christ the King Church in Stillwater' },
      {
        wrapperType: 'podcastEpisode',
        trackName: 'Exhortation - Redeem the Time',
        releaseDate: '2026-08-09T10:00:00Z',
        episodeGuid: '8e06a9caa3a43a87aa831794e97ebd46',
        trackTimeMillis: 324000,
        trackViewUrl: 'https://podcasts.apple.com/us/podcast/exhortation-redeem-the-time/id1792025763?i=1000782957478&uo=4',
        episodeUrl: 'https://t.subsplash.com/r/abc.mp3?k=3SCH47',
      },
    ],
  });

  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].guid, '8e06a9caa3a43a87aa831794e97ebd46');
  assert.equal(episodes[0].durationSeconds, 324);
  assert.equal(
    episodes[0].appleUrl,
    'https://podcasts.apple.com/us/podcast/exhortation-redeem-the-time/id1792025763?i=1000782957478',
    '`i` is the episode — only `uo` is tracking'
  );
  assert.ok(episodes[0].audioUrl.startsWith('https://t.subsplash.com/'));
});

test('parseSpotifyEpisodes flattens paged results', () => {
  const episodes = parseSpotifyEpisodes([
    { items: [{ id: 'sp1', name: 'Ep One', release_date: '2026-08-09', duration_ms: 324000, external_urls: { spotify: 'https://open.spotify.com/episode/sp1' } }] },
    { items: [null, { id: 'sp2', name: 'Ep Two', release_date: '2026-08-02', duration_ms: 2231000, external_urls: {} }] },
  ]);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].spotifyUrl, 'https://open.spotify.com/episode/sp1');
  assert.equal(episodes[1].spotifyUrl, null);
});

/* ---------------------------------------------------------------- *
 * The archive case: right sermon, wildly wrong date
 * ---------------------------------------------------------------- */

test('a bulk-uploaded archive video still matches its episode', () => {
  // CTK uploaded its back catalogue to YouTube on 2025-04-23, so 26 videos all
  // carry that date while the podcast has the real preaching dates. Requiring a
  // close date on every rule left all 26 unmatched on the first real run.
  const items = [
    {
      id: 'a',
      title: 'Andy Naselli - Introducing 1 Timothy: Fight the Good Fight of the Faith',
      durationSeconds: 1975,
      date: '2025-04-23T00:00:00Z',
    },
  ];
  const episodes = [
    {
      guid: 'g',
      title: 'Andy Naselli - Introducing 1 Timothy: Fight the Good Fight of the Faith',
      durationSeconds: 1974,
      date: '2023-09-10T10:00:00Z', // ~19 months earlier
    },
  ];

  const { matches } = matchEpisodes(items, episodes, { speakers: SPEAKERS });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].basis, 'duration+title');
});

test('a far-apart date still needs a strong title — duration alone is not enough', () => {
  const items = [{ id: 'a', title: 'Honor Widows', durationSeconds: 2000, date: '2025-04-23T00:00:00Z' }];
  const episodes = [
    { guid: 'g', title: 'Andy Naselli - Something Entirely Different', durationSeconds: 2000, date: '2023-01-01T10:00:00Z' },
  ];
  const { matches } = matchEpisodes(items, episodes, { speakers: SPEAKERS });
  assert.equal(matches.length, 0, 'coincidental equal duration must not pair unrelated sermons');
});

/* ---------------------------------------------------------------- *
 * Speaker name variants
 * ---------------------------------------------------------------- */

test('findSpeaker tolerates first-name variants and returns the CMS spelling', () => {
  const names = ['Clint Manley', 'Tom Dodds', 'Andy Naselli'];
  assert.equal(findSpeaker('Clinton Manley', names), 'Clint Manley');
  assert.equal(findSpeaker('Thomas Dodds', names), 'Tom Dodds');
  assert.equal(findSpeaker('Andy Naselli', names), 'Andy Naselli');
});

test('findSpeaker refuses unrelated names that share a surname', () => {
  const names = ['John Piper', 'Barnabas Piper'];
  assert.equal(findSpeaker('James Piper', names), null, 'different first name, no prefix');
  assert.equal(findSpeaker('Piper', names), null, 'surname alone is ambiguous');
});

test('the Clinton/Clint variant flows through to the podcast title split', () => {
  const { speaker, title } = splitPodcastTitle('Clinton Manley - Be on the Beauty Hunt', [
    'Clint Manley',
    'Andy Naselli',
  ]);
  assert.equal(speaker, 'Clint Manley', 'returns the name as spelled in the collection');
  assert.equal(title, 'Be on the Beauty Hunt');
});

test('appleEpisodeUrl keeps the episode id — the path id is only the show', () => {
  const raw =
    'https://podcasts.apple.com/us/podcast/nathan-colestock-from-confusion/id1792025763?i=1000123456789&uo=4';
  // Dropping `i` leaves a URL that still *looks* episode-specific but lands on
  // the show's front page. That was the bug.
  assert.equal(
    appleEpisodeUrl(raw),
    'https://podcasts.apple.com/us/podcast/nathan-colestock-from-confusion/id1792025763?i=1000123456789'
  );
});

test('appleEpisodeUrl drops Apple analytics params but survives odd input', () => {
  assert.equal(
    appleEpisodeUrl('https://podcasts.apple.com/us/podcast/x/id1?uo=4'),
    'https://podcasts.apple.com/us/podcast/x/id1'
  );
  assert.equal(appleEpisodeUrl(''), null);
  assert.equal(appleEpisodeUrl(null), null);
  assert.equal(appleEpisodeUrl('not a url'), null);
});

test('parseAppleEpisodes carries the episode id through', () => {
  const parsed = parseAppleEpisodes({
    results: [
      {
        wrapperType: 'podcastEpisode',
        episodeGuid: 'g1',
        trackName: 'A Sermon',
        releaseDate: '2026-08-12T00:00:00Z',
        trackTimeMillis: 1_800_000,
        trackViewUrl: 'https://podcasts.apple.com/us/podcast/a-sermon/id1792025763?i=1000999888777&uo=4',
        episodeUrl: 'https://cdn.example.com/a.mp3',
      },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.match(parsed[0].appleUrl, /\?i=1000999888777$/);
});
