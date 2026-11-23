/**
 * Whisper helpers shared by the local (whisper.cpp) and cloud (Groq) paths of
 * transcribe-missing.js.
 */

import { cuesToRichText, parseVtt } from './parse.js';

// Whisper's initial prompt nudges spelling of names and terms it would otherwise guess at.
export const VOCABULARY =
  'Christ the King Church, Stillwater, Minnesota. Pastor Andy Naselli, Nathan Colestock, ' +
  'Grant Colestock, Tom Dodds, Dustin Williams, Boaz Prince, Clint Manley, Cole Johnson, ' +
  'Andrew Wittenberg, Brad Brosius, Ryan Kappel, Caleb Zeigler, John Erickson. ' +
  'Ezra, Nehemiah, 1 Timothy, Psalms, exhortation, the Lord’s Supper, baptism, congregational worship.';

// Whisper often "hears" a sign-off in trailing silence ("Thank you.", "Thanks for
// watching!"). Drop such a cue when it is the very last one.
const PHANTOM_OUTRO = /^(thank you\.?|thanks for watching!?|thank you for watching\.?|bye\.?)$/i;
export function trimOutro(vtt) {
  const blocks = vtt.trimEnd().split(/\n\n+/);
  const last = blocks[blocks.length - 1] || '';
  const text = last.split('\n').filter((l) => !l.includes('-->')).join(' ').trim();
  if (blocks.length > 2 && PHANTOM_OUTRO.test(text)) blocks.pop();
  return blocks.join('\n\n') + '\n';
}

function vttTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

/** Whisper verbose_json segments → WebVTT. */
export function segmentsToVtt(segments) {
  const cues = (segments || [])
    .filter((s) => String(s.text || '').trim())
    .map((s) => `${vttTime(s.start)} --> ${vttTime(s.end)}\n${s.text.trim()}`);
  return ['WEBVTT', ...cues].join('\n\n') + '\n';
}

/** Segments → the site's timestamped rich text, via the same path as import-transcripts.js. */
export function segmentsToRichText(segments) {
  return cuesToRichText(parseVtt(trimOutro(segmentsToVtt(segments))));
}

export const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
export const GROQ_MAX_BYTES = 25 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** POST audio to Groq Whisper; retries 429/5xx/network errors, honouring Retry-After. */
export async function groqTranscribe(audio, { apiKey, filename = 'audio.ogg', fetchImpl = fetch, retries = 3, retryDelayMs = 5000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const form = new FormData();
    form.append('file', new Blob([audio]), filename);
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'en');
    form.append('temperature', '0');
    form.append('prompt', VOCABULARY);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');

    let res;
    let detail;
    try {
      res = await fetchImpl(GROQ_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
      if (res.ok) return (await res.json()).segments || [];
      detail = `Groq ${res.status}: ${(await res.text()).slice(0, 300)}`;
    } catch (error) {
      detail = `Groq network error: ${error.message}`;
    }
    if ((res && res.status !== 429 && res.status < 500) || attempt >= retries) throw new Error(detail);
    const retryAfter = Number(res && res.headers.get('retry-after')) || 0;
    await sleep(retryAfter ? retryAfter * 1000 : retryDelayMs * (attempt + 1));
  }
}
