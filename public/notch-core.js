// rowing-call notch island: pure logic. No DOM, no I/O — the page (notch.js)
// feeds it SSE payloads and times; the tests run the same functions in Node.

export const PHASES = Object.freeze(['idle', 'call', 'verdict']);
export const COLLAPSE_AFTER_MS = 6000;
export const DEFAULT_WINDOW_MS = 8000;

// A call whose meaning was recognised opens the island; a result always shows
// the verdict. Anything else leaves the phase alone.
export function nextPhase(phase, event, payload) {
  if (!PHASES.includes(phase)) phase = 'idle';
  if (event === 'call' && payload && payload.status === 'ok' && payload.meaning) return 'call';
  if (event === 'result' && payload && typeof payload === 'object') return 'verdict';
  return phase;
}

export const VERDICTS = Object.freeze({
  obeyed: { word: 'OBEYED', cls: 'ok' },
  not_obeyed: { word: 'NOT OBEYED', cls: 'bad' },
  not_sure: { word: 'NOT SURE', cls: 'warn' },
});

export function verdictOf(result) {
  const key = result && typeof result.outcome === 'string' ? result.outcome : 'not_sure';
  return VERDICTS[key] || VERDICTS.not_sure;
}

// One-line plain reason for the verdict, mirroring the dashboard's detailOf().
export function verdictReason(r) {
  if (!r || typeof r !== 'object') return '';
  return [
    r.reason,
    Number.isFinite(r.deltaSpm) ? `Δ ${r.deltaSpm > 0 ? '+' : ''}${Math.round(r.deltaSpm)} spm` : '',
    Number.isFinite(r.strokesObserved) ? `${r.strokesObserved} strokes observed` : '',
    r.superseded ? 'window cut short by a newer call' : '',
  ].filter(Boolean).join(' · ');
}

// Countdown ring for the observation window. Returns the remaining fraction
// in [0, 1]; 0 before the call or after the window closes.
export function countdown(nowT, callT, windowMs) {
  if (!Number.isFinite(nowT) || !Number.isFinite(callT) || !Number.isFinite(windowMs) || windowMs <= 0) return 0;
  const left = (callT + windowMs - nowT) / windowMs;
  return Math.min(1, Math.max(0, left));
}

// Live stroke rate for the big numerals: the newest stroke within staleMs,
// else 0.
export function liveSpm(strokes, nowT, staleMs = 4000) {
  if (!Array.isArray(strokes) || !Number.isFinite(nowT)) return 0;
  const last = strokes[strokes.length - 1];
  if (!last || !Number.isFinite(last.t) || nowT - last.t > staleMs) return 0;
  return Math.max(0, Math.round(last.rateSpm || 0));
}

// The SSE call record's `source` is the data lane ('live' | 'replay'). The
// origin ('voice_note', 'whatsapp_desktop', 'phone_mic', 'mac_mic', …) rides
// under origin fields when a build puts it there. Report it only when the
// payload actually carries one — never invent it.
const LANE_VALUES = new Set(['live', 'replay']);
export function callOriginBadge(call) {
  if (!call || typeof call !== 'object') return null;
  for (const key of ['origin', 'shoutSource', 'noteSource', 'inputSource', 'via']) {
    const v = call[key];
    if (typeof v === 'string' && v && !LANE_VALUES.has(v)) return v.replace(/_/g, ' ');
    if (v && typeof v === 'object' && typeof v.source === 'string' && v.source && !LANE_VALUES.has(v.source)) {
      return v.source.replace(/_/g, ' ');
    }
  }
  const v = call.source;
  if (typeof v === 'string' && v && !LANE_VALUES.has(v)) return v.replace(/_/g, ' ');
  return null;
}

// Watched-folder status line: shown only when the server reports one. The
// field is being added under a few plausible names; accept a string or an
// object with a status/watching/line text.
export function watchLine(state) {
  if (!state || typeof state !== 'object') return null;
  for (const key of ['watching', 'watcher', 'watch', 'voiceNotes', 'inbox', 'folders']) {
    const v = state[key];
    if (typeof v === 'string' && v) return v;
    if (v && typeof v === 'object') {
      for (const f of ['line', 'status', 'watching', 'text']) {
        if (typeof v[f] === 'string' && v[f]) return v[f];
      }
      if (Array.isArray(v.dirs) && v.dirs.length) {
        return `watching ${v.dirs.length} folder${v.dirs.length === 1 ? '' : 's'}`;
      }
    }
  }
  return null;
}

// May the island collapse now? Focus, an open text field, a recording in
// progress or a live observation window keep it open.
export function shouldCollapse(nowT, lastActivityT, { focused = false, recording = false, callOpen = false } = {}) {
  if (focused || recording || callOpen) return false;
  if (!Number.isFinite(nowT) || !Number.isFinite(lastActivityT)) return false;
  return nowT - lastActivityT >= COLLAPSE_AFTER_MS;
}

// Source names sent to POST /api/shout. The preferred names are the notch's
// own; the fallback is what the current server accepts, used when it answers
// invalid_source so the shout still lands (and is archived under a known name).
export const SHOUT_SOURCE = Object.freeze({
  text: { preferred: 'notch_text', fallback: 'text' },
  mic: { preferred: 'mac_mic', fallback: 'mic' },
  drop: { preferred: 'notch_drop', fallback: 'voice_note' },
});

// Malayalam original for a call, when the server provides one (second-ear
// transcript, or a transcript/original field on the record itself).
export function malayalamOf(call) {
  if (!call || typeof call !== 'object') return null;
  if (call.secondEar && typeof call.secondEar.transcript === 'string' && call.secondEar.transcript) {
    return call.secondEar.transcript;
  }
  for (const key of ['transcript', 'originalText', 'sourceText', 'mlText']) {
    if (typeof call[key] === 'string' && call[key]) return call[key];
  }
  return null;
}
