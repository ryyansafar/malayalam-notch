// SSE hub, immutable session state, the spoken phrase table and the validation of
// inbound phone/stroke/shout messages for rowing-call.
// The state object is never mutated: every change builds a new frozen object.

export const LANGS = Object.freeze(['en-IN', 'hi-IN', 'bn-IN', 'od-IN', 'ta-IN']);
export const SSE_EVENTS = Object.freeze(['state', 'stroke', 'call', 'result', 'phone']);

// What Bulbul speaks to the rower for each meaning.
// HONESTY: these phrases were written at the event and have NOT been reviewed by
// native speakers of Hindi, Bengali, Odia or Tamil. State exposes phrasesReviewed:false.
export const PHRASES_REVIEWED = false;
export const PHRASES = Object.freeze({
  start: Object.freeze({
    'en-IN': 'Start rowing',
    'hi-IN': 'चप्पू चलाना शुरू करो',
    'bn-IN': 'দাঁড় টানা শুরু করো',
    'od-IN': 'ଆହୁଲା ମାରିବା ଆରମ୍ଭ କର',
    'ta-IN': 'துடுப்பு போடத் தொடங்கு',
  }),
  speed_up: Object.freeze({
    'en-IN': 'Row faster',
    'hi-IN': 'तेज़ चलाओ',
    'bn-IN': 'আরও তাড়াতাড়ি টানো',
    'od-IN': 'ଆହୁରି ଜୋରରେ ମାର',
    'ta-IN': 'வேகமாக போடு',
  }),
  slow_down: Object.freeze({
    'en-IN': 'Row slower',
    'hi-IN': 'धीरे चलाओ',
    'bn-IN': 'আস্তে টানো',
    'od-IN': 'ଧୀରେ ମାର',
    'ta-IN': 'மெதுவாக போடு',
  }),
  hold: Object.freeze({
    'en-IN': 'Hold',
    'hi-IN': 'चप्पू थामे रखो',
    'bn-IN': 'দাঁড় ধরে রাখো',
    'od-IN': 'ଆହୁଲା ଧରି ରଖ',
    'ta-IN': 'அப்படியே பிடி',
  }),
  ready: Object.freeze({
    'en-IN': 'Get ready',
    'hi-IN': 'तैयार हो जाओ',
    'bn-IN': 'তৈরি হও',
    'od-IN': 'ପ୍ରସ୍ତୁତ ହୁଅ',
    'ta-IN': 'தயாராகு',
  }),
  stop: Object.freeze({
    'en-IN': 'Stop rowing',
    'hi-IN': 'रुक जाओ',
    'bn-IN': 'থামো',
    'od-IN': 'ବନ୍ଦ କର',
    'ta-IN': 'நிறுத்து',
  }),
});

export function phraseFor(meaning, lang) {
  const row = Object.hasOwn(PHRASES, meaning) ? PHRASES[meaning] : null;
  return row && Object.hasOwn(row, lang) ? row[lang] : null;
}

export const MAX_STROKES = 600; // stroke events kept in memory
export const MAX_TRIALS = 500; // evidence rows kept in memory
const RECENT_STROKES = 120; // stroke events served in the public state
const OUTCOMES = Object.freeze({ obeyed: 'obeyed', not_obeyed: 'notObeyed', not_sure: 'notSure' });

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function initialState({ mode = 'replay', startedT = 0 } = {}) {
  return deepFreeze({
    mode,
    startedT,
    langs: LANGS,
    phrasesReviewed: PHRASES_REVIEWED,
    callsVerified: false,
    phone: { connected: false, lastSeenT: null, userAgent: null, simulated: false },
    stroke: null,
    strokes: [],
    lastCall: null,
    lastResult: null,
    trials: [],
    tally: { obeyed: 0, notObeyed: 0, notSure: 0, total: 0 },
  });
}

export function withPhone(state, patch) {
  return { ...state, phone: { ...state.phone, ...patch } };
}

export function withStrokes(state, events) {
  if (events.length === 0) return state;
  const strokes = [...state.strokes, ...events].slice(-MAX_STROKES);
  return { ...state, strokes, stroke: strokes[strokes.length - 1] };
}

// Audio is delivered once in the SSE call event; it is never stored in state.
export function stripAudio(call) {
  const { ttsAudioBase64: _audio, ...rest } = call;
  return rest;
}

export function withCall(state, call) {
  return { ...state, lastCall: stripAudio(call), lastResult: null };
}

export function withTrial(state, trial) {
  const key = OUTCOMES[trial.outcome];
  if (!key) throw new TypeError(`unknown trial outcome: ${String(trial.outcome)}`);
  const row = stripAudio(trial);
  const kept = [...state.trials, row].slice(-MAX_TRIALS);
  const tally = { ...state.tally, [key]: state.tally[key] + 1, total: state.tally.total + 1 };
  return { ...state, trials: kept, tally, lastResult: row };
}

