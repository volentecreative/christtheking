#!/usr/bin/env node
/**
 * Christ the King — the whole pipeline, one command, run locally.
 *
 * Three scripts already do the work. This runs them in the order that gets the
 * most into Webflow for the least time spent against YouTube, and reports what
 * each one did.
 *
 *   1. sync-youtube.js       — everything YouTube will hand over
 *   2. import-transcripts.js — local .vtt files for the transcripts it wouldn't
 *   3. sync-podcast.js       — audio and platform links from the podcast feeds
 *   4. reconcile-speakers.js — speaker-text, from whatever speaker-s ended up as
 *
 * THE ORDER IS THE POINT. import-transcripts marks an item synced, which is
 * correct on its own — it stops sync-youtube re-fetching a video it cannot
 * fetch — but it also means sync-youtube will skip that item entirely. Run the
 * import first and you get transcripts and permanently lose descriptions.
 * Run the sync first and it takes everything YouTube offers, transcripts
 * included; the import is then a mop-up for the ones that failed. Same files,
 * same commands, strictly more data.
 *
 * Run this from a machine YouTube will talk to — a Mac on a residential IP, not
 * a cloud runner. That is the entire reason this command exists: on GitHub
 * Actions steps 1 and 2 are degraded by the bot check, and here they are not.
 *
 * Usage:
 *   node sync-all.js --captions ~/ctk-captions --dry-run   # preview everything
 *   node sync-all.js --captions ~/ctk-captions             # do it
 *   node sync-all.js                                       # no local captions
 *   node sync-all.js --captions ~/caps --skip-podcast
 *
 * --dry-run, --verbose and --force pass through to every step. Anything else
 * after `--` goes to sync-youtube.js alone, e.g.
 *   node sync-all.js -- --max-work 25 --concurrency 2
 *
 * Exit codes: 0 = every step clean, 1 = a step reported a real failure,
 * 2 = a step hit a config or setup problem (later steps are then skipped).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    captions: null,
    dryRun: false,
    force: false,
    verbose: false,
    podcast: true,
    youtubeArgs: [],
  };

  const passThrough = argv.indexOf('--');
  const own = passThrough === -1 ? argv : argv.slice(0, passThrough);
  if (passThrough !== -1) options.youtubeArgs = argv.slice(passThrough + 1);

  for (let i = 0; i < own.length; i++) {
    switch (own[i]) {
      case '--captions': case '-c': options.captions = own[++i]; break;
      case '--dry-run': options.dryRun = true; break;
      case '--force': options.force = true; break;
      case '--verbose': case '-v': options.verbose = true; break;
      case '--skip-podcast': options.podcast = false; break;
      case '--help': case '-h': options.help = true; break;
      default:
        console.error(`\nFATAL: Unknown flag: ${own[i]}\nRun with --help for usage.\n`);
        process.exit(2);
    }
  }

  return options;
}

/** Run one step, streaming its output straight through. Resolves to its code. */
function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(HERE, script), ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code === null ? 1 : code));
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    const header = (await import('node:fs')).readFileSync(fileURLToPath(import.meta.url), 'utf8');
    console.log(
      header
        .split('*/')[0]
        .split('\n')
        .filter((line) => !line.startsWith('#!') && !line.startsWith('/**'))
        .map((line) => line.replace(/^\s*\* ?/, ''))
        .join('\n')
        .trim()
    );
    return 0;
  }

  // Flags every step understands the same way.
  const shared = [
    ...(options.dryRun ? ['--dry-run'] : []),
    ...(options.force ? ['--force'] : []),
    ...(options.verbose ? ['--verbose'] : []),
  ];

  const steps = [
    { name: 'YouTube → Webflow', script: 'sync-youtube.js', args: [...shared, ...options.youtubeArgs] },
  ];

  if (options.captions) {
    if (!existsSync(options.captions)) {
      console.error(`\nFATAL: No such captions directory: ${options.captions}\n`);
      return 2;
    }
    steps.push({
      name: 'Local captions → transcripts',
      script: 'import-transcripts.js',
      args: ['--dir', options.captions, ...shared],
    });
  }

  if (options.podcast) {
    steps.push({ name: 'Podcast → Webflow', script: 'sync-podcast.js', args: [...shared] });
  }

  // Last on purpose: the steps above can fill a blank speaker-s, and this
  // reflects whatever they settled on. --force means nothing to it; it always
  // reconciles, because a derived field that can drift is worthless.
  steps.push({
    name: 'Reconcile speaker text',
    script: 'reconcile-speakers.js',
    args: shared.filter((a) => a !== '--force'),
  });

  const results = [];

  for (const step of steps) {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`  ${step.name}   (${step.script})`);
    console.log('='.repeat(72));

    const code = await run(step.script, step.args);
    results.push({ ...step, code });

    // Exit 2 is a config or setup problem — a missing token, an unreadable
    // collection. Every later step would hit exactly the same wall, so stop
    // rather than print the same failure three times.
    if (code === 2) {
      console.error(`\n${step.name} could not start. Skipping the remaining step(s).\n`);
      break;
    }
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`  Pipeline summary${options.dryRun ? ' (dry run)' : ''}`);
  console.log('='.repeat(72));

  for (const result of results) {
    const verdict =
      result.code === 0 ? 'clean' : result.code === 2 ? 'could not start' : 'finished with failures';
    console.log(`  ${result.code === 0 ? '✓' : '✗'} ${result.name} — ${verdict}`);
  }
  for (const step of steps.slice(results.length)) {
    console.log(`  · ${step.name} — skipped`);
  }
  console.log('');

  if (results.some((r) => r.code === 2)) return 2;
  return results.some((r) => r.code !== 0) ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`\nFATAL: ${error.stack || error.message}\n`);
    process.exit(2);
  });
