// shared/stroke.js
// Rowing-stroke detector fed by devicemotion accelerometer samples.
// Runs in the phone browser and in Node: no imports, no DOM, no Date.now,
// no globals. All state lives inside createStrokeDetector().

// --- Thresholds (each value justified inline) ---

const TAU_GRAVITY_MS = 2000;
// Slow per-axis running mean that tracks gravity (and drift) so it can be
// subtracted. 2 s is long enough that a first-order high-pass keeps ~97% of
// the slowest expected stroke (20 spm = 0.33 Hz: gain w*tau/sqrt(1+(w*tau)^2)),
// yet short enough to re-converge within about one stroke after the phone is
// re-orientated.

const TAU_ACTIVITY_MS = 800;
// Per-axis EMA of squared dynamic acceleration, used to pick the dominant
// stroke axis. ~1 stroke period at 60 spm: fast enough to find the axis
// during the first stroke, slow enough not to chase a single peak.

const AXIS_SWITCH_RATIO = 1.5;
// The dominant axis only changes when another axis carries >1.5x the
// activity: prevents flicker when a tilted pull splits energy across axes.

const TAU_ENV_MS = 2500;
// Envelope = EMA of |smoothed signal| feeding the adaptive threshold. Spans
// ~1.5-7 stroke periods over 18-60 spm, so the threshold reflects recent
// stroke size rather than a single spike.

const ADAPT_THRESHOLD_K = 0.8;
// Peak threshold = 0.8 * envelope. A sinusoid's mean-|value| is ~0.64x its
// amplitude, so the cutoff sits near half the peak height: safely above
// ~20% additive noise, comfortably below a real stroke peak.

const MIN_PEAK_ABS = 0.9; // m/s^2
// Absolute floor for a candidate while the envelope converges, and the only
// guard under "no motion". Phone-as-oar rowing produces a few m/s^2 of
// dynamic acceleration; sensor jitter is far below 0.9, so gravity + tiny
// noise can never produce a candidate.

const FIXED_PEAK_ABS = 1.0; // m/s^2
// Constant threshold used when opts.adaptive === false.

const MAX_INTERVALS = 4;
// Contract: rateSpm comes from the most recent 2-4 inter-stroke intervals.

const MISSED_BEAT_RATIO = 1.6;
// An interval outside [median/1.6, median*1.6] of the stored intervals is
// an outlier: a long one almost certainly contains an undetected stroke
// (dropout / missed peak) and a short one a split peak; dropping both
// stops one bad interval from halving or doubling the reported rate.
// 1.6 < 2, so a clean doubled or halved interval is dropped, while a
// genuine 24->40 spm change (ratio 1.67) still takes effect within
// 2 strokes as soon as the median itself has moved.

const REFRACTORY_AMP_RATIO = 0.7;
// A peak suppressed by the refractory window that is still >= 70% of the
// pending peak's amplitude may not be sensor noise - it may be evidence
// that the underlying rhythm is about twice the accepted rate, i.e. above
// maxSpm (e.g. 110 steps/min of walking aliasing to 55 spm when every
// other peak is refractory-swallowed). 70% is well above the residual a
// decaying sinusoid leaves within 60000/90 = 667 ms of its peak, and far
// above plausible noise bumps once the signal has fallen below zero.

const HIDDEN_BEAT_TOL = 0.15;
// The amplitude test alone is not enough (a jittered broad peak can throw
// up a comparable second bump), so the suppressed peak must also sit near
// the MIDPOINT of the interval it would split: |dt/iv - 0.5| <= 0.15.
// A persistent faster rhythm places suppressed peaks at almost exactly
// half the interval (r = 0.5 at 110 spm). In a real 20-45 spm train a
// refractory-swallowed bump always lands in the first third (the next
// true beat is >= 1333 ms out while the refractory window is only
// 667 ms), so real intervals are kept. Where the ranges could overlap
// (45-90 spm), the sinusoid has already crossed zero by then, so the
// amplitude gate fails anyway.

