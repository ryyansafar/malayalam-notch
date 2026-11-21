import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEANINGS, CALLS, EXPECTED, UNCONFIRMED, matchMeaning } from '../shared/calls.js';

test('MEANINGS is exactly the six contract meanings', () => {
  assert.deepEqual([...MEANINGS], ['start', 'speed_up', 'slow_down', 'hold', 'ready', 'stop']);
});

test('CALLS: every entry is unverified and has the contract shape', () => {
  const keys = ['english', 'id', 'malayalam', 'meaning', 'source', 'transliteration', 'verified'];
  for (const call of CALLS) {
    assert.deepEqual(Object.keys(call).sort(), keys);
    assert.equal(call.verified, false);
    assert.equal(typeof call.source, 'string');
    assert.ok(MEANINGS.includes(call.meaning) || call.meaning === UNCONFIRMED);
  }
  assert.equal(new Set(CALLS.map((c) => c.id)).size, CALLS.length);
});

test('CALLS: one placeholder per meaning, no invented Malayalam', () => {
  for (const meaning of MEANINGS) {
    const rows = CALLS.filter((c) => c.meaning === meaning);
    assert.equal(rows.length, 1, meaning);
    assert.equal(rows[0].malayalam, null);
    assert.equal(rows[0].transliteration, null);
    assert.match(rows[0].source, /placeholder/);
  }
});

test('CALLS: the three reported terms are present with unconfirmed meaning', () => {
  const terms = CALLS.filter((c) => c.meaning === UNCONFIRMED);
  assert.deepEqual(terms.map((c) => c.transliteration), ['Aanjukuthi', 'Valicheduthu', 'Kuthiyerinju']);
  for (const term of terms) {
    assert.equal(term.english, null);
    assert.match(term.source, /Onmanorama/);
  }
});

test('CALLS and EXPECTED are frozen', () => {
  assert.ok(Object.isFrozen(CALLS) && CALLS.every(Object.isFrozen));
  assert.ok(Object.isFrozen(EXPECTED) && Object.values(EXPECTED).every(Object.isFrozen));
});

test('placeholder english phrases match their own meaning', () => {
  for (const call of CALLS.filter((c) => c.english !== null)) {
    assert.equal(matchMeaning(call.english).meaning, call.meaning, call.english);
  }
});

test('EXPECTED covers every meaning with sane thresholds', () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), [...MEANINGS].sort());
  assert.ok(EXPECTED.speed_up.deltaSpmMin > 0);
  assert.ok(EXPECTED.slow_down.deltaSpmMax < 0);
  assert.ok(EXPECTED.hold.withinMs < EXPECTED.stop.withinMs);
  assert.ok(EXPECTED.start.minStrokes >= 3);
});

// [text, meaning, confidence]
const TABLE = [
  ['pull harder', 'speed_up', 'high'],
  ['Pull harder!', 'speed_up', 'high'],
  ['go faster', 'speed_up', 'high'],
  ['Faster, faster!', 'speed_up', 'high'],
  ['Row faster.', 'speed_up', 'high'],
  ['speed up', 'speed_up', 'high'],
  ['Pick up the pace, boys', 'speed_up', 'high'],
  ['harder', 'speed_up', 'low'],
  ['You are too slow', 'speed_up', 'low'],
  ['slow down', 'slow_down', 'high'],
  ['SLOW DOWN!!!', 'slow_down', 'high'],
  ['go slower', 'slow_down', 'high'],
  ['take it easy', 'slow_down', 'high'],
  ['Ease up a little', 'slow_down', 'high'],
  ['easy', 'slow_down', 'low'],
  ['slowly', 'slow_down', 'low'],
  ['too fast', 'slow_down', 'low'],
  ['stop rowing', 'stop', 'high'],
  ['Stop!', 'stop', 'high'],
  ['  stop   now  ', 'stop', 'high'],
  ['Halt.', 'stop', 'high'],
  ['finish', 'stop', 'low'],
  ['easy oars', 'stop', 'low'],
  ['hold the water', 'hold', 'high'],
  ['Hold water!', 'hold', 'high'],
  ['hold', 'hold', 'high'],
  ['hold it', 'hold', 'high'],
  ['ready', 'ready', 'high'],
  ['Ready?', 'ready', 'high'],
  ['Get ready to go', 'ready', 'high'],
  ['get set', 'ready', 'high'],
  ['Attention!', 'ready', 'high'],
  ['ready to row', 'ready', 'high'],
  ['begin', 'start', 'high'],
  ["let's go", 'start', 'high'],
  ['Let’s go!', 'start', 'high'],
  ['Start rowing', 'start', 'high'],
  ['start', 'start', 'high'],
  ['go', 'start', 'low'],
  ['Go, go, go!', 'start', 'low'],
  ['row', 'start', 'low'],
  // adversarial: conflicts, negations, substrings, noise, bad input
  ['faster, no wait, slower', null, 'none'],
  ['faster and slower', null, 'none'],
  ['stop and go', null, 'none'],
  ['ready, set, go', null, 'none'],
  ['start slowly', null, 'none'],
  ['hold on, slow down', null, 'none'],
  ["don't stop", null, 'none'],
  ['do not slow down', null, 'none'],
  ['never stop', null, 'none'],
  ['not so fast', null, 'none'],
  ["can't go faster", null, 'none'],
  ['stopwatch', null, 'none'],
  ['nonstop', null, 'none'],
  ['the goat is already holding a rowboat', null, 'none'],
  ['the weather is nice today', null, 'none'],
  ['Aanjukuthi', null, 'none'],
  ['', null, 'none'],
  ['   ', null, 'none'],
  ['?!...', null, 'none'],
];

test(`matchMeaning table (${TABLE.length} phrases)`, async (t) => {
  assert.ok(TABLE.length >= 30);
  for (const [text, meaning, confidence] of TABLE) {
    await t.test(JSON.stringify(text), () => {
      const result = matchMeaning(text);
      assert.equal(result.meaning, meaning);
      assert.equal(result.confidence, confidence);
      if (meaning === null) {
        assert.equal(result.matchedKeyword, undefined);
      } else {
        assert.equal(typeof result.matchedKeyword, 'string');
        assert.ok(result.matchedKeyword.length > 0);
      }
    });
  }
});

test('matchMeaning returns none for non-string input without throwing', () => {
  for (const bad of [null, undefined, 42, {}, [], true, () => 'stop']) {
    assert.deepEqual(matchMeaning(bad), { meaning: null, confidence: 'none' });
  }
});

test('matchMeaning reports the specific phrase that matched', () => {
  assert.equal(matchMeaning('please hold the water now').matchedKeyword, 'hold the water');
  assert.equal(matchMeaning('go faster').matchedKeyword, 'go faster');
  assert.equal(matchMeaning('stop rowing').matchedKeyword, 'stop rowing');
});

test('matchMeaning is deterministic and tolerates very long input', () => {
  const long = `${'blah '.repeat(5000)}stop`;
  assert.deepEqual(matchMeaning(long), matchMeaning(long));
  assert.deepEqual(matchMeaning('Pull harder!'), matchMeaning('Pull harder!'));
  assert.equal(matchMeaning(`stop ${'x '.repeat(5000)}`).meaning, 'stop');
});
