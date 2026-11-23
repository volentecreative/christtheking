# ctk-live — livestream lookup Worker

Sunday streams go out from the ATEM as **unlisted**, so YouTube's public
`/@channel/live` URL and search can't find them. This Cloudflare Worker is
signed in to the CTK YouTube channel (read-only) and asks the Data API what's
live right now.

Live at **https://livestream.christtheking.build**

Where this is heading (Cloudflare recording → Google Drive, dashboard, email
alerts, fallbacks): see [ROADMAP.md](ROADMAP.md).

| Path | Returns |
|---|---|
| `/` | 302 to the live stream, else the channel's Videos tab |
| `/status` | JSON `{ state, videoId, url }` (CORS-open, for the site's /livestream page) |
| `/embed` | Bare player page for an iframe |
| `/refresh?key=SETUP_KEY` | Forget the cached link and look again (use after a mid-service stream restart) |
| `/auth/start?key=SETUP_KEY` | One-time Google sign-in as the channel |

## Caching

Lookups are on demand. "Nothing live" is cached 30 seconds per Cloudflare location.
Once a live stream is found, its link is kept for **5 minutes**
(KV, global), so during a service visitors share one lookup. If the ATEM stream
restarts mid-service (new video ID), open `/refresh?key=…` to switch everyone over
at once.

## What counts as live

A broadcast must be `live` in YouTube **and** its bound ingest stream must be
receiving video (`liveStreams` `streamStatus: active`, not `noData`). With
auto-stop off, YouTube leaves a broadcast `live` after the ATEM stops sending
until someone clicks End stream in Studio; the second check stops the site from
showing a dead player in that case (2026-11-22). Worst case after the ATEM stops:
5 minutes (the cached live link), plus up to a minute for an open page to re-check
(resolver 2.5.0+).

## Where things live

- **Cloudflare:** "Christ the King Church" account (mediamen@christtheking.build).
  KV namespace `STATE` holds the refresh token.
- **Google Cloud:** project "CTK Live" (`single-arcana-515420-r1`) under
  christtheking.build. OAuth app is External + In production (the channel is a
  Brand Account, so Internal rejects it with `org_internal`).
- **Secrets** (`wrangler secret put`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SETUP_KEY`.

## Deploy

```bash
cd live-worker
npx wrangler deploy        # must be logged in to the CTK Cloudflare account
```

## If it stops finding streams

`/status` returning `"not-authorized"` or a 500 usually means the channel's
access was revoked. Re-run the sign-in: open `/auth/start?key=<SETUP_KEY>`,
pick **Media Men → Christ the King Church in Stillwater MN**, click through
"Google hasn't verified this app" (Advanced → continue), Allow.
