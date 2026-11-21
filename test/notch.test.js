// node:test suite for the notch island's pure logic (public/notch-core.js).
// No DOM, no network — the same functions the page uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextPhase, verdictOf, verdictReason, countdown, liveSpm, callOriginBadge,
  watchLine, shouldCollapse, SHOUT_SOURCE, malayalamOf, COLLAPSE_AFTER_MS,
} from '../public/notch-core.js';

const call = (over = {}) => ({
  callId: 'call-1', t: 10_000, meaning: 'speed_up', translatedText: 'Row faster',
  spokenText: 'तेज़ चलाओ', targetLang: 'hi-IN', windowMs: 8000, status: 'ok',
  source: 'live', ...over,
});

// ---- phase machine ----
test('nextPhase: a recognised call opens the call phase', () => {
  assert.equal(nextPhase('idle', 'call', call()), 'call');
  assert.equal(nextPhase('verdict', 'call', call()), 'call');
});

test('nextPhase: a not-sure or unrecognised call does not open the call phase', () => {
  assert.equal(nextPhase('idle', 'call', call({ status: 'not_sure' })), 'idle');
  assert.equal(nextPhase('idle', 'call', call({ meaning: null })), 'idle');
  assert.equal(nextPhase('idle', 'call', null), 'idle');
});

test('nextPhase: a result always shows the verdict phase', () => {
  assert.equal(nextPhase('call', 'result', { outcome: 'obeyed' }), 'verdict');
  assert.equal(nextPhase('idle', 'result', { outcome: 'not_sure', status: 'not_sure' }), 'verdict');
  assert.equal(nextPhase('call', 'result', null), 'call');
});

test('nextPhase: strokes and phone events never change the phase', () => {
  assert.equal(nextPhase('call', 'stroke', { t: 1 }), 'call');
  assert.equal(nextPhase('idle', 'phone', { connected: true }), 'idle');
  assert.equal(nextPhase('verdict', 'state', {}), 'verdict');
});

test('nextPhase: an unknown current phase recovers to idle', () => {
  assert.equal(nextPhase('bogus', 'stroke', {}), 'idle');
});

// ---- verdicts ----
test('verdictOf maps outcomes to word and colour class', () => {
  assert.deepEqual(verdictOf({ outcome: 'obeyed' }), { word: 'OBEYED', cls: 'ok' });
  assert.deepEqual(verdictOf({ outcome: 'not_obeyed' }), { word: 'NOT OBEYED', cls: 'bad' });
  assert.deepEqual(verdictOf({ outcome: 'not_sure' }), { word: 'NOT SURE', cls: 'warn' });
  assert.deepEqual(verdictOf({ outcome: 'garbage' }), { word: 'NOT SURE', cls: 'warn' });
  assert.deepEqual(verdictOf(null), { word: 'NOT SURE', cls: 'warn' });
});

test('verdictReason joins reason, delta and stroke count', () => {
  const r = { reason: 'rate did not rise', deltaSpm: -2.4, strokesObserved: 5, superseded: false };
  assert.equal(verdictReason(r), 'rate did not rise · Δ -2 spm · 5 strokes observed');
  assert.equal(verdictReason({ reason: '', superseded: true }), 'window cut short by a newer call');
  assert.equal(verdictReason(null), '');
});

// ---- countdown maths ----
test('countdown returns the remaining window fraction clamped to [0,1]', () => {
  assert.equal(countdown(10_000, 10_000, 8000), 1);       // at the call: full window left
  assert.equal(countdown(14_000, 10_000, 8000), 0.5);     // halfway
  assert.equal(countdown(18_000, 10_000, 8000), 0);       // window closed
  assert.equal(countdown(20_000, 10_000, 8000), 0);       // past the window stays 0
});

test('countdown: bad inputs give 0', () => {
  assert.equal(countdown(NaN, 10_000, 8000), 0);
  assert.equal(countdown(10_000, undefined, 8000), 0);
  assert.equal(countdown(10_000, 10_000, 0), 0);
  assert.equal(countdown(10_000, 10_000, -5), 0);
});

// ---- live stroke rate ----
test('liveSpm: newest fresh stroke wins, stale strokes read 0', () => {
  const strokes = [{ t: 90_000, rateSpm: 24.6 }, { t: 95_000, rateSpm: 30.2 }];
  assert.equal(liveSpm(strokes, 96_000), 30);
  assert.equal(liveSpm(strokes, 100_000), 0);   // older than 4 s staleness
  assert.equal(liveSpm([], 96_000), 0);
  assert.equal(liveSpm(null, 96_000), 0);
  assert.equal(liveSpm([{ t: 95_000 }], 96_000), 0); // missing rate
});

// ---- origin badge ----
test('callOriginBadge: data-lane source values never become a badge', () => {
  assert.equal(callOriginBadge(call({ source: 'live' })), null);
  assert.equal(callOriginBadge(call({ source: 'replay' })), null);
});

test('callOriginBadge: an origin field is shown, humanised', () => {
  assert.equal(callOriginBadge(call({ source: 'voice_note' })), 'voice note');
  assert.equal(callOriginBadge(call({ origin: 'whatsapp_desktop' })), 'whatsapp desktop');
  assert.equal(callOriginBadge(call({ origin: { source: 'phone_mic' } })), 'phone mic');
  assert.equal(callOriginBadge(null), null);
  assert.equal(callOriginBadge({}), null);
});

// ---- watched-folder line ----
test('watchLine: absent means absent', () => {
  assert.equal(watchLine({}), null);
  assert.equal(watchLine(null), null);
  assert.equal(watchLine({ phone: {} }), null);
});

test('watchLine: strings and object forms are picked up', () => {
  assert.equal(watchLine({ watching: '~/Downloads/rowing-call-inbox' }), '~/Downloads/rowing-call-inbox');
  assert.equal(watchLine({ watcher: { status: 'watching 1 folder' } }), 'watching 1 folder');
  assert.equal(watchLine({ watcher: { dirs: ['a', 'b'] } }), 'watching 2 folders');
});

// ---- collapse rules ----
test('shouldCollapse: only after the quiet window, and holds beat the timer', () => {
  const t0 = 1_000_000;
  assert.equal(shouldCollapse(t0 + COLLAPSE_AFTER_MS - 1, t0), false);
  assert.equal(shouldCollapse(t0 + COLLAPSE_AFTER_MS, t0), true);
  assert.equal(shouldCollapse(t0 + 60_000, t0, { focused: true }), false);
  assert.equal(shouldCollapse(t0 + 60_000, t0, { recording: true }), false);
  assert.equal(shouldCollapse(t0 + 60_000, t0, { callOpen: true }), false);
  assert.equal(shouldCollapse(t0 + 60_000, NaN), false);
});

// ---- shout sources ----
test('SHOUT_SOURCE: every kind has a notch name and a canonical fallback', () => {
  for (const kind of ['text', 'mic', 'drop']) {
    const s = SHOUT_SOURCE[kind];
    assert.ok(s.preferred.startsWith('notch_') || s.preferred.startsWith('mac_'));
    assert.ok(['text', 'mic', 'voice_note'].includes(s.fallback));
  }
});

// ---- Malayalam original ----
test('malayalamOf: second-ear transcript wins, then own fields', () => {
  assert.equal(malayalamOf(call({ secondEar: { transcript: 'വേഗത്തില്‍ ചല്ല്' } })), 'വേഗത്തില്‍ ചല്ല്');
  assert.equal(malayalamOf(call({ transcript: 'x' })), 'x');
  assert.equal(malayalamOf(call()), null);
  assert.equal(malayalamOf(null), null);
});
