# Livestream roadmap

Where the Sunday livestream setup is going, why, what can go wrong, and what is
needed from people before each stage can ship. Written 2026-11-23; update the
status column as stages land.

**Goal:** the moment a Sunday stream ends, the recording lands in Google Drive
with no one touching it, so the sermon can be edited and posted the same day.
Along the way: a small password-free dashboard at
`livestream.christtheking.build/admin` to see status, manage who gets alerts,
and read the log, and email alerts when something breaks during a service.

**Non-goals (for now):** text messages (Twilio was ruled out), automatic sermon
editing, replacing YouTube as the public player. YouTube stays the place people
watch and cast from.

---

## Status

| Stage | What | Status |
|---|---|---|
| 0 | "Live" only when YouTube is actually receiving video; page re-checks while live (resolver 2.5.0) | Code done, **not deployed** |
| 1 | ATEM → Cloudflare Stream → YouTube; recording copied to Drive | Planned |
| 2 | Dashboard: Google sign-in, People, status, recordings, log | Planned |
| 3 | Email alerts + Sunday health checks | Planned |
| 4 | Runbook page, polish, retention clean-up | Planned |

Stages 1 and 2 don't depend on each other and can be built in either order; 3
needs both.

---

## How it fits together

```
                ┌───────────────────────── normal path ─────────────────────────┐
ATEM SDI Pro ISO ──SRT──▶ Cloudflare Stream live input ──simulcast──▶ YouTube (unlisted)
   │                         │                                         │
   │ USB recording           │ recording ready (webhook)               │ Data API
   ▼ (local backup)          ▼                                         ▼
 USB SSD             ctk-live Worker ─────────────────────────▶ /status for the site
                     (livestream.christtheking.build)              (YouTube video ID)
                       ├─ copies recording → Google Drive folder
                       ├─ Sunday health check (cron, every minute)
                       ├─ email alerts (Cloudflare Email)
                       ├─ /admin dashboard (Google sign-in, People list)
                       └─ D1 database: people, settings, streams, log

                └──────────── fallback path: ATEM ──RTMP──▶ YouTube direct ─────────┘
```

- **The website keeps embedding YouTube** whichever path the stream takes. The
  Worker still finds the live video through the YouTube Data API (stage 0), so
  the /livestream page works the same on the normal and fallback paths.
- **Cloudflare is only the recorder and relay.** It gives us a recording we own
  and a reliable "the ATEM is sending" signal.
- **One Worker does everything** (`live-worker/`), with a D1 database for state.
  Nothing runs on anyone's computer.

---

## Stage 0: stop false "live" (done, needs deploy)

Sunday 2026-11-22 the page showed LIVE two hours after the service: the
broadcast was never ended in YouTube Studio, so YouTube still called it live.

- Worker: a broadcast counts as live only if it's `live` **and** its ingest
  stream is receiving video (`liveStreams` `streamStatus: active`).
- `site/livestreamresolver-2.5.0.js`: keeps checking every minute while live,
  switches back to the offline message when the stream ends.

**To ship:** `npx wrangler deploy` from `live-worker/` (CTK Cloudflare login);
register resolver 2.5.0 in Webflow in place of 2.4.0 and publish.
**Also:** turn on **Auto-stop** in YouTube Studio's stream settings.

---

## Stage 1: recording → Google Drive

**Workflow on a Sunday**

1. Operator starts streaming on the ATEM as usual. Destination: Cloudflare.
2. Cloudflare receives it, records it, and forwards it to YouTube with the
   church's YouTube stream key.
3. Operator stops the stream. Cloudflare finishes the recording (usually a few
   minutes) and calls the Worker's webhook.
4. The Worker streams the MP4 from Cloudflare into the Drive folder (resumable
   upload, so a 2–4 GB file never sits in memory), named
   `YYYY-MM-DD HHmm Livestream.mp4` in Central time.
5. The stream, recording and Drive link are written to the log. Stage 3 adds
   the "recording is in Drive" email.

**Build**

- Cloudflare Stream live input with recording on, plus one live output
  (simulcast) to YouTube's RTMP URL and stream key.
- Webhook endpoint in the Worker, signature-checked.
- Google Drive upload with the church's Google account (one-time sign-in,
  scope limited to the files the app creates, `drive.file`). The refresh token
  lives in KV next to the YouTube one.
