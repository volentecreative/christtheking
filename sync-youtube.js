#!/usr/bin/env node
/**
 * Christ the King — YouTube → Webflow sermon sync.
 *
 * Pulls uploads from the CTK channel via yt-dlp and syncs them into the Media
 * collection, keyed on `youtube-video-id`. New videos are created live; videos
 * already in Webflow only have their EMPTY fields filled in, so anything you or
 * the church edits by hand survives every re-run.
 *
 * Runs in two phases: YouTube fetching happens concurrently (it's nearly all
 * network latency), then Webflow writes happen one at a time in channel order
 * so the API rate limit is respected and the log stays readable.
 *
 * Usage:
 *   node sync-youtube.js                 # sync everything new
 *   node sync-youtube.js --dry-run       # show what would change, write nothing
 *   node sync-youtube.js --limit 5       # only look at the 5 newest uploads
 *   node sync-youtube.js --video ID      # sync one specific video
 *   node sync-youtube.js --since 2026-01-01
 *   node sync-youtube.js --force          # refresh YouTube-owned fields on existing items
 *   node sync-youtube.js --no-transcripts
 *   node sync-youtube.js --draft          # create new items as drafts instead of live
 *   node sync-youtube.js --concurrency 2  # parallel YouTube fetches (default 3)
 *   node sync-youtube.js --max-work 30    # fetch at most 30 videos this run
 *   node sync-youtube.js --no-partial     # don't create items YouTube wouldn't describe
 *   node sync-youtube.js --strict         # exit non-zero if any video is left unsynced
 *
 * Backfilling a large backlog? Use your logged-in session, or YouTube will
 * throttle you into timeouts:  export YTDLP_COOKIES_FROM_BROWSER=chrome
 *
 * When YouTube refuses to describe a video — a bot check on the IP, or a
 * throttle — three sources that don't need the blocked endpoint still do most
 * of the work: the channel listing (title, duration, and what those imply), the
 * channel's Atom feed (upload date) and the i.ytimg.com CDN (thumbnail). A video
 * missing from Webflow is created from them; one already there has its BLANKS
 * filled, never its hand-corrected fields. Only description and transcript truly
 * need the full fetch. See buildPlaceholderFieldData in lib/parse.js,
 * lib/feed.js and lib/thumbnail.js.
 *
 * Exit codes: 0 = clean, 1 = a Webflow write failed, 2 = fatal config error.
 * A video YouTube would not hand over is deferred work, not a failed run.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { mapWithConcurrency } from './lib/concurrency.js';
import {
  buildFieldData,
  buildPlaceholderFieldData,
  buildUpdatePatch,
  cuesToRichText,
  needsWork,
  parseIgnoreList,
  parseVtt,
  slugify,
  uniqueSlug,
} from './lib/parse.js';
import { fetchChannelFeed } from './lib/feed.js';
import { resolveThumbnailUrl } from './lib/thumbnail.js';
import { WebflowClient } from './lib/webflow.js';
import { fetchVideoBundle, listChannelVideos, ytdlpVersion } from './lib/ytdlp.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  channelUrl: 'https://www.youtube.com/@ChristIsKingOfStillwater',
  siteId: '69cff397cad92519d2e17d7a',
  mediaCollectionId: '6a5701458bc1d1a8814d8a51',
  speakersCollectionId: '6a5fa8a8b477fb672729b2e1',
  seriesCollectionId: '6a570145407c0c49ad9ab080',
  sermonMinSeconds: 900, // 15 min — below this a video is filed as an Exhortation
  // 3, not 5. YouTube escalates throttling on sustained runs — a 146-video pass
  // at concurrency 5 degraded from 44s to 240s+ per video and then failed 79 in
  // a row. Lower and slower finishes; faster and greedier gets choked.
  concurrency: 3,
  // Stop the fetch phase after this many consecutive failures rather than
  // burning hours against a throttle that isn't going to lift mid-run.
  failureLimit: 5,
};

/* ------------------------------------------------------------------ *
 * Config + CLI
 * ------------------------------------------------------------------ */

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
  if (!token) {
    fail(
      'No Webflow API token.\n' +
        '  Either set WEBFLOW_API_TOKEN in the environment (use this for GitHub Actions),\n' +
        '  or copy credentials.example.json to credentials.json and paste the token there.\n' +
        '  Get one at: Webflow → CTK site → Settings → Apps & integrations → API access.'
    );
  }

  let ignored = new Set();
  const ignorePath = process.env.CTK_IGNORE_LIST || join(HERE, 'ignored-videos.json');
  if (existsSync(ignorePath)) {
    try {
      ignored = parseIgnoreList(JSON.parse(readFileSync(ignorePath, 'utf8')));
    } catch (error) {
      fail(`Could not parse ${ignorePath}: ${error.message}`);
    }
  }

  const collections = file.collections || {};
  return {
    token,
    ignored,
    channelUrl: process.env.CTK_CHANNEL_URL || file.channelUrl || DEFAULTS.channelUrl,
    siteId: process.env.CTK_SITE_ID || file.siteId || DEFAULTS.siteId,
    mediaCollectionId:
      process.env.CTK_MEDIA_COLLECTION_ID || collections.media || DEFAULTS.mediaCollectionId,
    speakersCollectionId:
      process.env.CTK_SPEAKERS_COLLECTION_ID || collections.speakers || DEFAULTS.speakersCollectionId,
    seriesCollectionId:
      process.env.CTK_SERIES_COLLECTION_ID || collections.series || DEFAULTS.seriesCollectionId,
    sermonMinSeconds: Number(
      process.env.CTK_SERMON_MIN_SECONDS || file.sermonMinSeconds || DEFAULTS.sermonMinSeconds
    ),
    concurrency: Number(
      process.env.CTK_CONCURRENCY || file.concurrency || DEFAULTS.concurrency
    ),
    // Was missing from this object, so `config.failureLimit` read undefined and
    // `consecutiveFailures >= undefined` was false forever — the circuit breaker
    // below could never trip, which is exactly the run it exists to cut short.
    failureLimit: Number(
      process.env.CTK_FAILURE_LIMIT || file.failureLimit || DEFAULTS.failureLimit
    ),
  };
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    force: false,
    transcripts: true,
    draft: false,
    limit: null,
    since: null,
    video: null,
    concurrency: null,
    maxWork: null,
    partial: true,
    strict: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run': options.dryRun = true; break;
      case '--force': options.force = true; break;
      case '--no-transcripts': options.transcripts = false; break;
      case '--no-partial': options.partial = false; break;
      case '--strict': options.strict = true; break;
      case '--draft': options.draft = true; break;
      case '--verbose': case '-v': options.verbose = true; break;
      case '--limit': options.limit = Number(argv[++i]); break;
      case '--concurrency': options.concurrency = Number(argv[++i]); break;
      case '--max-work': options.maxWork = Number(argv[++i]); break;
      case '--since': options.since = new Date(argv[++i]); break;
      case '--video': options.video = argv[++i]; break;
      case '--help': case '-h': options.help = true; break;
      default:
        if (arg.startsWith('-')) fail(`Unknown flag: ${arg}\nRun with --help for usage.`);
    }
  }

  if (options.limit !== null && !Number.isFinite(options.limit)) fail('--limit needs a number.');
  if (options.concurrency !== null && !(options.concurrency >= 1)) {
    fail('--concurrency needs a number of 1 or more.');
  }
  if (options.maxWork !== null && !(options.maxWork >= 1)) {
    fail('--max-work needs a number of 1 or more.');
  }
  if (options.since && Number.isNaN(options.since.getTime())) {
    fail('--since needs a date, e.g. 2026-01-01.');
  }

  return options;
}

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */

const log = {
  info: (message) => console.log(message),
  step: (message) => console.log(`  ${message}`),
  warn: (message) => console.warn(`  ! ${message}`),
  error: (message) => console.error(`  ✗ ${message}`),
};

function fail(message) {
  console.error(`\nFATAL: ${message}\n`);
  process.exit(2);
}

/**
 * yt-dlp writes its errors for a human at a terminal: the bot-check message is
 * five lines of wiki links, and the timeout message carries the whole command.
 * Repeated 9 or 79 times they bury the run, so the two we actually see get one
 * line each.
 */
function describeFetchError(message) {
  if (/Sign in to confirm/i.test(message)) {
    return 'YouTube demanded a sign-in — bot check on this IP';
  }
  const timeout = /timed out after (\d+)ms/.exec(message);
  if (timeout) {
    return `timed out after ${Math.round(Number(timeout[1]) / 1000)}s (YouTube throttling)`;
  }
  return message;
}

function uploadedBefore(info, cutoff) {
  const epoch = info.release_timestamp || info.timestamp;
  const uploaded = epoch
    ? new Date(epoch * 1000)
    : info.upload_date
      ? new Date(
          `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6, 8)}`
        )
      : null;
  return uploaded ? uploaded < cutoff : false;
}

/* ------------------------------------------------------------------ *
 * Sync
 * ------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    // Print the header comment as plain text: no shebang, no comment markers.
    const header = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0];
    console.log(
      header
        .split('\n')
        .filter((line) => !line.startsWith('#!') && !line.startsWith('/**'))
        .map((line) => line.replace(/^\s*\* ?/, ''))
        .join('\n')
        .trim()
    );
    return 0;
  }

  const config = loadConfig();
  const concurrency = options.concurrency || config.concurrency;
  const startedAt = new Date();
  const now = startedAt.toISOString();

  log.info(`\nCTK sermon sync — ${startedAt.toLocaleString()}`);
  log.info(`Channel: ${config.channelUrl}`);
  if (options.dryRun) log.info('DRY RUN — nothing will be written to Webflow.\n');

  try {
    log.step(`yt-dlp ${await ytdlpVersion()}`);
  } catch (error) {
    fail(error.message);
  }

  const webflow = new WebflowClient(config.token);

  // --- Existing Webflow state -------------------------------------------
  let existingItems, speakerItems, seriesItems;
  try {
    [existingItems, speakerItems, seriesItems] = await Promise.all([
      webflow.listAllItems(config.mediaCollectionId),
      webflow.listAllItems(config.speakersCollectionId),
      webflow.listAllItems(config.seriesCollectionId),
    ]);
  } catch (error) {
    fail(`Could not read the Webflow collections: ${error.message}`);
  }

  const speakers = speakerItems.map((item) => ({ id: item.id, name: item.fieldData.name }));
  const series = seriesItems.map((item) => ({ id: item.id, name: item.fieldData.name }));

  const byVideoId = new Map();
  const takenSlugs = new Set();
  for (const item of existingItems) {
    const videoId = item.fieldData['youtube-video-id'];
    if (videoId) byVideoId.set(videoId, item);
    if (item.fieldData.slug) takenSlugs.add(item.fieldData.slug);
  }

  log.step(
    `Webflow: ${existingItems.length} media items (${byVideoId.size} keyed by video id), ` +
      `${speakers.length} speakers, ${series.length} series`
  );

  // --- Candidate videos --------------------------------------------------
  let candidates;
  let channelId = null;
  if (options.video) {
    // No listing data for a one-off id: title and duration are unknown, not
    // empty, so this candidate can never stand in for a fetch that fails.
    candidates = [
      { id: options.video, title: '', duration: 0, live_status: null, fromListing: false },
    ];
  } else {
    try {
      const listing = await listChannelVideos(config.channelUrl, { limit: options.limit });
      candidates = listing.videos;
      channelId = listing.channelId;
    } catch (error) {
      fail(`Could not list the channel: ${error.message}`);
    }
    for (const candidate of candidates) candidate.fromListing = true;
    log.step(`YouTube: ${candidates.length} uploads on the channel`);
  }

  const skippedLive = candidates.filter((v) =>
    ['is_upcoming', 'is_live'].includes(v.live_status)
  ).length;
  if (skippedLive) log.step(`Skipping ${skippedLive} live/upcoming video(s)`);

  let queue = candidates.filter((v) => !['is_upcoming', 'is_live'].includes(v.live_status));

  if (config.ignored.size) {
    const before = queue.length;
    queue = queue.filter((v) => !config.ignored.has(v.id));
    const skipped = before - queue.length;
    if (skipped) log.step(`Skipping ${skipped} video(s) on the ignore list`);
  }

  // --- Phase 1: fetch from YouTube, concurrently -------------------------
  // This is ~95% of the wall clock and it's nearly all network latency, so
  // running several at once is close to a linear speedup.
  const toFetch = [];
  let alreadyComplete = 0;

  for (const candidate of queue) {
    const existing = byVideoId.get(candidate.id);
    if (existing && !options.force && !needsWork(existing, options)) {
      alreadyComplete++;
      if (options.verbose) log.step(`= ${existing.fieldData.name} (up to date)`);
      continue;
    }
    toFetch.push({ candidate, existing });
  }

  if (alreadyComplete) log.step(`${alreadyComplete} item(s) already complete — not re-fetching`);

  // Videos missing from Webflow entirely come first. Otherwise a --max-work
  // budget gets eaten by transcript top-ups on the newest items while the
  // genuinely absent ones wait at the back of the channel-order queue.
  toFetch.sort((a, b) => (a.existing ? 1 : 0) - (b.existing ? 1 : 0));

  const missingCount = toFetch.filter((job) => !job.existing).length;
  if (toFetch.length) {
    log.step(
      `${missingCount} video(s) not in Webflow yet, ` +
        `${toFetch.length - missingCount} existing item(s) with gaps to fill`
    );
  }

  // Chunked backfill: do N per session so a long backlog is spread across runs
  // instead of provoking escalating throttling in one sitting.
  let deferred = 0;
  if (options.maxWork && toFetch.length > options.maxWork) {
    deferred = toFetch.length - options.maxWork;
    toFetch.length = options.maxWork;
    log.step(`--max-work ${options.maxWork}: deferring ${deferred} video(s) to a later run`);
  }

  let fetched = 0;
  let fallbacks = 0;
  const timings = [];
  const fetchStartedAt = Date.now();

  log.info(
    `\nFetching ${toFetch.length} video(s) from YouTube, ${concurrency} at a time` +
      `${options.transcripts ? ' (with captions)' : ' (metadata only)'}…`
  );

  let consecutiveFailures = 0;
  let circuitOpen = false;
  const failureLimit = config.failureLimit;

  const fetchResults = await mapWithConcurrency(toFetch, concurrency, async (job) => {
    if (circuitOpen) {
      const skip = new Error('not attempted — run stopped after repeated failures');
      skip.circuitSkipped = true;
      throw skip;
    }

    const needsTranscript =
      options.transcripts &&
      (!job.existing || options.force || !String(job.existing.fieldData.transcript || '').trim());

    let bundle;
    try {
      bundle = await fetchVideoBundle(job.candidate.id, { captions: needsTranscript });
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures++;
      if (consecutiveFailures >= failureLimit && !circuitOpen) {
        circuitOpen = true;
        log.warn(
          `${failureLimit} failures in a row — stopping the fetch phase. ` +
            `Everything fetched so far will still be written to Webflow.`
        );
      }
      throw error;
    }

    const { info, vtt, usedFallback, ms } = bundle;
    timings.push(ms);
    if (usedFallback) fallbacks++;

    fetched++;
    if (options.verbose) {
      log.step(
        `fetched ${fetched}/${toFetch.length} — ${Math.round(ms / 1000)}s` +
          `${usedFallback ? ' FALLBACK(2nd call)' : ''} — ${info.title || job.candidate.id}`
      );
    } else if (fetched % 20 === 0 || fetched === toFetch.length) {
      log.step(`fetched ${fetched}/${toFetch.length}`);
    }

    return { ...job, info, transcriptHtml: vtt ? cuesToRichText(parseVtt(vtt)) : '' };
  });

  const fetchSeconds = Math.round((Date.now() - fetchStartedAt) / 1000);
  const sorted = [...timings].sort((a, b) => a - b);
  const median = sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] / 1000) : 0;
  const slowest = sorted.length ? Math.round(sorted[sorted.length - 1] / 1000) : 0;

  log.step(
    `fetch phase took ${fetchSeconds}s — median ${median}s per video, slowest ${slowest}s, ` +
      `${concurrency} at a time`
  );

  // If this is non-zero, --no-simulate isn't writing subtitles on this yt-dlp
  // build and every one of these videos cost two launches instead of one.
  if (fallbacks) {
    log.warn(
      `${fallbacks}/${timings.length} videos needed a second yt-dlp call for captions — ` +
        `that roughly doubles the fetch cost. Try \`yt-dlp -U\`.`
    );
  }

  // --- Phase 2: write to Webflow, serially -------------------------------
  const summary = {
    created: [],
    partial: 0,
    partialDated: 0,
    partialFilled: 0,
    updated: [],
    unchanged: alreadyComplete,
    skipped: 0,
    // Two different things, kept apart because only one of them is a broken run:
    // YouTube declining to describe a video is deferred work, a Webflow write
    // that errored is a real failure. See the exit code at the bottom.
    fetchFailed: [],
    writeFailed: [],
    notAttempted: 0,
  };

  /**
   * Create a brand-new Media item. Shared by the full-metadata path and the
   * partial path so slug de-duplication and empty-field pruning can't drift.
   */
  async function createItem(desired, { partial = false, transcriptHtml = '' } = {}) {
    const slug = uniqueSlug(slugify(desired.name), takenSlugs);
    takenSlugs.add(slug);

    const fieldData = { ...desired, slug };
    for (const key of Object.keys(fieldData)) {
      const value = fieldData[key];
      if (value === null || value === '' || (Array.isArray(value) && !value.length)) {
        delete fieldData[key];
      }
    }
    fieldData.name = desired.name;
    fieldData.slug = slug;

    if (!options.dryRun) {
      if (options.draft) {
        await webflow.createDraftItem(config.mediaCollectionId, fieldData);
      } else {
        await webflow.createLiveItem(config.mediaCollectionId, fieldData);
      }
    }

    summary.created.push({
      title: desired.name,
      type: desired.type,
      scripture: desired['scripture-raw'],
      transcript: Boolean(transcriptHtml),
      partial,
    });
    log.step(
      `+ ${desired.name} [${desired.type}]` +
        `${desired['scripture-raw'] ? ` · ${desired['scripture-raw']}` : ''}` +
        `${transcriptHtml ? ' · transcript' : ''}` +
        `${partial ? ` · PARTIAL${desired.date ? '' : ' — no date'}` : ''}`
    );
  }

  async function writeUpdate(existing, patch) {
    if (options.dryRun) return;
    if (existing.isDraft) {
      await webflow.updateDraftItem(config.mediaCollectionId, existing.id, patch);
    } else {
      await webflow.updateLiveItem(config.mediaCollectionId, existing.id, patch);
    }
  }

  // Everything the partial path can act on this run: a video YouTube refused to
  // describe, that the channel listing did describe. Both the ones missing from
  // Webflow (created below) and the ones already there with blanks (filled in).
  const partialJobs =
    options.partial && !options.since
      ? fetchResults
          .map((result, i) => (result.error && toFetch[i].candidate.fromListing ? toFetch[i] : null))
          .filter(Boolean)
      : [];

  // Neither of these needs the endpoint YouTube blocks. The Atom feed is plain
  // XML on another path; thumbnails are fixed URLs on an image CDN. Read only
  // when the partial path can use them, and never fatal — a missing value just
  // leaves a blank field, which the next full fetch fills.
  let feed = new Map();
  const thumbnails = new Map();

  if (partialJobs.length) {
    try {
      feed = await fetchChannelFeed(channelId);
      log.step(`channel feed: ${feed.size} recent video(s)`);
    } catch (error) {
      log.warn(`channel feed unreadable, partial items lose their date: ${error.message}`);
    }

    const probed = await mapWithConcurrency(partialJobs, 5, (job) =>
      resolveThumbnailUrl(job.candidate.id)
    );
    probed.forEach((result, i) => {
      const id = partialJobs[i].candidate.id;
      const url = result.value || (feed.get(id) || {}).thumbnail || null;
      if (url) thumbnails.set(id, url);
    });
    log.step(`thumbnails: resolved ${thumbnails.size}/${partialJobs.length}`);
  }

  const partialFieldData = (candidate) =>
    buildPlaceholderFieldData(
      {
        ...candidate,
        publishedAt: (feed.get(candidate.id) || {}).publishedAt || null,
        thumbnailUrl: thumbnails.get(candidate.id) || null,
      },
      { speakers, series, sermonMinSeconds: config.sermonMinSeconds, now }
    );

  log.info('');

  for (let i = 0; i < fetchResults.length; i++) {
    const result = fetchResults[i];
    const job = toFetch[i];

    if (result.error) {
      if (result.error.circuitSkipped) {
        summary.notAttempted++;
      } else {
        summary.fetchFailed.push({
          id: job.candidate.id,
          title: job.candidate.title,
          error: result.error.message,
        });
        log.error(
          `${job.candidate.title || job.candidate.id}: ${describeFetchError(result.error.message)}`
        );
      }

      // YouTube wouldn't describe this video, but plenty is still knowable
      // without it: the channel listing has the title and duration, the Atom
      // feed has the upload date, and the image CDN has the thumbnail. So a
      // video missing from Webflow is created, and one already there has its
      // BLANKS filled — buildUpdatePatch only ever writes into empty fields, so
      // a title, date or speaker corrected by hand is never touched.
      //
      // Two cases can't take this path: --video (no listing data, so no title or
      // duration) and --since (the cutoff is a date, and a date is exactly what
      // is missing here).
      if (!partialJobs.includes(job)) continue;

      try {
        const desired = partialFieldData(job.candidate);

        if (job.existing) {
          const { patch, changed, changedFields } = buildUpdatePatch(
            desired,
            job.existing.fieldData,
            { speakers }
          );
          // The item is still not fully synced — description and transcript need
          // the fetch that just failed. Leaving `last-synced` off keeps
          // needsWork() returning true, so the next run tries again.
          delete patch['last-synced'];
          if (!changed) continue;

          await writeUpdate(job.existing, patch);
          summary.updated.push({ title: job.existing.fieldData.name, fields: changedFields });
          summary.partialFilled++;
          log.step(
            `~ ${job.existing.fieldData.name || desired.name} → ${changedFields.join(', ')} (partial)`
          );
        } else {
          await createItem(desired, { partial: true });
          summary.partial++;
          if (desired.date) summary.partialDated++;
        }
      } catch (error) {
        summary.writeFailed.push({
          id: job.candidate.id,
          title: job.candidate.title,
          error: error.message,
        });
        log.error(`${job.candidate.title || job.candidate.id}: ${error.message}`);
      }
      continue;
    }

    const { candidate, existing, info, transcriptHtml } = result.value;

    try {
      if (options.since && uploadedBefore(info, options.since)) {
        summary.skipped++;
        continue;
      }

      if (options.transcripts && !transcriptHtml && (!existing || !existing.fieldData.transcript)) {
        log.warn(`${info.title}: no captions available yet`);
      }

      const desired = buildFieldData(info, {
        transcriptHtml,
        speakers,
        series,
        sermonMinSeconds: config.sermonMinSeconds,
        now,
      });

      if (existing) {
        const { patch, changed, changedFields } = buildUpdatePatch(desired, existing.fieldData, {
          force: options.force,
          speakers,
        });

        if (!changed) {
          summary.unchanged++;
          if (options.verbose) log.step(`= ${existing.fieldData.name || desired.name} (up to date)`);
          continue;
        }

        await writeUpdate(existing, patch);

        // Log the name as it stands in Webflow, not the YouTube title — otherwise a
        // hand-corrected (or mis-imported) item looks like it's being renamed.
        const shownName = existing.fieldData.name || desired.name;
        const renamed =
          existing.fieldData.name && existing.fieldData.name !== desired.name
            ? `  [YouTube: "${desired.name}"]`
            : '';

        summary.updated.push({ title: shownName, fields: changedFields });
        log.step(`~ ${shownName} → ${changedFields.join(', ')}${options.verbose ? renamed : ''}`);
      } else {
        await createItem(desired, { transcriptHtml });
      }
    } catch (error) {
      summary.writeFailed.push({ id: candidate.id, title: info.title, error: error.message });
      log.error(`${info.title || candidate.id}: ${error.message}`);
    }
  }

  // --- Summary -----------------------------------------------------------
  const elapsed = Math.round((Date.now() - startedAt.getTime()) / 1000);
  log.info(
    `\nDone in ${elapsed}s — ${summary.created.length} created` +
      `${summary.partial ? ` (${summary.partial} partial)` : ''}, ` +
      `${summary.updated.length} updated, ${summary.unchanged} unchanged, ` +
      `${summary.skipped} skipped, ${summary.writeFailed.length} failed` +
      `${options.dryRun ? ' (dry run)' : ''}\n`
  );

  // Videos YouTube would not describe. Not failures — work for the next run.
  const unfetched = summary.fetchFailed.length + summary.notAttempted;
  const remaining = unfetched + deferred;

  if (summary.notAttempted) {
    log.info(`${summary.notAttempted} video(s) not attempted — the run stopped early.`);
  }
  if (deferred) {
    log.info(`${deferred} video(s) deferred by --max-work.`);
  }

  if (summary.writeFailed.length) {
    log.info(`\n${summary.writeFailed.length} Webflow write(s) failed:`);
    for (const failure of summary.writeFailed.slice(0, 10)) {
      log.info(`  https://www.youtube.com/watch?v=${failure.id} — ${failure.error}`);
    }
    if (summary.writeFailed.length > 10) {
      log.info(`  …and ${summary.writeFailed.length - 10} more`);
    }
  }

  if (summary.fetchFailed.length) {
    const botGated = summary.fetchFailed.filter((f) => /Sign in to confirm/i.test(f.error)).length;
    const throttled = summary.fetchFailed.filter((f) => /timed out/.test(f.error)).length;

    log.info(`\n${summary.fetchFailed.length} video(s) YouTube would not describe:`);
    for (const failure of summary.fetchFailed.slice(0, 10)) {
      log.info(
        `  https://www.youtube.com/watch?v=${failure.id} — ${describeFetchError(failure.error)}`
      );
    }
    if (summary.fetchFailed.length > 10) {
      log.info(`  …and ${summary.fetchFailed.length - 10} more`);
    }

    if (summary.partial || summary.partialFilled) {
      const lines = [];

      if (summary.partial) {
        lines.push(
          `${summary.partial} of them were still created from the channel listing — title,`,
          `duration and type — of which ${summary.partialDated} carry their real upload date from the`,
          'channel feed.'
        );
      }
      if (summary.partialFilled) {
        lines.push(
          `${summary.partialFilled} item(s) already in Webflow had blanks filled from the same`,
          'sources. Only empty fields were written, so anything corrected by hand is',
          'untouched.'
        );
      }
      lines.push(
        'Description and transcript still need the fetch that failed, and because',
        'these items carry no `last-synced`, the next run that gets through fills',
        'them in — no --force needed.'
      );

      log.info(`\n${lines.join('\n')}\n`);
    }

    if (botGated > 3) {
      log.info(
        'Most of these are bot checks, not throttling: YouTube gates the IP this\n' +
          'ran from. Cloud runners (GitHub Actions included) are gated as a matter of\n' +
          'course, and waiting does not clear it. To fetch the full metadata:\n' +
          '  1. Run from a residential IP — a Mac, or a self-hosted runner on one.\n' +
          '  2. Use your logged-in session there:  export YTDLP_COOKIES_FROM_BROWSER=chrome\n'
      );
    } else if (throttled > 3) {
      log.info(
        'Most of these are timeouts, which means YouTube throttled this run.\n' +
          'Nothing is lost — re-running picks up exactly what is missing. To get\n' +
          'through the rest:\n' +
          '  1. Wait a few hours. The throttling decays.\n' +
          '  2. Use your logged-in session — authenticated requests are throttled far\n' +
          '     less:  export YTDLP_COOKIES_FROM_BROWSER=chrome\n' +
          '  3. Go in chunks:  node sync-youtube.js --max-work 25 --concurrency 2\n'
      );
    }
  }

  if (remaining) {
    log.info(`${remaining} video(s) still to fetch in full. Re-run when ready.\n`);
  }

  // Exit 1 ONLY for a real failure — a Webflow write that errored.
  //
  // A video YouTube declines to hand over is NOT a failure. It bot-gates shared
  // cloud IPs as a matter of course, so treating that as a broken run paints
  // every CI run red — which trains you to ignore the one run that genuinely
  // breaks. Nothing is lost either way: the video is still created from the
  // listing, and the next run that gets through fills in the rest.
  //
  // Pass --strict when you DO want unfetched videos to fail the run.
  if (options.strict && unfetched) {
    log.warn(`--strict: ${unfetched} video(s) were not fetched, exiting non-zero`);
    return 1;
  }
  return summary.writeFailed.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`\nFATAL: ${error.stack || error.message}\n`);
      process.exit(2);
    });
}

export { main };
