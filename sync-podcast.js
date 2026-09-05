#!/usr/bin/env node
/**
 * Christ the King — Podcast → Webflow sync.
 *
 * Matches the CTK podcast (Apple Podcasts / Subsplash / Spotify) to the Webflow
 * Media collection and fills in the audio + platform links, plus the speaker.
 *
 * Matching is on DURATION first, not title: the podcast audio and the YouTube
 * video differ by exactly 1 second, which is close to a unique fingerprint.
 * Titles disagree between the two systems and podcast dates snap to Sunday, so
 * both are corroboration only. Anything the rules can't decide is reported as
 * ambiguous rather than guessed.
 *
 * Apple needs no key at all. Spotify per-episode links need a free developer
 * app; without one, everything else still syncs.
 *
 * Usage:
 *   node sync-podcast.js --dry-run     # match and report, write nothing
 *   node sync-podcast.js               # write matched fields
 *   node sync-podcast.js --report out.csv
 *   node sync-podcast.js --no-speakers # skip the speaker backfill
 *   node sync-podcast.js --force       # overwrite existing podcast fields
 *
 * Exit codes: 0 = clean, 1 = some items unmatched, 2 = config/setup problem.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { matchEpisodes, parseAppleEpisodes, parseSpotifyEpisodes } from './lib/podcast.js';
import { WebflowClient } from './lib/webflow.js';
import { speakerNames } from './lib/parse.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  applePodcastId: '1792025763', // Christ the King Church in Stillwater
  spotifyShowId: '5sM8yqesuQFR6xzEytsF3M',
  mediaCollectionId: '6a5701458bc1d1a8814d8a51',
  speakersCollectionId: '6a5fa8a8b477fb672729b2e1',
};

const log = {
  info: (m) => console.log(m),
  step: (m) => console.log(`  ${m}`),
  warn: (m) => console.warn(`  ! ${m}`),
  error: (m) => console.error(`  ✗ ${m}`),
};

function fail(message) {
  console.error(`\nFATAL: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { dryRun: false, force: false, speakers: true, report: null, verbose: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run': options.dryRun = true; break;
      case '--force': options.force = true; break;
      case '--no-speakers': options.speakers = false; break;
      case '--report': options.report = argv[++i]; break;
      case '--verbose': case '-v': options.verbose = true; break;
      case '--strict': options.strict = true; break;
      case '--help': case '-h': options.help = true; break;
      default:
        if (argv[i].startsWith('-')) fail(`Unknown flag: ${argv[i]}`);
    }
  }
  return options;
}

function loadConfig() {
  let file = {};
  const path = process.env.CTK_CREDENTIALS || join(HERE, 'credentials.json');
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      fail(`Could not parse ${path}: ${error.message}`);
    }
  }

  const token = process.env.WEBFLOW_API_TOKEN || process.env.WEBFLOW_TOKEN || file.webflowToken;
  if (!token) fail('No Webflow API token. See the README.');

  const podcast = file.podcast || {};
  const collections = file.collections || {};

  return {
    token,
    applePodcastId: podcast.applePodcastId || DEFAULTS.applePodcastId,
    spotifyShowId: podcast.spotifyShowId || DEFAULTS.spotifyShowId,
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID || podcast.spotifyClientId || null,
    spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || podcast.spotifyClientSecret || null,
    mediaCollectionId: collections.media || DEFAULTS.mediaCollectionId,
    speakersCollectionId: collections.speakers || DEFAULTS.speakersCollectionId,
  };
}

/* ------------------------------------------------------------------ *
 * Sources
 * ------------------------------------------------------------------ */

async function fetchApple(podcastId) {
  const url =
    `https://itunes.apple.com/lookup?id=${podcastId}` +
    `&entity=podcastEpisode&limit=200&country=US`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Apple lookup failed: HTTP ${response.status}`);
  return parseAppleEpisodes(await response.json());
}

async function fetchSpotify({ clientId, clientSecret, showId }) {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!tokenResponse.ok) {
    throw new Error(`Spotify auth failed: HTTP ${tokenResponse.status} (check client id/secret)`);
  }
  const { access_token: accessToken } = await tokenResponse.json();

  const pages = [];
  let offset = 0;
  for (;;) {
    const url =
      `https://api.spotify.com/v1/shows/${showId}/episodes` +
      `?limit=50&offset=${offset}&market=US`;
    const page = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!page.ok) throw new Error(`Spotify episodes failed: HTTP ${page.status}`);
    const body = await page.json();
    pages.push(body);
    offset += (body.items || []).length;
    if (!body.next || !(body.items || []).length) break;
  }
  return parseSpotifyEpisodes(pages);
}

/* ------------------------------------------------------------------ *
 * Sync
 * ------------------------------------------------------------------ */

