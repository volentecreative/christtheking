/**
 * CTK livestream redirect.
 *
 * The Sunday stream goes out from the ATEM as UNLISTED, so youtube.com/@channel/live
 * can't see it. This Worker asks the YouTube Data API — signed in as the channel —
 * for the broadcast that's live right now, and sends visitors there.
 *
 *   GET /           → 302 to the live stream, else a stream starting soon, else FALLBACK_URL
 *   GET /embed      → a bare page with the current stream in an <iframe> (for a Webflow embed)
 *   GET /status     → JSON: what / and /embed would show (debugging)
 *   GET /auth/start?key=SETUP_KEY → one-time Google sign-in as the channel
 *   GET /auth/callback            → stores the refresh token in KV
 *
 * Secrets:  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SETUP_KEY
 * Vars:     CHANNEL_ID, FALLBACK_URL
 * KV:       STATE  (refresh_token, cached access token)
 */

const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const RESULT_TTL = 60; // seconds to cache the "what's live" answer
const UPCOMING_WINDOW_MS = 3 * 60 * 60 * 1000; // treat a scheduled stream as "now" within 3h

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      switch (url.pathname.replace(/\/+$/, '') || '/') {
        case '/':
          return redirectTo(await currentTarget(env, ctx));
        case '/embed':
          return embedPage(await currentTarget(env, ctx), env);
        case '/status':
          return json(await currentTarget(env, ctx));
        case '/refresh':
          return refresh(url, env);
        case '/auth/start':
          return authStart(url, env);
        case '/auth/callback':
          return authCallback(url, env);
        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (err) {
      console.error(err);
      // Never strand a visitor on an error page: fall back to the channel.
      if (url.pathname === '/' ) return redirectTo({ url: env.FALLBACK_URL, state: 'error' });
      return new Response('Something went wrong', { status: 500 });
    }
  },
};

// ---------------------------------------------------------------------------
// What's live?

// A live stream's link is held in KV (global) for LIVE_TTL so the whole service
// is one lookup; /refresh clears it if the stream restarts with a new video ID.
// "Nothing live" is held only RESULT_TTL in the local cache so 10:00 is noticed fast.
const LIVE_TTL = 15 * 60;
const OFFLINE_CACHE_KEY = 'https://cache.internal/ctk-live-target';

async function currentTarget(env, ctx) {
  const live = await env.STATE.get('live_target', 'json');
  if (live) return live;

  const cache = caches.default;
  const cacheKey = new Request(OFFLINE_CACHE_KEY);
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const target = await lookupTarget(env);
  if (target.state === 'live') {
    await env.STATE.put('live_target', JSON.stringify(target), { expirationTtl: LIVE_TTL });
    return target;
  }
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(target), {
        headers: { 'Cache-Control': `max-age=${RESULT_TTL}`, 'Content-Type': 'application/json' },
      })
    )
  );
  return target;
}

async function lookupTarget(env) {
  const token = await accessToken(env);
  if (!token) return { state: 'not-authorized', url: env.FALLBACK_URL };

  // broadcastType=all includes the ATEM's default ("persistent") stream-key broadcast.
  const active = await listBroadcasts(token, 'active');
  const live = active.find((b) => b.status?.lifeCycleStatus === 'live') || active[0];
  if (live) return target('live', live);

  const upcoming = await listBroadcasts(token, 'upcoming');
  const now = Date.now();
  const soon = upcoming
    .filter((b) => b.snippet?.isDefaultBroadcast !== true) // idle stream-key placeholder isn't a real event
    .filter((b) => {
      const t = Date.parse(b.snippet?.scheduledStartTime || '');
      return t && t - now < UPCOMING_WINDOW_MS && now - t < UPCOMING_WINDOW_MS;
    })
    .sort((a, b) => Date.parse(a.snippet.scheduledStartTime) - Date.parse(b.snippet.scheduledStartTime))[0];
  if (soon) return target('upcoming', soon);

  return { state: 'offline', url: env.FALLBACK_URL };
}

function target(state, b) {
  return {
    state,
    videoId: b.id,
    title: b.snippet?.title || '',
    url: `https://www.youtube.com/watch?v=${b.id}`,
  };
}

async function listBroadcasts(token, broadcastStatus) {
  const api = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts');
  api.searchParams.set('part', 'id,snippet,status');
  api.searchParams.set('broadcastStatus', broadcastStatus);
  api.searchParams.set('broadcastType', 'all');
  api.searchParams.set('maxResults', '10');
  const res = await fetch(api, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`liveBroadcasts ${broadcastStatus}: ${res.status} ${await res.text()}`);
  return (await res.json()).items || [];
}

