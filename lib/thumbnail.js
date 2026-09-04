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

const CDN = 'https://i.ytimg.com/vi';

/**
 * Best first. hqdefault is last because YouTube generates it for every video,
 * so it is the one that always answers.
 */
export const QUALITIES = ['maxresdefault', 'sddefault', 'hqdefault'];

export function thumbnailUrl(videoId, quality) {
  return `${CDN}/${encodeURIComponent(videoId)}/${quality}.jpg`;
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
    const url = thumbnailUrl(videoId, quality);
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return url;
    } catch {
      // Trouble on one quality shouldn't stop the others being tried.
    }
  }
  return null;
}
