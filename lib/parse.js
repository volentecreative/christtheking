/**
 * Pure parsing / mapping helpers for the CTK YouTube → Webflow sync.
 * Kept dependency-free and side-effect-free so they can be unit tested offline.
 */

/* ------------------------------------------------------------------ *
 * Text helpers
 * ------------------------------------------------------------------ */

export function slugify(input, { maxLength = 240 } = {}) {
  return String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’‘`]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '') || 'untitled';
}

/** Make a slug unique against a set of slugs already in the collection. */
export function uniqueSlug(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Seconds → "1:23:45" / "4:05" / "0:07" */
export function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * WebVTT → cue list
 * ------------------------------------------------------------------ */

const TIMECODE_RE =
  /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s+-->\s+(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;

function timecodeToSeconds(h, m, s, ms) {
  return (
    Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0) + Number(ms || 0) / 1000
  );
}

function stripCueMarkup(line) {
  return line
    .replace(/<[^>]*>/g, '')          // <c>, <00:00:01.234>, <v Speaker>
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\[\s*(?:music|applause|laughter|inaudible)\s*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a WebVTT file into [{ start, text }].
 *
 * YouTube auto-captions are "rolling": each cue repeats the previous cue's
 * last line before adding new words. We drop any line that already appeared
 * in the immediately preceding cue, which collapses the roll into clean prose.
 */
export function parseVtt(vtt) {
  const lines = String(vtt || '').replace(/\r/g, '').split('\n');
  const cues = [];
  let previousLines = [];

  for (let i = 0; i < lines.length; i++) {
    const match = TIMECODE_RE.exec(lines[i].trim());
    if (!match) continue;

    const start = timecodeToSeconds(match[1], match[2], match[3], match[4]);

    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      if (raw.trim() === '' || TIMECODE_RE.test(raw.trim())) break;
      body.push(raw);
      i = j;
    }

    const cleaned = body.map(stripCueMarkup).filter(Boolean);
    const fresh = cleaned.filter((line) => !previousLines.includes(line));
    if (cleaned.length) previousLines = cleaned;

    const text = fresh.join(' ').trim();
    if (!text) continue;

    // Consecutive identical cues (common on static screens) add nothing.
    const last = cues[cues.length - 1];
    if (last && last.text === text) continue;

    cues.push({ start, text });
  }

  return cues;
}

/**
 * Cues → Webflow rich text, one <p> per chunk, each led by a timestamp
 * anchor: <p><a href="#t=0.0">0:00</a> ...</p>
 *
 * Matches the format already stored on the existing CTK media items.
 */
export function cuesToRichText(cues, { maxChars = 420, maxSeconds = 45 } = {}) {
  if (!cues || !cues.length) return '';

  const paragraphs = [];
  let chunkStart = null;
  let buffer = [];
  let length = 0;

  const flush = () => {
    if (!buffer.length) return;
    const seconds = Number(chunkStart.toFixed(1));
    paragraphs.push(
      `<p><a href="#t=${seconds.toFixed(1)}">${formatTimestamp(chunkStart)}</a> ` +
        `${escapeHtml(buffer.join(' '))}</p>`
    );
    buffer = [];
    length = 0;
    chunkStart = null;
  };

  for (const cue of cues) {
    if (chunkStart === null) chunkStart = cue.start;
    buffer.push(cue.text);
    length += cue.text.length + 1;

    const longEnough = length >= maxChars;
    const oldEnough = cue.start - chunkStart >= maxSeconds;
    const sentenceEnd = /[.!?]"?$/.test(cue.text);

    if ((longEnough && sentenceEnd) || length >= maxChars * 1.6 || oldEnough) flush();
  }
  flush();

  return paragraphs.join('\n');
}

/** Plain-text video description → simple rich text. */
export function descriptionToRichText(description) {
  const text = String(description || '').trim();
  if (!text) return '';

  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const withBreaks = escapeHtml(block).replace(/\n/g, '<br>');
      const linked = withBreaks.replace(
        /(https?:\/\/[^\s<]+[^\s<.,)])/g,
        '<a href="$1">$1</a>'
      );
      return `<p>${linked}</p>`;
    })
    .join('\n');
}

/* ------------------------------------------------------------------ *
 * Scripture reference parsing
 * ------------------------------------------------------------------ */

const BOOKS = [
  'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges',
  'Ruth', 'Samuel', 'Kings', 'Chronicles', 'Ezra', 'Nehemiah', 'Esther', 'Job',
  'Psalms', 'Psalm', 'Proverbs', 'Ecclesiastes', 'Song of Songs',
  'Song of Solomon', 'Isaiah', 'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel',
  'Hosea', 'Joel', 'Amos', 'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk',
  'Zephaniah', 'Haggai', 'Zechariah', 'Malachi', 'Matthew', 'Mark', 'Luke',
  'John', 'Acts', 'Romans', 'Corinthians', 'Galatians', 'Ephesians',
  'Philippians', 'Colossians', 'Thessalonians', 'Timothy', 'Titus', 'Philemon',
  'Hebrews', 'James', 'Peter', 'Jude', 'Revelation',
];

/** Common abbreviations → canonical book name. Keys are lowercased, dots stripped. */
const ABBREVIATIONS = {
  gen: 'Genesis', ex: 'Exodus', exod: 'Exodus', lev: 'Leviticus', num: 'Numbers',
  deut: 'Deuteronomy', dt: 'Deuteronomy', josh: 'Joshua', judg: 'Judges',
  sam: 'Samuel', kgs: 'Kings', chron: 'Chronicles', chr: 'Chronicles',
  neh: 'Nehemiah', esth: 'Esther', ps: 'Psalm', psa: 'Psalm', pss: 'Psalm',
  prov: 'Proverbs', prv: 'Proverbs', eccl: 'Ecclesiastes', song: 'Song of Songs',
  isa: 'Isaiah', jer: 'Jeremiah', lam: 'Lamentations', ezek: 'Ezekiel',
  dan: 'Daniel', hos: 'Hosea', obad: 'Obadiah', mic: 'Micah', nah: 'Nahum',
  hab: 'Habakkuk', zeph: 'Zephaniah', hag: 'Haggai', zech: 'Zechariah',
  mal: 'Malachi', matt: 'Matthew', mt: 'Matthew', mk: 'Mark', lk: 'Luke',
  jn: 'John', rom: 'Romans', cor: 'Corinthians', gal: 'Galatians',
  eph: 'Ephesians', phil: 'Philippians', php: 'Philippians',
  philem: 'Philemon', phlm: 'Philemon', col: 'Colossians',
  thess: 'Thessalonians', thes: 'Thessalonians', tim: 'Timothy', tit: 'Titus',
  heb: 'Hebrews', jas: 'James', pet: 'Peter', pt: 'Peter', rev: 'Revelation',
};

const ORDINAL = '(?:(?:1|2|3|I{1,3}|First|Second|Third)\\s+)?';
// Longest first so "Philippians" wins over the "Phil" abbreviation.
const BOOK_PATTERN = [...BOOKS, ...Object.keys(ABBREVIATIONS)]
  .sort((a, b) => b.length - a.length)
  .map((b) => b.replace(/ /g, '\\s+'))
  .join('|');
const BOOK_RE = `\\b(${ORDINAL}(?:${BOOK_PATTERN}))\\.?\\s+`;

/**
 * Cross-chapter ranges first — "Nehemiah 1:1-2:8" must not be read as
 * "Nehemiah 1:1-2" with a stray ":8" left over.
 */
const CROSS_CHAPTER_RE = new RegExp(
  `${BOOK_RE}(\\d{1,3})\\s*:\\s*(\\d{1,3})\\s*[-–—]\\s*(\\d{1,3})\\s*:\\s*(\\d{1,3})`,
  'i'
);

const SCRIPTURE_RE = new RegExp(
  `${BOOK_RE}(\\d{1,3})` +
    `(?:\\s*:\\s*(\\d{1,3}(?:\\s*[-–—]\\s*\\d{1,3})?(?:\\s*,\\s*\\d{1,3}(?:\\s*[-–—]\\s*\\d{1,3})?)*))?` +
    `(?:\\s*[-–—]\\s*(\\d{1,3})(?:\\s*:\\s*(\\d{1,3}))?)?`,
  'i'
);

/** en/em dashes → plain hyphen, so references read consistently in the CMS. */
const normalizeDashes = (text) => text.replace(/\s*[-–—]\s*/g, '-').replace(/\s*,\s*/g, ',');

/** Expand an ordinal + abbreviation into the canonical book name. */
function canonicalBook(raw) {
  const normalized = raw
    .replace(/\s+/g, ' ')
    .replace(/^I{1,3}\b/, (roman) => String(roman.length))
    .replace(/^First\b/i, '1')
    .replace(/^Second\b/i, '2')
    .replace(/^Third\b/i, '3')
    .trim();

  const parts = /^([123])\s+(.*)$/.exec(normalized);
  const ordinal = parts ? `${parts[1]} ` : '';
  const rawBook = parts ? parts[2] : normalized;
  const canonical =
    ABBREVIATIONS[rawBook.toLowerCase().replace(/\./g, '')] ||
    rawBook.replace(/^psalms$/i, 'Psalm');
  return `${ordinal}${canonical}`;
}

/** Pull the first scripture reference out of a title (falling back to description). */
export function parseScripture(title, description = '') {
  for (const source of [title, description]) {
    const text = String(source || '');

    const cross = CROSS_CHAPTER_RE.exec(text);
    if (cross) {
      return `${canonicalBook(cross[1])} ${cross[2]}:${cross[3]}-${cross[4]}:${cross[5]}`;
    }

    const match = SCRIPTURE_RE.exec(text);
    if (!match) continue;

    let ref = `${canonicalBook(match[1])} ${match[2]}`;
    if (match[3]) ref += `:${normalizeDashes(match[3])}`;
    if (match[4]) ref += `-${match[4]}${match[5] ? `:${match[5]}` : ''}`;
    return ref;
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * Title normalization
 * ------------------------------------------------------------------ */

/**
 * Lowercased inside a title: articles, coordinating conjunctions, and short
 * prepositions (three letters or fewer). Longer prepositions stay capitalized —
 * "Warning Against", "Win the World Through the Word" — which is the AP rule
 * and reads far better here than lowercasing every preposition.
 *
 * Deliberately NOT minor: "up", "out" and "off" are phrasal-verb particles in
 * these titles ("Stir Up One Another"), and "so" is usually an adverb ("Why Is
 * the Corporate Worship Service So Important?").
 */
const MINOR_WORDS = new Set([
  'a', 'an', 'the',
  'and', 'but', 'or', 'nor', 'yet',
  'as', 'at', 'by', 'for', 'in', 'of', 'on', 'per', 'to', 'via',
]);

/**
 * YouTube truncates titles at ~100 characters, which strands a trailing
 * preposition ("…and Two Types of"). Capitalizing the final word is the normal
 * rule, but not when that word is only final because the title was cut off.
 */
const TRUNCATED_AT = 90;

const PIPE_SUFFIX = /\s*\|\s*.*$/;
const LEAD_LABEL = /^\s*(?:Exhortation|Sermon)\s*[-–—]\s*/i;

/**
 * A trailing "(Ezra 7–8)" or "(1 Timothy 3:8-13, Part 2 of 2)". The reference
 * belongs in scripture-raw and is rendered separately on the page, so it comes
 * out of the title — but a part marker inside the same parentheses survives.
 *
 * The digit after the book name is what keeps "(John Piper)" from being read as
 * a reference to John.
 */
const TRAILING_REF = new RegExp(
  `\\s*\\((?:${ORDINAL}(?:${BOOK_PATTERN}))\\.?\\s*\\d[^)]*\\)\\s*$`,
  'i'
);
const PART_MARKER = /,\s*(Part\s+\d+\s+of\s+\d+)\s*$/i;

/** Words the author already shaped are left alone: ALL-CAPS (LORD, ESV),
 *  internal capitals (McCheyne), and anything with a digit (1 Timothy 6:6). */
function isAuthorShaped(word) {
  if (/\d/.test(word)) return true;
  const letters = word.replace(/[^A-Za-z]/g, '');
  if (letters.length > 1 && letters === letters.toUpperCase()) return true;
  return /[A-Z]/.test(word.slice(1));
}

const capWord = (word) =>
  !word || isAuthorShaped(word) ? word : word[0].toUpperCase() + word.slice(1);

const lowerWord = (word) => (isAuthorShaped(word) ? word : word.toLowerCase());

const wordKey = (word) => word.toLowerCase().replace(/[^a-z]/g, '');

/** Title case with the minor-word exceptions above. */
export function titleCase(text, { truncated = false } = {}) {
  const tokens = String(text).split(/(\s+)/);
  const words = tokens.map((t, i) => (t.trim() ? i : -1)).filter((i) => i >= 0);
  if (!words.length) return text;

  const first = words[0];
  let last = words[words.length - 1];

  const looksTruncated =
    truncated || (text.length >= TRUNCATED_AT && !/[.?!)"]$/.test(text.trimEnd()));
  if (looksTruncated && MINOR_WORDS.has(wordKey(tokens[last]))) last = -1;

  // A word opening a new clause (after : ; ? ! — or an opening bracket) is
  // capitalized even when it is a minor word.
  const force = new Set();
  words.forEach((i, n) => {
    if (n === 0) return;
    const prev = tokens[words[n - 1]].trimEnd();
    if (/[:;?!.—–-]$/.test(prev) || /^[(\[\u201C\u2018"']/.test(tokens[i])) force.add(i);
  });

  const out = [...tokens];
  for (const i of words) {
    out[i] = tokens[i]
      .split(/([-/])/)
      .map((part) => {
        if (part === '-' || part === '/') return part;
        if (i === first || i === last || force.has(i)) return capWord(part);
        return MINOR_WORDS.has(wordKey(part)) ? lowerWord(part) : capWord(part);
      })
      .join('');
  }
  return out.join('');
}

/**
 * Normalize a raw YouTube title into the archive's house style.
 *
 * Four conventions are in play across the archive: a "Speaker - Title" prefix,
 * a "| Series - Part N" suffix, a trailing scripture reference, and wildly
 * inconsistent capitalization. Speaker, series and reference are all rendered
 * from their own CMS fields on the page, so all three come out of the title.
 *
 * @param {string} rawTitle  the title exactly as YouTube has it
 * @param {Array<{name?: string}>} speakers  Contributors, for prefix stripping
 */
export function normalizeTitle(rawTitle, speakers = []) {
  const original = String(rawTitle || '');
  let title = original.replace(PIPE_SUFFIX, '').trim();

  const names = new Set(
    speakers.map((s) => String(s?.name || '').trim()).filter(Boolean)
  );
  const prefixed = /^\s*(.{2,30}?)\s+[-–—]\s+(.*)$/.exec(title);
  if (prefixed && names.has(prefixed[1].trim())) title = prefixed[2].trim();

  title = title.replace(LEAD_LABEL, '').trim();

  const ref = TRAILING_REF.exec(title);
  if (ref) {
    const part = PART_MARKER.exec(ref[0].replace(/\)\s*$/, ''));
    title = title.slice(0, ref.index).trimEnd();
    if (part) title += ` (${part[1]})`;
  }

  title = title.replace(/\s+/g, ' ').trim();

  // Detect YouTube's 100-character truncation on the ORIGINAL string — stripping
  // the speaker prefix hides the evidence.
  title = titleCase(title, { truncated: original.length >= 95 });

  // Titles don't end in a period. An ellipsis (…) is left alone: it marks a
  // truncation rather than a sentence.
  return title.replace(/\s*\.+$/, '').trim();
}

/* ------------------------------------------------------------------ *
 * Speaker / series matching
 * ------------------------------------------------------------------ */

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a video against the Speakers collection.
 * Full-name matches win; a bare surname counts only if it's unique among speakers.
 * Returns an array of speaker ids (empty when the match is ambiguous).
 */
export function matchSpeakers(title, description, speakers) {
  const haystack = `${title || ''}\n${String(description || '').slice(0, 600)}`;
  const found = new Set();

  for (const speaker of speakers) {
    const name = speaker.name || '';
    if (!name) continue;
    const full = new RegExp(`\\b${escapeRegex(name).replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (full.test(haystack)) found.add(speaker.id);
  }

  if (found.size === 0) {
    const surnames = new Map();
    for (const speaker of speakers) {
      const parts = String(speaker.name || '').trim().split(/\s+/);
      if (parts.length < 2) continue;
      const surname = parts[parts.length - 1].toLowerCase();
      surnames.set(surname, surnames.has(surname) ? null : speaker.id);
    }
    for (const [surname, id] of surnames) {
      if (!id) continue;
      if (new RegExp(`\\b${escapeRegex(surname)}\\b`, 'i').test(haystack)) found.add(id);
    }
  }

  return found.size === 1 ? [...found] : [];
}

