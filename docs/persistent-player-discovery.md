# Persistent sermon player, PiP and audio integration — discovery

Status: **discovery only, no code changed.** Audited 2026-10-14 against the
`christtheking` and `narthex` repos, the live Webflow site
(`christthekingchurch.webflow.io`, no custom domain), the Webflow Data API,
the Apple/Subsplash podcast feed, the YouTube channel feed, and the GitHub
Actions run history. Everything marked *verified* was observed directly;
everything marked *reported* comes from vendor docs or bug trackers and
needs the proof-of-concept to confirm it on real devices.

---

## 0. The three findings that shape the plan

1. **Option A already exists.** `sync-podcast.js` has been enriching Media
   items with podcast audio since before this task: 140 of 153 items carry
   `audio-url`, `distributor-episode-id` (the podcast GUID), Apple and Spotify
   links, matched on duration with title/date corroboration and an ambiguity
   report. The only thing it does not know about is Libsyn. The publishing
   question is therefore "how does the existing podcast step read Libsyn",
   not "which architecture".
2. **The site has never played audio.** No `<audio>` element exists anywhere;
   `audio-url` is written to the CMS and not rendered. The only player is a
   YouTube iframe built by the transcript embed on the Media Template. The
   player work is therefore a new front-end component, with one existing
   consumer (the transcript follow-along) that must be refactored to listen
   to it rather than own it.
3. **The podcast is currently stalled, and the repo mirror has drifted.** The
   Apple feed still points at Subsplash (`podcasts.subsplash.com/ggrw8rt`),
   its newest episode is 2026-08-23, while YouTube's newest upload is
   2026-09-16 and the Action has run green daily. No public Libsyn feed for
   CTK could be found. Separately, the live Media Template embed contains a
   block that builds the YouTube iframe which is **not** in
   `webflow/embeds/media-template-transcript.html` (see §A.3).

---

## A. Existing architecture audit

### A.1 Webflow CMS synchronisation and GitHub Actions (verified)

| Piece | What it does | Reusable for this work |
| --- | --- | --- |
| `.github/workflows/sync.yml` | One job, daily 15:00 UTC + manual dispatch. Steps: unit tests → yt-dlp install → `sync-youtube.js --max-work 15 --concurrency 2` → `sync-podcast.js --report` → `reconcile-speakers.js`. Each step runs even if an earlier one fails. 33 runs; the last 12 (Oct 3–13) all succeeded. | Yes. The podcast step is the natural home for Libsyn. |
| `sync-youtube.js` | yt-dlp channel listing → create/fill Media items keyed on `youtube-video-id`; partial path (title/duration/date/thumbnail without the bot-gated player endpoint); circuit breaker; `--max-work`. | Unchanged. |
| `sync-podcast.js` + `lib/podcast.js` | Apple `itunes.apple.com/lookup` (keyless, whole archive) + optional Spotify. `matchEpisodes()` is duration-first (±3 s), date (21 d) and Jaccard title similarity as corroboration, strictly one-to-one, contested pairs reported as ambiguous. Writes `distributor-episode-id`, `apple-podcasts-episode-url`, `audio-url`, `spotify-episode-url`, and fills a blank `speaker-s`. Fill-only unless `--force`. | **Yes, this is Option A.** Needs a Libsyn RSS source, GUID-first matching, and a rule that lets `audio-url` migrate hosts. |
| `lib/parse.js` | `buildUpdatePatch()` with `FILL_ONLY`, `FIRST_SYNC_ONLY`, `DERIVED`, `ALWAYS_UPDATE`; `needsWork()` convergence guard. 38 offline tests. | Yes. The audio-host rule slots in beside these. |
| `lib/webflow.js` | Data API v2 client, 60 req/min pacing, 429/5xx backoff, live and draft create/patch. | Unchanged. |
| `lib/feed.js` | Parses YouTube's Atom feed with regexes. | Pattern to copy for a dependency-free `lib/rss.js`. |
| `reconcile-speakers.js`, `import-transcripts.js`, `sync-all.js` | Speaker text derivation; local `.vtt` import; the Mac-side pipeline. | Unchanged. |

Idempotency and safety already in place: items are never deleted by any
script; a video or episode vanishing from its source leaves the item alone;
`ignored-videos.json` makes deliberate deletions stick; writes are serialized
and retried; exit codes separate "source would not answer" from "write failed".

### A.2 Webflow CMS — Media collection `6a5701458bc1d1a8814d8a51` (verified via API)

20 fields. The ones that matter here:

| Field slug | Type | State today |
| --- | --- | --- |
| `youtube-video-id` | PlainText | sync key; **153/153 items have one** (no audio-only items exist) |
| `video-url`, `thumbnail`, `date`, `duration-seconds`, `transcript`, `description`, `scripture-raw` | — | YouTube-owned (duration is the video's) |
| `type` | Option | `Sermon`, `Exhortation`, **`Conference Session`** (the third option is not in the README; the sync only ever writes the first two) |
| `speaker-s` / `speaker-text`, `series` | refs / text | as documented |
| `audio-url` | Link | **140/153 filled, all `t.subsplash.com` redirect URLs.** These will break if Subsplash is switched off. |
| `distributor-episode-id` | PlainText | 140 filled with the Apple `episodeGuid` = the RSS `<guid>` (verified equal for the newest episode: `a382b537…`) |
| `apple-podcasts-episode-url`, `spotify-episode-url` | Link | filled alongside |
| `last-synced` | DateTime | convergence guard |
| `exclude-from-listing` | Switch | — |

The 13 items without audio are conference sessions (Sep 2026) that were never
on the podcast, plus whatever the stalled feed has not carried since Aug 23.

### A.3 Media playback and the Media Template (verified via API + live HTML)

Template `6a5701468bc1d1a8814d8aa0`, published at `/media/<slug>`:

```
section > .container-large > .media-content_wrap
├── .media-primary
│   ├── .video-embed [data-video] [data-youtube-id ← CMS youtube-video-id]   16:9, radius 1rem, overflow clip, no children
│   ├── .media-title_wrap  (breadcrumb + "breadcrumb-handler" embed + .media_platform-buttons "Listen on" Spotify / Apple icon-buttons, h1, byline)
│   ├── .media-transcript.is-preview [data-transcript-preview]  (tablet/phone preview box)
│   ├── .media-series_playlist  (series rows, prev/next)
│   └── .media_nav [data-date-nav]  (Finsweet previous/next item)
├── .media-secondary  vci-modal="drawer" key=transcript, inline ≥992px, enter/exit "sheet"
│   ├── .media-transcript_scrim  vci-modal="scrim"
│   └── .media-transcript  vci-modal="part"  (handle, header with search/copy/download/play-pause/close, body, Synchronize)
└── HtmlEmbed "Code Embed" (the transcript script) + a hidden HtmlEmbed
```

How the video is rendered **on the live site**: the transcript embed's script
starts with an IIFE that reads `[data-youtube-id]`, creates an `<iframe>` with
`embed/<id>?rel=0&modestbranding=1&playsinline=1&enablejsapi=1&origin=…`,
`allow="…autoplay; picture-in-picture…"`, and appends it to `.video-embed`.
It then loads `youtube.com/iframe_api`, wraps the iframe in `YT.Player`,
polls `getCurrentTime()` every 400 ms for the transcript follow-along,
seeks on `#t=` anchor clicks, and drives the sheet's play/pause button.

**Drift:** the repo copy of that embed lacks the iframe-building IIFE (and
differs in two escaped-unicode regexes). The repo should be brought back in
step before any edit to that embed, or the next paste would remove the video.

Nothing else on the site touches media. `audio-url` has no front-end consumer.

### A.4 Site navigation (verified)

Plain Webflow multi-page site. No SPA, no Turbo, no view transitions. Every
navigation is a full document load, so **no DOM element survives navigation
today**, and the YouTube iframe is rebuilt per page. `/media` uses Finsweet
Attributes v2 (`fs-list-load="infinite"`), which is why the speaker-name
script observes DOM mutations. Header: hand-built `nav.navbar` (`position:
sticky; top: 0; z-index: 100`) under an `announcement-bar`; narthex `nav`
writes `--nav-height` and `--nav-offset` (the header's live bottom edge).
Mobile menu is narthex-owned (`vci-nav` toggle/menu/dim).

### A.5 Sticky, floating and overlay components (verified from the compiled CSS)

| Element | Position / z-index | Relevance to a floating player |
| --- | --- | --- |
| `.navbar` | sticky, z 100 | player dock must stay below it (z < 100) or it will cover the mobile menu |
| `.scroll-to-top_button` | fixed, z 90, bottom corner, `.is-visible` + `inert` pattern | **collision**: same corner a dock would use; needs a `--player-dock-height` offset while the dock shows |
| `.sticky-menu-wrap` | sticky, z 50 (1000 when `.is-open`) | Beliefs pages only |
| `.modal` / `.modal-dialog` | fixed, z 101 open | narthex dialog |
| `.filter-drawer_component` | fixed inset 0, z 1000 | narthex drawer (Media, Study Tools) |
| `.media-transcript.is-visible` | fixed bottom sheet, 92dvh, z 1001 | covers a bottom dock on phones; the sheet already has its own play/pause |
| `[vci-nav="dim"]` | behind the mobile menu | — |

Design tokens available to the player (no new ones needed):
`--_theme---background-01/02/03`, `--_theme---border-01/02`,
`--_theme---text-01/02/03`, `--_theme---accent-01` (gold),
`--border-radius-small` (.5rem) / `--border-radius-medium` (1rem),
`--_spacing---gap-*`, `.icon-button` (2rem), `.modal_close` (2.25rem),
JetBrains Mono for timestamps, breakpoints 991 / 767 / 479.

### A.6 narthex (verified)

v0.5.1 live on the site. Core: `vci.define()`, settings resolution,
`vci.css()`, `vci.emit()`, the shared iOS-safe scroll lock, focus helpers.
Modules: modal (dialog + drawer with swipe, inline media query, enter/exit
animations), accordion, nav, scroll. Build is pure concatenation into a
committed `dist/`; `test/smoke.mjs` drives `demo/index.html` in headless
Chromium; ES5 only in modules. Adding a module = one file in `src/modules/`,
its roles exercised in the demo, a smoke block, a header comment, a minor
version tag, and the site's footer tag bumped from `@v0.5.1`.

### A.7 What can be reused

- The whole sync pipeline, matcher, Webflow client and test harness.
- CMS fields `audio-url` and `distributor-episode-id` (no rename).
- `.video-embed` as the inline stage, `.icon-button` / `.modal_close` /
  tokens for controls, the `.is-visible` + `inert` show/hide pattern.
- narthex core for attributes, settings, events, CSS injection; the modal
  module's sheet for an expanded transcript (already there).
- The transcript embed's seek / follow-along / play-pause logic, re-pointed
  at the shared player instead of its own `YT.Player`.

---

## B. Publishing architecture recommendation

### Recommendation: **Option A, extended** — keep YouTube primary, read Libsyn RSS in the existing podcast step

Why, from the code and data:

- The reconciliation Option C asks for (normalise both sources, match, then
  write) is what `sync-podcast.js` already does; YouTube creates, podcast
  enriches, one-to-one, ambiguity reported, blank fields only. A "unified"
  rewrite would replace a tested pipeline with an untested one for no new
  capability.
- Option B (RSS primary) cannot create the item the site needs: RSS has no
  video id, no transcript, no thumbnail the site uses, titles in a different
  house style (`Nathan Colestock - …`, `Exhortation - …`), and dates snapped
  to Sunday 10:00 UTC. It would also inherit Libsyn's default 100-episode
  feed cap and the publishing lag now visible (podcast seven weeks behind
  YouTube). YouTube is the richer, earlier, more stable source.
- Everything the user wants from "unified" — audio-only, video-only and
  combined entries — is a matter of letting the player accept any one of the
  two fields, plus one opt-in to create Listen-only items (below).

### Changes to make (all inside `sync-podcast.js` / `lib/`)

1. **`lib/rss.js`** — dependency-free parser for the Libsyn feed:
   `<guid>`, `<enclosure url length type>`, `<itunes:duration>` (seconds or
   `H:MM:SS`), `<pubDate>`, `<title>`, `<itunes:author>`,
   `<itunes:episodeType>`. Same regex style as `lib/feed.js`. Fixture: the
   Subsplash feed snapshot captured today (147 items) and, once available, a
   Libsyn snapshot.
2. **Sources in order of trust:** Libsyn RSS (canonical audio URL and GUID) →
   Apple lookup (keyless cross-check, deep links; stays until Apple is
   repointed and then still useful for the Apple URL) → Spotify (unchanged).
3. **GUID-first matching.** Before the duration matcher runs, join RSS items
   to Media items on `distributor-episode-id` = `<guid>`. If Libsyn preserved
   the Subsplash GUIDs on import (Libsyn's import is RSS-based and third-party
   accounts say GUIDs are mirrored — *reported, verify*), 140 items match
   with zero ambiguity and no title/date heuristics. Only GUID-less items
   and GUID mismatches fall through to the existing duration matcher.
4. **Audio host migration rule.** Today `audio-url` is fill-only, which would
   leave 140 dead Subsplash URLs in place. Add a small, explicit rule: a
   podcast-owned link is overwritten when its *host* is not the canonical
   host (`libsyn`), never otherwise. Same for `distributor-episode-id` if the
   GUID changed and the duration matcher is confident (confidence ≥ 3), with
   the change listed in the report.
5. **Store the enclosure URL directly in `audio-url`** — yes. The player needs
   a plain `src`; Libsyn enclosure URLs are per-episode and stable (they pass
   through Libsyn's stats redirect, which is fine for `<audio>`). Keep
   `apple-podcasts-episode-url` / `spotify-episode-url` for the "Listen on"
   buttons.
6. **Verify full-archive visibility before trusting RSS.** Libsyn's classic
   feed shows the newest 100 episodes by default; the Episode/Post Limit
   under the feed destination's Advanced Options must be set to **No Limit**
   (*reported from Libsyn's help centre; the page itself is behind a bot
   check*). The script should assert `items ≥ expected` (147 today) and warn
   loudly, not silently match a truncated archive. Also set Libsyn's
   directory "Episode Display Limit" to 0 if the site ever links the show
   page.
7. **Publishing lag.** Keep the existing behaviour: the YouTube step creates
   the item (Watch-only), audio arrives on a later daily run through the
   fill-only path, no duplicate is possible because the item is keyed on the
   video id and the episode on the GUID. The player must therefore render
   Watch-only gracefully (it will be the normal state for the first days).
8. **Listen-only items (opt-in, Phase 1b).** `--create-audio-only --grace-days
   10`: an RSS episode with no match after the grace window becomes a Media
   item keyed on `distributor-episode-id`, `type` from the title prefix
   (`Exhortation -` → Exhortation, else Sermon), `duration-seconds` from
   `itunes:duration`, `date` from `pubDate`, no `youtube-video-id`. If a video
   appears later the YouTube step will create a *second* item — so the YouTube
   step must also try a duration match against GUID-only items before
   creating. This is the one genuinely new reconciliation path; ship it only
   if the church actually publishes audio-only content (today: zero cases).
9. **Failure handling** is already right: a source that will not answer exits
   2 and skips, a write failure exits 1, nothing is deleted, the next daily run
   retries. Add the RSS fetch to the same pattern (15 s timeout, 3 retries).

### Proposed CMS schema changes (small)

| Field | Type | Why |
| --- | --- | --- |
| `audio-duration-seconds` | Number | Needed for Listen-only items and to detect timeline mismatch in the player (today only the video duration is stored). Podcast-owned. |
| `audio-offset-seconds` | Number, optional | Hand-set editor override when a historical MP3 is cut differently from the video (`audio_time = video_time + offset`). Default 0. Never written by the sync. |

No renames, no URL changes, no change to `youtube-video-id` as the key.
`distributor-episode-id` keeps its name (it already holds the GUID).

### Migration requirements

1. Get the Libsyn feed URL and set its episode limit to No Limit.
2. Snapshot the old feed (done: 147 items, GUIDs) and diff GUIDs against Libsyn.
3. Dry-run `sync-podcast.js` with `--report`; expect 140 GUID matches, review
   the rest in the CSV; flagged ambiguities are fixed by hand in the Designer
   (today's matcher produced 7 permanent unmatched items; expect similar).
4. Run live; Subsplash URLs are replaced with Libsyn URLs by rule 4.
5. Confirm Apple and Spotify have followed the 301 redirect from Subsplash.

---

## C. Player architecture

### C.1 Where it lives

**In christtheking, not narthex** (decided 2026-10-14). The player ships as a
site registered script, `webflow/registered/media-player.js`, applied
site-wide in the footer like `scrollToTop` and `navbarSpeakerNames`, with
its source of truth in this repo. It still follows narthex's conventions
(attribute hooks, state not style, events for site code) and uses narthex
core where loaded (`vci.emit`, `vci.css`, `vci.modal.isOpen('transcript')`),
but it owns its own markup hooks under a `data-player-*` prefix, matching the
site's other registered scripts, and it is not versioned or released through
jsDelivr. The transcript embed becomes a consumer of its events.

### C.2 Roles and settings (sketch)

```
data-player="stage"        the inline slot (.video-embed): a 16:9 placeholder that stays in the page
data-player="root"         the single persistent container that owns the iframe and <audio>; one per page
data-player="dock"         the floating chrome (controls, title, status) — part of root
data-player="play|mode|expand|close|back|forward|speed|title|status|time"   controls inside root or the transcript sheet

data-player-youtube="<id>"      bound to CMS youtube-video-id on the stage (today: data-youtube-id)
data-player-audio="<url>"       bound to CMS audio-url on the stage
data-player-offset="<s>"        bound to audio-offset-seconds
data-player-title / -artist / -artwork   Media Session metadata (title, speaker-text, thumbnail)
```

Events on `document`: `ctk:player:ready`, `:play`, `:pause`, `:time`
(throttled, one source of truth for the transcript), `:mode` (watch|listen),
`:float`, `:inline`, `:error`, `:handoff` (experimental). API on
`window.ctkPlayer`: `play() pause() seek(s) setMode(m) getTime()`.

### C.3 Playback state (one object, one owner)

```
{ item: slug, mode: 'watch'|'listen', state: 'idle'|'loading'|'playing'|'paused'|'error',
  time, rate, presentation: 'inline'|'floating'|'hidden', userStarted: bool }
```

Rules: only one source is ever audible; `time` is read from the active
adapter and written to the other only at a switch; the player only becomes
visible after `userStarted`.

### C.4 Inline / floating presentation without reloading the iframe

Moving an iframe in the DOM reloads it (WebKit WONTFIX, same in Blink and
Gecko), so the iframe is **never re-parented**. The `root` is
`position: fixed` from the moment it is created, and *inline* is just a
geometry: on scroll/resize (rAF-throttled, plus a ResizeObserver on the
stage) the root is sized and translated to the stage's bounding rect, so it
reads as part of the page while the stage placeholder keeps the layout.
Floating is the same root translated to the dock position with a smaller
size. Playback is untouched by either; the transition is transform/size only
and is skipped under `prefers-reduced-motion`.

IntersectionObserver on the stage: when `userStarted` and the stage is
< 30 % visible → `floating`; back ≥ 60 % visible → `inline`. Manual
expand = scroll the stage into view and go inline; close = pause, hide,
remember position, do not restart.

### C.5 YouTube policy constraints that fix the dock's size (verified from the policy pages)

- Embedded player viewport ≥ 200 × 200 px → a 16:9 floating video is at
  least ~356 × 200 px. On a 390 px phone that is a full-width bottom strip
  with 16 px gutters, not a thumbnail. In Listen mode the dock may be a
  compact bar because the iframe is hidden/paused.
- No overlays, frames or visual elements in front of any part of the
  player; player controls and the settings wheel must remain visible → our
  controls sit **beside or below** the video, never over it; no custom
  scrubber over the iframe.
- "Custom play buttons over the YouTube thumbnail are acceptable, but tapping
  must initiate playback" → a poster + our own Play button is allowed, and
  is what gives us the user gesture the audio unlock needs (§D).
- Prohibited: background play of the YouTube player, separating audio from
  video, hiding the player while it plays. Hence Listen mode pauses YouTube
  and plays the MP3; there is no hidden YouTube audio.

### C.6 Adapters

- **Watch:** the existing `YT.Player` on the iframe (`playsinline=1`,
  `enablejsapi=1`, `origin`), `getCurrentTime / seekTo / getPlaybackRate /
  setPlaybackRate / getPlayerState`, `onStateChange`. Created once per page.
- **Listen:** one `<audio preload="none" playsinline>` created with the root;
  `src` set lazily on first user intent; `preload="metadata"` once the user
  has started anything; Media Session metadata + `play/pause/seekbackward/
  seekforward/seekto` handlers + `setPositionState` so the lock screen has
  real controls (Safari 15+ *reported*, Chrome Android verified widely).
- Lazy loading: no YouTube iframe or iframe_api request until the stage is
  near the viewport or the user taps Play on the poster (poster = the CMS
  thumbnail, already on every item). This also removes ~500 KB of YouTube
  JS from first paint on sermon pages.

### C.7 Watch ⇄ Listen switching and timestamp sync

Watch → Listen: `t = yt.getCurrentTime()`, `rate = yt.getPlaybackRate()`,
`wasPlaying`; `audio.currentTime = t + offset`, `audio.playbackRate = rate`;
on `seeked`/`canplay` → `audio.play()` then `yt.pauseVideo()` (≤150 ms of
overlap, YouTube muted first so there is no echo). Listen → Watch:
`yt.seekTo(t − offset, true)`, `yt.playVideo()`; on YouTube `PLAYING`,
`audio.pause()`. Both are user-gesture initiated, so autoplay policy is not
a factor.

A true crossfade is **not recommended**: the two streams are not
sample-aligned (the observed 1 s duration delta is a rounding artefact, not a
measured offset), so any overlap longer than ~150 ms reads as an echo; and
the YouTube volume ramp would have to happen with the video still visible.
The near-seamless hard handoff above is what Spotify-style switching feels
like in practice.

Timeline differences: store `audio-duration-seconds`; if
`|video − audio − 1| > 3 s` the player applies `audio-offset-seconds` when
set, otherwise switches at the same absolute time, clamps to the
destination's duration and shows a one-word "approx." badge next to the
time for 3 s. The sync report lists such items for an editor to set the
offset.

Preferences (localStorage, one key): last mode, speed, "continue listening
when I leave" opt-in. Positions (localStorage, per slug, capped at 50): time
and mode, so a sermon reopened later offers "Resume at 23:14".

### C.8 Cross-page persistence

Honest answer: a full-page site cannot keep a YouTube iframe or an `<audio>`
element alive across navigation, and browsers will not autoplay audible media
on the new page without a gesture (iOS Safari always; desktop Chrome
sometimes, via its engagement score). Options:

| Approach | Verdict |
| --- | --- |
| Save state on `pagehide`, show a one-tap **Resume** in the dock on the next page, auto-resume where the browser allows it (Listen mode, Chrome desktop/Android with prior engagement) | **Recommended for v1.** Reliable, zero risk to Webflow interactions, Finsweet, SEO or history. |
| Soft navigation (fetch the next page, swap `<body>` content, keep a player root injected outside the swapped region, `pushState`) | Possible but it *is* the SPA the brief says to avoid: Webflow IX2 and Finsweet have to be re-initialised per swap, per-page custom code re-run, focus/scroll/announcement handled by hand, and one missed case breaks a page. Revisit only if resume-on-next-page proves insufficient, and then scope it to `/media/*` → `/media/*` links only. |
| Keep a hidden iframe alive via bfcache | Not controllable; bfcache is the browser's choice and the YouTube iframe is paused in it anyway. |

### C.9 Responsive behaviour (one component)

Same markup, same state machine, same controls everywhere. Differences are
CSS only, keyed on the dock class:

- ≥ 992 px: dock bottom-right, 400 × 225 video + a 2.75 rem control row,
  gap 1.5 rem from the edges, below the navbar (z 95).
- < 992 px: dock bottom, full width minus 1 rem gutters, 16:9 video (≥ 200 px
  tall by policy), controls in a row below it, `padding-bottom:
  env(safe-area-inset-bottom)`; in Listen mode collapses to a 4 rem bar.
  Touch targets ≥ 44 px (`.icon-button` is 2 rem → use `.modal_close` size
  2.25 rem with padding, or a 2.75 rem variant).
- While the dock is visible: `body.has-player-dock` sets
  `--player-dock-height` so `.scroll-to-top_button` moves up; while the
  transcript sheet or a drawer is open the dock hides (the sheet already
  carries play/pause and will now also carry the mode switch).
- Dock markup lives in the site's `footer` component (so it exists on every
  page) with `data-player` roles; the script only toggles classes, `aria-*`,
  `inert` and CSS variables, and injects only the CSS a state needs (the
  fixed geometry), never colours or sizes.

### C.10 Native and Document PiP

- The HTML `requestPictureInPicture()` API cannot reach a `<video>` inside a
  cross-origin YouTube iframe. YouTube's own PiP button (enabled by
  `allow="picture-in-picture"`, already set) exists only where YouTube chooses
  to show it. Nothing for us to build; leave the permission on.
- Document Picture-in-Picture (an always-on-top window for arbitrary DOM):
  Chromium desktop 116+, Firefox 151+ *reported*, no Safari, **no mobile**.
  Moving the player root into the PiP window re-parents the iframe, which
  reloads it. Not useful for this feature; possibly a later desktop-Chrome
  nicety for Listen mode only.

---

## D. Experimental: automatic audio handoff when the user leaves

### D.1 What is known

- iOS Safari pauses the YouTube iframe when the page is hidden or the screen
  locks (widely *reported*; also the YouTube policy forbids us enabling
  background play of their player). So the only background path is our MP3.
- An HTML `<audio>` element playing in a **Safari tab** keeps playing when
  Safari is backgrounded or the screen locks, with lock-screen controls via
  Media Session (Safari 15+). Home-screen web apps historically did not
  (*reported*, WebKit bugs; CTK is not a PWA, so this does not apply).
- `play()` needs a user gesture on iOS, and a `visibilitychange` handler has
  none. **The lever is WebKit's per-element activation:** an `<audio>`
  element whose `play()` was called inside a real gesture (even if paused a
  moment later, or muted) stays "unlocked" for later programmatic `play()`
  on the same element (*reported*, widely used for UI sounds; must be
  verified for a long MP3 with a `currentTime` seek on current iOS).
- The gesture must happen **in our document**. A tap on the YouTube player's
  own Play button inside the iframe gives our page no activation. Hence the
  poster + custom Play button (§C.5), and the opt-in toggle, both of which
  are our gestures and both of which unlock the audio element.
- Chrome on Android keeps an `<audio>` element playing in the background and
  shows Media Session controls; it also usually allows `play()` after any
  prior interaction on the page. Expect the handoff to work there first.

### D.2 Proof-of-concept design (isolated page, before any integration)

A single static page (`webflow/poc/background-handoff.html`, hostable on the
Webflow `/test` page or any HTTPS host) containing: the CTK YouTube iframe
for one sermon, one `<audio>` with the matching Libsyn/Subsplash MP3, a
poster with our Play button, an "Continue listening when I leave" switch,
and an on-screen log persisted to `localStorage` (so results survive
locking the phone). The script:

1. On our Play tap: `audio.src = mp3; audio.muted = true; audio.play()
   .then(() => audio.pause())` (unlock), `audio.muted = false`, then
   `yt.playVideo()`. Log the promise outcome.
2. While watching, every 20 s: `audio.currentTime = yt.getCurrentTime()`
   (a paused seek fetches a small range near the playhead, so the buffer is
   warm) — also measure whether this costs noticeable bandwidth.
3. On `visibilitychange → hidden` (and `pagehide` as a second chance), with
   the opt-in on and YouTube playing: synchronously `audio.currentTime =
   yt.getCurrentTime() + offset; audio.play()`; set Media Session metadata;
   log the promise result and `document.visibilityState`. No awaits before
   `play()`.
4. On `visibilitychange → visible`: if the handoff succeeded, stay in Listen
   (YouTube is paused by the OS; ensure it is), show "Watch" to switch back.
   If `play()` was rejected, show "Resume listening" with the captured time
   and never restart from zero.
5. Variants to test: unlock muted vs unmuted-then-pause; `preload="auto"` vs
   `metadata`; handoff on `hidden` vs `pagehide`; app switch vs lock button
   vs Control Center; Safari tab vs Chrome iOS (WebKit, same rules) vs Chrome
   Android; low-power mode.

Acceptance for taking it into the product: on iPhone Safari (current iOS and
one back) the audio continues ≥ 60 s after locking in ≥ 9 of 10 trials with
the opt-in on; on Android Chrome ≥ 9/10; no double audio on return in any
trial; and the fallback UI never claims audio is playing when it is not
(verified by the log).

### D.3 Known failure modes to design around

- iOS freezes background tabs under memory pressure: audio stops with no
  event we can act on. The resume chip on return covers it.
- `pauseVideo()` sent via postMessage after `hidden` may not be delivered;
  on return re-assert the paused state so YouTube and audio never both play.
- A handoff that starts after the page is already frozen does nothing; the
  seek-ahead in step 2 keeps the window short.
- The opt-in must never gate reliable Listen mode: switching by tapping
  Listen is the dependable path; the handoff is a convenience on top.

---

## E. Technical feasibility matrix

| Feature | Verdict | Basis |
| --- | --- | --- |
| Libsyn RSS enrichment inside the existing Action | **Reliable and practical** | pipeline, matcher and fields exist; RSS is keyless |
| GUID-based historical matching (140 items) | **Reliable if Libsyn preserved GUIDs**, else falls back to the proven duration matcher | GUIDs verified in CMS; preservation *reported* |
| Full-archive RSS | **Possible with a setting** — default cap 100, must set No Limit and assert the count | Libsyn docs *reported* |
| Listen-only CMS items from RSS | Possible; opt-in; no current need (0 items) | §B.8 |
| Inline → floating without restarting playback | **Reliable** (fixed root, geometry only, never re-parent) | WebKit/Blink iframe-move behaviour |
| Mobile floating video at a useful size | **Possible with limitations**: ≥ 200 px tall by policy → full-width strip | YouTube RMF |
| Custom controls over the video | **Prohibited** — controls beside/below only | YouTube RMF |
| Watch ⇄ Listen with position kept | **Reliable** (near-seamless hard handoff) | IFrame API + HTML audio |
| Audible crossfade between YouTube and MP3 | **Not recommended** (echo, not aligned) | §C.7 |
| Playback rate, ±15 s, Media Session lock-screen controls | **Reliable** (Chrome, Android); **possible** on iOS Safari 15+ | *reported* for iOS |
| Remember position / mode across visits | **Reliable** (localStorage) | — |
| Continuous playback across page navigation | **Not practical without an SPA**; v1 = one-tap Resume on the next page | §C.8 |
| Document PiP / native PiP for the YouTube player | **Not useful** (cross-origin iframe; Chromium-desktop only; reparenting reloads) | §C.10 |
| Automatic audio handoff on app switch / lock, Android Chrome | **Experimental, likely works** | background `<audio>` allowed |
| Automatic audio handoff, iOS Safari | **Experimental / device-dependent**; hinges on per-element unlock holding for a seeked MP3 | §D |
| Keeping YouTube playing in the background | **Prohibited** | developer policies |
| Hidden YouTube / extracting audio | **Prohibited** | developer policies |

---

## F. Implementation plan

### Phase 0 — Prerequisites (no code; needs Josh / CTK)

- Libsyn feed URL; set Episode/Post Limit to No Limit; confirm Subsplash will
  301 to it and when Subsplash is switched off.
- Diff Libsyn GUIDs against the Subsplash snapshot (147 items). Outcome
  decides whether Phase 1 is a lookup or a re-match.
- Re-mirror the live transcript embed into the repo (drift in §A.3).
- Decide dock placement in the Designer (footer component) and confirm the
  narthex-module route.

### Phase 1 — Publishing (christtheking, 1 PR)

`lib/rss.js`, Libsyn as the first podcast source, GUID-first matching, the
audio-host migration rule, `audio-duration-seconds`, archive-count assertion,
tests against both feed snapshots, README update. Dry-run report reviewed
before the live run.
Acceptance: dry run shows ≥ 140 GUID or confidence-4 matches, zero
overwrites of hand-edited fields, Action green, Subsplash hosts gone from
`audio-url` after one live run.
Risk: GUIDs not preserved → re-match by duration (already tested at 143
episodes); publishing lag → Watch-only items, handled by the player.
Phase 1b (optional): `--create-audio-only` with grace window.

### Phase 2 — Player core (christtheking, 1–2 PRs)

`webflow/registered/media-player.js` (state, adapters, inline/floating
geometry, switching, Media Session, preferences, Watch-only / Listen-only,
error and loading states, keyboard and `aria` on every control), browser
tests in `test/*.test.mjs` against fixtures shaped like the template
(Playwright stubs the IFrame API and uses a short local MP3), registered and
applied site-wide via the Data API like the other registered scripts.
Designer: template attributes bound to CMS fields, poster + Play button on
the stage, dock markup in the footer component styled with existing tokens.
Transcript embed refactored to consume `ctk:player:time` and call
`ctkPlayer.seek()` instead of owning `YT.Player`; scroll-to-top offset.
Depends on Phase 1 only for Libsyn URLs; works today against Subsplash URLs.
Acceptance: see §G; plus no YouTube policy violation (no overlays, ≥ 200 px,
no background play).
Risks: Webflow attribute binding to CMS fields on the template (standard,
but confirm the `audio-url` Link field binds to an attribute); z-index
interplay with drawers; iOS `100dvh`/safe-area quirks in the sheet.

### Phase 3 — Background handoff proof-of-concept (parallel with Phase 2)

The isolated page in §D.2, test log, device matrix run by hand on real
phones. Deliverable: a results table and a go/no-go. No production code.

### Phase 4 — Handoff integration (only on a "go")

Opt-in switch in the dock ("Continue listening when I leave"), unlock on
our Play gesture, seek-ahead, the `hidden`/`pagehide` handler, the return
UI, and the never-restart fallback. Ships behind the preference, default
off.

### Phase 5 — Cross-page resume

`pagehide` snapshot → Resume chip on the next page, auto-resume only where
`play()` succeeds without a gesture. Evaluate demand for soft navigation
after this has been live for a while.

---

## G. Testing requirements

Automated (runs in CI, Playwright/Chromium):
- Inline → floating → inline transitions keep `currentTime` within 0.5 s and
  never reload the iframe (assert the iframe `src` and load event count).
- Watch → Listen → Watch keeps position within 1 s and only one source has
  `paused === false` at any time; speed and paused/playing state preserved.
- Watch-only and Listen-only items render the right controls; a missing or
  404 MP3 shows the error state and keeps Watch working; vice versa.
- Position and mode persist across a reload; Resume chip appears; nothing
  autoplays without a gesture.
- Keyboard: every control reachable, Space/Enter operate, Escape closes the
  dock, focus returns to the stage; screen-reader names on every control;
  `inert` on the hidden dock.
- Slow network: throttled MP3 shows buffering state and does not switch mode
  until `canplay`.

Manual device matrix (each phase's acceptance):

| Platform | Checks |
| --- | --- |
| Desktop Chrome, Firefox, Safari | all of the above; dock placement vs scroll-to-top; multiple tabs never double-play |
| iOS Safari (current and previous iOS) | safe-area padding; dock vs transcript sheet; `playsinline`; lock screen controls in Listen; the §D handoff trials (lock, app switch, Control Center, return); low-power mode |
| Android Chrome | background `<audio>` continues; Media Session notification; handoff trials |
| Long-running | 60-minute sermon in Listen with the screen locked; 60 minutes in Watch with periodic Listen switches; memory and battery sanity |
| Historical items | the items flagged for timeline mismatch in the Phase 1 report; switching lands within the tolerance or shows "approx." |
| Navigation | leave mid-sermon, return, Resume; back/forward with bfcache |

---

## H. Open questions for Josh

1. ~~Libsyn feed URL~~ — received; see §I. GUIDs preserved, one episode missing.
2. When Subsplash hosting ends (the 140 current `audio-url` values depend on it).
3. Are Apple/Spotify already repointed? (Apple still serves the Subsplash feed.)
4. Dock markup in the footer component vs generated by the site script — the
   plan assumes the Designer owns the markup.
5. ~~narthex module vs CTK-only registered script~~ — decided: christtheking.
6. Is "Conference Session" meant to be classified by the sync, or stay manual?
7. Should the missing episode ("Exhortation - Love One Another", 2026-04-12)
   be re-imported into Libsyn?

---

## I. Addendum 2026-10-14 — Libsyn feed verified

Feed: `http://feeds.libsyn.com/632508/rss` → 301 →
`https://rss.libsyn.com/shows/632508/destinations/5582368.xml` (the script
should store the final URL). Compared against the Subsplash snapshot taken
the same day:

| Check | Result |
| --- | --- |
| Items | **146** in Libsyn vs 147 in Subsplash — the archive is already past the 100 default, so the episode limit is set correctly today. One episode did not import: *Exhortation - Love One Another*, 2026-04-12, GUID `c3b55365…`. |
| GUIDs | **146 / 146 preserved** (Libsyn wraps them in CDATA; the parser must strip it). Phase 1 is therefore a GUID lookup for 140 CMS items, with the duration matcher as fallback only. |
| Durations | Libsyn = Subsplash **+ 1 s on every episode**, which puts Libsyn's `itunes:duration` within 0–1 s of the YouTube duration. The matcher's 3 s slack still holds. |
| Titles | 137 identical; 9 differ only by curly → straight apostrophes. `itunes:title` always equals `title`. Shapes: 82 `Speaker - Title`, 63 `Exhortation - Title`, 1 bare title. |
| `itunes:author` | Present on every episode and names the preacher **including exhortations** (Andy Naselli 62, Nathan Colestock 25, Dustin Williams 14, Andrew Wittenburg 10, Clint Manley 8, Thomas Dodds 8, Cole Johnson 5, …). Today the sync can only backfill speakers from a title prefix, so exhortations stay unattributed; `itunes:author` fixes that, through the existing `findSpeaker()` nickname matching. |
| Descriptions | Empty on 145 / 146 (one has a Google Doc link). Nothing to ingest. |
| Dates | Identical to Subsplash (Sunday 10:00 UTC). |
| Enclosures | `https://traffic.libsyn.com/secure/<show-uuid>/<file>.mp3?dest-id=5582368`, `audio/mpeg`. Each request 302s to a short-lived signed `content.libsyn.com` URL. The stable `traffic.libsyn.com` URL is what goes in `audio-url`; never store the signed one. |
| Playback headers | Final response: `accept-ranges: bytes`, `206` on a Range request, `access-control-allow-origin: *`. Seeking, `preload="metadata"`, and the handoff's seek-ahead all work; CORS is not an obstacle. |
| Video link | No YouTube or video field in the feed; only `<link>` to the Libsyn episode page. Association stays on our side (GUID ↔ `youtube-video-id` in the CMS). |

Consequences for Phase 1: add `itunes:author` → `speaker-s` backfill (blank
field only, matching speaker record required, as today); report the one
missing episode; the duration matcher is fallback only.

---

## J. Addendum 2026-10-14 — Phase 2 built

`webflow/registered/media-player.js` (the player), the transcript embed
re-pointed at it (`webflow/embeds/media-template-transcript.html`, which also
re-mirrors the live iframe builder), `test/media-player.test.mjs` with a
stubbed YouTube API and generated audio, and the `webflow/README.md` section
"The sermon player" with the Designer steps and hosting options. Not built:
Phase 1 (Libsyn in the sync), Phase 3/4 (background handoff), Phase 5
(resume on the next page). Blocked on the Designer side: `data-audio-url`
bound to Audio URL on `.video-embed`, the embed paste, and a host for the
registered script (this repo is private, so not jsDelivr).

---

## K. Addendum 2026-10-14 — cross-page playback built after all

Josh judged continuity across pages the core feature, so §C.8's "not
practical without an SPA" became a scoped one: while the player is active,
same-site links fetch and swap the page content in place (navbar, announcement
bar and footer kept; Webflow, Finsweet and narthex re-initialised; the new
page's own scripts run), and the player root lives on `<body>` outside the
swap. Once the player is closed the site navigates normally. The bar was
also redesigned to the series-playlist row style with a scrubbable progress
edge, and the floating state trimmed to title, speaker, time, play/pause and
progress. See `webflow/README.md`, "The sermon player".

Later the same day the inline bar under the video was dropped altogether:
the video sits in the page as before, a Listen icon joins the "Listen on"
row, and a bottom bar exists only while a sermon plays (pausing hides it,
and with it the in-place navigation).