const isEmpty = (v) =>
  v === null || v === undefined || (typeof v === 'string' && !v.trim()) ||
  (Array.isArray(v) && !v.length);

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    const header = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0];
    console.log(
      header.split('\n').filter((l) => !l.startsWith('#!') && !l.startsWith('/**'))
        .map((l) => l.replace(/^\s*\* ?/, '')).join('\n').trim()
    );
    return 0;
  }

  const config = loadConfig();
  const startedAt = Date.now();

  log.info(`\nCTK podcast sync — ${new Date().toLocaleString()}`);
  if (options.dryRun) log.info('DRY RUN — nothing will be written to Webflow.\n');

  // --- sources ----------------------------------------------------------
  let appleEpisodes;
  try {
    appleEpisodes = await fetchApple(config.applePodcastId);
    log.step(`Apple: ${appleEpisodes.length} episodes (keyless)`);
  } catch (error) {
    fail(`Could not read the Apple podcast feed: ${error.message}`);
  }

  let spotifyEpisodes = [];
  if (config.spotifyClientId && config.spotifyClientSecret) {
    try {
      spotifyEpisodes = await fetchSpotify({
        clientId: config.spotifyClientId,
        clientSecret: config.spotifyClientSecret,
        showId: config.spotifyShowId,
      });
      log.step(`Spotify: ${spotifyEpisodes.length} episodes`);
    } catch (error) {
      log.warn(`Spotify skipped — ${error.message}`);
    }
  } else {
    log.step('Spotify: no credentials, skipping per-episode links (everything else still syncs)');
  }

  const webflow = new WebflowClient(config.token);
  let mediaItems, speakerItems;
  try {
    [mediaItems, speakerItems] = await Promise.all([
      webflow.listAllItems(config.mediaCollectionId),
      webflow.listAllItems(config.speakersCollectionId),
    ]);
  } catch (error) {
    fail(`Could not read the Webflow collections: ${error.message}`);
  }
  const speakers = speakerItems.map((s) => ({ id: s.id, name: s.fieldData.name }));
  log.step(`Webflow: ${mediaItems.length} media items, ${speakers.length} speakers`);

  // --- match ------------------------------------------------------------
  const items = mediaItems.map((item) => ({
    id: item.id,
    title: item.fieldData.name || '',
    durationSeconds: item.fieldData['duration-seconds'] || null,
    date: item.fieldData.date || null,
    raw: item,
  }));

  const { matches, ambiguous, unmatchedItems, unmatchedEpisodes } = matchEpisodes(
    items,
    appleEpisodes,
    { speakers }
  );

  log.info(
    `\nMatched ${matches.length} of ${items.length} media items ` +
      `(${unmatchedEpisodes.length} episodes with no item, ${ambiguous.length} ambiguous)`
  );

  // Spotify joins on the SAME duration fingerprint, against Apple's episodes.
  const spotifyByGuid = new Map();
  if (spotifyEpisodes.length) {
    const appleAsItems = matches.map((m) => ({
      id: m.ep.guid,
      title: m.ep.cleanTitle,
      durationSeconds: m.ep.durationSeconds,
      date: m.ep.date,
    }));
    const spotifyMatch = matchEpisodes(appleAsItems, spotifyEpisodes, { speakers });
    for (const m of spotifyMatch.matches) spotifyByGuid.set(m.item.id, m.ep.spotifyUrl);
    log.step(`Spotify links resolved for ${spotifyByGuid.size} episodes`);
  }

  const speakerIdByName = new Map(speakers.map((s) => [s.name.toLowerCase(), s.id]));

  // --- write ------------------------------------------------------------
  const summary = { updated: 0, unchanged: 0, speakersFilled: 0, failed: [] };
  const rows = [['webflow_title', 'podcast_title', 'basis', 'dur_delta', 'days', 'speaker', 'action']];

  // Webflow writes are serialized ~1.1s apart to stay under the 60/min limit, so
  // this phase is slow and was previously silent — it looked like a freeze.
  const toWrite = matches.length;
  if (!options.dryRun && toWrite) {
    const eta = Math.ceil((toWrite * 1.1) / 60);
    log.info(`\nWriting to Webflow — up to ${toWrite} item(s), roughly ${eta} min…`);
  }

  let processed = 0;

  for (const match of matches) {
    const data = match.item.raw.fieldData;
    const patch = {};

    const wanted = {
      'distributor-episode-id': match.ep.guid,
      'apple-podcasts-episode-url': match.ep.appleUrl,
      'audio-url': match.ep.audioUrl,
      'spotify-episode-url': spotifyByGuid.get(match.ep.guid) || null,
    };

    for (const [field, value] of Object.entries(wanted)) {
      if (!value) continue;
      const current = data[field];
      // A stored Apple URL with no `i` param is a casualty of the old
      // query-stripping bug — it points at the show, not the episode. Treat it
      // as empty so an ordinary run repairs it without needing --force.
      // Stale Apple URLs come in two shapes: the old query-stripped ones that
      // land on the show page, and the short `/podcast/id<show>?i=<ep>` form,
      // which works but loses the episode slug. Both get upgraded to Apple's
      // canonical URL without needing --force.
      const staleApple =
        field === 'apple-podcasts-episode-url' &&
        current &&
        (!/[?&]i=/.test(String(current)) || /\/podcast\/id\d+\?/.test(String(current)));
      if (isEmpty(current) || staleApple || (options.force && current !== value)) {
        patch[field] = value;
      }
    }

    // Speaker: fill only when blank, never overwrite a human's choice.
    let speakerNote = '';
    if (options.speakers && match.ep.speaker && isEmpty(data['speaker-s'])) {
      const id = speakerIdByName.get(match.ep.speaker.toLowerCase());
      if (id) {
        patch['speaker-s'] = [id];
        // The plain-text mirror takes the CMS record's spelling, not the
        // podcast's — the titles say "Clinton Manley" where the CMS says
        // "Clint Manley", and the site should read the same everywhere.
        patch['speaker-names'] = speakerNames([id], speakers);
        speakerNote = match.ep.speaker;
      } else {
        speakerNote = `MISSING SPEAKER RECORD: ${match.ep.speaker}`;
      }
    }

    // Repair a mirror that is missing or stale — e.g. a speaker assigned by
    // hand in the Designer, which nothing else writes the plain text for.
    if (!patch['speaker-names'] && !isEmpty(data['speaker-s'])) {
      const mirror = speakerNames(data['speaker-s'], speakers);
      if (mirror && mirror !== data['speaker-names']) patch['speaker-names'] = mirror;
    }

    const action = Object.keys(patch).length ? Object.keys(patch).join(' ') : 'up to date';
    rows.push([
      match.item.title, match.ep.title, match.basis,
      match.durationDelta, match.dateDelta.toFixed(1), speakerNote, action,
    ]);

    if (!Object.keys(patch).length) {
      summary.unchanged++;
      continue;
    }

    if (!options.dryRun) {
      try {
        await webflow.updateLiveItem(config.mediaCollectionId, match.item.id, patch);
      } catch (error) {
        summary.failed.push({ title: match.item.title, error: error.message });
        log.error(`${match.item.title}: ${error.message}`);
        continue;
      }
    }
    summary.updated++;
    processed++;
    if (patch['speaker-s']) summary.speakersFilled++;

    if (options.verbose) {
      log.step(`~ ${match.item.title} → ${action}`);
    } else if (!options.dryRun && processed % 20 === 0) {
      log.step(`written ${processed}…`);
    }
  }

  // --- report -----------------------------------------------------------
  for (const item of unmatchedItems) rows.push([item.title, '', 'NO MATCH', '', '', '', 'skipped']);
  for (const ep of unmatchedEpisodes) rows.push(['', ep.title, 'NO WEBFLOW ITEM', '', '', '', 'skipped']);

  if (options.report) {
    writeFileSync(options.report, rows.map((r) => r.map(csvEscape).join(',')).join('\n'));
    log.step(`Report written to ${options.report}`);
  }

  if (unmatchedItems.length) {
    log.info(
      `\n${unmatchedItems.length} media item(s) with no podcast episode ` +
        `(expected for video-only content — not an error):`
    );
    for (const item of unmatchedItems.slice(0, 10)) log.info(`  ${item.title}`);
    if (unmatchedItems.length > 10) log.info(`  …and ${unmatchedItems.length - 10} more`);
  }

  if (ambiguous.length) {
    log.info(`\n${ambiguous.length} ambiguous pairing(s) left alone — check the report.`);
  }

  log.info(
    `\nDone in ${Math.round((Date.now() - startedAt) / 1000)}s — ${summary.updated} updated, ` +
      `${summary.speakersFilled} speakers filled, ${summary.unchanged} already current, ` +
      `${summary.failed.length} failed${options.dryRun ? ' (dry run)' : ''}\n`
  );

  // Exit 1 ONLY for a real failure — a write that errored.
  //
  // Unmatched items are NOT failures. CTK has 7 permanently: video-only content
  // (the Conference promo) and podcast-only episodes with no video. That count
  // is steady state, so treating it as failure made every scheduled run report
  // red — which trains you to ignore the one run that genuinely breaks.
  //
  // Pass --strict when you DO want unmatched or ambiguous pairings to fail.
  if (options.strict && (unmatchedItems.length || ambiguous.length)) {
    log.warn('--strict: unmatched or ambiguous pairings present, exiting non-zero');
    return 1;
  }
  return summary.failed.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`\nFATAL: ${error.stack || error.message}\n`);
    process.exit(2);
  });
}

export { main };
