import assert from 'node:assert/strict';
import test from 'node:test';

import { mapWithConcurrency } from '../lib/concurrency.js';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('results come back in input order, not completion order', async () => {
  const items = [30, 5, 20, 1];
  const results = await mapWithConcurrency(items, 4, async (ms) => {
    await tick(ms);
    return ms;
  });
  assert.deepEqual(results.map((r) => r.value), [30, 5, 20, 1]);
});

test('never exceeds the concurrency limit', async () => {
  let inFlight = 0;
  let peak = 0;

  await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 5, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick(5);
    inFlight--;
  });

  assert.ok(peak <= 5, `peak concurrency was ${peak}, expected <= 5`);
  assert.equal(peak, 5, 'should actually saturate the limit');
});

test('one failure does not sink the batch', async () => {
  const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('video 2 is broken');
    return n * 10;
  });

  assert.equal(results[0].value, 10);
  assert.equal(results[1].value, undefined);
  assert.equal(results[1].error.message, 'video 2 is broken');
  assert.equal(results[2].value, 30);
});

test('handles an empty list and a limit larger than the list', async () => {
  assert.deepEqual(await mapWithConcurrency([], 5, async () => 1), []);
  const results = await mapWithConcurrency([1, 2], 99, async (n) => n);
  assert.deepEqual(results.map((r) => r.value), [1, 2]);
});

test('every item runs exactly once', async () => {
  const seen = [];
  await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 7, async (n) => {
    await tick(Math.random() * 3);
    seen.push(n);
  });
  assert.equal(seen.length, 50);
  assert.equal(new Set(seen).size, 50);
});
