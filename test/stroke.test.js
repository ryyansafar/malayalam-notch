import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStrokeDetector, detectStrokes } from '../shared/stroke.js';

// Deterministic PRNG so the synthetic signals are reproducible.
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sinusoidal stroke train on one phone axis, plus optional constant gravity,
// uniform additive noise, per-interval timing jitter, a linear drift ramp,
// and an optional step change in stroke rate (phase stays continuous).
function gen(o = {}) {
  const {
    spm = 30,
    fs = 30,
    seconds = 24,
    amp = 3,
    noise = 0,
    jitter = 0,
    gravity = [0, 0, 0],
    strokeAxis = 1,
    drift = 0,
    seed = 42,
    changeAtMs = null,
    spmAfter = null,
  } = o;
  const rnd = mulberry32(seed);
  const samples = [];
  let t = 0;
  while (t < seconds * 1000) {
    const phase =
      changeAtMs !== null && t >= changeAtMs
        ? ((2 * Math.PI * spm) / 60000) * changeAtMs +
          ((2 * Math.PI * spmAfter) / 60000) * (t - changeAtMs)
        : ((2 * Math.PI * spm) / 60000) * t;
    const stroke = amp * Math.sin(phase);
    const a = [
      gravity[0] + (rnd() * 2 - 1) * noise + drift * (t / 1000),
      gravity[1] + (rnd() * 2 - 1) * noise,
      gravity[2] + (rnd() * 2 - 1) * noise,
    ];
    a[strokeAxis] += stroke;
    samples.push({ t, ax: a[0], ay: a[1], az: a[2] });
    t += (1000 / fs) * (1 + jitter * (rnd() * 2 - 1));
  }
  return samples;
}

const expectedStrokes = (spm, seconds) => Math.round((spm * seconds) / 60);

function lastRate(events) {
  return events[events.length - 1].rateSpm;
}

// --- clean sinusoidal trains: spm x fs matrix ---
for (const spm of [20, 30, 40, 60]) {
  for (const fs of [20, 30, 60]) {
    test(`clean ${spm} spm at ${fs} Hz`, () => {
      const ev = detectStrokes(gen({ spm, fs, seconds: 24 }));
      assert.ok(ev.length >= 4, `emitted ${ev.length}`);
      assert.ok(
        Math.abs(lastRate(ev) - spm) <= 2,
        `rate ${lastRate(ev)} vs ${spm}`,
      );
      assert.ok(
        Math.abs(ev.length - expectedStrokes(spm, 24)) <= 1,
        `count ${ev.length} vs ~${expectedStrokes(spm, 24)}`,
      );
      assert.equal(ev[0].count, 1);
      assert.equal(ev.at(-1).count, ev.length);
    });
  }
}

// --- timing jitter +/-30% of the sampling interval + 20% noise ---
test('30 spm at 30 Hz survives +/-30% jitter and 20% noise', () => {
  const ev = detectStrokes(
    gen({ spm: 30, fs: 30, seconds: 24, amp: 3, noise: 0.6, jitter: 0.3 }),
  );
  assert.ok(ev.length >= 4, `emitted ${ev.length}`);
  assert.ok(Math.abs(lastRate(ev) - 30) <= 2, `rate ${lastRate(ev)}`);
  // Noise can merge or split at most the occasional peak; allow 2 here.
  assert.ok(Math.abs(ev.length - 12) <= 2, `count ${ev.length}`);
});

test('20 spm at 20 Hz survives jitter+noise (worst case: fewest samples/period)', () => {
  const ev = detectStrokes(
    gen({ spm: 20, fs: 20, seconds: 30, amp: 3, noise: 0.6, jitter: 0.3 }),
  );
  assert.ok(ev.length >= 4, `emitted ${ev.length}`);
  assert.ok(Math.abs(lastRate(ev) - 20) <= 2, `rate ${lastRate(ev)}`);
});