// Most recent smoothed rate before t, or 0 when the rower was not rowing
// (no stroke within staleMs before the call).
export function baselineSpm(state, t, staleMs = 8000) {
  const before = state.strokes.filter((e) => e.t <= t && t - e.t <= staleMs);
  const last = before[before.length - 1];
  return last && Number.isFinite(last.rateSpm) ? last.rateSpm : 0;
}

export function strokesBetween(state, fromT, toT) {
  return state.strokes.filter((e) => e.t > fromT && e.t <= toT);
}

export function publicState(state, serverT) {
  const { strokes, ...rest } = state;
  return { ...rest, recentStrokes: strokes.slice(-RECENT_STROKES), serverT };
}

export function formatSse(event, data) {
  if (!SSE_EVENTS.includes(event)) throw new TypeError(`unknown SSE event: ${String(event)}`);
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'X-Content-Type-Options': 'nosniff',
});
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024; // drop clients that stop reading

export function createHub(options = {}) {
  const { initial = initialState(), timers = globalThis, keepAliveMs = 15000, maxClients = 50 } = options;
  let state = deepFreeze(initial);
  let closed = false;
  const clients = new Set();

  function drop(res) {
    if (!clients.delete(res)) return;
    try {
      res.end();
    } catch {
      // the socket is already gone; nothing left to release
    }
  }

  function write(res, chunk) {
    try {
      if (res.destroyed || res.writableEnded || res.writableLength > MAX_BUFFERED_BYTES) return drop(res);
      res.write(chunk);
    } catch {
      drop(res);
    }
  }

  const keepAlive = timers.setInterval(() => {
    for (const res of [...clients]) write(res, ': keep-alive\n\n');
  }, keepAliveMs);
  if (keepAlive && typeof keepAlive.unref === 'function') keepAlive.unref();

  return {
    getState: () => state,
    clientCount: () => clients.size,
    // updater receives the current frozen state and must return a new object.
    update(updater) {
      const next = updater(state);
      if (!next || typeof next !== 'object') throw new TypeError('state updater must return an object');
      state = deepFreeze(next);
      return state;
    },
    // Registers an SSE client. Returns false (nothing written) when full or closed.
    addClient(req, res, initialEvents = []) {
      if (closed || clients.size >= maxClients) return false;
      res.writeHead(200, SSE_HEADERS);
      clients.add(res);
      const cleanup = () => drop(res);
      req.on('close', cleanup);
      res.on('error', cleanup);
      write(res, 'retry: 2000\n\n');
      for (const [event, data] of initialEvents) write(res, formatSse(event, data));
      return true;
    },
    broadcast(event, data) {
      const frame = formatSse(event, data);
      for (const res of [...clients]) write(res, frame);
      return clients.size;
    },
    close() {
      closed = true;
      timers.clearInterval(keepAlive);
      for (const res of [...clients]) drop(res);
    },
  };
}

// ---- Inbound message validation (system boundary for /api/phone, /api/stroke, /api/shout) ----

export class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}
const bad = (code, message) => new ValidationError(code, message);
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const present = (v) => v !== undefined && v !== null && v !== '';

export function validatePhone(body, req) {
  if (!isObject(body)) throw bad('invalid_body', 'Body must be a JSON object');
  const ua = present(body.userAgent) ? body.userAgent : req.headers['user-agent'] || null;
  if (ua !== null && typeof ua !== 'string') throw bad('invalid_user_agent', 'userAgent must be a string');
  const simulated = [body.simulated, body.simulation].includes(true) || [body.motion, body.mode].includes('simulated');
  return { userAgent: ua === null ? null : ua.slice(0, 300), simulated };
}

export function validateStrokes(body, cfg) {
  const list = Array.isArray(body) ? body : isObject(body) ? body.events : null;
  if (!Array.isArray(list)) throw bad('invalid_events', 'Body must be { "events": [ { "type": "stroke", "t", "rateSpm", "count" } ] }');
  if (list.length > cfg.maxStrokeBatch) throw bad('too_many_events', `events must hold at most ${cfg.maxStrokeBatch} items`);
  const events = list.map((e, i) => {
    if (!isObject(e)) throw bad('invalid_event', `events[${i}] must be an object`);
    if (e.type !== undefined && e.type !== 'stroke') throw bad('invalid_event', `events[${i}].type must be "stroke"`);
    if (!Number.isFinite(e.t) || Math.abs(e.t) > 1e15) throw bad('invalid_event', `events[${i}].t must be a finite number (ms) within +/-1e15`);
    const rate = e.rateSpm === undefined ? null : e.rateSpm;
    if (rate !== null && !(Number.isFinite(rate) && rate >= 0 && rate <= 400)) throw bad('invalid_event', `events[${i}].rateSpm must be a number between 0 and 400, or null`);
    if (!(Number.isInteger(e.count) && e.count >= 0)) throw bad('invalid_event', `events[${i}].count must be a non-negative integer`);
    return { t: e.t, rateSpm: rate, count: e.count, simulated: e.simulated === true };
  });
  const sentAt = isObject(body) && Number.isFinite(body.sentAt) && Math.abs(body.sentAt) <= 1e15 ? body.sentAt : null;
  return { events, sentAt, simulated: isObject(body) && body.simulated === true };
}