const DASHES = /[-–—]/g;

/** Match a video title against existing Media Series names. Never invents a series. */
export function matchSeries(title, seriesList) {
  const normalized = String(title || '').toLowerCase().replace(DASHES, '-');
  let best = null;

  for (const series of seriesList) {
    const name = String(series.name || '').toLowerCase().replace(DASHES, '-');
    if (!name) continue;
    if (normalized.includes(name)) {
      if (!best || name.length > best.length) best = { id: series.id, length: name.length };
    }
  }

  return best ? best.id : null;
}

/* ------------------------------------------------------------------ *
 * yt-dlp metadata → Webflow fieldData
 * ------------------------------------------------------------------ */

export const SERMON = 'Sermon';
export const EXHORTATION = 'Exhortation';

export function classifyType(durationSeconds, threshold) {
  return Number(durationSeconds || 0) >= threshold ? SERMON : EXHORTATION;
}

/** yt-dlp gives `timestamp` (epoch) on most videos and `upload_date` (YYYYMMDD) on all. */
export function resolveDate(info) {
  const epoch = info.release_timestamp || info.timestamp;
  if (epoch) return new Date(Number(epoch) * 1000).toISOString();

  const ymd = info.upload_date || info.release_date;
  if (ymd && /^\d{8}$/.test(ymd)) {
    return new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T12:00:00Z`).toISOString();
  }
  return null;
}

export function pickThumbnail(info) {
  if (info.thumbnail) return info.thumbnail;
  const thumbs = Array.isArray(info.thumbnails) ? info.thumbnails : [];
  const ranked = thumbs
    .filter((t) => t && t.url)
    .sort((a, b) => (b.width || b.preference || 0) - (a.width || a.preference || 0));
  return ranked.length ? ranked[0].url : null;
}

/**
 * Build the Webflow fieldData for a video.
 * `type`, `speaker-s` and `series` are treated as first-sync-only elsewhere —
 * this returns the full picture and the caller decides what to actually send.
 */
export function buildFieldData(info, { transcriptHtml, speakers, series, sermonMinSeconds, now }) {
  const title = (info.title || '').trim() || `Untitled ${info.id}`;
  const duration = Math.round(Number(info.duration || 0));
  const type = classifyType(duration, sermonMinSeconds);

  return {
    name: normalizeTitle(title, speakers).slice(0, 256),
    'youtube-video-id': info.id,
    'video-url': `https://www.youtube.com/watch?v=${info.id}`,
    thumbnail: pickThumbnail(info),
    date: resolveDate(info),
    'duration-seconds': duration,
    type,
    description: descriptionToRichText(info.description),
    transcript: transcriptHtml || '',
    // Parsed from the RAW title: normalizeTitle strips the trailing reference.
    'scripture-raw': parseScripture(title, info.description),
    'speaker-s': matchSpeakers(title, info.description, speakers),
    series: matchSeries(title, series),
    'last-synced': now,
  };
}

