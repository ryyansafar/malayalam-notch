// shared/obedience.js
// Decide whether the rower obeyed a call, from stroke events alone.
// Pure: no I/O, no clock, no mutation of the inputs.
//
// The caller is expected to invoke evaluate() once the observation window
// (windowMs after callT) has fully elapsed; an absence of strokes is read as
// stillness, so calling early would overstate obedience to stop/hold/ready.
//
// Per-meaning thresholds live in EXPECTED (shared/calls.js) and are explained
// there. The thresholds that belong to the judging method itself are below.

import { EXPECTED, MEANINGS } from './calls.js';

// Default observation window after the call (contract default).
const DEFAULT_WINDOW_MS = 8000;

// At least 3 strokes after the call are needed to judge a rate change:
// 3 strokes give 2 intervals, the fewest that make a rate less than a one-off.
const MIN_STROKES_TO_JUDGE = 3;

// The post-call rate at a stroke is taken over the last (up to) 3 intervals
// between post-call strokes, mirroring the detector's 2-4 interval smoothing
// while never mixing in intervals from before the call.
const RATE_INTERVALS = 3;

// A baseline at or above 10 spm counts as "was rowing" (the stroke detector's
// own minimum detectable rate). Below it the rower is treated as at rest.
const MIN_ROWING_SPM = 10;

// For stop/hold/ready the quiet tail (window minus run-off allowance) must be
// at least 2 s long, otherwise stillness cannot be observed at all.
const MIN_QUIET_TAIL_MS = 2000;

const round1 = (n) => Math.round(n * 10) / 10;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

function verdict(obeyed, reason, strokesUntilObeyed = null, deltaSpm = null) {
  return { obeyed, strokesUntilObeyed, deltaSpm: deltaSpm === null ? null : round1(deltaSpm), reason };
}

/** Stroke times strictly after callT and inside the window, ascending. */
function strokeTimesInWindow(events, callT, windowMs) {
  if (!Array.isArray(events)) return [];
  return events
    .filter((e) => e !== null && typeof e === 'object' && isNum(e.t))
    .filter((e) => e.type === undefined || e.type === 'stroke')
    .map((e) => e.t)
    .filter((t) => t > callT && t <= callT + windowMs)
    .sort((a, b) => a - b);
}

/** Rate in spm at stroke index i (0-based), or null before the third stroke. */
function rateAt(times, i) {
  if (i < MIN_STROKES_TO_JUDGE - 1) return null;
  const from = Math.max(0, i - RATE_INTERVALS);
  const span = times[i] - times[from];
  return span > 0 ? (60000 * (i - from)) / span : null;
}

function judgeRateChange(meaning, times, baselineSpm) {
  if (times.length < MIN_STROKES_TO_JUDGE) {
    return verdict(null, `not sure: only ${times.length} stroke(s) after the call, need ${MIN_STROKES_TO_JUDGE}`);
  }
  if (!isNum(baselineSpm) || baselineSpm < MIN_ROWING_SPM) {
    return verdict(null, 'not sure: no rowing baseline before the call to compare against');
  }
  const up = meaning === 'speed_up';
  const threshold = up ? EXPECTED.speed_up.deltaSpmMin : EXPECTED.slow_down.deltaSpmMax;
  let lastDelta = null;
  for (let i = MIN_STROKES_TO_JUDGE - 1; i < times.length; i += 1) {
    const rate = rateAt(times, i);
    if (rate === null) continue;
    lastDelta = rate - baselineSpm;
    if (up ? lastDelta >= threshold : lastDelta <= threshold) {
      return verdict(true, `rate changed by ${round1(lastDelta)} spm by stroke ${i + 1}`, i + 1, lastDelta);
    }
  }
  if (lastDelta === null) return verdict(null, 'not sure: stroke timestamps do not give a rate');
  const need = up ? `+${threshold}` : `${threshold}`;
  return verdict(false, `rate changed by ${round1(lastDelta)} spm, needed ${need}`, null, lastDelta);
}