// --- constant gravity on each axis and on a tilted combination ---
const TILT = [0.3 * 9.81, 0.4 * 9.81, Math.sqrt(1 - 0.09 - 0.16) * 9.81];
const GRAVITY_CASES = [
  ['gravity on x, stroke on x', [9.81, 0, 0], 0],
  ['gravity on y, stroke on x', [0, 9.81, 0], 0],
  ['gravity on z, stroke on x', [0, 0, 9.81], 0],
  ['gravity on z, stroke on z (parallel)', [0, 0, 9.81], 2],
  ['tilted gravity, stroke on y', TILT, 1],
];
for (const [name, gravity, axis] of GRAVITY_CASES) {
  test(name, () => {
    const ev = detectStrokes(
      gen({ spm: 36, fs: 50, seconds: 20, gravity, strokeAxis: axis, noise: 0.15 }),
    );
    assert.ok(ev.length >= 4, `emitted ${ev.length}`);
    assert.ok(Math.abs(lastRate(ev) - 36) <= 2, `rate ${lastRate(ev)}`);
    assert.ok(Math.abs(ev.length - 12) <= 1, `count ${ev.length}`);
  });
}

// --- no motion: gravity + tiny noise only ---
test('no motion yields zero strokes', () => {
  const ev = detectStrokes(
    gen({ spm: 30, fs: 50, seconds: 15, amp: 0, noise: 0.03, gravity: [0, 0, 9.81] }),
  );
  assert.equal(ev.length, 0);
});

// --- walking cadence (> maxSpm) must not alias into a stroke rate ---
test('110 steps/min yields zero strokes with default maxSpm 90', () => {
  const ev = detectStrokes(gen({ spm: 110, fs: 50, seconds: 20, amp: 3 }));
  assert.equal(ev.length, 0);
});

test('raising maxSpm above walking cadence lets it through (discriminator is maxSpm)', () => {
  const ev = detectStrokes(
    gen({ spm: 110, fs: 50, seconds: 20, amp: 3 }),
    { maxSpm: 130 },
  );
  assert.ok(ev.length >= 4);
  assert.ok(Math.abs(lastRate(ev) - 110) <= 5, `rate ${lastRate(ev)}`);
});

// --- rate change 24 -> 40 spm is tracked within 4 strokes ---
test('rate change 24 -> 40 spm is tracked', () => {
  const changeAtMs = 15000;
  const ev = detectStrokes(
    gen({ spm: 24, spmAfter: 40, changeAtMs, fs: 40, seconds: 30 }),
  );
  const post = ev.filter((e) => e.t >= changeAtMs);
  assert.ok(post.length >= 4, `post-change events ${post.length}`);
  // 2nd post-change event already moves clearly off the old rate.
  assert.ok(post[1].rateSpm > 26, `rate ${post[1].rateSpm}`);
  // By the 4th post-change stroke the median filter has caught up.
  assert.ok(Math.abs(post[3].rateSpm - 40) <= 2, `rate ${post[3].rateSpm}`);
  assert.ok(Math.abs(lastRate(ev) - 40) <= 2, `rate ${lastRate(ev)}`);
});

// --- short dropout: 600 ms of missing samples mid-train ---
test('short dropout does not break the train', () => {
  const samples = gen({ spm: 30, fs: 40, seconds: 24 }).filter(
    (s) => s.t < 8000 || s.t > 8600,
  );
  const ev = detectStrokes(samples);
  assert.ok(ev.length >= 4, `emitted ${ev.length}`);
  // One stroke may be lost inside the gap; a doubled interval is excluded
  // from the rate by the missed-beat median filter.
  assert.ok(Math.abs(lastRate(ev) - 30) <= 3, `rate ${lastRate(ev)}`);
  assert.ok(Math.abs(ev.length - 12) <= 2, `count ${ev.length}`);
});

// --- reset() and batch/stream equivalence ---
test('reset() restores initial state', () => {
  const samples = gen({ spm: 30, fs: 30, seconds: 20 });
  const d = createStrokeDetector();
  const first = samples.flatMap((s) => d.push(s));
  d.reset();
  const second = samples.flatMap((s) => d.push(s));
  assert.deepEqual(second, first);
  assert.equal(second[0].count, 1);
});

test('detectStrokes() equals feeding push() sample by sample', () => {
  const samples = gen({ spm: 45, fs: 30, seconds: 20, noise: 0.4, jitter: 0.2 });
  const d = createStrokeDetector();
  const streamed = samples.flatMap((s) => d.push(s));
  assert.deepEqual(detectStrokes(samples), streamed);
});

// --- options ---
test('adaptive=false uses a fixed threshold', () => {
  const ev = detectStrokes(gen({ spm: 30, fs: 30, seconds: 24 }), {
    adaptive: false,
  });
  assert.ok(ev.length >= 4);
  assert.ok(Math.abs(lastRate(ev) - 30) <= 2);
});