/**
 * Field data for a video whose full metadata could not be fetched.
 *
 * The channel listing is one cheap call that YouTube still answers when it is
 * bot-gating the per-video player endpoint, and it carries id, title and
 * duration — enough for a real, findable, correctly-classified item. Everything
 * only the full fetch knows (thumbnail, date, description, transcript) is left
 * EMPTY rather than guessed: `date` and `name` are fill-only, so a value
 * invented here would be permanent.
 *
 * Two fields are the exception, and both are real values rather than guesses:
 * `candidate.publishedAt` is an EXACT stamp from the channel's Atom feed
 * (lib/feed.js) — the same moment the full fetch would have recorded — and
 * `candidate.thumbnailUrl` is an i.ytimg.com URL confirmed to exist
 * (lib/thumbnail.js), normally the very file the full fetch would have picked.
 * A date guessed from the listing's relative "3 weeks ago" would be permanent,
 * which is why the listing's own timestamp is dropped upstream, not used here.
 *
 * `last-synced` is deliberately omitted. needsWork() reads an item without it
 * as never synced, so every later run re-fetches this video until YouTube
 * answers, and the blank fields then fill through the ordinary fill-only path —
 * no --force required.
 */
export function buildPlaceholderFieldData(candidate, context) {
  const publishedAtMs = candidate.publishedAt ? Date.parse(candidate.publishedAt) : NaN;

  const fieldData = buildFieldData(
    {
      id: candidate.id,
      title: candidate.title || '',
      duration: candidate.duration || 0,
      timestamp: Number.isNaN(publishedAtMs) ? null : Math.floor(publishedAtMs / 1000),
      thumbnail: candidate.thumbnailUrl || null,
    },
    { ...context, transcriptHtml: '' }
  );
  delete fieldData['last-synced'];
  return fieldData;
}