/** stop, hold, and ready-while-rowing: strokes must cease after the run-off. */
function judgeCease(meaning, times, baselineSpm, callT, windowMs) {
  const { rateBelowSpm, withinMs } = EXPECTED[meaning];
  const tailMs = windowMs - withinMs;
  if (tailMs < MIN_QUIET_TAIL_MS) {
    return verdict(null, `not sure: window of ${windowMs} ms is too short to observe stillness`);
  }
  const runOff = times.filter((t) => t <= callT + withinMs).length;
  const tailCount = times.length - runOff;
  // Observed rate over the quiet tail; one stroke in a 4 s tail is 15 spm.
  const tailRate = (tailCount * 60000) / tailMs;
  const delta = tailRate - baselineSpm;
  if (tailRate < rateBelowSpm) {
    return verdict(true, `strokes ceased after ${runOff} stroke(s)`, runOff, delta);
  }
  return verdict(false, `${tailCount} stroke(s) more than ${withinMs} ms after the call`, null, delta);
}

function judgeStillness(meaning, times, baselineSpm, callT, windowMs) {
  const wasRowing = isNum(baselineSpm) && baselineSpm >= MIN_ROWING_SPM;
  if (wasRowing) return judgeCease(meaning, times, baselineSpm, callT, windowMs);
  if (meaning !== 'ready') {
    return verdict(null, 'not sure: rower was not rowing before the call, stillness proves nothing');
  }
  if (times.length >= EXPECTED.ready.falseStartStrokes) {
    return verdict(false, `false start: ${times.length} strokes after a ready call`);
  }
  if (times.length > 0) {
    return verdict(null, `not sure: only ${times.length} stroke(s) after the call, need ${MIN_STROKES_TO_JUDGE}`);
  }
  return verdict(null, 'not sure: still before and after the call, cannot tell ready from not listening');
}

function judgeStart(times, baselineSpm) {
  if (isNum(baselineSpm) && baselineSpm >= MIN_ROWING_SPM) {
    return verdict(null, 'not sure: rower was already rowing before the start call');
  }
  const { minStrokes } = EXPECTED.start;
  if (times.length === 0) return verdict(false, 'no strokes after the start call');
  if (times.length < minStrokes) {
    return verdict(null, `not sure: only ${times.length} stroke(s) after the call, need ${minStrokes}`);
  }
  const rate = rateAt(times, minStrokes - 1);
  const delta = rate !== null && isNum(baselineSpm) ? rate - baselineSpm : null;
  return verdict(true, `rowing started, ${minStrokes} strokes inside the window`, minStrokes, delta);
}

/**
 * @param {object} input
 * @param {string} input.meaning       one of MEANINGS
 * @param {number} input.callT         time of the call, ms, same clock as events
 * @param {Array<{t:number}>} input.events  stroke events; only those after callT are used
 * @param {number|null} [input.baselineSpm] stroke rate just before the call
 * @param {number} [input.windowMs=8000]    observation window after callT
 * @returns {{ obeyed: boolean|null, strokesUntilObeyed: number|null, deltaSpm: number|null, reason: string }}
 *   obeyed null means "not sure". strokesUntilObeyed is the 1-based post-call
 *   stroke at which a rate change or start was confirmed; for stop, hold and
 *   ready it is the number of run-off strokes taken before going still.
 */
export function evaluate({ meaning, callT, events, baselineSpm = null, windowMs = DEFAULT_WINDOW_MS } = {}) {
  if (!MEANINGS.includes(meaning)) return verdict(null, 'not sure: unknown meaning');
  if (!isNum(callT)) return verdict(null, 'not sure: call time missing');
  const win = isNum(windowMs) && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS;
  const times = strokeTimesInWindow(events, callT, win);

  if (meaning === 'speed_up' || meaning === 'slow_down') return judgeRateChange(meaning, times, baselineSpm);
  if (meaning === 'start') return judgeStart(times, baselineSpm);
  return judgeStillness(meaning, times, baselineSpm, callT, win);
}
