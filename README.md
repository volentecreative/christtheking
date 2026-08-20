# CTK — YouTube → Webflow sermon sync

Pulls uploads from [@ChristIsKingOfStillwater](https://www.youtube.com/@ChristIsKingOfStillwater)
and syncs them into the Christ the King Webflow **Media** collection.

No Google API key and no OAuth: `yt-dlp` handles listing, metadata, and captions.
(The `client_secret_*.json` sitting in this folder is left over from the first
attempt at this — nothing here reads it. Safe to delete.)

---

## Setup (one time)

**1. Requirements**

```bash
node --version      # needs 18+
yt-dlp --version    # brew install yt-dlp
```

No `npm install` — the script has zero dependencies.

**2. Webflow token**

Webflow → CTK site → **Settings → Apps & integrations → API access** → generate a
Site API token with **CMS read + write**. Then:

```bash
cp credentials.example.json credentials.json
# paste the token into credentials.json
```

`credentials.json` is gitignored. For CI, set `WEBFLOW_API_TOKEN` instead — env
vars always beat the file.

**3. First run — look before you leap**

```bash
node sync-youtube.js --dry-run
```

This prints exactly what it would create and change, and writes nothing.

---

## Usage

```bash
node sync-youtube.js                  # sync everything new
node sync-youtube.js --dry-run        # preview only
node sync-youtube.js --limit 5        # only the 5 newest uploads
node sync-youtube.js --video lQXc-tgNQ5A
node sync-youtube.js --since 2026-01-01
node sync-youtube.js --no-transcripts # metadata only, much faster
node sync-youtube.js --draft          # create as drafts instead of publishing live
node sync-youtube.js --force          # refresh YouTube-owned fields on existing items
node sync-youtube.js --concurrency 2   # parallel YouTube fetches (default 3)
node sync-youtube.js --max-work 25    # fetch at most 25 videos this run
node sync-youtube.js --verbose
```

Exit codes: `0` clean · `1` one or more videos failed · `2` config/setup problem.

---

## What it writes

`youtube-video-id` is the sync key — that's how a video is matched to an existing
item, so **don't edit that field in the Designer.**

| Webflow field | Source |
|---|---|
| `name` | video title |
| `slug` | slugified title, de-duplicated |
| `youtube-video-id` | video id — the sync key |
| `video-url` | `https://www.youtube.com/watch?v=…` |
| `thumbnail` | highest-resolution YouTube thumbnail |
| `date` | actual upload/premiere timestamp |
| `duration-seconds` | video length |
| `type` | `Sermon` ≥ 15 min, `Exhortation` below — **first sync only** |
| `description` | video description, as rich text |
| `transcript` | captions as `<p><a href="#t=…">m:ss</a> …</p>` |
| `scripture-raw` | first reference found in the title, else description |
| `speaker-s` | matched against the Speakers collection |
| `series` | matched against existing Media Series |
| `last-synced` | timestamp of the run |

New items are **created live** (published immediately).

### The rule that protects your work

On a re-run, an existing item only gets its **empty** fields filled in. Anything
with a value already — a title you fixed, a description you rewrote, a speaker
you assigned — is left alone.

Three fields have stricter rules:

- **`type`** is written only when the item is created, and never again — not even
  by `--force`. Reclassify an exhortation by hand and it stays reclassified.
- **`speaker-s`** and **`series`** are filled when the Webflow field is *empty*,
  and never overwritten — not even by `--force`. This is what makes the workflow
  work: add a missing speaker to the Speakers collection, re-run, and the items
  that had no match get backfilled, while anything you assigned by hand is safe.

`--force` refreshes the YouTube-owned fields (title, description, thumbnail,
date, duration, transcript) only.

**Note:** the log line for an updated item shows the name as it exists in
Webflow, not the YouTube title. If you renamed something in the Designer, the
sync keeps your name — run with `--verbose` to see the YouTube title alongside it.

### Sermon vs. Exhortation

The 900-second cutoff was calibrated against the 25 items already in the
collection: exhortations run 157–338s, sermons 1417–3458s. The gap is wide, so
the split is unambiguous — but it's still a guess about length, not content.
Change `sermonMinSeconds` in `credentials.json` if that ever drifts, and fix
individual mistakes in the Designer — the sync won't overwrite you.

---

## Transcripts

Captions come from `yt-dlp`, preferring a human-uploaded English track and
falling back to YouTube's auto-generated one. Rolling auto-caption duplication
is collapsed, inline markup and `[Music]` tags are stripped, and the text is
chunked into timestamped paragraphs matching the format already in the CMS.

Fresh uploads often have no captions for the first 10–60 minutes. That's not an
error — the video syncs without a transcript, and the **next run backfills it**
(an empty transcript is an empty field, so it gets filled).

`--no-transcripts` skips captions entirely if you just want metadata (though it
saves no time — see below).

### What a run decides to fetch

`last-synced` is the guard. Once the script has synced an item, whatever
YouTube had was written, and an empty field means YouTube has nothing — so the
item is done. **Empty is not the same as incomplete.**

This matters more than it sounds: 90 of CTK's 92 videos have no YouTube
description, and most have no series. An earlier version treated any empty
field as "needs work", so every item stayed eligible forever and two separate
`--max-work` runs were spent re-fetching videos that were already finished.

The one exception is a missing transcript — captions can appear an hour or two
after upload, so those are retried on later runs, for up to 14 days. After that
the sync accepts that the video has no captions and stops asking.

To re-run speaker/series matching after adding to those collections, use
`--force` (it re-fetches, but never overwrites a value you set by hand).

---

## Ignoring a video

Deleting an item in the Designer does **not** keep it gone. The video is still
on the channel, so the next run sees it as missing and recreates it.

`ignored-videos.json` in this folder is what makes a deletion stick:

```json
{
  "ignore": [
    { "id": "bezHcAlVmtw", "why": "duplicate re-upload" }
  ]
}
```

Delete the item in Webflow, add its video id here, done. Removing an id brings
the video back on the next run, so this is reversible.

Currently ignored: three duplicate re-uploads (the same sermon posted twice on
the channel). In each case the copy owning the clean, un-suffixed slug was kept.

---

## Speed, and YouTube throttling

**YouTube throttles this, and the throttling gets worse the longer you run.**
This is the single most important thing to know about the script.

From the first full backlog run (146 videos, concurrency 5, Aug 2026):

| Videos | Time per video |
|---|---|
| 1–37 | ~44s |
| 38–47 | ~101–124s |
| 58–62 | ~147s |
| 63–67 | ~230s |
| 68–146 | **timeout** — 79 consecutive failures |

The run took 5 hours and completed 42 creates + 24 updates before YouTube
choked it off entirely. Shorter runs don't hit this: a 20-minute pass over the
same channel finished fine. It's sustained volume that triggers the ramp.

Related measurements, for reference:

| Setup | Per video | Throughput |
|---|---|---|
| 1 at a time | ~12s | 0.083 videos/sec |
| 5 at a time | ~43s | 0.116 videos/sec |

Concurrency 5 buys only ~1.4× over serial, and it provokes the throttle faster.
**The default is now 3.**

### Backfilling a large backlog

Do it in chunks across sessions rather than one long run:

```bash
export YTDLP_COOKIES_FROM_BROWSER=chrome   # authenticated = throttled much less
node sync-youtube.js --max-work 25 --concurrency 2
```

Repeat over a few sittings. The sync is idempotent — each run picks up exactly
what's missing and skips everything already complete, so chunking costs nothing
but wall-clock patience.

Built-in protections:

- **Circuit breaker.** After 5 consecutive failures the fetch phase stops
  instead of grinding for hours. Everything already fetched still gets written.
- **`--max-work N`** caps how many videos a single run will fetch.
- **`--sleep-requests`** (default 1s, via `YTDLP_SLEEP_REQUESTS`) paces the HTTP
  requests yt-dlp makes.
- **Timeouts are reported compactly** — you get a count and the first ten URLs,
  not 79 copies of the full command line.

If you see mass timeouts: wait a few hours, then resume. Nothing is lost.

### Things that are NOT the cost

Verified, so nobody re-litigates them:

- **Captions are free.** A metadata-only pass takes the same time as one with
  transcripts. `--no-transcripts` saves nothing.
- **It isn't CPU.** A bare yt-dlp call uses ~1s of CPU across 20s of wall clock.
- Collapsing two yt-dlp calls into one, `--no-simulate`, `youtube:skip=dash,hls`
  — all kept where sensible, all worth ~0, because the cost is server-side.

Steady state is fine: once the backlog is in, a weekly run touches a handful of
videos and finishes in well under a minute.

---

## Automation (GitHub Actions)

Two workflows live in `.github/workflows/`:

| Workflow | Trigger | Why |
|---|---|---|
| `podcast-sync.yml` | **daily, 10am CT** + manual | Apple/Spotify/Webflow are plain API calls. Runs in seconds, nothing to throttle. |
| `youtube-sync.yml` | **manual only** | YouTube blocks GitHub runner IPs. No schedule on purpose. |

### Repository secrets

Settings -> Secrets and variables -> Actions:

| Secret | Where it comes from |
|---|---|
| `WEBFLOW_API_TOKEN` | `webflowToken` in `credentials.json` |
| `SPOTIFY_CLIENT_ID` | `podcast.spotifyClientId` |
| `SPOTIFY_CLIENT_SECRET` | `podcast.spotifyClientSecret` |

With `gh` installed you can set all three without the values ever hitting your
clipboard or scrollback:

```bash
python3 -c "import json;print(json.load(open('credentials.json'))['webflowToken'])" | gh secret set WEBFLOW_API_TOKEN
python3 -c "import json;print(json.load(open('credentials.json'))['podcast']['spotifyClientId'])" | gh secret set SPOTIFY_CLIENT_ID
python3 -c "import json;print(json.load(open('credentials.json'))['podcast']['spotifyClientSecret'])" | gh secret set SPOTIFY_CLIENT_SECRET
```

Env vars beat `credentials.json`, which is gitignored and never leaves your Mac.

### Why YouTube is not scheduled

From this project's own runs: on a residential IP, an unauthenticated pass
degraded from 44s to 240s+ per video and then failed 79 in a row. Browser
cookies fixed it locally (12-18s per video, zero failures) but that fix does not
transfer to CI — cookies expire within days, and a login session should not sit
in repo secrets. A shared GitHub runner IP is a worse starting point than yours.

For unattended YouTube syncing, run it on a Mac: a `launchd` job, or a
self-hosted runner registered to this repo. The manual workflow is there for the
occasional dispatch and may simply fail; that is expected, not a regression.

---

## Running the YouTube sync on a schedule, locally



`.github/workflows/sync.yml.example` is a working starting point. Add
`WEBFLOW_API_TOKEN` as a repository secret and rename the file to drop
`.example`.

One caveat worth knowing before you rely on it: **YouTube frequently blocks
requests from GitHub-hosted runner IPs.** If the action starts failing with
"Sign in to confirm you're not a bot", the fixes are, in order of hassle: a
self-hosted runner (a Mac at the church or your own machine), or exporting
cookies and passing them via `YTDLP_COOKIES_FILE`. A `launchd` job on a Mac
that's always on avoids the problem entirely.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `yt-dlp not found` | `brew install yt-dlp`, or set `YTDLP_PATH` |
| `Webflow 401` | Token is wrong or expired — regenerate it |
| `Webflow 403` | Token lacks CMS write scope |
| `Webflow 409` | Slug collision; the script de-dupes, so this means an item was added by hand mid-run |
| "Sign in to confirm you're not a bot" | `yt-dlp -U`, then set `YTDLP_COOKIES_FROM_BROWSER=chrome` |
| Duplicate items appear | Something cleared `youtube-video-id` on an item — restore it and re-run |

Sanity check any time: `node sync-youtube.js --dry-run --limit 3`

---

## Tests

```bash
npm test
```

The 38 offline tests cover caption parsing, transcript formatting, scripture
extraction, speaker/series matching, the Sermon/Exhortation threshold (asserted
against all 25 real durations), the concurrency helper (ordering, limit,
failure isolation), the yt-dlp wrapper against a stub binary, and — most
importantly — the update rules that keep re-runs from clobbering manual edits.

They need no network, so they also run fine in CI.

---

## Podcast sync (`sync-podcast.js`)

Fills the audio and platform-link fields on Media items from the CTK podcast,
**and backfills the speaker** — the podcast titles name the preacher where the
YouTube titles don't.

```bash
node sync-podcast.js --dry-run --report podcast-report.csv   # match, write nothing
node sync-podcast.js                                          # write
```

| Field | Source |
|---|---|
| `distributor-episode-id` | Apple `episodeGuid` — permanent key for future runs |
| `apple-podcasts-episode-url` | Apple per-episode deep link |
| `audio-url` | the episode's audio file (Subsplash CDN) |
| `spotify-episode-url` | Spotify per-episode link (needs credentials) |
| `speaker-s` | parsed from the podcast title, **only when the field is blank** |

### Why it matches on duration

The podcast audio and the YouTube video differ by **exactly 1 second** on every
sampled pair (YouTube rounds up), which makes duration close to a unique
fingerprint. The other signals are unreliable:

- **Titles disagree.** YouTube: `Sing: Part 2 of 3 | Congregational Worship - Part 6`.
  Podcast: `Andy Naselli - Sing: Part 2 of 3—Why Should a Church Continually Sing the Psalms?`
- **Dates drift.** The podcast snaps to Sunday 10:00 UTC; YouTube uses the real
  upload time. *Pray and Give* is Jul 5 on the podcast, Jul 7 on YouTube.

- **Some dates are badly wrong.** CTK bulk-uploaded its back catalogue to
  YouTube on 2025-04-23, so 26 videos all carry that upload date while the
  podcast has the real preaching dates — years apart. A duration match with a
  strong title is therefore accepted *without* any date agreement.

So duration decides, date and title corroborate, and matching is strictly
one-to-one. Anything the rules can't settle is listed as ambiguous in the report
rather than guessed — a wrong audio file on a sermon is worse than a blank field.

### Sources

- **Apple** — keyless. One `itunes.apple.com/lookup` call returns all 143
  episodes with guid, deep link, audio url, title and duration. This is the
  whole archive, so the Subsplash RSS (which only serves ~61 recent episodes)
  isn't used.
- **Spotify** — needs a free developer app (developer.spotify.com → Create app),
  then put the client id/secret in `credentials.json` under `podcast`. Spotify
  doesn't expose the RSS guid, so its episodes are joined on the same duration
  fingerprint. Without credentials the sync still runs and leaves Spotify blank.

### Speakers

Sermons are titled `Nathan Colestock - …` on the podcast; exhortations are
titled `Exhortation - …` with no name, so those stay unattributed.

First-name variants are handled: the podcast says `Clinton Manley` where the CMS
says `Clint Manley`, and `Thomas Dodds` vs `Tom Dodds`. A surname must match
exactly and the first names must agree by prefix or known nickname, so
`James Piper` never resolves to `John Piper`. A speaker is
only written when the Webflow field is empty, and only when a matching Speaker
record exists — an unknown name is reported, never invented.