/**
 * Written when the item is created, then never touched again — not even by
 * --force. Reclassify an exhortation by hand and it stays reclassified.
 */
export const FIRST_SYNC_ONLY = new Set(['type', 'slug']);

/**
 * Filled in when the Webflow field is EMPTY, but never overwritten — not even
 * by --force. This is what lets you add a missing speaker to the Speakers
 * collection and have the next run backfill it, while an assignment you made
 * by hand is still safe.
 */
export const FILL_ONLY = new Set([
  'speaker-s',
  'series',
  // The worship service guides are the source of truth for these three, not
  // YouTube. Upload dates are batched (sometimes 100 days after the service),
  // titles have been normalized by hand, and scripture references were read off
  // the guide. A --force run must not drag any of it back to the YouTube value.
  'date',
  'name',
  'scripture-raw',
]);

/** Fields that are always refreshed, even without --force. */
export const ALWAYS_UPDATE = new Set(['last-synced']);


function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Diff desired fieldData against what's already in Webflow.
 * Default behaviour fills blanks only, so manual edits in the Designer survive.
 * `force` refreshes metadata pulled from YouTube but still respects FIRST_SYNC_ONLY.
 */
export function buildUpdatePatch(desired, existing, { force = false } = {}) {
  const patch = {};

  for (const [key, value] of Object.entries(desired)) {
    if (ALWAYS_UPDATE.has(key)) {
      patch[key] = value;
      continue;
    }
    if (FIRST_SYNC_ONLY.has(key)) continue;
    if (isEmptyValue(value)) continue;

    const current = existing ? existing[key] : undefined;
    const currentValue =
      current && typeof current === 'object' && !Array.isArray(current) && current.url
        ? current.url
        : current;

    if (isEmptyValue(currentValue)) {
      patch[key] = value;
    } else if (force && !FILL_ONLY.has(key) && String(currentValue) !== String(value)) {
      patch[key] = value;
    }
  }

  // Nothing but the heartbeat changed.
  const meaningful = Object.keys(patch).filter((k) => !ALWAYS_UPDATE.has(k));
  return { patch, changed: meaningful.length > 0, changedFields: meaningful };
}

