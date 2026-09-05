#!/usr/bin/env node
/**
 * Christ the King — local .vtt captions → Webflow transcripts.
 *
 * The companion to sync-youtube.js for the one field a blocked runner can never
 * supply. YouTube bot-gates shared cloud IPs, so transcripts have to come from a
 * machine it trusts; this takes the .vtt files yt-dlp already wrote on that
 * machine and pushes them into the Media collection.
 *
 * It never talks to YouTube at all — no yt-dlp, no network beyond Webflow — so
 * it cannot be throttled or gated, and it runs in seconds rather than minutes.
 *
 * Files are matched to items by VIDEO ID, read out of the filename and checked
 * against the ids already in Webflow, so whatever -o template yt-dlp was given
 * will do. Titles are never matched on: they drift between YouTube and the CMS,
 * and a transcript on the wrong sermon is worse than no transcript.
 *
 * Usage:
 *   node import-transcripts.js --dir ~/ctk-captions --dry-run
 *   node import-transcripts.js --dir ~/ctk-captions
 *   node import-transcripts.js --dir ~/ctk-captions --force     # replace existing
 *   node import-transcripts.js --dir ~/ctk-captions --strict    # unmatched files fail
 *
 * Getting the files in the first place, from a machine YouTube will talk to:
 *   yt-dlp --skip-download --write-subs --write-auto-subs --sub-langs 'en.*,en' \
 *          --convert-subs vtt -o '%(title)s [%(id)s].%(ext)s' \
 *          https://www.youtube.com/@ChristIsKingOfStillwater/videos
 *
 * An item that already has a transcript is left alone unless --force: the
 * worship guides and hand corrections outrank a re-import, same rule the rest of
 * the pipeline follows.
 *
 * Exit codes: 0 = clean, 1 = a Webflow write failed, 2 = config/setup problem.
 * Files that match nothing are reported, not fatal — pass --strict to change that.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cuesToRichText, parseVtt, pickVttFile, videoIdsInFilename } from './lib/parse.js';
import { WebflowClient } from './lib/webflow.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  mediaCollectionId: '6a5701458bc1d1a8814d8a51',
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
  const options = { dir: null, dryRun: false, force: false, strict: false, verbose: false };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dir': case '-d': options.dir = argv[++i]; break;
      case '--dry-run': options.dryRun = true; break;
      case '--force': options.force = true; break;
      case '--strict': options.strict = true; break;
      case '--verbose': case '-v': options.verbose = true; break;
      case '--help': case '-h': options.help = true; break;
      default:
        if (argv[i].startsWith('-')) fail(`Unknown flag: ${argv[i]}\nRun with --help for usage.`);
        else if (!options.dir) options.dir = argv[i];
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

  const collections = file.collections || {};
  return {
    token,
    mediaCollectionId:
      process.env.CTK_MEDIA_COLLECTION_ID || collections.media || DEFAULTS.mediaCollectionId,
  };
}

/** Every .vtt under a directory. Recursive, because yt-dlp may have nested them. */
function findVttFiles(root) {
  const found = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue; // a broken symlink shouldn't sink the scan
      }
      if (stats.isDirectory()) walk(path);
      else if (entry.toLowerCase().endsWith('.vtt')) found.push(path);
    }
  };

  walk(root);
  return found.sort();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
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

  if (!options.dir) fail('Which directory? Pass --dir /path/to/captions.');
  if (!existsSync(options.dir)) fail(`No such directory: ${options.dir}`);

  const config = loadConfig();
  const startedAt = Date.now();
  const now = new Date().toISOString();

  log.info(`\nCTK transcript import — ${new Date().toLocaleString()}`);
  log.info(`Captions: ${options.dir}`);
  if (options.dryRun) log.info('DRY RUN — nothing will be written to Webflow.\n');

  const files = findVttFiles(options.dir);
  if (!files.length) fail(`No .vtt files under ${options.dir}.`);
  log.step(`${files.length} .vtt file(s) found`);

  const webflow = new WebflowClient(config.token);

  let items;
  try {
    items = await webflow.listAllItems(config.mediaCollectionId);
  } catch (error) {
    fail(`Could not read the Webflow Media collection: ${error.message}`);
  }

  const byVideoId = new Map();
  for (const item of items) {
    const videoId = item.fieldData['youtube-video-id'];
    if (videoId) byVideoId.set(videoId, item);
  }
  log.step(`Webflow: ${items.length} media items (${byVideoId.size} keyed by video id)`);

  // --- Match files to items ----------------------------------------------
  // Several files can belong to one video (en, en-orig, auto), so group first
  // and let pickVttFile choose — otherwise the last one written would win.
  const knownIds = new Set(byVideoId.keys());
  const grouped = new Map();
  const unmatched = [];
  const ambiguous = [];

  for (const path of files) {
    const ids = videoIdsInFilename(path, knownIds);
    if (ids.length === 0) unmatched.push(path);
    else if (ids.length > 1) ambiguous.push({ path, ids });
    else {
      if (!grouped.has(ids[0])) grouped.set(ids[0], []);
      grouped.get(ids[0]).push(path);
    }
  }

  log.step(`matched ${grouped.size} video(s) from ${files.length - unmatched.length - ambiguous.length} file(s)`);

  // --- Write --------------------------------------------------------------
  const summary = { written: [], alreadyHad: 0, empty: [], failed: [] };
  log.info('');

  for (const [videoId, paths] of grouped) {
    const item = byVideoId.get(videoId);
    const name = item.fieldData.name || videoId;

    if (String(item.fieldData.transcript || '').trim() && !options.force) {
      summary.alreadyHad++;
      if (options.verbose) log.step(`= ${name} (already has a transcript)`);
      continue;
    }

    const chosen = pickVttFile(paths);
    let html;
    try {
      html = cuesToRichText(parseVtt(readFileSync(chosen, 'utf8')));
    } catch (error) {
      summary.failed.push({ videoId, name, error: `could not read ${chosen}: ${error.message}` });
      log.error(`${name}: could not read ${chosen}: ${error.message}`);
      continue;
    }

    if (!html) {
      // A .vtt with no cues is a header and nothing else — writing it would
      // mark the item done and hide the fact that the transcript is missing.
      summary.empty.push({ videoId, name, file: chosen });
      log.warn(`${name}: ${chosen.split('/').pop()} has no cues — skipped`);
      continue;
    }

    try {
      if (!options.dryRun) {
        const patch = { transcript: html, 'last-synced': now };
        if (item.isDraft) {
          await webflow.updateDraftItem(config.mediaCollectionId, item.id, patch);
        } else {
          await webflow.updateLiveItem(config.mediaCollectionId, item.id, patch);
        }
      }
      // Paragraphs, not bytes: it is the number a transcript is judged by, and
      // a suspiciously short one is the tell that the wrong .vtt was picked.
      const paragraphs = html.split('</p>').length - 1;
      summary.written.push({ videoId, name, paragraphs });
      log.step(
        `+ ${name} → transcript (${paragraphs} paragraph${paragraphs === 1 ? '' : 's'})` +
          `${paths.length > 1 && options.verbose ? ` [chose ${chosen.split('/').pop()} of ${paths.length}]` : ''}`
      );
    } catch (error) {
      summary.failed.push({ videoId, name, error: error.message });
      log.error(`${name}: ${error.message}`);
    }
  }

  // --- Summary ------------------------------------------------------------
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  log.info(
    `\nDone in ${elapsed}s — ${summary.written.length} transcript(s) written, ` +
      `${summary.alreadyHad} already had one, ${summary.empty.length} empty, ` +
      `${summary.failed.length} failed${options.dryRun ? ' (dry run)' : ''}\n`
  );

  if (unmatched.length) {
    log.info(`${unmatched.length} file(s) matched no video in Webflow:`);
    for (const path of unmatched.slice(0, 10)) log.info(`  ${path.split('/').pop()}`);
    if (unmatched.length > 10) log.info(`  …and ${unmatched.length - 10} more`);
    log.info(
      '\nEither the video is not in the Media collection yet — run sync-youtube.js\n' +
        'first — or the id is not in the filename. Re-download with\n' +
        "  -o '%(title)s [%(id)s].%(ext)s'\n"
    );
  }

  if (ambiguous.length) {
    log.info(`${ambiguous.length} file(s) named more than one known video, so were skipped:`);
    for (const entry of ambiguous.slice(0, 10)) {
      log.info(`  ${entry.path.split('/').pop()} — ${entry.ids.join(', ')}`);
    }
  }

  if (summary.written.length) {
    log.info(
      'Imported items are marked synced, so sync-youtube.js will stop re-fetching\n' +
        'them. Descriptions were not touched; `npm run sync -- --force` from a\n' +
        'machine YouTube talks to still refreshes those.\n'
    );
  }

  if (options.strict && (unmatched.length || ambiguous.length)) {
    log.warn('--strict: unmatched or ambiguous files present, exiting non-zero');
    return 1;
  }
  return summary.failed.length ? 1 : 0;
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
