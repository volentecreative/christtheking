# ctk-live — livestream lookup Worker

Sunday streams go out from the ATEM as **unlisted**, so YouTube's public
`/@channel/live` URL and search can't find them. This Cloudflare Worker is
signed in to the CTK YouTube channel (read-only) and asks the Data API what's
live right now.

Live at **https://livestream.christtheking.build**

| Path | Returns |
|---|---|
| `/` | 302 to the live stream → a stream scheduled within 3h → the channel's Videos tab |
| `/status` | JSON `{ state, videoId, url }` (CORS-open, for the site's /livestream page) |
| `/embed` | Bare player page for an iframe |
| `/auth/start?key=SETUP_KEY` | One-time Google sign-in as the channel |

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
