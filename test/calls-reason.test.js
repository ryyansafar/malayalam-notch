import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchMeaning, noMatchReason, NO_MATCH_REASONS } from '../shared/calls.js';

test('noMatchReason: null when the rules find a meaning', () => {
  for (const text of ['Row faster', 'Slow down', 'Stop rowing', 'Hold water', 'Get ready', 'Start rowing', 'Easy there']) {
    assert.equal(noMatchReason(text), null, text);
    assert.notEqual(matchMeaning(text).meaning, null, text);
  }
});

test('noMatchReason: empty for non-strings and text without words', () => {
  for (const value of [undefined, null, 42, {}, '', '   ', '!!! ...', 'വലി']) {
    assert.equal(noMatchReason(value), 'empty');
  }
});

test('noMatchReason: negation wins over everything else', () => {
  for (const text of ['Do not stop', "Don't stop", 'Never slow down', 'Not so fast', 'No', 'Stop, do not go faster', 'Pull without fear']) {
    assert.equal(noMatchReason(text), 'negation', text);
    assert.equal(matchMeaning(text).meaning, null, text);
  }
});

test('noMatchReason: conflict when keywords of two meanings are present', () => {
  for (const text of ['Stop, go faster', 'Get ready and stop', 'Slow down then speed up', 'Hold it, row']) {
    assert.equal(noMatchReason(text), 'conflict', text);
    assert.equal(matchMeaning(text).meaning, null, text);
  }
});

test('noMatchReason: no_match when no keyword is present', () => {
  for (const text of ['Pull with all your strength', 'Everyone together now', 'Oars up', 'What time is it']) {
    assert.equal(noMatchReason(text), 'no_match', text);
    assert.equal(matchMeaning(text).meaning, null, text);
  }
});

test('noMatchReason agrees with matchMeaning on every input and uses only the documented reasons', () => {
  const samples = ['Row faster', 'Do not stop', 'Stop, go faster', 'Oars up', '', 'ready ready', 'go go go', 'too slow', 'not sure', 7];
  for (const text of samples) {
    const reason = noMatchReason(text);
    const matched = matchMeaning(text);
    assert.equal(reason === null, matched.meaning !== null, String(text));
    if (reason !== null) {
      assert.ok(NO_MATCH_REASONS.includes(reason));
      assert.equal(matched.confidence, 'none');
    }
  }
});
