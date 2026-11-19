/**
 * YouTube thumbnails without the player endpoint.
 *
 * Thumbnails live at fixed URLs on i.ytimg.com, one per video id and quality.
 * That is a plain image CDN — no player, no key, no session, and none of the bot
 * gating that blocks the per-video metadata fetch. So an item created or filled
 * while YouTube is refusing to describe a video can still get its real artwork,
 * which is the difference between a sermon that looks published and one that
 * looks broken.
 *
 * Which files exist depends on the source upload, so the qualities are PROBED
 * best-first rather than assumed. maxresdefault is what yt-dlp reports for a
 * modern 1080p upload, so a probed URL is normally the exact one a full fetch
 * would have written — nothing to reconcile later.
 */

const HOST = 'https://i.ytimg.com';

/**
 * Best first. hqdefault is last because YouTube generates it for every video,
 * so it is the one that always answers.
 */
export const QUALITIES = ['maxresdefault', 'sddefault', 'hqdefault'];

/**
 * WebP before JPEG at every quality. YouTube serves the same frame at the same
 * size from /vi_webp/, at roughly 40% of the bytes (1280x720: ~25-40 KB against
 * ~55-95 KB). Webflow re-hosts an Image field's URL byte for byte and Collection
 * List images get no srcset, so this file is exactly what every Media card
 * downloads - the format is the bandwidth saving.
 */
export const FORMATS = ['webp', 'jpg'];

export function thumbnailUrl(videoId, quality, format = 'jpg') {
  const dir = format === 'webp' ? 'vi_webp' : 'vi';
  return `${HOST}/${dir}/${encodeURIComponent(videoId)}/${quality}.${format}`;
}

const YTIMG = /^https?:\/\/i\.ytimg\.com\/(?:vi|vi_webp)\/([\w-]{11})\/([a-z0-9]+)\.(?:jpg|webp)(?:\?.*)?$/i;

async function exists(url, timeoutMs) {
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The WebP twin of an i.ytimg.com thumbnail URL when YouTube has one, else the
 * URL unchanged. Anything that isn't an i.ytimg.com thumbnail passes straight
 * through, and so does every failure: this can only ever make a thumbnail
 * lighter, never take one away.
 */
export async function preferWebp(url, { timeoutMs = 10_000 } = {}) {
  const match = typeof url === 'string' ? YTIMG.exec(url) : null;
  if (!match) return url;
  const webp = thumbnailUrl(match[1], match[2], 'webp');
  if (webp === url) return url;
  return (await exists(webp, timeoutMs)) ? webp : url;
}

/**
 * The best thumbnail that actually exists for a video, or null.
 *
 * Deliberately never throws. A thumbnail that can't be resolved leaves the
 * Webflow field empty, and an empty field is what the next successful full
 * fetch fills in — so failing quietly here costs nothing but a re-run.
 */
export async function resolveThumbnailUrl(videoId, { timeoutMs = 10_000 } = {}) {
  for (const quality of QUALITIES) {
    for (const format of FORMATS) {
      // Trouble on one quality or format shouldn't stop the others being tried.
      const url = thumbnailUrl(videoId, quality, format);
      if (await exists(url, timeoutMs)) return url;
    }
  }
  return null;
}
