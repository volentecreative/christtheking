import assert from 'node:assert/strict';
import test from 'node:test';

import { groqTranscribe, segmentsToRichText, segmentsToVtt, trimOutro } from '../lib/transcribe.js';

// The shape Groq returns for response_format=verbose_json (trimmed).
const GROQ_RESPONSE = {
  task: 'transcribe',
  language: 'English',
  duration: 3725.4,
  text: '…',
  segments: [
    { id: 0, start: 0, end: 4.2, text: ' Please turn with me to Nehemiah chapter 8.' },
    { id: 1, start: 4.2, end: 9.96, text: ' Ezra the scribe stood on a wooden platform.' },
    { id: 2, start: 3661.5, end: 3664, text: ' Amen.' },
    { id: 3, start: 3720, end: 3725.4, text: ' Thank you.' },
  ],
};

test('segmentsToVtt writes WebVTT cues with hour timestamps', () => {
  const vtt = segmentsToVtt(GROQ_RESPONSE.segments.slice(0, 2));
  assert.equal(
    vtt,
    'WEBVTT\n\n' +
      '00:00:00.000 --> 00:00:04.200\nPlease turn with me to Nehemiah chapter 8.\n\n' +
      '00:00:04.200 --> 00:00:09.960\nEzra the scribe stood on a wooden platform.\n'
  );
});

test('trimOutro drops a phantom final "Thank you." but keeps real cues', () => {
  const vtt = segmentsToVtt(GROQ_RESPONSE.segments);
  assert.ok(!trimOutro(vtt).includes('Thank you'));
  assert.ok(trimOutro(vtt).includes('Amen.'));
  const single = segmentsToVtt([{ start: 0, end: 1, text: 'Thank you.' }]);
  assert.equal(trimOutro(single), single);
});

test('segmentsToRichText produces the site transcript format', () => {
  const html = segmentsToRichText(GROQ_RESPONSE.segments);
  assert.match(html, /^<p><a href="#t=0\.0">0:00<\/a> Please turn with me to Nehemiah chapter 8\. Ezra the scribe/);
  assert.match(html, /wooden platform\. Amen\.<\/p>$/);
  assert.equal(segmentsToRichText([]), '');
});

test('groqTranscribe retries a 429 and returns segments', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init);
    if (calls.length === 1) return new Response('{"error":{"message":"rate limited"}}', { status: 429 });
    return Response.json(GROQ_RESPONSE);
  };
  const segments = await groqTranscribe(Buffer.from('x'), { apiKey: 'k', fetchImpl, retryDelayMs: 0 });
  assert.equal(calls.length, 2);
  assert.equal(segments.length, 4);
  assert.equal(calls[0].body.get('model'), 'whisper-large-v3-turbo');
  assert.equal(calls[0].body.get('response_format'), 'verbose_json');
});

test('groqTranscribe fails fast on a 4xx and gives up after retries on 5xx', async () => {
  let n = 0;
  await assert.rejects(
    groqTranscribe(Buffer.from('x'), { apiKey: 'k', fetchImpl: async () => (n++, new Response('bad file', { status: 400 })), retryDelayMs: 0 }),
    /Groq 400: bad file/
  );
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(
    groqTranscribe(Buffer.from('x'), { apiKey: 'k', fetchImpl: async () => (n++, new Response('', { status: 503 })), retries: 2, retryDelayMs: 0 }),
    /Groq 503/
  );
  assert.equal(n, 3);
});
