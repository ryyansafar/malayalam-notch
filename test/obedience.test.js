import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../shared/obedience.js';

const CALL_T = 100000;

/** Synthetic stroke events at the given offsets (ms) from the call. */
function strokesAt(offsets) {
  return offsets.map((off, i) => ({ type: 'stroke', t: CALL_T + off, rateSpm: 0, count: i + 1 }));
}

/** Evenly spaced strokes at `spm`, first one `firstMs` after the call. */
function steady(spm, n, firstMs = 500) {
  const gap = 60000 / spm;
  return strokesAt(Array.from({ length: n }, (_, i) => firstMs + i * gap));
}

function run(meaning, events, baselineSpm, extra = {}) {
  return evaluate({ meaning, callT: CALL_T, events, baselineSpm, ...extra });
}

function assertShape(result) {
  assert.deepEqual(Object.keys(result).sort(), ['deltaSpm', 'obeyed', 'reason', 'strokesUntilObeyed']);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
}

// ---- speed_up ----
test('speed_up obeyed: 24 -> 30 spm', () => {
  const r = run('speed_up', steady(30, 4), 24);
  assertShape(r);
  assert.equal(r.obeyed, true);
  assert.equal(r.strokesUntilObeyed, 3);
  assert.equal(r.deltaSpm, 6);
});

test('speed_up obeyed late: rate rises gradually', () => {
  // intervals 2500, 2500 (24 spm), then 1500, 1500, 1500 (40 spm)
  const r = run('speed_up', strokesAt([200, 2700, 5200, 6700, 7900]), 24);
  assert.equal(r.obeyed, true);
  assert.ok(r.strokesUntilObeyed > 3);
});

test('speed_up not obeyed: rate stays at baseline', () => {
  const r = run('speed_up', steady(24, 4), 24);
  assert.equal(r.obeyed, false);
  assert.equal(r.strokesUntilObeyed, null);
  assert.equal(r.deltaSpm, 0);
});

test('speed_up not sure: two strokes only', () => {
  const r = run('speed_up', steady(40, 2), 24);
  assertShape(r);
  assert.equal(r.obeyed, null);
  assert.equal(r.deltaSpm, null);
  assert.match(r.reason, /not sure/);
});

test('speed_up not sure: no baseline', () => {
  assert.equal(run('speed_up', steady(30, 4), null).obeyed, null);
  assert.equal(run('speed_up', steady(30, 4), 0).obeyed, null);
});

// ---- slow_down ----
test('slow_down obeyed: 30 -> 24 spm', () => {
  const r = run('slow_down', steady(24, 4), 30);
  assert.equal(r.obeyed, true);
  assert.equal(r.strokesUntilObeyed, 3);
  assert.equal(r.deltaSpm, -6);
});

test('slow_down not obeyed: drop of 2 spm is below the 4 spm threshold', () => {
  const r = run('slow_down', steady(28, 4), 30);
  assert.equal(r.obeyed, false);
  assert.equal(r.deltaSpm, -2);
});

test('slow_down not sure: one stroke', () => {
  assert.equal(run('slow_down', steady(20, 1), 30).obeyed, null);
});

// ---- stop ----
test('stop obeyed: two run-off strokes then silence', () => {
  const r = run('stop', strokesAt([800, 2800]), 30);
  assertShape(r);
  assert.equal(r.obeyed, true);
  assert.equal(r.strokesUntilObeyed, 2);
  assert.equal(r.deltaSpm, -30);
});

test('stop obeyed at once: no strokes after the call', () => {
  const r = run('stop', [], 30);
  assert.equal(r.obeyed, true);
  assert.equal(r.strokesUntilObeyed, 0);
});

test('stop not obeyed: keeps rowing', () => {
  const r = run('stop', steady(30, 4), 30);
  assert.equal(r.obeyed, false);
  assert.equal(r.strokesUntilObeyed, null);
});

test('stop not sure: rower was not rowing before the call', () => {
  assert.equal(run('stop', [], 0).obeyed, null);
  assert.equal(run('stop', [], null).obeyed, null);
});

test('stop not sure: window too short to see stillness', () => {
  assert.equal(run('stop', [], 30, { windowMs: 4500 }).obeyed, null);
});

