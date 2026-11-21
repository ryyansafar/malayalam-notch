// node:test suite for the notch island's pure logic (public/notch-core.js).
// No DOM, no network — the same functions the page uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextPhase, phaseLine, cardFields, noteOriginBadge, pushShelf, chipLine,
  elapsedSeconds, shouldCollapse, SHOUT_SOURCE, receivedLine, acceptsAudioName,
  COLLAPSE_AFTER_MS, SHELF_MAX,
} from '../public/notch-core.js';

const note = (over = {}) => ({
  noteId: 'note-1', t: 10_000, input: 'audio', origin: 'notch_drop',
  sourceText: 'വേഗത്തില്‍ പോവുക', romanText: 'vegam povuka', translatedText: 'Move faster',
  detectedLanguage: 'ml-IN', spokenText: 'Move faster', spokenLang: 'en-IN',
  targetLang: 'en-IN', ttsAvailable: true, status: 'ok', failedOps: [], ...over,
});

// ---- phase machine ----
test('nextPhase: a received note opens the island; the note lands on result', () => {
  assert.equal(nextPhase('idle', 'received', { noteId: 'n1' }), 'received');
  assert.equal(nextPhase('received', 'note', note()), 'result');
  assert.equal(nextPhase('idle', 'note', note()), 'result');
});

test('nextPhase: an error shows the error phase; empty payloads do nothing', () => {
  assert.equal(nextPhase('translating', 'note_error', { message: 'x' }), 'error');
  assert.equal(nextPhase('idle', 'note', null), 'idle');
  assert.equal(nextPhase('idle', 'received', null), 'idle');
});

test('nextPhase: recording and reset move the island; unknown phases recover', () => {
  assert.equal(nextPhase('idle', 'recording', {}), 'recording');
  assert.equal(nextPhase('recording', 'recording', false), 'idle');
  assert.equal(nextPhase('result', 'reset'), 'idle');
  assert.equal(nextPhase('bogus', 'received', { noteId: 'x' }), 'received');
});

// ---- the one plain line per state ----
test('phaseLine: every state names what is happening', () => {
  assert.equal(phaseLine('idle', { notesToday: 0 }), 'Drop a WhatsApp voice note');
  assert.equal(phaseLine('idle', { notesToday: 3 }), '3 notes translated today');
  assert.equal(phaseLine('idle', { notesToday: 1 }), '1 note translated today');
  assert.equal(phaseLine('received', { filename: 'PTT-1.opus' }), 'Received PTT-1.opus');
  assert.equal(phaseLine('translating'), 'Translating');
  assert.equal(phaseLine('result'), 'Done');
  assert.match(phaseLine('error', {}), /something went wrong/i);
});

// ---- card fields: only what the API returned ----
test('cardFields: the three lines plus the detected language', () => {
  const f = cardFields(note());
  assert.equal(f.malayalam, 'വേഗത്തില്‍ പോവുക');
  assert.equal(f.roman, 'vegam povuka');
  assert.equal(f.english, 'Move faster');
  assert.equal(f.detectedLanguage, 'ml-IN');
  assert.equal(f.malayalamFailed, false);
});

test('cardFields: a failed mode is flagged, never fabricated', () => {
  const f = cardFields(note({ romanText: null, failedOps: ['translit'] }));
  assert.equal(f.roman, null);
  assert.equal(f.romanFailed, true);
  assert.equal(f.english, 'Move faster');
  assert.equal(cardFields(null), null);
});

// ---- origin badge ----
test('noteOriginBadge: a real origin is humanised; lane values never become one', () => {
  assert.equal(noteOriginBadge(note({ origin: 'notch_drop' })), 'notch drop');
  assert.equal(noteOriginBadge(note({ origin: 'whatsapp_desktop' })), 'whatsapp desktop');
  assert.equal(noteOriginBadge({ source: 'live' }), null);
  assert.equal(noteOriginBadge(null), null);
  assert.equal(noteOriginBadge({}), null);
});

// ---- the shelf ----
test('pushShelf: newest first, capped at five, only display fields kept', () => {
  let shelf = [];
  for (let i = 1; i <= 7; i += 1) {
    shelf = pushShelf(shelf, note({ noteId: `n-${i}`, ttsAudioBase64: 'QUJD' }));
  }
  assert.equal(shelf.length, SHELF_MAX);
  assert.equal(shelf[0].noteId, 'n-7');
  assert.equal(shelf[4].noteId, 'n-3');
  assert.equal('ttsAudioBase64' in shelf[0], false);
  assert.equal(shelf[0].firstLine, 'Move faster');
  assert.equal(shelf[0].origin, 'notch drop');
  assert.equal(shelf[0].language, 'ml-IN');
});

test('chipLine: the first English line, trimmed to the chip width', () => {
  assert.equal(chipLine({ firstLine: 'short' }), 'short');
  const long = 'x'.repeat(80);
  assert.equal(chipLine({ firstLine: long }).length <= 42, true);
  assert.match(chipLine({ firstLine: long }), /…$/);
  assert.equal(chipLine({}), '');
});

// ---- elapsed and collapse ----
test('elapsedSeconds: whole seconds for the live activity, floored and clamped', () => {
  assert.equal(elapsedSeconds(10_500, 10_000), 0);
  assert.equal(elapsedSeconds(12_000, 10_000), 2);
  assert.equal(elapsedSeconds(9_000, 10_000), 0);
  assert.equal(elapsedSeconds(NaN, 10_000), 0);
});

test('shouldCollapse: only after the quiet window, and holds beat the timer', () => {
  const t0 = 1_000_000;
  assert.equal(shouldCollapse(t0 + COLLAPSE_AFTER_MS - 1, t0), false);
  assert.equal(shouldCollapse(t0 + COLLAPSE_AFTER_MS, t0), true);
  assert.equal(shouldCollapse(t0 + 60_000, t0, { focused: true }), false);
  assert.equal(shouldCollapse(t0 + 60_000, t0, { recording: true }), false);
  assert.equal(shouldCollapse(t0 + 60_000, t0, { busy: true }), false);
  assert.equal(shouldCollapse(t0 + 60_000, t0, { resultOpen: true }), false);
  assert.equal(shouldCollapse(t0 + 60_000, t0, { dragOver: true }), false);
  assert.equal(shouldCollapse(t0 + 60_000, NaN), false);
});

// ---- sources and received line ----
test('SHOUT_SOURCE: the notch speaks the server source names', () => {
  assert.equal(SHOUT_SOURCE.drop, 'notch_drop');
  assert.equal(SHOUT_SOURCE.text, 'text');
  assert.equal(SHOUT_SOURCE.mic, 'mic');
});

test('receivedLine: filename and duration joined plainly', () => {
  assert.equal(receivedLine({ filename: 'PTT-1.opus', seconds: 12.4 }), 'Received PTT-1.opus · 12 s');
  assert.equal(receivedLine({ filename: 'PTT-1.opus' }), 'Received PTT-1.opus');
  assert.equal(receivedLine({}), 'Received');
});

test('acceptsAudioName: WhatsApp and common formats pass; others do not', () => {
  assert.equal(acceptsAudioName('PTT-20261121-WA0001.opus'), true);
  assert.equal(acceptsAudioName('note.M4A'), true);
  assert.equal(acceptsAudioName('clip.webm'), true);
  assert.equal(acceptsAudioName('photo.jpg'), false);
  assert.equal(acceptsAudioName('.opus'), false);
  assert.equal(acceptsAudioName(null), false);
});
