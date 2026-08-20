/**
 * Matching helpers for the CTK podcast sync (Apple Podcasts → Webflow Media).
 *
 * Pure and dependency-free so the matching can be tested offline against real
 * fixtures — which matters, because a bad match writes the wrong audio file
 * onto the wrong sermon.
 *
 * The primary key is DURATION, not title. Measured against the live data, the
 * podcast audio and the YouTube video differ by exactly 1 second every time
 * (YouTube rounds up), which makes duration a near-unique fingerprint. Titles
 * are unreliable here: YouTube says "Sing: Part 2 of 3 | Congregational Worship
 * - Part 6" where the podcast says "Andy Naselli - Sing: Part 2 of 3—Why Should
 * a Church Continually Sing the Psalms?". Dates drift too — the podcast
 * normalizes to Sunday 10:00 UTC while YouTube uses the real upload time.
 */

/** Podcast titles prefix sermons with the preacher, exhortations with "Exhortation". */
const GENERIC_PREFIXES = ['exhortation', 'sermon', 'sunday sermon'];

export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[’‘']/g, "'")
    .replace(/[—–]/g, '-')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split a leading "Andy Naselli - " or "Exhortation - " off a podcast title.
 * Only strips a person's name when it matches a known speaker, so a title like
 * "Build and Fight - Part 2" keeps its words.
 */
export function splitPodcastTitle(title, speakerNames = []) {
  const raw = String(title || '').trim();
  const dash = raw.search(/\s[-–—]\s/);
  if (dash === -1) return { speaker: null, title: raw };

  const head = raw.slice(0, dash).trim();
  const tail = raw.slice(dash + 3).trim();
  const headNorm = normalizeTitle(head);

  if (GENERIC_PREFIXES.includes(headNorm)) return { speaker: null, title: tail };

  const speaker = findSpeaker(head, speakerNames);
  if (speaker) return { speaker, title: tail };

  return { speaker: null, title: raw };
}

/**
 * Resolve a name from a podcast title against the Speakers collection,
 * tolerating first-name variants: the podcast says "Clinton Manley" where the
 * CMS says "Clint Manley", and "Thomas Dodds" vs "Tom Dodds". Surnames must
 * match exactly and one first name must be a prefix of the other, so
 * "John Piper" never collapses into "James Piper".
 *
 * Returns the CANONICAL name as spelled in the collection, so the caller can
 * look up the record id with it.
 */
const NICKNAMES = [
  ['tom', 'thomas'], ['clint', 'clinton'], ['andy', 'andrew'], ['nate', 'nathan'],
  ['jim', 'james'], ['bob', 'rob', 'robert'], ['bill', 'will', 'william'],
  ['dave', 'david'], ['mike', 'michael'], ['chris', 'christopher'],
  ['dan', 'daniel'], ['joe', 'joseph'], ['matt', 'matthew'], ['nick', 'nicholas'],
  ['steve', 'stephen', 'steven'], ['tony', 'anthony'], ['ben', 'benjamin'],
  ['sam', 'samuel'], ['greg', 'gregory'], ['jon', 'jonathan'], ['ken', 'kenneth'],
  ['rick', 'richard'], ['ron', 'ronald'], ['josh', 'joshua'], ['zach', 'zachary'],
];

/** Do two first names refer to the same person? Prefix OR known nickname. */
function sameFirstName(a, b) {
  if (a === b) return true;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 3 && longer.startsWith(shorter)) return true;

  return NICKNAMES.some((group) => group.includes(a) && group.includes(b));
}

export function findSpeaker(candidate, speakerNames = []) {
  const norm = normalizeTitle(candidate);
  if (!norm) return null;

  const exact = speakerNames.find((name) => normalizeTitle(name) === norm);
  if (exact) return exact;

  const parts = norm.split(' ');
  if (parts.length < 2) return null;
  const first = parts[0];
  const last = parts[parts.length - 1];

  const variants = speakerNames.filter((name) => {
    const other = normalizeTitle(name).split(' ');
    if (other.length < 2) return false;
    if (other[other.length - 1] !== last) return false;

    return sameFirstName(first, other[0]);
  });

  return variants.length === 1 ? variants[0] : null;
}

/** Drop a YouTube-style " | Series - Part 4" suffix. */
export function stripSeriesSuffix(title) {
  const bar = String(title || '').indexOf('|');
  return bar === -1 ? String(title || '').trim() : String(title).slice(0, bar).trim();
}

/** Jaccard overlap of word sets — 0 to 1. Order-insensitive and length-tolerant. */
export function titleSimilarity(a, b) {
  const wordsA = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const wordsB = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (!wordsA.size || !wordsB.size) return 0;

  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared++;
  return shared / (wordsA.size + wordsB.size - shared);
}

const DAY = 86_400_000;

export function daysApart(a, b) {
  const timeA = new Date(a).getTime();
  const timeB = new Date(b).getTime();
  if (Number.isNaN(timeA) || Number.isNaN(timeB)) return Infinity;
  return Math.abs(timeA - timeB) / DAY;
}