// ---- hold ----
test('hold obeyed: one run-off stroke', () => {
  const r = run('hold', strokesAt([900]), 28);
  assert.equal(r.obeyed, true);
  assert.equal(r.strokesUntilObeyed, 1);
});

test('hold not obeyed: a stroke 3 s after the call is too late for hold', () => {
  const events = strokesAt([900, 3000]);
  assert.equal(run('hold', events, 28).obeyed, false);
  // the same strokes are acceptable run-off for stop
  assert.equal(run('stop', events, 28).obeyed, true);
});

test('hold not sure: no rowing baseline', () => {
  assert.equal(run('hold', [], 3).obeyed, null);
});

// ---- ready ----
test('ready obeyed: was rowing, went still', () => {
  const r = run('ready', strokesAt([700]), 26);
  assert.equal(r.obeyed, true);
  assert.equal(r.strokesUntilObeyed, 1);
});

test('ready not obeyed: was rowing, kept rowing', () => {
  assert.equal(run('ready', steady(26, 4), 26).obeyed, false);
});

test('ready not obeyed: false start from rest', () => {
  const r = run('ready', steady(30, 3), 0);
  assert.equal(r.obeyed, false);
  assert.match(r.reason, /false start/);
});

test('ready not sure: still before and after', () => {
  const r = run('ready', [], 0);
  assertShape(r);
  assert.equal(r.obeyed, null);
});

test('ready not sure: one or two strokes from rest', () => {
  assert.equal(run('ready', steady(30, 2), null).obeyed, null);
});

// ---- start ----
test('start obeyed: three strokes from rest', () => {
  const r = run('start', steady(24, 3), 0);
  assert.equal(r.obeyed, true);
  assert.equal(r.strokesUntilObeyed, 3);
  assert.equal(r.deltaSpm, 24);
});

test('start obeyed with unknown baseline gives null deltaSpm', () => {
  const r = run('start', steady(24, 3), null);
  assert.equal(r.obeyed, true);
  assert.equal(r.deltaSpm, null);
});

test('start not obeyed: no strokes', () => {
  const r = run('start', [], 0);
  assert.equal(r.obeyed, false);
  assert.equal(r.strokesUntilObeyed, null);
});

test('start not sure: fewer than three strokes', () => {
  assert.equal(run('start', steady(24, 2), 0).obeyed, null);
});

test('start not sure: already rowing', () => {
  assert.equal(run('start', steady(24, 4), 24).obeyed, null);
});

// ---- windowing, validation, purity ----
test('only events after callT and inside windowMs are used', () => {
  const before = strokesAt([-6000, -4000, -2000, 0]); // t === callT is not "after"
  const after = strokesAt([9000, 10000, 11000]); // beyond the default 8000 ms
  const r = run('start', [...before, ...after], 0);
  assert.equal(r.obeyed, false);
  const wide = run('start', [...before, ...after], 0, { windowMs: 12000 });
  assert.equal(wide.obeyed, true);
});

test('unsorted events and malformed entries are tolerated', () => {
  const events = [...steady(30, 4)].reverse();
  const noisy = [null, 'x', { t: 'soon' }, { t: NaN }, { type: 'phone', t: CALL_T + 100 }, ...events];
  const r = run('speed_up', noisy, 24);
  assert.equal(r.obeyed, true);
  assert.equal(r.strokesUntilObeyed, 3);
});

test('invalid input yields a not-sure verdict instead of throwing', () => {
  assert.equal(run('dance', steady(30, 4), 24).obeyed, null);
  assert.equal(run('unconfirmed', steady(30, 4), 24).obeyed, null);
  assert.equal(evaluate({ meaning: 'stop', callT: 'now', events: [], baselineSpm: 30 }).obeyed, null);
  assert.equal(run('speed_up', 'not-an-array', 24).obeyed, null);
  assert.equal(evaluate().obeyed, null);
  // invalid windowMs falls back to the 8000 ms default
  assert.equal(run('stop', [], 30, { windowMs: -5 }).obeyed, true);
});

test('evaluate is pure: inputs untouched, same output twice', () => {
  const events = Object.freeze([...steady(30, 5)].reverse().map(Object.freeze));
  const snapshot = JSON.stringify(events);
  const input = Object.freeze({ meaning: 'speed_up', callT: CALL_T, events, baselineSpm: 24 });
  const a = evaluate(input);
  const b = evaluate(input);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(events), snapshot);
});
