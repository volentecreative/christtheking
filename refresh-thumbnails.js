#!/usr/bin/env node
/**
 * Christ the King — move Media thumbnails onto YouTube's WebP files.
 *
 * WHY. Every Media card downloads its item's `thumbnail` as-is: Webflow
 * re-hosts an Image field's URL byte for byte, and Collection List images get
 * no srcset, so a phone fetches the full 1280x720 file for a ~360px card. The
 * sync used to write YouTube's JPEG (~55-95 KB, ~110 KB once re-hosted). The
 * same frame is served as WebP from /vi_webp/ at roughly 40% of the bytes, and
 * sync-youtube now writes that for new items (lib/thumbnail.js). This pass
 * brings the existing library across.
 *
 * WHAT IT TOUCHES. Only the `thumbnail` field, only on items that have a
 * `youtube-video-id`, and only when the current file isn't already WebP (the
 * re-hosted URL keeps the source file name, so `…_maxresdefault.webp` is how
 * a converted item is recognised). Re-running it is a no-op for those. An item
 * whose WebP YouTube won't serve is left exactly as it is. A thumbnail set by
 * hand to a non-YouTube image is NOT protected - pass --video to limit the
 * run if that ever matters.
 *
 * It touches no YouTube endpoint other than the image CDN (HEAD probes), so it
 * is safe on a cloud runner.
 *
 * Usage:
 *   node refresh-thumbnails.js --dry-run     # list what would change
 *   node refresh-thumbnails.js               # convert
 *   node refresh-thumbnails.js --video <id>  # one video only
 *
 * Exit codes: 0 = clean, 1 = one or more writes failed, 2 = config problem.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { mapWithConcurrency } from './lib/concurrency.js';
import { QUALITIES, thumbnailUrl } from './lib/thumbnail.js';
import { WebflowClient } from './lib/webflow.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = { mediaCollectionId: '6a5701458bc1d1a8814d8a51' };

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { dryRun: false, video: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run': case '-n': options.dryRun = true; break;
      case '--video': options.video = argv[++i]; break;
      case '--help': case '-h':
        console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default:
        fail(`Unknown flag: ${argv[i]}\nRun with --help for usage.`);
    }
  }
  return options;
}

function loadConfig() {
  let file = {};
  const path = process.env.CTK_CREDENTIALS || join(HERE, 'credentials.json');
  try {
    file = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    /* env-only is fine */
  }
  const token = process.env.WEBFLOW_API_TOKEN || process.env.WEBFLOW_TOKEN || file.webflowToken;
  if (!token) fail('No Webflow token. Set WEBFLOW_API_TOKEN or put webflowToken in credentials.json.');
  const collections = file.collections || {};
  return {
    token,
    mediaCollectionId:
      process.env.CTK_MEDIA_COLLECTION_ID || collections.media || DEFAULTS.mediaCollectionId,
  };
}

/** True when the item's current thumbnail is already a WebP file. */
export function isWebpThumbnail(fieldData) {
  const url = fieldData && fieldData.thumbnail && fieldData.thumbnail.url;
  return typeof url === 'string' && /\.webp(?:$|\?)/i.test(url);
}

/** Best WebP thumbnail YouTube serves for a video, or null. Never throws. */
export async function resolveWebp(videoId, { timeoutMs = 10_000 } = {}) {
  for (const quality of QUALITIES) {
    const url = thumbnailUrl(videoId, quality, 'webp');
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return url;
    } catch {
      // try the next quality
    }
  }
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const webflow = new WebflowClient(config.token);

  const items = await webflow.listAllItems(config.mediaCollectionId);
  const todo = items.filter(
    (item) =>
      item.fieldData['youtube-video-id'] &&
      !isWebpThumbnail(item.fieldData) &&
      (!options.video || item.fieldData['youtube-video-id'] === options.video)
  );
  console.log(`Media: ${items.length} items, ${todo.length} without a WebP thumbnail`);

  const resolved = await mapWithConcurrency(todo, 5, (item) =>
    resolveWebp(item.fieldData['youtube-video-id'])
  );

  let converted = 0;
  let skipped = 0;
  const failed = [];
  for (let i = 0; i < todo.length; i++) {
    const item = todo[i];
    const url = resolved[i].value;
    const name = item.fieldData.name || item.fieldData['youtube-video-id'];
    if (!url) {
      skipped++;
      console.log(`  - ${name}: no WebP on YouTube, left as is`);
      continue;
    }
    if (options.dryRun) {
      console.log(`  ~ ${name} → ${url}`);
      converted++;
      continue;
    }
    try {
      const patch = { thumbnail: url };
      if (item.isDraft) await webflow.updateDraftItem(config.mediaCollectionId, item.id, patch);
      else await webflow.updateLiveItem(config.mediaCollectionId, item.id, patch);
      converted++;
      console.log(`  ~ ${name}`);
    } catch (error) {
      failed.push(name);
      console.error(`  x ${name}: ${error.message}`);
    }
  }

  console.log(
    `\nDone — ${converted} ${options.dryRun ? 'would convert' : 'converted'}, ` +
      `${skipped} left as is, ${failed.length} failed${options.dryRun ? ' (dry run)' : ''}`
  );
  process.exit(failed.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(`FATAL: ${error.message}`));
}
