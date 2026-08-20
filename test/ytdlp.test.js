/**
 * Offline test of the yt-dlp wrapper using a stub binary.
 *
 * YouTube isn't reachable from CI, but the parts most likely to break are
 * local anyway: pulling the JSON out of stdout when yt-dlp interleaves
 * "[info] Writing ..." lines with it, and finding the .vtt it wrote.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STUB = `#!/bin/bash
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) echo "9999.99.99"; exit 0 ;;
    -o) OUT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -n "$OUT" ]; then
  DIR=$(dirname "$OUT")
  mkdir -p "$DIR"
  printf 'WEBVTT\\n\\n00:00:00.000 --> 00:00:02.000\\nHello there.\\n' > "$DIR/TESTID.en.vtt"
  # yt-dlp prints these to stdout, mixed in with the JSON
  echo "[info] TESTID: Downloading subtitles: en"
  echo "[info] Writing video subtitles to: $DIR/TESTID.en.vtt"
fi

echo '{"id":"TESTID","title":"Stub Video","duration":1800,"timestamp":1783619659,"description":"A stub.","thumbnail":"https://example.test/t.jpg","automatic_captions":{"en":[{"ext":"vtt"}]}}'
`;

let dir;
let ytdlp;

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ctk-stub-'));
  const path = join(dir, 'yt-dlp-stub');
  writeFileSync(path, STUB);
  chmodSync(path, 0o755);
  process.env.YTDLP_PATH = path;
  ytdlp = await import('../lib/ytdlp.js');
});

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('fetchVideoBundle returns metadata and captions from ONE invocation', async () => {
  const { info, vtt } = await ytdlp.fetchVideoBundle('TESTID');

  assert.equal(info.id, 'TESTID', 'JSON survives the interleaved [info] lines on stdout');
  assert.equal(info.title, 'Stub Video');
  assert.equal(info.duration, 1800);
  assert.ok(vtt.includes('Hello there.'), 'the written .vtt is picked up');
});

test('fetchVideoBundle can skip captions entirely', async () => {
  const { info, vtt } = await ytdlp.fetchVideoBundle('TESTID', { captions: false });
  assert.equal(info.id, 'TESTID');
  assert.equal(vtt, null);
});

test('fetchVideoInfo still works on its own', async () => {
  const info = await ytdlp.fetchVideoInfo('TESTID');
  assert.equal(info.id, 'TESTID');
});

test('a missing binary produces an actionable message', async () => {
  process.env.YTDLP_PATH = '/definitely/not/here/yt-dlp';
  const fresh = await import('../lib/ytdlp.js?missing=1');
  await assert.rejects(() => fresh.ytdlpVersion(), /yt-dlp not found.*brew install yt-dlp/s);
});
