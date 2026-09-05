/**
 * Thin wrapper around the yt-dlp binary.
 *
 * yt-dlp is used for BOTH listing and captions so the sync needs no Google API
 * key and no OAuth dance — the same approach the original CTK import used.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pickVttFile } from './parse.js';

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

function run(args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', (error) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(
          new Error(
            'yt-dlp not found. Install it with `brew install yt-dlp`, or set YTDLP_PATH ' +
              'to its full path.'
          )
        );
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`yt-dlp exited ${code}: ${stderr.trim().split('\n').slice(-4).join(' | ')}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** Shared flags: cookies let the script keep working if YouTube starts gating. */
function baseArgs() {
  const args = [
    '--ignore-config',
    '--no-warnings',
    '--no-progress',
    // We never download media, so don't make yt-dlp parse the DASH/HLS format
    // manifests. Pure waste on every call.
    '--extractor-args',
    'youtube:skip=dash,hls',
  ];
  if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
    args.push('--cookies-from-browser', process.env.YTDLP_COOKIES_FROM_BROWSER);
  }
  if (process.env.YTDLP_COOKIES_FILE) {
    args.push('--cookies', process.env.YTDLP_COOKIES_FILE);
  }
  // Pace the HTTP requests yt-dlp makes per video. Costs a few seconds each but
  // makes a long run less likely to trip YouTube's escalating throttling.
  const sleep = process.env.YTDLP_SLEEP_REQUESTS ?? '1';
  if (Number(sleep) > 0) args.push('--sleep-requests', String(sleep));
  return args;
}

export async function ytdlpVersion() {
  const { stdout } = await run([...baseArgs(), '--version'], { timeoutMs: 30_000 });
  return stdout.trim();
}

/**
 * List the channel's uploads (newest first), metadata only — one cheap call.
 * This is the call that keeps working when YouTube is bot-gating the per-video
 * player endpoint, so what it returns is all a blocked run has to go on.
 *
 * Returns { channelId, videos: [{ id, title, duration, live_status }] }.
 *
 * A flat entry can also carry a `timestamp`, and it is deliberately dropped:
 * YouTube gives the channel tab a relative "3 weeks ago", so any date derived
 * from it is an approximation. `date` is fill-only in Webflow, so an approximate
 * value written once would never be corrected. lib/feed.js has the exact one.
 */
export async function listChannelVideos(channelUrl, { limit } = {}) {
  const url = /\/(videos|streams|playlist)/.test(channelUrl)
    ? channelUrl
    : `${channelUrl.replace(/\/+$/, '')}/videos`;

  const args = [...baseArgs(), '--flat-playlist', '--dump-single-json'];
  if (limit) args.push('--playlist-end', String(limit));
  args.push(url);

  const { stdout } = await run(args, { timeoutMs: 300_000 });
  const payload = JSON.parse(stdout);
  const entries = Array.isArray(payload.entries) ? payload.entries : [];

  // The Atom feed only accepts a UC… id, so match that shape explicitly rather
  // than trusting whichever of these fields yt-dlp filled — on a handle URL
  // `uploader_id` is "@ChristIsKingOfStillwater", which the feed rejects.
  const channelId =
    [payload.channel_id, payload.uploader_id, payload.id].find(
      (value) => typeof value === 'string' && /^UC[\w-]{22}$/.test(value)
    ) || null;

  return {
    channelId,
    videos: entries
      .filter((entry) => entry && entry.id)
      .map((entry) => ({
        id: entry.id,
        title: entry.title || '',
        duration: entry.duration || 0,
        live_status: entry.live_status || null,
      })),
  };
}

/**
 * yt-dlp prints `[info] Writing ...` lines to stdout alongside the JSON when
 * it's actually writing files, so we can't just JSON.parse the whole stream.
 */
function extractJson(stdout) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to a line scan.
  }
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && parsed.id) return parsed;
    } catch {
      // keep scanning
    }
  }
  throw new Error('yt-dlp did not return parseable video JSON');
}

/** Full metadata for a single video. */
export async function fetchVideoInfo(videoId) {
  const args = [
    ...baseArgs(),
    '--dump-single-json',
    '--skip-download',
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  const { stdout } = await run(args);
  return extractJson(stdout);
}

/** Read the best .vtt in a directory — same preference the local importer uses. */
function readBestVtt(dir) {
  const best = pickVttFile(readdirSync(dir));
  return best ? readFileSync(join(dir, best), 'utf8') : null;
}

function hasEnglishCaptions(info) {
  const tracks = { ...(info.subtitles || {}), ...(info.automatic_captions || {}) };
  return Object.keys(tracks).some((lang) => /^en/i.test(lang));
}

/**
 * Metadata AND captions in a SINGLE yt-dlp invocation.
 *
 * Two things make this fast, and both were learned the hard way:
 *   1. `--print-json` rather than `--no-simulate --dump-single-json`. The
 *      latter triggers full format resolution + n-signature deciphering.
 *   2. `youtube:skip=dash,hls` (in baseArgs) skips the format manifests.
 * Neither matters for metadata + captions, and together they were the
 * difference between ~40s and ~10s per video.
 */
export async function fetchVideoBundle(videoId, { captions = true } = {}) {
  const startedAt = Date.now();

  if (!captions) {
    const info = await fetchVideoInfo(videoId);
    return { info, vtt: null, usedFallback: false, ms: Date.now() - startedAt };
  }

  const dir = mkdtempSync(join(tmpdir(), `ctk-vtt-${videoId}-`));
  try {
    const args = [
      ...baseArgs(),
      '--skip-download',
      // NOT `--no-simulate --dump-single-json`. That pair tells yt-dlp a real
      // download is coming, so it resolves every format and runs YouTube's
      // player JS to decipher the n-signature — ~30s of CPU we never use.
      // `--print-json` prints the same metadata without implying simulate, so
      // the subtitle files still get written. Measured: ~40s → ~10s per video.
      '--print-json',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      'en.*,en',
      '--sub-format',
      'vtt/best',
      '--convert-subs',
      'vtt',
      '-o',
      join(dir, '%(id)s.%(ext)s'),
      `https://www.youtube.com/watch?v=${videoId}`,
    ];

    const { stdout } = await run(args, { timeoutMs: 240_000 });
    const info = extractJson(stdout);
    let vtt = readBestVtt(dir);

    // Safety net: if a yt-dlp build ignores --no-simulate under -J, fall back
    // to the dedicated caption call rather than silently losing the transcript.
    // This costs a SECOND yt-dlp launch, so the sync reports how often it fires.
    let usedFallback = false;
    if (!vtt && hasEnglishCaptions(info)) {
      usedFallback = true;
      vtt = await fetchCaptionsVtt(videoId);
    }

    return { info, vtt, usedFallback, ms: Date.now() - startedAt };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Download the English caption track (manual preferred, auto-generated as
 * fallback) and return the raw VTT, or null when the video has no captions.
 */
export async function fetchCaptionsVtt(videoId) {
  const dir = mkdtempSync(join(tmpdir(), `ctk-vtt-${videoId}-`));
  try {
    const args = [
      ...baseArgs(),
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      'en.*,en',
      '--sub-format',
      'vtt/best',
      '--convert-subs',
      'vtt',
      '-o',
      join(dir, '%(id)s.%(ext)s'),
      `https://www.youtube.com/watch?v=${videoId}`,
    ];
    await run(args);
    return readBestVtt(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