// After a mid-service stream restart: forget the cached link and look again.
async function refresh(url, env) {
  if (!env.SETUP_KEY || url.searchParams.get('key') !== env.SETUP_KEY) {
    return new Response('Forbidden', { status: 403 });
  }
  await env.STATE.delete('live_target');
  await caches.default.delete(new Request(OFFLINE_CACHE_KEY));
  const t = await lookupTarget(env);
  if (t.state === 'live') await env.STATE.put('live_target', JSON.stringify(t), { expirationTtl: LIVE_TTL });
  const msg = t.videoId
    ? `<p>Now pointing to <b>${escapeHtml(t.title)}</b> (${t.state}).</p><p><a href="${t.url}">${t.url}</a></p>`
    : `<p>Nothing is live yet. Give YouTube a minute after the stream starts, then refresh this page.</p>`;
  return page('Livestream link refreshed', msg);
}

// ---------------------------------------------------------------------------
// Google OAuth

async function accessToken(env) {
  const cached = await env.STATE.get('access_token', 'json');
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;

  const refresh = await env.STATE.get('refresh_token');
  if (!refresh) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`token refresh: ${res.status} ${await res.text()}`);
  const data = await res.json();
  await env.STATE.put(
    'access_token',
    JSON.stringify({ token: data.access_token, expires: Date.now() + data.expires_in * 1000 }),
    { expirationTtl: Math.max(60, data.expires_in) }
  );
  return data.access_token;
}

function redirectUri(url) {
  return `${url.origin}/auth/callback`;
}

function authStart(url, env) {
  if (!env.SETUP_KEY || url.searchParams.get('key') !== env.SETUP_KEY) {
    return new Response('Forbidden', { status: 403 });
  }
  const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  google.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  google.searchParams.set('redirect_uri', redirectUri(url));
  google.searchParams.set('response_type', 'code');
  google.searchParams.set('scope', SCOPE);
  google.searchParams.set('access_type', 'offline');
  google.searchParams.set('prompt', 'consent select_account');
  google.searchParams.set('state', env.SETUP_KEY);
  return Response.redirect(google.toString(), 302);
}

async function authCallback(url, env) {
  if (url.searchParams.get('state') !== env.SETUP_KEY) return new Response('Forbidden', { status: 403 });
  const code = url.searchParams.get('code');
  if (!code) return page('Sign-in cancelled', `<p>${escapeHtml(url.searchParams.get('error') || 'No code returned.')}</p>`);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(url),
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) {
    return page('Sign-in failed', `<p>Google didn't return a refresh token. Try again.</p>`);
  }

  // Make sure they picked the CTK channel, not a personal one.
  const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${data.access_token}` },
  }).then((r) => r.json());
  const channel = ch.items?.[0];
  if (!channel || channel.id !== env.CHANNEL_ID) {
    return page(
      'Wrong channel',
      `<p>You signed in as <b>${escapeHtml(channel?.snippet?.title || 'a channel with no YouTube channel')}</b>.
       Start over and choose <b>Christ the King Church in Stillwater MN</b> on the account picker.</p>`
    );
  }

  await env.STATE.put('refresh_token', data.refresh_token);
  await env.STATE.delete('access_token');
  return page('Connected', `<p>Connected to <b>${escapeHtml(channel.snippet.title)}</b>. You can close this tab.</p>`);
}

// ---------------------------------------------------------------------------
// Responses

function redirectTo(t) {
  return new Response(null, {
    status: 302,
    headers: { Location: t.url, 'Cache-Control': 'no-store' },
  });
}

function embedPage(t, env) {
  const body = t.videoId
    ? `<iframe src="https://www.youtube.com/embed/${t.videoId}?autoplay=1&mute=1" title="${escapeHtml(t.title)}"
         allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`
    : `<div class="off"><p>We're not live right now.</p>
         <a href="${escapeHtml(env.FALLBACK_URL)}" target="_top">Watch past sermons</a></div>`;
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%}
.off{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font:1rem/1.4 system-ui,sans-serif}
.off a{color:#fff}</style>${body}`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': `max-age=${RESULT_TTL}` } }
  );
}

function page(title, html) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:1rem/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1>${html}</body>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      // The /livestream page on christtheking.build reads this from the browser.
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
