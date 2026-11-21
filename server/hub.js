// SSE hub, immutable session state and the validation of inbound phone/shout
// messages for the Malayalam notch product. The state object is never mutated:
// every change builds a new frozen object.

export const LANGS = Object.freeze(['en-IN', 'hi-IN', 'bn-IN', 'od-IN', 'ta-IN']);
export const SSE_EVENTS = Object.freeze(['state', 'received', 'note', 'phone']);

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
    phone: { connected: false, lastSeenT: null, userAgent: null },
    lastNote: null,
  });
}

export function withPhone(state, patch) {
  return { ...state, phone: { ...state.phone, ...patch } };
}

// Audio is delivered once in the SSE note event; it is never stored in state.
export function stripAudio(note) {
  const { ttsAudioBase64: _audio, ...rest } = note;
  return rest;
}

export function withNote(state, note) {
  return { ...state, lastNote: stripAudio(note) };
}

export function publicState(state, serverT) {
  return { ...state, serverT };
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

// ---- Inbound message validation (system boundary for /api/phone, /api/shout) ----

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
  return { userAgent: ua === null ? null : ua.slice(0, 300) };
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

// Where a note came from: a dropped voice note, a microphone, typed text, the
// phone's hold-to-record button, an OS share sheet, a watched folder, the
// ingest CLI or a file dropped onto the MacBook notch.
// Keep in sync with SOURCES in server/archive.js.
export const SHOUT_SOURCES = Object.freeze([
  'voice_note', 'text', 'mic', 'phone_mic', 'whatsapp_share', 'whatsapp_desktop', 'watched_folder', 'ingest', 'notch_drop',
]);

export function validateShout(body, cfg) {
  if (!isObject(body)) throw bad('invalid_body', 'Body must be a JSON object');
  // `mode` is accepted and ignored: older callers may send it.
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
