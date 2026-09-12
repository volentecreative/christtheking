/**
 * The reconcile pass decides what to write from the two collections alone.
 * These cover that decision; main() only walks the result.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { planReconcile } from '../reconcile-speakers.js';

const SPEAKERS = [
  { id: 'sp-andy', name: 'Andy Naselli' },
  { id: 'sp-clint', name: 'Clint Manley' },
];

const item = (name, speakerIds, speakerTextValue) => ({
  id: `id-${name}`,
  fieldData: {
    name,
    'speaker-s': speakerIds,
    ...(speakerTextValue === undefined ? {} : { 'speaker-text': speakerTextValue }),
  },
});

test('a blank speaker-text is scheduled for a write', () => {
  const plan = planReconcile([item('A', ['sp-andy'], '')], SPEAKERS);
  assert.equal(plan.writes.length, 1);
  assert.deepEqual(plan.writes[0], {
    id: 'id-A', title: 'A', from: '', to: 'Andy Naselli',
  });
});

test('a missing speaker-text field counts as blank, not as a crash', () => {
  const plan = planReconcile([item('A', ['sp-andy'])], SPEAKERS);
  assert.equal(plan.writes[0].to, 'Andy Naselli');
});

test('an already-correct item is left alone', () => {
  const plan = planReconcile([item('A', ['sp-andy'], 'Andy Naselli')], SPEAKERS);
  assert.deepEqual(plan.writes, [], 'a steady state must write nothing');
  assert.equal(plan.alreadyCurrent, 1);
});

test('multiple speakers join in reference order', () => {
  const plan = planReconcile([item('A', ['sp-clint', 'sp-andy'], '')], SPEAKERS);
  assert.equal(plan.writes[0].to, 'Clint Manley, Andy Naselli');
});

test('an item with no speaker is counted, and its text is not disturbed', () => {
  const plan = planReconcile([item('A', [], '')], SPEAKERS);
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.noSpeaker, 1);
});

test('a speaker removed from an item has its name cleared', () => {
  const plan = planReconcile([item('A', [], 'Andy Naselli')], SPEAKERS);
  assert.equal(plan.writes[0].to, '', 'a stale name must not survive');
  assert.equal(plan.noSpeaker, 1);
});

test('a stale name is corrected', () => {
  const plan = planReconcile([item('A', ['sp-clint'], 'Andy Naselli')], SPEAKERS);
  assert.equal(plan.writes[0].to, 'Clint Manley');
});

test('an item pointing at a deleted Speaker record is reported', () => {
  const plan = planReconcile([item('A', ['sp-andy', 'sp-gone'], '')], SPEAKERS);
  assert.deepEqual(plan.orphans, ['A']);
  assert.equal(
    plan.writes[0].to,
    'Andy Naselli',
    'the surviving name is still written, but the gap is flagged'
  );
});

test('a whole library in a steady state produces no writes at all', () => {
  const plan = planReconcile(
    [
      item('A', ['sp-andy'], 'Andy Naselli'),
      item('B', ['sp-clint'], 'Clint Manley'),
      item('C', [], ''),
    ],
    SPEAKERS
  );
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.alreadyCurrent, 3);
  assert.deepEqual(plan.orphans, []);
});

test('an item with no fieldData at all does not throw', () => {
  const plan = planReconcile([{ id: 'bare' }], SPEAKERS);
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.noSpeaker, 1);
});