- Retries with backoff; a recording stays in Cloudflare until it's confirmed in
  Drive, then is deleted after the retention period (default 30 days).
- Mid-service restart = two recordings; both are copied, time in the name
  keeps them apart.

**Open questions**

- ~~ATEM model~~: **ATEM SDI Pro ISO** (confirmed 2026-11-23). Blackmagic's
  9.5 switcher update added SRT streaming to it, and Cloudflare Stream accepts
  SRT, so it can feed Cloudflare directly. Update both the switcher firmware and
  ATEM Software Control to the latest 9.x (some guides say 9.6+ for SRT) and
  check the installed version before the first test. Being an ISO model, its
  USB recording also keeps each camera input as a separate file, which helps
  if a sermon ever needs re-editing from the raw angles.
- Which Drive folder (and which Google account owns it).
- Does Cloudflare's download link for large recordings stream cleanly through a
  Worker into Drive within Worker limits? Prototype this first; if not, use a
  Cloudflare Queue consumer or Workflow to do the copy in steps.

---

## Stage 2: dashboard at `/admin`

**Sign-in**

- "Sign in with Google" using the existing Google Cloud project ("CTK Live").
  Scopes: `openid email` only.
- **Only people on the People list get in**, any Google account (church or not).
  Unlisted accounts are refused even if signed in to Google.
- First admins are seeded from the Worker secret `ADMIN_SEED` (comma-separated
  emails), read only while the People table is empty. After that the list is
  managed on the People page. Addresses are **not** committed: this repo is
  public.
- Sessions: signed, HttpOnly cookie, 30 days, stored in D1 so removing someone
  ends their session on the next request. CSRF token on every form.
- Roles: **admin** (everything, including People and Settings) and
  **volunteer** (status, recordings, log, operational buttons). Everyone in the
  first invite is an admin.

**Pages**

| Page | Shows | Actions |
|---|---|---|
| Status | ATEM → Cloudflare connected? YouTube receiving? What the site shows. Last health check. | Refresh live link |
| Recordings | Past streams: start/end, recording state, Drive copy state + link | Retry Drive copy, mark as test stream |
| People | Who can sign in, role, alert subscriptions | Add, remove, change role |
| Notifications | Which alerts exist, who gets each | Send test email, mute this Sunday |
| Settings | Drive folder, health-check window, recording retention | Edit (admins) |
| Log | Timestamped events, filter by Sunday, 90 days | — |
| Runbook | ATEM switch-over steps, what each alert means | Edit (admins) |

The main address `livestream.christtheking.build/` keeps redirecting visitors
to the stream; `/status` stays public for the website.

**Storage:** one D1 database, tables `people`, `sessions`, `settings`,
`streams`, `log`, `alerts`. Free tier is plenty.

---

## Stage 3: email alerts and Sunday health checks

**Alerts**

| Alert | When | Default recipients |
|---|---|---|
| Not reaching YouTube | Cloudflare has the ATEM's feed but YouTube isn't receiving for 2+ minutes | Admins |
| ATEM not sending | Inside the service window, no feed at Cloudflare by start time + 5 min | Admins |
| Recording in Drive | Copy finished (with link) | Opt-in |
| Recording failed | No recording after the stream, or Drive copy still failing after retries | Admins |
| YouTube sign-in lost | Data API says not authorized | Admins |
| Still live after service | YouTube still live 30 min after the ATEM stopped (Auto-stop off) | Admins |

Each alert is per person on the Notifications page; repeats are throttled (one
email per alert per 15 minutes) so a flapping feed doesn't flood inboxes.

**Health check:** a cron trigger every minute, doing work only inside the
service window (default Sundays 9:00 AM–12:30 PM Central, set on Settings).

**Sending email through Cloudflare**

- `christtheking.build`'s mail is on Google Workspace, so **do not turn on
  Email Routing for the root domain**: it would replace the MX records and stop
  church email. Turn it on for a subdomain instead (e.g.
  `notify.christtheking.build`) and send from `livestream@notify.christtheking.build`.
- The Workers `send_email` binding only delivers to **verified destination
  addresses**. Adding someone on the People page should call the Cloudflare
  API to add their address as a destination, which sends them a one-time
  "verify" email from Cloudflare. The People page shows "email not verified
  yet" until they click it. Needs an API token with Email Routing edit rights.
