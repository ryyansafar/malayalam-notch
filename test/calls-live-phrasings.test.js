import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchMeaning } from '../shared/calls.js';

// Phrasings the live translate API returned for Malayalam shouts, plus close variants.
const CASES = [
  ['Row fast', 'speed_up'],
  ['Row fast.', 'speed_up'],
  ['Row quickly.', 'speed_up'],
  ['row quick', 'speed_up'],
  ['Go fast!', 'speed_up'],
  ['Pull quickly', 'speed_up'],
  ['Paddle faster', 'speed_up'],
  ['Row slowly.', 'slow_down'],
  ['row slow', 'slow_down'],
  ['Go slowly', 'slow_down'],
  ['Row gently', 'slow_down'],
  ['Paddle slower', 'slow_down'],
];

for (const [text, meaning] of CASES) {
  test(`matchMeaning(${JSON.stringify(text)}) -> ${meaning} (high)`, () => {
    const r = matchMeaning(text);
    assert.equal(r.meaning, meaning);
    assert.equal(r.confidence, 'high');
  });
}

// The matcher must still refuse to guess on genuine conflicts and negations.
const STILL_NOT_SURE = [
  'Start slowly',
  'Row fast and then slow down',
  "Don't row fast",
  'Not so fast',
  'row',
  '',
];

for (const text of STILL_NOT_SURE) {
  test(`matchMeaning(${JSON.stringify(text)}) stays not sure`, () => {
    const r = matchMeaning(text);
    assert.equal(r.meaning === null || r.confidence === 'low', true, JSON.stringify(r));
    assert.notEqual(r.confidence, 'high');
  });
}
