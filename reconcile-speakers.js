#!/usr/bin/env node
/**
 * Christ the King — reconcile `speaker-text` against `speaker-s`.
 *
 * `speaker-s` is a MultiReference. Webflow cannot bind one to a text element,
 * and the media card is a component whose root is a link, so it can host
 * neither the binding nor the nested Collection List a multi-reference needs.
 * `speaker-text` is that rendering, precomputed, and the card binds to it.
 *
 * WHY THIS IS ITS OWN SCRIPT. The derivation also runs inside sync-youtube and
 * sync-podcast, but both only reach it for items they decided to process, and
 * sync-youtube's gate is needsWork() — "does this item need a YouTube
 * re-fetch?". Every already-synced item answers no, so the field never got
 * written for the existing library. Backfilling a derived field has nothing to
 * do with YouTube. This pass walks EVERY item instead.
 *
 * It touches no YouTube endpoint — two Webflow list calls and a patch per item
 * that drifted — so unlike sync-youtube it is safe on a cloud runner, and fast.
 *
 * Run it LAST in a pipeline: the other syncs may fill a blank `speaker-s`, and
 * this reflects whatever they settled on.
 *
 * Usage:
 *   node reconcile-speakers.js --dry-run     # report drift, write nothing
 *   node reconcile-speakers.js               # fix it
 *   node reconcile-speakers.js --verbose
 *
 * Exit codes: 0 = clean, 1 = one or more writes failed, 2 = config problem.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { speakerText } from './lib/parse.js';
import { WebflowClient } from './lib/webflow.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  mediaCollectionId: '6a5701458bc1d1a8814d8a51',
  speakersCollectionId: '6a5fa8a8b477fb672729b2e1',
};

const log = {
  step: (m) => console.log(m),
  warn: (m) => console.warn(`! ${m}`),
  error: (m) => console.error(`x ${m}`),
};

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { dryRun: false, verbose: false };
  for (const arg of argv) {
    switch (arg) {
      case '--dry-run': case '-n': options.dryRun = true; break;
      case '--verbose': case '-v': options.verbose = true; break;
      case '--help': case '-h':
        console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default:
        if (arg.startsWith('-')) fail(`Unknown flag: ${arg}\nRun with --help for usage.`);
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
    speakersCollectionId:
      process.env.CTK_SPEAKERS_COLLECTION_ID || collections.speakers || DEFAULTS.speakersCollectionId,
  };
}

/**
 * Decide what to write, from the two collections alone. Pure, so the decision
 * can be tested without a network: main() only walks the result.
 *
 * `orphans` are items pointing at a Speaker record that no longer exists. Their
 * text would silently come back short, so they are reported rather than
 * quietly written.
 */
export function planReconcile(mediaItems, speakers) {
  const known = new Set(speakers.map((s) => s.id));
  const plan = { writes: [], alreadyCurrent: 0, noSpeaker: 0, orphans: [] };

  for (const item of mediaItems) {
    const data = item.fieldData || {};
    const title = data.name || item.id;
    const ids = Array.isArray(data['speaker-s']) ? data['speaker-s'] : [];
    const want = speakerText(ids, speakers);
    const have = data['speaker-text'] || '';

    if (ids.some((id) => !known.has(id))) plan.orphans.push(title);
    if (!ids.length) plan.noSpeaker++;

    if (want === have) {
      plan.alreadyCurrent++;
      continue;
    }
    plan.writes.push({ id: item.id, title, from: have, to: want });
  }
  return plan;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const config = loadConfig();
  const webflow = new WebflowClient(config.token);

  let mediaItems, speakerItems;
  try {
    [mediaItems, speakerItems] = await Promise.all([
      webflow.listAllItems(config.mediaCollectionId),
      webflow.listAllItems(config.speakersCollectionId),
    ]);
  } catch (error) {
    fail(`Webflow: ${error.message}`);
  }

  const speakers = speakerItems.map((s) => ({ id: s.id, name: s.fieldData.name }));
  log.step(`Webflow: ${mediaItems.length} media items, ${speakers.length} speakers`);

  const plan = planReconcile(mediaItems, speakers);
  const summary = { written: 0, failed: [] };

  if (options.verbose) {
    for (const w of plan.writes) {
      log.step(`~ ${w.title}: ${JSON.stringify(w.from)} -> ${JSON.stringify(w.to)}`);
    }
  }

  for (const w of plan.writes) {
    if (options.dryRun) {
      if (!options.verbose) log.step(`~ ${w.title} -> ${JSON.stringify(w.to)}`);
      summary.written++;
      continue;
    }
    try {
      await webflow.updateLiveItem(config.mediaCollectionId, w.id, { 'speaker-text': w.to });
      summary.written++;
    } catch (error) {
      summary.failed.push({ title: w.title, error: error.message });
      log.error(`${w.title}: ${error.message}`);
    }
  }

  log.step('');
  const cleared = plan.writes.filter((w) => !w.to).length;
  log.step(
    `${options.dryRun ? 'Would write' : 'Wrote'} ${summary.written}, ` +
      `${plan.alreadyCurrent} already current, ` +
      `${plan.noSpeaker} with no speaker assigned` +
      (cleared ? `, ${cleared} cleared` : '')
  );

  if (plan.orphans.length) {
    log.warn(
      `${plan.orphans.length} item(s) reference a Speaker record that no longer ` +
        'exists — their text is missing that name:'
    );
    for (const title of plan.orphans) log.warn(`  ${title}`);
  }

  if (summary.failed.length) {
    log.error(`${summary.failed.length} write(s) failed`);
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