/* ------------------------------------------------------------------ *
 * Re-fetch eligibility
 * ------------------------------------------------------------------ */

/** How long to keep retrying a missing transcript before giving up on it. */
export const TRANSCRIPT_RETRY_DAYS = 14;

/**
 * Should this already-synced item be fetched from YouTube again?
 *
 * `last-synced` is the convergence guard, and getting this wrong cost two
 * wasted runs: the check used to look for empty fields (description, series,
 * speaker, scripture) and re-fetch anything incomplete. But 90 of CTK's 92
 * videos have NO YouTube description at all, and most have no series — so
 * "incomplete" was permanent, every item was eligible forever, and a
 * --max-work budget got spent re-fetching videos that were already as complete
 * as YouTube can make them.
 *
 * If the script has synced an item, whatever YouTube had was written. Empty
 * means empty. The single exception is a missing transcript: captions can show
 * up an hour or two after upload, so keep retrying those — but only for
 * `retryDays`, since a video with no captions after two weeks isn't getting any.
 */
export function needsWork(existing, options = {}) {
  const {
    transcripts = true,
    now = Date.now(),
    retryDays = TRANSCRIPT_RETRY_DAYS,
  } = options;

  const data = existing.fieldData || {};

  // Never touched by this script (e.g. hand-created, or from the old import).
  if (!data['last-synced']) return true;

  if (!transcripts) return false;
  if (String(data.transcript || '').trim()) return false;

  const syncedAt = new Date(data['last-synced']).getTime();
  if (Number.isNaN(syncedAt)) return true;

  const ageDays = (now - syncedAt) / 86_400_000;
  return ageDays < retryDays;
}

/**
 * Read the ignore list into a Set of video ids.
 *
 * Deleting an item in the Designer does not keep it gone: the video is still on
 * the channel, so the next run treats it as missing and recreates it. The
 * ignore list is what actually makes a deletion stick — and removing an id from
 * it brings the video back on the next run, so nothing here is one-way.
 */
export function parseIgnoreList(json) {
  if (!json) return new Set();
  const entries = Array.isArray(json) ? json : json.ignore || [];
  const ids = entries
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.id))
    .filter(Boolean);
  return new Set(ids);
}