export const MATCH_RULES = {
  durationSlackSeconds: 3, // observed delta is exactly 1s; 3s is generous
  dateWindowDays: 21, // podcast pubDate snaps to Sunday, YouTube is upload time
  titleFallbackSimilarity: 0.55, // only when duration can't decide
  titleCorroboration: 0.15, // a duration match still needs *some* word overlap
  // A duration match with a strong title but a FAR-APART date is still a match.
  // CTK bulk-uploaded its archive to YouTube on 2025-04-23, so 26 videos carry
  // that upload date while the podcast has the real preaching dates, years off.
  // Requiring a close date on every rule left all 26 unmatched.
  titleWithoutDate: 0.45,
};

/**
 * Match Webflow media items to podcast episodes.
 *
 * Returns { matches, ambiguous, unmatchedItems, unmatchedEpisodes }. Anything
 * the rules can't decide confidently lands in `ambiguous` rather than being
 * guessed — a wrong audio file on a sermon is worse than a blank field.
 */
export function matchEpisodes(items, episodes, { speakers = [], rules = MATCH_RULES } = {}) {
  const speakerNames = speakers.map((s) => s.name).filter(Boolean);

  const prepared = episodes.map((ep, index) => {
    const { speaker, title } = splitPodcastTitle(ep.title, speakerNames);
    return { ...ep, index, speaker, cleanTitle: title };
  });

  const scored = [];

  for (const item of items) {
    const itemTitle = stripSeriesSuffix(item.title);
    const duration = Number(item.durationSeconds) || 0;

    for (const ep of prepared) {
      const epDuration = Number(ep.durationSeconds) || 0;
      const durationDelta =
        duration && epDuration ? Math.abs(duration - epDuration) : Infinity;
      const dateDelta = daysApart(item.date, ep.date);
      const similarity = titleSimilarity(itemTitle, ep.cleanTitle);

      const durationHit = durationDelta <= rules.durationSlackSeconds;
      const dateHit = dateDelta <= rules.dateWindowDays;

      let confidence = 0;
      let basis = null;

      if (durationHit && dateHit && similarity >= rules.titleCorroboration) {
        confidence = 4;
        basis = 'duration+date+title';
      } else if (durationHit && dateHit) {
        confidence = 3;
        basis = 'duration+date';
      } else if (durationHit && similarity >= rules.titleWithoutDate) {
        confidence = 2;
        basis = 'duration+title';
      } else if (dateHit && similarity >= rules.titleFallbackSimilarity) {
        confidence = 1;
        basis = 'date+title';
      }

      if (confidence) {
        scored.push({ item, ep, confidence, basis, durationDelta, dateDelta, similarity });
      }
    }
  }

  // Best-first, so a strong pairing claims both sides before a weaker one can.
  scored.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.durationDelta - b.durationDelta ||
      b.similarity - a.similarity ||
      a.dateDelta - b.dateDelta
  );

  const matches = [];
  const takenItems = new Set();
  const takenEpisodes = new Set();
  const contested = [];

  for (const candidate of scored) {
    const itemKey = candidate.item.id;
    const epKey = candidate.ep.guid;

    if (takenItems.has(itemKey) || takenEpisodes.has(epKey)) {
      contested.push(candidate);
      continue;
    }
    takenItems.add(itemKey);
    takenEpisodes.add(epKey);
    matches.push(candidate);
  }

  // A loser only matters if BOTH of its sides ended up unmatched.
  const ambiguous = contested.filter(
    (c) => !takenItems.has(c.item.id) || !takenEpisodes.has(c.ep.guid)
  );

  return {
    matches,
    ambiguous,
    unmatchedItems: items.filter((i) => !takenItems.has(i.id)),
    unmatchedEpisodes: prepared.filter((e) => !takenEpisodes.has(e.guid)),
  };
}

/** Apple's lookup payload → the episode shape the matcher wants. */
export function parseAppleEpisodes(payload) {
  const results = (payload && payload.results) || [];
  return results
    .filter((r) => r.wrapperType === 'podcastEpisode' && r.episodeGuid)
    .map((r) => ({
      guid: r.episodeGuid,
      title: r.trackName || '',
      date: r.releaseDate || null,
      durationSeconds: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : null,
      appleUrl: (r.trackViewUrl || '').split('?')[0] || null,
      audioUrl: r.episodeUrl || null,
    }));
}

/** Spotify's show-episodes payload → the same shape. */
export function parseSpotifyEpisodes(pages) {
  const all = [];
  for (const page of pages || []) {
    for (const ep of (page && page.items) || []) {
      if (!ep) continue;
      all.push({
        guid: ep.id,
        title: ep.name || '',
        date: ep.release_date || null,
        durationSeconds: ep.duration_ms ? Math.round(ep.duration_ms / 1000) : null,
        spotifyUrl: (ep.external_urls && ep.external_urls.spotify) || null,
      });
    }
  }
  return all;
}