export function createStrokeDetector(opts = {}) {
  const minSpm = opts.minSpm ?? 10;
  const maxSpm = opts.maxSpm ?? 90;
  const smoothingHz = opts.smoothingHz ?? 3;
  const adaptive = opts.adaptive ?? true;
  // Refractory: peaks closer than 60000/maxSpm imply a rate above maxSpm.
  const minGapMs = opts.minPeakGapMs ?? 60000 / maxSpm;
  // Peaks farther apart than 60000/minSpm imply a rate below minSpm: the
  // pairing is rejected and a new train starts.
  const maxGapMs = 60000 / minSpm;

  let lastT, g, activity, axis, lp1, lp2, lp3, env;
  let vPrev2, vPrev1, tPrev2, tPrev1, nHist;
  let pending, pendingEmitted, intervals, count;

  function reset() {
    lastT = null;
    g = null;
    activity = [0, 0, 0];
    axis = -1;
    lp1 = 0;
    lp2 = 0;
    lp3 = 0;
    env = 0;
    vPrev2 = 0;
    vPrev1 = 0;
    tPrev2 = 0;
    tPrev1 = 0;
    nHist = 0;
    pending = null;       // last above-threshold candidate peak {t, amp}
    pendingEmitted = false; // whether `pending` already produced an event
    intervals = [];
    count = 0;
  }
  reset();

  function rateSpm() {
    if (intervals.length === 0) return 0;
    const sorted = [...intervals].sort((a, b) => a - b);
    const median = sorted[(sorted.length - 1) >> 1];
    const usable = intervals.filter(
      (iv) => iv <= MISSED_BEAT_RATIO * median && iv >= median / MISSED_BEAT_RATIO,
    );
    const list = usable.length >= 2 || usable.length === intervals.length
      ? usable
      : intervals;
    // Recency-weighted mean of the non-outlier intervals (oldest weight 1,
    // newest weight n). A plain mean is slow to re-centre after a genuine
    // rate change: a transitional interval inside the outlier band (e.g.
    // 1.53x the new median during a 24->40 spm change) drags the estimate
    // for the whole 4-interval window. Linear recency weights keep the
    // estimate unbiased on a steady train (the weights multiply
    // independent per-interval noise) while roughly halving the lag
    // during a transition - the reported rate sits within 2 spm of the
    // new cadence by the 4th stroke after a change.
    let wsum = 0;
    let sum = 0;
    for (let i = 0; i < list.length; i++) {
      wsum += i + 1;
      sum += list[i] * (i + 1);
    }
    const mean = sum / wsum;
    return Math.round(60000 / mean * 10) / 10;
  }

  function candidate(t, amp, out) {
    if (pending) {
      const iv = t - pending.t;
      if (iv < minGapMs) {
        // Too fast for maxSpm: inside the refractory window the taller peak
        // is the more plausible beat, so keep it as the pending candidate.
        // This is also what makes cadence > maxSpm (e.g. walking) produce
        // zero events instead of rate-halved false strokes.
        if (amp > pending.amp) {
          pending = { t, amp, sub: null };
        } else if (!pending.sub || amp > pending.sub.amp) {
          // Remember the tallest refractory-swallowed peak: if it turns out
          // to be a comparable-height beat near the midpoint of the next
          // interval, the real rhythm is ~twice the reported rate.
          pending.sub = { dt: iv, amp };
        }
        return;
      }
      if (iv <= maxGapMs) {
        const s = pending.sub;
        const hidden = s &&
          s.amp >= REFRACTORY_AMP_RATIO * pending.amp &&
          Math.abs(s.dt / iv - 0.5) <= HIDDEN_BEAT_TOL;
        if (!hidden) {
          intervals.push(iv);
          if (intervals.length > MAX_INTERVALS) intervals.shift();
          const rate = rateSpm();
          if (!pendingEmitted) {
            // First confirmed stroke of a train: the earlier peak could not be
            // emitted until a valid interval proved it was rowing cadence, so
            // it is emitted now at its own peak time.
            out.push({ type: 'stroke', t: pending.t, rateSpm: rate, count: ++count });
            pendingEmitted = true;
          }
          out.push({ type: 'stroke', t, rateSpm: rate, count: ++count });
        }
        pending = { t, amp, sub: null };
        return;
      }
      // iv > maxGapMs: gap implies < minSpm -> rhythm broken, start a new
      // train; the lone earlier peak is discarded per the spec.
      intervals = [];
      pendingEmitted = false;
    }
    pending = { t, amp, sub: null };
  }

  function push(s) {
    const out = [];
    const t = s.t;
    if (lastT === null) {
      g = [s.ax, s.ay, s.az]; // first sample seeds gravity: instant convergence
      lastT = t;
      return out;
    }
    const dt = t - lastT;
    if (!(dt > 0)) return out; // non-increasing timestamp: ignore sample
    lastT = t;

    // 1) Remove gravity / drift per axis (running-mean high-pass), so a
    //    constant offset on any axis or tilted combination is invisible.
    const ag = 1 - Math.exp(-dt / TAU_GRAVITY_MS);
    const dyn = [s.ax - (g[0] += ag * (s.ax - g[0])),
                 s.ay - (g[1] += ag * (s.ay - g[1])),
                 s.az - (g[2] += ag * (s.az - g[2]))];

    // 2) Dominant axis: the phone may be held at any orientation, so measure
    //    which axis carries the stroke instead of assuming one or using the
    //    magnitude (which would double the detected frequency).
    const aa = 1 - Math.exp(-dt / TAU_ACTIVITY_MS);
    let best = 0;
    for (let i = 0; i < 3; i++) {
      activity[i] += aa * (dyn[i] * dyn[i] - activity[i]);
      if (activity[i] > activity[best]) best = i;
    }
    if (axis < 0) axis = best;
    else if (best !== axis && activity[best] > AXIS_SWITCH_RATIO * activity[axis]) {
      axis = best;
    }

    // 3) Low-pass smooth: cascaded one-pole filters at smoothingHz. lp2
    //    feeds the adaptive envelope; lp3 (a third pole) is used only for
    //    peak picking - it suppresses noise bumps that can otherwise look
    //    taller than the true apex, and its extra group delay is constant
    //    so it shifts every detected peak equally and leaves inter-stroke
    //    intervals untouched.
    const al = 1 - Math.exp(-2 * Math.PI * smoothingHz * dt / 1000);
    lp1 += al * (dyn[axis] - lp1);
    lp2 += al * (lp1 - lp2);
    lp3 += al * (lp2 - lp3);

    // 4) Adaptive amplitude envelope of the smoothed signal.
    const ae = 1 - Math.exp(-dt / TAU_ENV_MS);
    env += ae * (Math.abs(lp2) - env);

    // 5) Local maximum of the peak-picking signal, confirmed one sample
    //    late.
    if (nHist >= 2 && vPrev1 > vPrev2 && vPrev1 >= lp3) {
      const thr = adaptive
        ? Math.max(MIN_PEAK_ABS, ADAPT_THRESHOLD_K * env)
        : FIXED_PEAK_ABS;
      if (vPrev1 >= thr) {
        // Parabolic refinement of the peak instant through the three
        // (possibly unevenly spaced) samples around the maximum: removes
        // the up-to-half-a-sample timing bias that otherwise makes
        // measured intervals jitter several spm at 20-30 Hz sampling.
        // The offset is clamped inside the bracketing interval so a
        // degenerate fit can never move the peak absurdly.
        const a = tPrev1 - tPrev2;
        const b = t - tPrev1;
        const u = vPrev1 - vPrev2; // rise into the max
        const w = lp3 - vPrev1;    // fall after the max (<= 0)
        const curv = (w * a - u * b) / (a * b * (a + b));
        let tp = tPrev1;
        if (curv < 0) {
          const slope = u / a + curv * a;
          const d = -slope / (2 * curv);
          if (Math.abs(d) <= Math.min(a, b)) tp = tPrev1 + d;
        }
        candidate(tp, vPrev1, out);
      }
    }
    vPrev2 = vPrev1;
    vPrev1 = lp3;
    tPrev2 = tPrev1;
    tPrev1 = t;
    nHist++;
    return out;
  }

  return { push, reset };
}

export function detectStrokes(samples, opts) {
  const d = createStrokeDetector(opts);
  const out = [];
  for (const s of samples) out.push(...d.push(s));
  return out;
}
