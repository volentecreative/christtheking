#!/usr/bin/env node
/**
 * Christ the King — local Whisper transcripts for Media items that have none.
 *
 * Every Media item carries its Transistor MP3 (audio-url), so transcripts can
 * come from the podcast audio instead of YouTube: no yt-dlp, no bot checks. This
 * asks Webflow which items still have an empty transcript, downloads each MP3,
 * runs whisper.cpp on this Mac (Metal GPU), and writes one .vtt per item named
 * "<slug> [<videoId>].vtt". import-transcripts.js then pushes those files into
 * Webflow, matched by video id, in the same timestamped format as the rest.
 *
 * Resumable: an item whose .vtt already exists in --out is skipped, so an
 * interrupted overnight run just picks up where it stopped.
 *
 * --groq runs Whisper in the cloud instead (Groq whisper-large-v3-turbo, needs
 * GROQ_API_KEY and ffmpeg) and writes each transcript straight to Webflow, no
 * .vtt files. It only ever fills an EMPTY transcript; the daily GitHub sync
 * runs it with --limit 5.
 *
 * Usage:
 *   node transcribe-missing.js --dry-run            # list what would be transcribed
 *   node transcribe-missing.js                      # transcribe into ~/ctk-transcripts
 *   node transcribe-missing.js --import             # ...then push them to Webflow
 *   node transcribe-missing.js --limit 1            # try one first
 *   node transcribe-missing.js --replace --import   # ALSO redo items that already have a
 *                                                   # transcript (e.g. the YouTube-caption
 *                                                   # backfill) and overwrite them. Every
 *                                                   # existing transcript is saved first to
 *                                                   # --out/transcripts-backup-<time>.json.
 *   node transcribe-missing.js --out DIR --model PATH
 *   node transcribe-missing.js --groq --limit 5      # cloud: Groq → Webflow directly
 *
 * Needs: brew install whisper-cpp ffmpeg, and a ggml model (default
 * ~/.cache/whisper/ggml-large-v3-turbo.bin). Webflow token as for the other
 * scripts (credentials.json or WEBFLOW_API_TOKEN).
 *
 * Exit codes: 0 = clean, 1 = one or more items failed, 2 = config/setup problem.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { GROQ_MAX_BYTES, VOCABULARY, groqTranscribe, segmentsToRichText, trimOutro } from './lib/transcribe.js';
import { WebflowClient } from './lib/webflow.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  mediaCollectionId: '6a5701458bc1d1a8814d8a51',
  out: join(homedir(), 'ctk-transcripts'),
  model: join(homedir(), '.cache', 'whisper', 'ggml-large-v3-turbo.bin'),
};

function fail(message) {
  console.error(`\nFATAL: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const o = { out: DEFAULTS.out, model: DEFAULTS.model, limit: Infinity, dryRun: false, import: false, replace: false, groq: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--out': o.out = argv[++i]; break;
      case '--model': o.model = argv[++i]; break;
      case '--limit': o.limit = Number(argv[++i]); break;
      case '--dry-run': o.dryRun = true; break;
      case '--import': o.import = true; break;
      case '--replace': o.replace = true; break;
      case '--groq': o.groq = true; break;
      case '--help': case '-h': o.help = true; break;
      default: fail(`Unknown flag: ${argv[i]}`);
    }
  }
  return o;
}

function loadToken() {
  const path = process.env.CTK_CREDENTIALS || join(HERE, 'credentials.json');
  let file = {};
  if (existsSync(path)) file = JSON.parse(readFileSync(path, 'utf8'));
  const token = process.env.WEBFLOW_API_TOKEN || process.env.WEBFLOW_TOKEN || file.webflowToken;
  if (!token) fail('No Webflow API token. See the README.');
  return { token, mediaCollectionId: (file.collections || {}).media || DEFAULTS.mediaCollectionId };
}

function have(cmd) {
  return spawnSync('which', [cmd]).status === 0;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}: ${String(r.stderr).trim().split('\n').slice(-3).join(' | ')}`);
}

function safeName(s) {
  return String(s).replace(/[\/\\:*?"<>|]/g, '').slice(0, 120);
}

async function download(url, path) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${res.status}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^.*\n.*\n/, '').replace(/^ \* ?/gm, ''));
    return 0;
  }

  if (o.groq && (o.replace || o.import)) fail('--groq writes to Webflow itself and never replaces; drop --replace/--import.');
  if (!o.dryRun) {
    const tools = o.groq ? ['ffmpeg'] : ['whisper-cli', 'ffmpeg'];
    for (const cmd of tools) if (!have(cmd)) fail(`${cmd} not found. brew install whisper-cpp ffmpeg`);
    if (o.groq && !process.env.GROQ_API_KEY) fail('GROQ_API_KEY is not set.');
    if (!o.groq && !existsSync(o.model)) fail(`No Whisper model at ${o.model}`);
  }
  if (!o.groq) mkdirSync(o.out, { recursive: true });

  const { token, mediaCollectionId } = loadToken();
  const webflow = new WebflowClient(token);
  const items = await webflow.listAllItems(mediaCollectionId);

  const done = new Set(
    o.groq ? [] : readdirSync(o.out).filter((f) => f.endsWith('.vtt')).map((f) => (/\[([\w-]{11})\]\.vtt$/.exec(f) || [])[1])
  );
  const hasTranscript = (i) => !!String(i.fieldData.transcript || '').trim();
  const noAudio = items.filter((i) => (o.replace || !hasTranscript(i)) && !i.fieldData['audio-url']);
  const todo = items
    .filter((i) => o.replace || !hasTranscript(i))
    .filter((i) => i.fieldData['audio-url'] && i.fieldData['youtube-video-id'])
    .filter((i) => !done.has(i.fieldData['youtube-video-id']))
    .sort((a, b) => String(b.fieldData.date).localeCompare(String(a.fieldData.date)))
    .slice(0, o.limit);

  const minutes = Math.round(todo.reduce((s, i) => s + (i.fieldData['duration-seconds'] || 0), 0) / 60);
  console.log(`\n${todo.length} item(s) to transcribe, ~${minutes} min of audio${done.size ? ` (${done.size} already in ${o.out})` : ''}`);
  for (const i of todo) {
    const tag = hasTranscript(i) ? '  (replaces existing)' : '';
    console.log(`  ${String(i.fieldData.date).slice(0, 10)}  ${i.fieldData.name}${tag}`);
  }
  if (noAudio.length) {
    console.log(`\n${noAudio.length} item(s) skipped — no audio-url to transcribe from:`);
    for (const i of noAudio) console.log(`  ${String(i.fieldData.date).slice(0, 10)}  ${i.fieldData.name}`);
  }
  if (o.dryRun || !todo.length) return 0;

  if (o.replace) {
    // Keep every transcript we might overwrite, so a bad run can be undone.
    const backup = items
      .filter(hasTranscript)
      .map((i) => ({ id: i.id, videoId: i.fieldData['youtube-video-id'], name: i.fieldData.name, transcript: i.fieldData.transcript }));
    const path = join(o.out, `transcripts-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(path, JSON.stringify(backup, null, 2));
    console.log(`\nBacked up ${backup.length} existing transcript(s) to ${path}`);
  }

  const work = join(tmpdir(), `ctk-whisper-${process.pid}`);
  mkdirSync(work, { recursive: true });
  let failed = 0;

  if (o.groq) {
    for (const [n, item] of todo.entries()) {
      const f = item.fieldData;
      const mp3 = join(work, 'in.mp3');
      const ogg = join(work, 'in.ogg');
      process.stdout.write(`\n[${n + 1}/${todo.length}] ${f.name} … `);
      try {
        await download(f['audio-url'], mp3);
        // Mono 16 kHz Opus at 24 kbps: ~11 MB an hour, well under Groq's 25 MB cap.
        run('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp3, '-map', '0:a', '-ar', '16000', '-ac', '1', '-c:a', 'libopus', '-b:a', '24k', ogg]);
        const audio = readFileSync(ogg);
        if (audio.length > GROQ_MAX_BYTES) throw new Error(`audio is ${Math.round(audio.length / 1048576)} MB after downsampling, over Groq's 25 MB limit`);
        const html = segmentsToRichText(await groqTranscribe(audio, { apiKey: process.env.GROQ_API_KEY }));
        if (!html) throw new Error('Groq returned no speech');
        const fresh = await webflow.getItem(mediaCollectionId, item.id);
        if (String(fresh.fieldData.transcript || '').trim()) {
          console.log('skipped — a transcript appeared meanwhile');
          continue;
        }
        const patch = { transcript: html };
        if (item.isDraft) await webflow.updateDraftItem(mediaCollectionId, item.id, patch);
        else await webflow.updateLiveItem(mediaCollectionId, item.id, patch);
        console.log(`written (${html.split('</p>').length - 1} paragraphs)`);
      } catch (error) {
        failed++;
        console.log(`FAILED: ${error.message}`);
      } finally {
        rmSync(mp3, { force: true });
        rmSync(ogg, { force: true });
      }
    }
    rmSync(work, { recursive: true, force: true });
    console.log(`\nGroq: ${todo.length - failed}/${todo.length} transcript(s) handled${failed ? ` — ${failed} failed` : ''}`);
    return failed ? 1 : 0;
  }

  for (const [n, item] of todo.entries()) {
    const f = item.fieldData;
    const id = f['youtube-video-id'];
    const base = join(o.out, `${safeName(f.slug || f.name)} [${id}]`);
    const mp3 = join(work, `${id}.mp3`);
    const wav = join(work, `${id}.wav`);
    const started = Date.now();
    process.stdout.write(`\n[${n + 1}/${todo.length}] ${f.name} … `);
    try {
      await download(f['audio-url'], mp3);
      run('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp3, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
      // Write to a temp name first so a half-finished run never looks "done".
      run('whisper-cli', ['-m', o.model, '-f', wav, '-l', 'en', '--prompt', VOCABULARY, '-ovtt', '-of', `${base}.partial`]);
      const vtt = trimOutro(readFileSync(`${base}.partial.vtt`, 'utf8'));
      writeFileSync(`${base}.vtt`, vtt);
      rmSync(`${base}.partial.vtt`);
      console.log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
    } catch (error) {
      failed++;
      console.log(`FAILED: ${error.message}`);
    } finally {
      rmSync(mp3, { force: true });
      rmSync(wav, { force: true });
    }
  }
  rmSync(work, { recursive: true, force: true });

  console.log(`\nTranscribed ${todo.length - failed}/${todo.length} into ${o.out}${failed ? ` — ${failed} failed` : ''}`);

  if (o.import) {
    console.log('\nImporting into Webflow…');
    const args = [join(HERE, 'import-transcripts.js'), '--dir', o.out];
    if (o.replace) args.push('--force');
    const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (r.status !== 0) return 1;
  } else {
    console.log(`Next: node import-transcripts.js --dir ${o.out} --dry-run, then without --dry-run.`);
  }
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => fail(error.stack || error.message));
