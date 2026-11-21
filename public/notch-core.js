// Malayalam-in-the-notch island: pure logic. No DOM, no I/O — the page
// (notch.js) feeds it SSE payloads and times; the tests run the same functions
// in Node.

// Island phases. 'dragover' is a modifier, not a phase: the island can be
// hovered/drag-target while in any phase, tracked by flags in notch.js.
export const PHASES = Object.freeze(['idle', 'received', 'translating', 'result', 'recording', 'error']);
export const COLLAPSE_AFTER_MS = 8000;
export const SHELF_MAX = 5;

// received → translating is automatic the moment the note leaves for Sarvam;
// the phase only flips back to idle when nothing is in flight and the shelf is
// closed. A note or an error always lands on result/error.
export function nextPhase(phase, event, payload) {
  if (!PHASES.includes(phase)) phase = 'idle';
  switch (event) {
    case 'received': return payload ? 'received' : phase;
    case 'note': return payload ? 'result' : phase;
    case 'note_error': return 'error';
    case 'recording': return payload === false ? 'idle' : 'recording';
    case 'reset': return 'idle';
    default: return phase;
  }
}

// One plain sentence per phase — the "what is happening" line. Every state
// names itself; nothing is communicated by colour alone.
export function phaseLine(phase, ctx = {}) {
  switch (phase) {
    case 'idle': return ctx.notesToday > 0 ? `${ctx.notesToday} note${ctx.notesToday === 1 ? '' : 's'} translated today` : 'Drop a WhatsApp voice note';
    case 'received': return ctx.filename ? `Received ${ctx.filename}` : 'Received';
    case 'translating': return 'Translating';
    case 'recording': return 'Recording — release to translate';
    case 'result': return 'Done';
    case 'error': return ctx.message || 'Something went wrong. Try the note again.';
    default: return '';
  }
}

// The three card fields, each only what the API returned — never fabricated.
// A failed mode shows an honest "not available" line.
export function cardFields(note) {
  if (!note || typeof note !== 'object') return null;
  const failed = Array.isArray(note.failedOps) ? note.failedOps : [];
  return {
    malayalam: typeof note.sourceText === 'string' && note.sourceText ? note.sourceText : null,
    malayalamFailed: failed.includes('transcribe'),
    roman: typeof note.romanText === 'string' && note.romanText ? note.romanText : null,
    romanFailed: failed.includes('translit'),
    english: typeof note.translatedText === 'string' && note.translatedText ? note.translatedText : null,
    englishFailed: failed.includes('translate'),
    detectedLanguage: typeof note.detectedLanguage === 'string' && note.detectedLanguage ? note.detectedLanguage : null,
  };
}

// The SSE note record's `source` is the data lane ('live' | 'replay'). The
// origin ('notch_drop', 'voice_note', 'whatsapp_desktop', 'mic', …) rides in
// `origin`. Report it only when the payload actually carries one.
const LANE_VALUES = new Set(['live', 'replay']);
export function noteOriginBadge(note) {
  if (!note || typeof note !== 'object') return null;
  for (const key of ['origin', 'shoutSource', 'noteSource', 'inputSource', 'via']) {
    const v = note[key];
    if (typeof v === 'string' && v && !LANE_VALUES.has(v)) return v.replace(/_/g, ' ');
    if (v && typeof v === 'object' && typeof v.source === 'string' && v.source && !LANE_VALUES.has(v.source)) {
      return v.source.replace(/_/g, ' ');
    }
  }
  return null;
}

// The shelf: the last few notes as chips. Newest first, capped, no audio.
export function pushShelf(shelf, note, max = SHELF_MAX) {
  const entry = {
    noteId: note.noteId || null,
    t: Number.isFinite(note.t) ? note.t : null,
    origin: noteOriginBadge(note),
    language: typeof note.detectedLanguage === 'string' ? note.detectedLanguage : null,
    firstLine: typeof note.translatedText === 'string' ? note.translatedText.split('\n')[0] : '',
    sourceText: typeof note.sourceText === 'string' ? note.sourceText : null,
    romanText: typeof note.romanText === 'string' ? note.romanText : null,
    spokenText: typeof note.spokenText === 'string' ? note.spokenText : null,
    spokenLang: typeof note.spokenLang === 'string' ? note.spokenLang : null,
    targetLang: typeof note.targetLang === 'string' ? note.targetLang : null,
    ttsAvailable: Boolean(note.ttsAvailable),
  };
  const list = [entry, ...(Array.isArray(shelf) ? shelf : [])];
  return list.slice(0, max);
}

// A chip's first line of English, trimmed for the small width.
export function chipLine(entry, max = 42) {
  const line = entry && typeof entry.firstLine === 'string' ? entry.firstLine.trim() : '';
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1).trimEnd()}…`;
}

// Elapsed whole seconds for the live-activity counter — always a non-negative
// integer; missing times read 0.
export function elapsedSeconds(nowT, startedT) {
  if (!Number.isFinite(nowT) || !Number.isFinite(startedT) || nowT <= startedT) return 0;
  return Math.floor((nowT - startedT) / 1000);
}

// May the island collapse now? Focus, an open text field, a recording, an
// in-flight shout or an open result card keep it open.
export function shouldCollapse(nowT, lastActivityT, { focused = false, recording = false, busy = false, resultOpen = false, dragOver = false } = {}) {
  if (focused || recording || busy || resultOpen || dragOver) return false;
  if (!Number.isFinite(nowT) || !Number.isFinite(lastActivityT)) return false;
  return nowT - lastActivityT >= COLLAPSE_AFTER_MS;
}

// Source names sent to POST /api/shout. The server accepts every one of these
// directly (SHOUT_SOURCES in server/hub.js).
export const SHOUT_SOURCE = Object.freeze({
  text: 'text',
  mic: 'mic',
  drop: 'notch_drop',
  phone: 'phone_mic',
});

// Filename + duration for the "received" line, e.g. `PTT-1.opus · 12 s`.
export function receivedLine({ filename, seconds } = {}) {
  const parts = [];
  if (typeof filename === 'string' && filename) parts.push(filename);
  if (Number.isFinite(seconds) && seconds > 0) parts.push(`${Math.round(seconds)} s`);
  return parts.length ? `Received ${parts.join(' · ')}` : 'Received';
}

// A dropped file is worth sending when the extension is one we accept.
export const AUDIO_EXTENSIONS = Object.freeze(['opus', 'ogg', 'm4a', 'mp3', 'wav', 'aac', 'amr', 'webm', 'mp4']);
export function acceptsAudioName(name) {
  if (typeof name !== 'string') return false;
  const dot = name.lastIndexOf('.');
  return dot > 0 && AUDIO_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}