// Phone timestamps are on the phone clock (performance.now). Map them onto the server
// clock by anchoring the batch: sentAt (if given) or the newest event equals "now".
export function toServerEvents({ events, sentAt, simulated }, nowT) {
  if (events.length === 0) return [];
  const newest = Math.max(...events.map((e) => e.t));
  const anchor = sentAt !== null && sentAt >= newest ? sentAt : newest;
  return events.map((e) => ({
    type: 'stroke', t: nowT - (anchor - e.t), phoneT: e.t, rateSpm: e.rateSpm, count: e.count, simulated: simulated || e.simulated,
  }));
}

function decodeAudio(raw, mimeRaw, cfg) {
  if (typeof raw !== 'string') throw bad('invalid_audio', 'audioBase64 must be a base64 string');
  const dataUrl = /^data:([^;,]+)[^,]*;base64,/.exec(raw.slice(0, 200));
  const b64 = dataUrl ? raw.slice(dataUrl[0].length) : raw;
  if (b64.length > cfg.maxBodyBytes || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw bad('invalid_audio', 'audioBase64 is not valid base64');
  const mime = present(mimeRaw) ? mimeRaw : dataUrl ? dataUrl[1] : 'audio/webm';
  if (typeof mime !== 'string' || mime.length > 100 || !/^audio\/[A-Za-z0-9.+-]+(\s*;\s*[A-Za-z0-9.,+="\s-]+)?$/.test(mime)) {
    throw bad('invalid_mime', 'mime must be an audio type such as audio/webm or audio/mp4');
  }
  const audio = Buffer.from(b64, 'base64');
  if (audio.length === 0) throw bad('invalid_audio', 'audioBase64 decoded to zero bytes');
  return { audio, mime };
}

// Where a shout came from: a dropped voice note, the laptop microphone, typed
// text, the phone's hold-to-record button, an OS share sheet, a watched folder
// or the ingest CLI. Keep in sync with SOURCES in server/archive.js.
export const SHOUT_SOURCES = Object.freeze([
  'voice_note', 'text', 'mic', 'phone_mic', 'whatsapp_share', 'whatsapp_desktop', 'watched_folder', 'ingest',
]);

export function validateShout(body, cfg) {
  if (!isObject(body)) throw bad('invalid_body', 'Body must be a JSON object');
  if (!LANGS.includes(body.targetLang)) throw bad('invalid_target_lang', `targetLang must be one of: ${LANGS.join(', ')}`);
  const hasText = present(body.text);
  const hasAudio = present(body.audioBase64);
  if (!hasText && !hasAudio) throw bad('missing_input', 'Provide either text or audioBase64');
  if (hasText && hasAudio) throw bad('ambiguous_input', 'Provide text or audioBase64, not both');
  const source = present(body.source) ? body.source : null;
  if (source !== null && !SHOUT_SOURCES.includes(source)) {
    throw bad('invalid_source', `source must be one of: ${SHOUT_SOURCES.join(', ')}`);
  }
  let filename = null;
  if (present(body.filename)) {
    if (typeof body.filename !== 'string' || body.filename.length > 200 || /[\u0000-\u001f/\\]/.test(body.filename)) {
      throw bad('invalid_filename', 'filename must be a file name (no path separators) of at most 200 characters');
    }
    filename = body.filename;
  }
  const origin = { source: source || (hasAudio ? 'mic' : 'text'), filename };
  if (hasAudio) return { targetLang: body.targetLang, ...origin, ...decodeAudio(body.audioBase64, body.mime, cfg) };
  if (typeof body.text !== 'string' || body.text.trim() === '') throw bad('invalid_text', 'text must be a non-empty string');
  const text = body.text.trim();
  if (text.length > cfg.maxTextChars) throw bad('invalid_text', `text must be at most ${cfg.maxTextChars} characters`);
  return { targetLang: body.targetLang, ...origin, text };
}