- Check first whether Cloudflare's newer Email Sending service is available on
  the account; if it can send to any address, skip the verification step.
- **Fallback** if neither works well: a transactional provider (e.g. Resend,
  free tier) behind the same alert code.

**Known limit:** phones are often silenced during the service, so an email can
be missed in the moment. Revisit push notifications (e.g. Pushover critical
alerts) if that turns out to matter.

---

## Stage 4: runbook and polish

- Runbook page (editable): switching the ATEM to YouTube direct, where the USB
  recording is, what each alert means, who to call.
- Delete recordings from Cloudflare after the retention period, only once Drive
  has them.
- Weekly summary email (optional): what streamed, what's in Drive, any alerts.

---

## Contingencies

| What fails | Effect | Fallback |
|---|---|---|
| Cloudflare ingest down | Nothing reaches YouTube | Operator switches the ATEM to the saved **YouTube direct** destination (seconds). "ATEM not sending"/"Not reaching YouTube" alert says so. |
| Simulcast to YouTube fails, ingest fine | YouTube blank, ATEM looks fine | Health check sees Cloudflare connected + YouTube not receiving → "Not reaching YouTube" email → switch the ATEM to YouTube direct. |
| Cloudflare recording missing/broken, or streamed direct | Nothing to copy | ATEM **USB recording** (always on). "Recording failed" email says where to get it; or download from YouTube Studio. |
| Drive copy fails | File not in Drive yet | Automatic retries; recording kept in Cloudflare 30 days; Retry button; alert after retries run out. |
| Stream restarts mid-service | Two recordings, new YouTube video ID | Both copied; the live link heals within 5 min, or Refresh live link. |
| Worker down | Site can't tell if live | Page shows offline + Watch on YouTube; YouTube unaffected; no alerts that day. |
| YouTube sign-in revoked | Site can't find the live video | Alert; re-run `/auth/start` sign-in (see README). |
| Broadcast never ended | YouTube "live" with no video | Stage 0 already hides it on the site; turn on Auto-stop; "Still live" alert. |
| Google sign-in to dashboard broken | Can't open `/admin` | Recording and alerts keep working; fix from Cloudflare by someone with the login. |

**One rule:** never send to YouTube from both Cloudflare and the ATEM on the
same stream key at once. The switch-over is either/or.

---

## What's needed, and from whom

| Item | Who | For stage |
|---|---|---|
| Deploy the Worker (`npx wrangler deploy`), set secrets | Someone with the CTK Cloudflare login | 0+ |
| Register resolver 2.5.0 in Webflow and publish | Josh (or Claude via the Webflow connection) | 0 |
| Turn on Auto-stop in YouTube Studio | Media team | 0 |
| Update ATEM SDI Pro ISO firmware + ATEM Software Control to latest 9.x (SRT needs 9.5+) | Media team | 1 |
| Turn on Cloudflare Stream (about $5/month) | CTK Cloudflare account owner | 1 |
| YouTube stream key into the Cloudflare live output | Media team | 1 |
| ATEM: save the Cloudflare destination and keep YouTube direct as a second one; USB recording on | Media team | 1 |
| Choose the Drive folder; one-time Google sign-in for Drive | Josh / media team | 1 |
| Add the dashboard's redirect URL and `openid email` scopes to the "CTK Live" Google project | Google Cloud project owner | 2 |
| `ADMIN_SEED` secret (first admins) | Josh | 2 |
| Email Routing on a `notify.` subdomain; API token for adding destination addresses | CTK Cloudflare account owner | 3 |
| Each person clicks Cloudflare's verify email once | Everyone on the People list | 3 |

**Secrets** (`wrangler secret put`, never committed): `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `SETUP_KEY` (existing); `ADMIN_SEED`, `SESSION_SECRET`,
`CF_STREAM_WEBHOOK_SECRET`, `CF_API_TOKEN` (new).

## Rough running cost

| Item | Cost |
|---|---|
| Cloudflare Stream (recordings deleted after 30 days) | about $5/month |
| Workers, D1, KV, cron, Email Routing | free tier |
| Google sign-in, Drive API, YouTube Data API | free |

Prices as of late 2026 knowledge; check Cloudflare's pricing page before
turning Stream on.
