You are working in a small Node.js (>= 20, ES modules, zero runtime dependencies) project. Read CONTRACT.md in the current directory first, specifically the section "shared/stroke.js".

YOUR TASK (only this; touch no other files):
Create exactly two files:
1. shared/stroke.js
2. test/stroke.test.js

shared/stroke.js must export `createStrokeDetector(opts)` and `detectStrokes(samples, opts)` exactly as described in CONTRACT.md. It is a rowing-stroke detector that runs in a phone browser (fed by devicemotion samples) and in Node (for tests), with no imports and no DOM or Node-only APIs.

Requirements:
- Input samples `{ t, ax, ay, az }` (t in milliseconds, acceleration in m/s^2 that may include gravity; optional gx, gy, gz). Output stroke events `{ type: 'stroke', t, rateSpm, count }` where rateSpm is strokes per minute computed from the most recent 2 to 4 inter-stroke intervals and count is cumulative.
- Robust to: uneven sampling (jitter up to +/-30 percent of the nominal interval), nominal rates from 20 Hz to 60 Hz, additive noise, a constant gravity offset on any axis (phone held at arbitrary orientation), slow drift, and short dropouts.
- Strategy suggestion (you may improve it): remove gravity with a slow high-pass or running mean, take the acceleration magnitude or the dominant axis, low-pass smooth (default smoothingHz = 3), detect peaks with an adaptive threshold, a refractory period derived from maxSpm (minimum gap between strokes) and reject peaks implying a rate above maxSpm or below minSpm. Do not use libraries.
- Options: `{ minSpm = 10, maxSpm = 90, smoothingHz = 3, minPeakGapMs, adaptive = true }`. Defaults must work for rowing rates of roughly 18 to 60 strokes per minute.
- Pure and deterministic: no randomness, no Date.now (use sample t only), no global state. `reset()` clears state.
- Document each threshold with a short comment explaining why that value.

test/stroke.test.js uses `node:test` and `node:assert/strict` only. Write a deterministic synthetic signal generator inside the test file (use a seeded pseudo-random generator, for example mulberry32) and test:
- clean sinusoidal-like stroke trains at 20, 30, 40 and 60 strokes per minute sampled at 20, 30 and 60 Hz; after at least 4 strokes the reported rateSpm is within 2 spm of truth and the count is within 1 of truth;
- with +/-30 percent timing jitter and noise at about 20 percent of the stroke amplitude;
- with gravity (9.81) on each axis in turn and on a tilted combination;
- no motion (only gravity plus tiny noise) yields zero strokes;
- walking-like motion at about 110 steps per minute yields zero strokes with the default maxSpm 90;
- a rate change from 24 to 40 strokes per minute is tracked (rateSpm moves toward the new rate within 4 strokes);
- reset() works and detectStrokes() equals feeding push() sample by sample.
Print nothing else. Run `node --test test/stroke.test.js` and iterate until every test passes. If a requirement is impossible in some regime, tune the test tolerance honestly and add a comment in the test file explaining the limit instead of hiding it.

Rules: do not run git commands except `git add` and one `git commit` of your own two files at the end with a message starting "feat(stroke): ", do not push, do not install packages, do not use the network, do not modify any other file. When finished, reply with a short factual summary: what you implemented, the algorithm in 5 lines, the test results (number passing), and any limits or regimes where accuracy degrades, with the measured numbers.
