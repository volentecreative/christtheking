/**
 * The channel's Atom feed — the one upload-date source that survives a bot check.
 *
 * When YouTube gates the per-video player endpoint, a video's upload timestamp
 * is unreachable through yt-dlp, and an item created from the channel listing
 * alone has no date. This feed is plain XML on a different path: no key, no
 * session, no player, and it carries an EXACT <published> stamp for each of the
 * channel's most recent uploads — precisely the set a blocked run is creating.
 *
 * It replaces nothing else. The feed holds only the newest ~15 videos and no
 * duration, description or captions, so it is read only on the partial path.
 */

const FEED_URL = 'https://www.youtube.com/feeds/videos.xml';

const VIDEO_ID = /<yt:videoId>([^<]+)<\/yt:videoId>/;
const PUBLISHED = /<published>([^<]+)<\/published>/;

/**
 * Atom XML → Map of video id to ISO timestamp.
 *
 * Split rather than parsed: the feed is a flat list of <entry> blocks with no
 * nesting to track, and this keeps the project dependency-free.
 *
 * `published`, never `updated` — the latter moves when a title or description
 * is edited, which would silently redate a sermon years after the fact.
 */
export function parseFeedDates(xml) {
  const dates = new Map();

  for (const entry of String(xml || '').split('<entry').slice(1)) {
    const id = VIDEO_ID.exec(entry);
    const published = PUBLISHED.exec(entry);
    if (!id || !published) continue;

    const when = new Date(published[1].trim());
    if (Number.isNaN(when.getTime())) continue;

    dates.set(id[1].trim(), when.toISOString());
  }

  return dates;
}

/**
 * Upload dates for the channel's most recent videos.
 *
 * Throws on a network or HTTP problem — the caller treats that as "no dates
 * this run", never as a reason to stop. The feed only accepts a UC… channel id;
 * a @handle is not a valid value for it.
 */
export async function fetchChannelFeedDates(channelId, { timeoutMs = 15_000 } = {}) {
  if (!channelId) return new Map();

  const response = await fetch(`${FEED_URL}?channel_id=${encodeURIComponent(channelId)}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/atom+xml' },
  });

  if (!response.ok) throw new Error(`the feed responded ${response.status}`);

  return parseFeedDates(await response.text());
}
