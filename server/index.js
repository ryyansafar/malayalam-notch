// Malayalam-in-the-notch HTTP(S) server: routes, validation, static files and
// the translate flow. Everything external is injected into createServer so
// tests never touch the network.
import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as H from './hub.js';
import { createArchive, archiveCsv, archiveJson } from './archive.js';
import { createQrRenderer, validateQrUrl, landingPage, messagePage, sharePage, QrUnavailableError } from './qr.js';
import { loadEnvFile, resolveConfig, readTls, lanAddresses, bannerLines, ConfigError } from './env.js';
import { sniffAudio, measureDuration, cutOgg, NOTE_MAX_BYTES, SPEECH_MAX_SECONDS } from '../shared/audio-sniff.js';
import { resolveWatchDirs, createWatcher } from './watcher.js';
import { createAgent, MAX_TEXT as AGENT_MAX_TEXT } from './agent.js';
import { createCaller } from './voice-call.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_LANG = 'ml-IN';
const TTS_PROVIDERS = Object.freeze(['sarvam', 'smallest']);
const DEFAULT_TTS_PROVIDER = 'sarvam';
// The three Saaras readings of one audio note (docs/SARVAM-FINDINGS.md):
// Malayalam script, romanised Malayalam and English, each an independent call.
const STT_OPS = Object.freeze({ sourceText: 'transcribe', romanText: 'translit', translatedText: 'translate' });
const MIME = Object.freeze({
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
});
const HTML = MIME['.html'];
const BASE_HEADERS = Object.freeze({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
const PAGE_CSP = "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'";
const DEFAULTS = Object.freeze({
  mode: 'replay', rootDir: ROOT, https: false,
  phoneTimeoutMs: 10000, // heartbeats arrive every 3 s
  maxBodyBytes: 8 * 1024 * 1024, keepAliveMs: 15000, maxSseClients: 50,
  maxTextChars: 500, maxSpeakChars: 2000,
  watchDirs: [], // folders the voice-note watcher reads (dashboard shows them)
  shareCutTtlMs: 120000, // how long a "use the first 30 s" offer stays valid
});
const ROUTES = Object.freeze({
  '/': ['GET'], '/phone': ['GET'], '/dashboard': ['GET'], '/qr.svg': ['GET'], '/events': ['GET'],
  '/api/state': ['GET'], '/api/phone': ['POST'], '/api/shout': ['POST'], '/api/speak': ['POST'], '/api/agent': ['POST'], '/api/call': ['POST'], '/api/call/status': ['GET'],
  '/api/providers': ['GET'], '/api/archive': ['GET'], '/api/archive.csv': ['GET'], '/api/archive.json': ['GET'],
  '/share': ['POST'], '/share/cut': ['POST'],
});

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    Object.assign(this, { status, code, headers });
  }
}
const bad = (code, message) => new HttpError(400, code, message);
const { isObject } = H;

// Only a short identifier from an error ever leaves the process: never its message or stack.
function errorName(err) {
  const candidates = [err && err.code, err && err.name, err && err.constructor && err.constructor.name];
  const names = candidates.filter((n) => typeof n === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(n));
  return names.includes('NoReplayAvailable') ? 'NoReplayAvailable' : names[0] || 'Error';
}

function send(res, status, type, body, extra = {}) {
  const buf = Buffer.from(body);
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Length': buf.length, ...extra });
  res.end(res.req && res.req.method === 'HEAD' ? undefined : buf);
}
const sendJson = (res, status, data, extra) => send(res, status, MIME['.json'], JSON.stringify(data), extra);
const sendPage = (res, status, html) => send(res, status, HTML, html, { 'Content-Security-Policy': PAGE_CSP });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, 'body_too_large', `Request body exceeds the ${limit} byte limit`, { Connection: 'close' });
    if (Number(req.headers['content-length']) > limit) {
      req.resume();
      return reject(tooLarge());
    }
    let chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      chunks = [];
      fn(value);
    };
    req.on('data', (chunk) => {
      if (done) return; // keep draining after an over-limit body so the 413 can be delivered
      size += chunk.length;
      if (size > limit) finish(reject, tooLarge());
      else chunks = [...chunks, chunk];
    });
    req.on('error', () => finish(reject, bad('unreadable_body', 'Request body could not be read')));
    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
  });
}

async function readJson(req, limit) {
  const text = (await readBody(req, limit)).toString('utf8');
  if (text.trim() === '') throw bad('empty_body', 'Request body must be JSON');
  try {
    return JSON.parse(text);
  } catch {
    throw bad('invalid_json', 'Request body is not valid JSON');
  }
}

// Splits a multipart/form-data body into parts. Binary-safe (Buffer indexes).
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType));
  if (!m) return [];
  const boundary = Buffer.from(`--${m[1] || m[2]}`, 'latin1');
  const parts = [];
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    let start = pos + boundary.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // closing --
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    const headerEnd = buf.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headers = {};
    for (const line of buf.slice(start, headerEnd).toString('latin1').split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const dataStart = headerEnd + 4;
    const next = buf.indexOf(boundary, dataStart);
    const end = next === -1 ? buf.length : next;
    const data = end - 2 >= dataStart ? buf.slice(dataStart, end - 2) : buf.slice(dataStart, end); // strip the CRLF before the boundary
    const disp = headers['content-disposition'] || '';
    const name = (/(?:^|;)\s*name="([^"]*)"/.exec(disp) || [])[1] ?? null;
    const filename = (/(?:^|;)\s*filename="([^"]*)"/.exec(disp) || [])[1] ?? null;
    parts.push({ name, filename, type: headers['content-type'] || null, data });
    pos = next === -1 ? -1 : next;
  }
  return parts;
}

// A shared file name (browsers may send a full path): keep only the base name.
function safeFilename(raw) {
  const base = String(raw || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').slice(0, 200).trim();
  return base || 'shared-audio';
}

function decodePath(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw bad('bad_path', 'Malformed URL path');
  }
}

// Serves one regular file from inside baseDir. No listings, no dotfiles, no traversal.
async function serveFile(res, baseDir, rel) {
  const notFound = new HttpError(404, 'not_found', 'File not found');
  const segments = rel.split('/');
  if (rel.includes('\0') || rel.includes('\\') || segments.some((s) => s.startsWith('.'))) {
    throw new HttpError(403, 'forbidden_path', 'Path not allowed');
  }
  const type = MIME[path.extname(rel).toLowerCase()];
  if (!type || segments.some((s) => s === '')) throw notFound;
  let real;
  let data;
  try {
    const base = await fs.realpath(baseDir);
    real = await fs.realpath(path.join(base, ...segments));
    if (!real.startsWith(base + path.sep)) throw new HttpError(403, 'forbidden_path', 'Path not allowed');
    if (!(await fs.stat(real)).isFile()) throw notFound;
    data = await fs.readFile(real);
  } catch (err) {
    throw err instanceof HttpError ? err : notFound;
  }
  send(res, 200, type, data);
}

const lane = (r) => (r && r.source === 'live' ? 'live' : 'replay'); // unknown is never claimed as LIVE
const ms = (r) => (r && Number.isFinite(r.latencyMs) ? r.latencyMs : 0);
const textOf = (r) => (r && typeof r.text === 'string' ? r.text.trim() : '');

// Optional shout fields: which speech provider reads the translation back.
function shoutOptions(body, smallest) {
  const provider = body.ttsProvider === undefined || body.ttsProvider === null ? DEFAULT_TTS_PROVIDER : body.ttsProvider;
  if (!TTS_PROVIDERS.includes(provider)) throw bad('invalid_tts_provider', `ttsProvider must be one of: ${TTS_PROVIDERS.join(', ')}`);
  if (provider === 'smallest' && !smallest) throw bad('tts_provider_unavailable', 'ttsProvider "smallest" is not configured on this server');
  return { ttsProvider: provider };
}

/**
 * @param {{ sarvam: object, smallest?: object, archive?: object,
 *   timers?: object, qr?: (url: string) => Promise<string>, log?: (line: string) => void,
 *   now?: () => number, config?: object }} deps
 * @returns {{ server: import('node:http').Server, hub: object, archive: object, listen: Function, close: Function }}
 */
export function createServer(deps = {}) {
  const { sarvam, smallest = null, agent = null, caller = null, archive: archiveDep = null, now = Date.now, timers = globalThis, qr = createQrRenderer(), log = () => {} } = deps;
  const cfg = Object.freeze({ lanAddresses: lanAddresses(), ...DEFAULTS, ...deps.config });
  const hub = H.createHub({ initial: H.initialState({ mode: cfg.mode, startedT: now() }), timers, keepAliveMs: cfg.keepAliveMs, maxClients: cfg.maxSseClients });
  const archive = archiveDep || createArchive({ log, now });
  const publicDir = path.join(cfg.rootDir, 'public');
  const snapshot = () => ({ ...H.publicState(hub.getState(), now()), notesToday: countNotesToday() });
  let seq = 0;
  let shoutInFlight = false;
  const pendingCuts = new Map(); // token -> { bytes, mime, filename, expiresT } for a /share "first 30 s" offer

  function countNotesToday() {
    try {
      return typeof archive.countToday === 'function' ? archive.countToday(now()) : 0;
    } catch {
      return 0;
    }
  }

  const sweep = timers.setInterval(() => {
    const { phone } = hub.getState();
    if (!phone.connected || now() - phone.lastSeenT <= cfg.phoneTimeoutMs) return;
    hub.broadcast('phone', hub.update((s) => H.withPhone(s, { connected: false })).phone);
  }, Math.max(1, Math.floor(cfg.phoneTimeoutMs / 2)));
  if (sweep && typeof sweep.unref === 'function') sweep.unref();

  // A tunnel (for example a cloudflared quick tunnel) terminates TLS and forwards plain HTTP.
  // The header only changes the links shown to the client that sent it.
  const viaHttpsProxy = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';

  function origin(req) {
    const scheme = cfg.https ? 'https' : 'http';
    const port = (server.address() || {}).port;
    const lan = cfg.lanAddresses.map((a) => `${scheme}://${a}:${port}`);
    const host = String(req.headers.host || '');
    const safe = /^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:\d{1,5})?$/.test(host);
    const local = !safe || /^(localhost|127\.|\[::1\])/i.test(host);
    const own = local ? lan[0] || `${scheme}://localhost:${port}` : `${viaHttpsProxy(req) ? 'https' : scheme}://${host}`;
    return [own, ...lan.filter((u) => u !== own)];
  }

  async function upstream(stage, fn) {
    try {
      return await fn();
    } catch (err) {
      const name = errorName(err);
      log(`[shout] ${stage} failed: ${name}`);
      if (name === 'NoReplayAvailable') {
        throw new HttpError(503, 'no_replay_available', `No cached ${stage} result is available in REPLAY mode. Record fixtures or set SARVAM_API_KEY for LIVE mode.`);
      }
      throw new HttpError(502, `${stage}_failed`, `The Sarvam ${stage} call failed (${name}).`);
    }
  }

  // One Saaras reading of the audio, with a fallback for clients that only
  // expose translate(): the English field still works, the others report failed.
  function sttCall(input, mode) {
    if (typeof sarvam.stt === 'function') {
      return sarvam.stt({ audio: input.audio, mime: input.mime, sourceLang: SOURCE_LANG, mode });
    }
    if (mode === 'translate') return sarvam.translate({ audio: input.audio, mime: input.mime, sourceLang: SOURCE_LANG });
    return Promise.reject(Object.assign(new Error(`client has no ${mode} speech-to-text`), { name: 'UnsupportedStt' }));
  }

  // The three Saaras modes in parallel (docs/SARVAM-FINDINGS.md). A mode that
  // fails never sinks the others; only a clean sweep of failures is an error.
  async function hearAudio(input) {
    const fields = {};
    const sources = {};
    const failedOps = [];
    const errors = [];
    let latencyMs = 0;
    await Promise.all(Object.entries(STT_OPS).map(async ([field, mode]) => {
      try {
        const r = await upstream(mode, () => sttCall(input, mode));
        fields[field] = textOf(r);
        sources[mode] = lane(r);
        fields.detectedLanguage = fields.detectedLanguage || (typeof r.language === 'string' && r.language ? r.language : null);
        latencyMs = Math.max(latencyMs, ms(r));
      } catch (err) {
        failedOps.push(mode);
        sources[mode] = null;
        errors.push(err);
        log(`[shout] ${mode} reading failed: ${errorName(err)}`);
      }
    }));
    if (errors.length === Object.keys(STT_OPS).length) throw errors[0];
    return { ...fields, sources, failedOps, latencyMs };
  }

  async function hearText(input) {
    const tr = await upstream('translate', () => sarvam.translate({ text: input.text, sourceLang: SOURCE_LANG }));
    return {
      sourceText: input.text, romanText: null, translatedText: textOf(tr),
      detectedLanguage: typeof tr.language === 'string' && tr.language ? tr.language : null,
      sources: { translate: lane(tr) }, failedOps: [], latencyMs: ms(tr),
    };
  }

  async function speakWith(provider, text, targetLang) {
    const client = provider === 'smallest' ? smallest : sarvam;
    const tts = await upstream('speak', () => client.speak({ text, targetLang })).catch(() => null);
    return tts && typeof tts.audioBase64 === 'string' && tts.audioBase64 !== '' ? tts : null;
  }

  // The translation spoken in the chosen language. English is spoken as is;
  // anything else is translated English -> target first. A failed re-translation
  // means no audio rather than speech in the wrong language.
  async function spoken(translatedText, input) {
    let spokenText = translatedText;
    let extraMs = 0;
    if (input.targetLang !== 'en-IN') {
      try {
        const t = await upstream('translate', () => sarvam.translate({ text: translatedText, sourceLang: 'en-IN', targetLang: input.targetLang }));
        spokenText = textOf(t) || translatedText;
        extraMs = ms(t);
        if (!textOf(t)) return { spokenText: null, spokenLang: null, tts: null, extraMs, failed: true };
      } catch (err) {
        log(`[shout] ${input.targetLang} re-translation failed: ${errorName(err)}`);
        return { spokenText: null, spokenLang: null, tts: null, extraMs, failed: true };
      }
    }
    const tts = await speakWith(input.ttsProvider, spokenText, input.targetLang);
    return { spokenText: tts ? spokenText : null, spokenLang: input.targetLang, tts, extraMs, failed: false };
  }

  // One shout at a time; /api/shout, /share and the watched-folder ingest all come through here.
  async function processShout(input) {
    if (shoutInFlight) throw new HttpError(429, 'busy', 'Another note is being translated. Try again in a moment.', { 'Retry-After': '1' });
    shoutInFlight = true;
    try {
      return await runShout(input);
    } finally {
      shoutInFlight = false;
    }
  }

  function publish(note) {
    hub.update((s) => H.withNote(s, note));
    hub.broadcast('note', note);
    hub.broadcast('state', snapshot());
    return note;
  }

  async function runShout(input) {
    seq += 1;
    const noteId = `note-${seq}`;
    hub.broadcast('received', { noteId, t: now(), input: input.audio ? 'audio' : 'text', origin: input.source, filename: input.filename });
    let heard;
    try {
      heard = input.audio ? await hearAudio(input) : await hearText(input);
    } catch (err) {
      const code = err instanceof HttpError ? err.code : errorName(err);
      const failed = { noteId, t: now(), input: input.audio ? 'audio' : 'text', origin: input.source, filename: input.filename, status: 'error', error: { code, message: err instanceof HttpError ? err.message : 'Translation failed.' } };
      publish(failed);
      throw err;
    }
    const { spokenText, spokenLang, tts, extraMs, failed: speakTranslateFailed } = heard.translatedText
      ? await spoken(heard.translatedText, input)
      : { spokenText: null, spokenLang: null, tts: null, extraMs: 0, failed: false };
    const t = now();
    const failedOps = [...heard.failedOps, ...(speakTranslateFailed ? ['speak_translate'] : [])];
    const lanes = [heard.sources.translate, heard.sources.transcribe, heard.sources.translit, tts && lane(tts)].filter(Boolean);
    const note = {
      noteId, t, status: 'ok', input: input.audio ? 'audio' : 'text',
      origin: input.source, filename: input.filename, targetLang: input.targetLang,
      sourceText: heard.sourceText || null, romanText: heard.romanText || null,
      translatedText: heard.translatedText || null, detectedLanguage: heard.detectedLanguage || null,
      spokenText, spokenLang, ttsAudioBase64: tts ? tts.audioBase64 : null,
      mime: tts ? tts.mime || 'audio/wav' : null, ttsAvailable: Boolean(tts),
      ttsProvider: input.ttsProvider, tts: tts ? { provider: input.ttsProvider, latencyMs: ms(tts), source: lane(tts) } : null,
      sources: { ...heard.sources, speak: tts ? lane(tts) : null },
      failedOps, latencyMs: heard.latencyMs + extraMs + ms(tts),
      source: lanes.includes('replay') ? 'replay' : 'live',
    };
    try {
      archive.add({
        time: t, source: input.source, filename: input.filename,
        language: note.detectedLanguage, text: note.translatedText || '',
        transcript: note.sourceText, roman: note.romanText,
      });
    } catch (err) {
      log(`[archive] add failed: ${errorName(err)}`);
    }
    return publish(note);
  }

  // Booleans and mode names only: never a key.
  function providersInfo() {
    const modeOf = (client) => (client && (client.mode === 'live' || client.mode === 'replay') ? client.mode : null);
    const keyed = (flag, client) => (typeof flag === 'boolean' ? flag : modeOf(client) === 'live');
    return {
      providers: {
        sarvam: { configured: keyed(cfg.sarvamKeyPresent, sarvam), mode: modeOf(sarvam) || cfg.mode },
        smallest: { configured: Boolean(smallest) && keyed(cfg.smallestKeyPresent, smallest), mode: modeOf(smallest) },
      },
      ttsProviders: smallest ? TTS_PROVIDERS : [DEFAULT_TTS_PROVIDER],
      defaultTtsProvider: DEFAULT_TTS_PROVIDER,
      watchDirs: Array.isArray(cfg.watchDirs) ? cfg.watchDirs.slice(0, 10) : [],
    };
  }

  // One plain sentence for the share-target answer page.
  function shareDetail(result) {
    const heard = result.translatedText ? `heard "${result.translatedText}"` : 'nothing could be translated';
    return result.sourceText ? `${heard} — Malayalam: "${result.sourceText}".` : `${heard}.`;
  }

  const handlers = {
    'GET /': async (req, res) => {
      const [phoneBase, ...others] = origin(req);
      sendPage(res, 200, landingPage({ phoneUrl: `${phoneBase}/phone`, otherPhoneUrls: others.map((u) => `${u}/phone`), mode: cfg.mode, https: cfg.https || viaHttpsProxy(req) }));
    },
    'GET /qr.svg': async (req, res, query) => {
      const checked = validateQrUrl(query.get('url'));
      if (!checked.ok) throw bad('invalid_url', checked.message);
      try {
        send(res, 200, MIME['.svg'], await qr(checked.url));
      } catch (err) {
        if (!(err instanceof QrUnavailableError)) log(`[qr] render failed: ${errorName(err)}`);
        throw new HttpError(503, 'qr_unavailable', 'QR code could not be generated. Run npm install, or type the phone URL shown on the start page.');
      }
    },
    'GET /events': async (req, res) => {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Use GET for /events', { Allow: 'GET' });
      if (!hub.addClient(req, res, [['state', snapshot()]])) throw new HttpError(503, 'too_many_clients', 'Too many event stream clients');
    },
    'GET /api/state': async (req, res) => sendJson(res, 200, snapshot()),
    'GET /api/providers': async (req, res) => sendJson(res, 200, { ok: true, ...providersInfo() }),
    'GET /api/archive': async (req, res, query) => {
      const q = (query.get('q') || '').slice(0, 200);
      sendJson(res, 200, { ok: true, entries: archive.list({ q }) });
    },
    'POST /api/phone': async (req, res) => {
      const info = H.validatePhone(await readJson(req, cfg.maxBodyBytes), req);
      const { phone } = hub.update((s) => H.withPhone(s, { ...info, connected: true, lastSeenT: now() }));
      hub.broadcast('phone', phone);
      sendJson(res, 200, { ok: true, phone });
    },
    'POST /api/shout': async (req, res) => {
      const body = await readJson(req, cfg.maxBodyBytes);
      const input = { ...H.validateShout(body, cfg), ...shoutOptions(body, smallest) };
      const result = await processShout(input);
      sendJson(res, 200, { ok: true, ...result });
    },
    'POST /api/speak': async (req, res) => {
      // Speak-again: stored archive text re-spoken in the chosen language.
      const body = await readJson(req, cfg.maxBodyBytes);
      if (!isObject(body)) throw bad('invalid_body', 'Body must be a JSON object');
      if (!H.LANGS.includes(body.targetLang)) throw bad('invalid_target_lang', `targetLang must be one of: ${H.LANGS.join(', ')}`);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) throw bad('invalid_text', 'text must be a non-empty string');
      if (text.length > cfg.maxSpeakChars) throw bad('invalid_text', `text must be at most ${cfg.maxSpeakChars} characters`);
      const { ttsProvider } = shoutOptions(body, smallest);
      const { spokenText, spokenLang, tts, failed } = await spoken(text, { targetLang: body.targetLang });
      if (failed || !tts) throw new HttpError(502, 'speak_failed', 'The speech call failed.');
      sendJson(res, 200, { ok: true, spokenText, spokenLang, ttsAudioBase64: tts.audioBase64, mime: tts.mime || 'audio/wav', ttsProvider, tts: { provider: ttsProvider, latencyMs: ms(tts), source: lane(tts) } });
    },
    'POST /api/agent': async (req, res) => {
      // Free-form request (Malayalam or English) -> a short reply plus validated tool calls.
      // The Mac app performs the actions; the reply can be spoken back in the user's language.
      const body = await readJson(req, cfg.maxBodyBytes);
      if (!isObject(body)) throw bad('invalid_body', 'Body must be a JSON object');
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) throw bad('invalid_text', 'text must be a non-empty string');
      if (text.length > AGENT_MAX_TEXT) throw bad('invalid_text', `text must be at most ${AGENT_MAX_TEXT} characters`);
      if (!agent) throw new HttpError(503, 'agent_unavailable', 'The assistant is not configured.');
      // Optional profile context: only what the user chose to share, capped, and never logged.
      const profile = typeof body.profile === 'string' ? body.profile.trim().slice(0, 800) : '';
      const out = await agent.run({ text, profile });
      if (!out.ok) throw new HttpError(502, out.error || 'agent_failed', 'The assistant could not answer. Try again.');
      let speech = null;
      if (body.speak === true && out.reply) {
        const { ttsProvider } = shoutOptions(body, smallest);
        const lang = /[\u0D00-\u0D7F]/.test(out.reply) ? 'ml-IN' : 'en-IN';
        const tts = await speakWith(ttsProvider, out.reply, lang);
        if (tts) speech = { ttsAudioBase64: tts.audioBase64, mime: tts.mime || 'audio/wav', lang, provider: ttsProvider };
      }
      sendJson(res, 200, { ok: true, reply: out.reply, actions: out.actions, latencyMs: out.latencyMs ?? null, offline: out.offline === true, speech });
    },
    'GET /api/call/status': async (req, res) => {
      const missing = caller ? caller.missing() : ['SARVAM_VOICE_*'];
      sendJson(res, 200, { ok: true, configured: missing.length === 0, missing });
    },
    'POST /api/call': async (req, res) => {
      // Ring the user's phone with a Malayalam reminder (Sarvam Voice Agents). The Mac app asks for an
      // on-screen confirmation first; this route only places the call.
      const body = await readJson(req, cfg.maxBodyBytes);
      if (!isObject(body)) throw bad('invalid_body', 'Body must be a JSON object');
      if (!caller) throw new HttpError(503, 'call_unavailable', 'Phone calls are not configured.');
      const out = await caller.call({ phone: body.phone, reminderText: body.reminderText, userName: body.userName });
      if (!out.ok && (out.error === 'bad_phone' || out.error === 'empty_reminder')) throw bad(out.error, 'Check the phone number (+91…) and the reminder text.');
      sendJson(res, out.ok ? 200 : 502, out);
    },
    'GET /api/archive.csv': async (req, res) => {
      send(res, 200, 'text/csv; charset=utf-8', archiveCsv(archive.list()), { 'Content-Disposition': 'attachment; filename="malayalam-notes.csv"' });
    },
    'GET /api/archive.json': async (req, res) => {
      send(res, 200, MIME['.json'], archiveJson(archive.list()), { 'Content-Disposition': 'attachment; filename="malayalam-notes.json"' });
    },
    'POST /share': async (req, res, query) => {
      // Web Share Target (public/phone.webmanifest): the OS share sheet posts
      // the voice note here. The answer is a small HTML page, not JSON.
      const ctype = String(req.headers['content-type'] || '');
      if (!/^multipart\/form-data/i.test(ctype)) {
        return sendPage(res, 400, sharePage({ title: 'No file shared', detail: 'The share did not contain a file.' }));
      }
      const part = parseMultipart(await readBody(req, cfg.maxBodyBytes), ctype).find((p) => p.filename && p.data.length > 0);
      if (!part) return sendPage(res, 400, sharePage({ title: 'No audio file', detail: 'The shared item did not contain an audio file.' }));
      const filename = safeFilename(part.filename);
      if (part.data.length > NOTE_MAX_BYTES) {
        return sendPage(res, 200, sharePage({ title: 'Note too large', detail: `"${filename}" is ${(part.data.length / 1e6).toFixed(1)} MB; the limit is ${NOTE_MAX_BYTES / 1e6} MB.` }));
      }
      const sniffed = sniffAudio(part.data);
      if (!sniffed) {
        return sendPage(res, 200, sharePage({ title: 'Not an audio file', detail: `"${filename}" is not a recognised audio file (Ogg/Opus, MP3, WAV, M4A, AAC, AMR or WebM).` }));
      }
      const lang = H.LANGS.includes(query.get('lang')) ? query.get('lang') : 'en-IN';
      const dur = measureDuration(part.data, sniffed.format);
      if (dur && dur.seconds > SPEECH_MAX_SECONDS) {
        const how = dur.exact ? 'is' : 'is about';
        const cut = sniffed.format === 'ogg' ? cutOgg(part.data, SPEECH_MAX_SECONDS) : null;
        if (!cut) {
          return sendPage(res, 200, sharePage({ title: 'Note too long', detail: `"${filename}" ${how} ${Math.round(dur.seconds)} s; Sarvam speech-to-text accepts clips up to ${SPEECH_MAX_SECONDS} s. Send a shorter note.` }));
        }
        const token = randomBytes(10).toString('hex');
        for (const [k, v] of pendingCuts) if (v.expiresT <= now()) pendingCuts.delete(k);
        pendingCuts.set(token, { bytes: cut, mime: sniffed.mime, filename, expiresT: now() + cfg.shareCutTtlMs });
        return sendPage(res, 200, sharePage({
          title: 'Note too long',
          detail: `"${filename}" ${how} ${Math.round(dur.seconds)} s; the limit is ${SPEECH_MAX_SECONDS} s. The first 30 seconds can be cut at a page boundary — nothing is re-encoded.`,
          form: { action: '/share/cut', token, label: 'Use the first 30 seconds' },
        }));
      }
      try {
        const result = await processShout({ audio: part.data, mime: sniffed.mime, filename, source: 'whatsapp_share', targetLang: lang, ttsProvider: DEFAULT_TTS_PROVIDER });
        return sendPage(res, 200, sharePage({ title: 'Voice note heard', detail: shareDetail(result) }));
      } catch (err) {
        return sendPage(res, err instanceof HttpError && err.status === 429 ? 200 : 500, sharePage({ title: 'Not sent', detail: err instanceof HttpError ? err.message : 'The note could not be translated.' }));
      }
    },
    'POST /share/cut': async (req, res) => {
      const token = new URLSearchParams((await readBody(req, cfg.maxBodyBytes)).toString('utf8')).get('token');
      const held = token ? pendingCuts.get(token) : null;
      pendingCuts.delete(token);
      if (!held || held.expiresT <= now()) {
        return sendPage(res, 200, sharePage({ title: 'Offer expired', detail: 'That "first 30 seconds" offer is no longer held. Share the note again.' }));
      }
      try {
        const result = await processShout({ audio: held.bytes, mime: held.mime, filename: held.filename, source: 'whatsapp_share', targetLang: 'en-IN', ttsProvider: DEFAULT_TTS_PROVIDER });
        return sendPage(res, 200, sharePage({ title: 'Voice note heard', detail: `first 30 s of "${held.filename}". ${shareDetail(result)}` }));
      } catch (err) {
        return sendPage(res, err instanceof HttpError && err.status === 429 ? 200 : 500, sharePage({ title: 'Not sent', detail: err instanceof HttpError ? err.message : 'The note could not be translated.' }));
      }
    },
  };
  for (const name of ['phone', 'dashboard']) {
    handlers[`GET /${name}`] = (req, res) => serveFile(res, publicDir, `${name}.html`).catch((err) => {
      if (err.status !== 404) throw err;
      sendPage(res, 404, messagePage({ title: 'Page not built yet', detail: `public/${name}.html is missing. It is built separately; add the file and reload.` }));
    });
  }

  async function route(req, res) {
    const cut = req.url.indexOf('?');
    const rawPath = cut === -1 ? req.url : req.url.slice(0, cut);
    const query = new URLSearchParams(cut === -1 ? '' : req.url.slice(cut + 1));
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (Object.hasOwn(ROUTES, rawPath)) {
      if (ROUTES[rawPath].includes(method)) return handlers[`${method} ${rawPath}`](req, res, query);
      throw new HttpError(405, 'method_not_allowed', `Use ${ROUTES[rawPath].join(', ')} for ${rawPath}`, { Allow: ROUTES[rawPath].join(', ') });
    }
    if (method !== 'GET') throw new HttpError(rawPath.startsWith('/api/') ? 404 : 405, 'not_found', 'No such endpoint', { Allow: 'GET, HEAD' });
    const pathname = decodePath(rawPath);
    for (const dir of ['public', 'shared']) {
      if (pathname.startsWith(`/${dir}/`)) return serveFile(res, path.join(cfg.rootDir, dir), pathname.slice(dir.length + 2));
    }
    // Pages served at /phone and /dashboard may reference sibling files relatively (for example "phone.js").
    if (!pathname.startsWith('/api/') && /^\/[^/]+\.[A-Za-z0-9]+$/.test(pathname)) return serveFile(res, publicDir, pathname.slice(1));
    throw new HttpError(404, 'not_found', 'No such endpoint');
  }

  function fail(req, res, err) {
    const invalid = err instanceof H.ValidationError ? bad(err.code, err.message) : null;
    const known = invalid || err instanceof HttpError;
    if (!known) log(`[server] unexpected error: ${errorName(err)}`);
    if (res.headersSent) return res.destroy();
    const e = invalid || (known ? err : new HttpError(500, 'internal_error', 'Unexpected server error'));
    if (e.status === 404 && !String(req.url).startsWith('/api/')) {
      return sendPage(res, 404, messagePage({ title: 'Not found', detail: 'There is nothing at this address.' }));
    }
    return sendJson(res, e.status, { ok: false, error: { code: e.code, message: e.message } }, e.headers);
  }

  const onRequest = (req, res) => route(req, res).catch((err) => fail(req, res, err));
  const server = cfg.tls ? https.createServer(cfg.tls, onRequest) : http.createServer(onRequest);
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return {
    server,
    hub,
    archive,
    listen: (port = 0, host = '0.0.0.0') => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve({ port: server.address().port }));
    }),
    close: () => new Promise((resolve) => {
      timers.clearInterval(sweep);
      hub.close();
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 1000).unref();
    }),
  };
}

async function main() {
  const say = (line) => process.stdout.write(`${line}\n`);
  const warn = (line) => process.stderr.write(`${line}\n`);
  loadEnvFile(path.join(ROOT, '.env'));
  const conf = resolveConfig();
  const [client, second] = await Promise.all([
    import('../sarvam/client.js'), import('../smallest/client.js'),
  ]);
  const cacheDir = path.join(ROOT, 'sarvam', 'cache');
  const smallestKey = (process.env.SMALLEST_API_KEY || '').trim();
  const clientLog = Object.assign((line) => warn(String(line)), { info: warn, warn, error: warn, debug: () => {} });
  const sarvam = client.createSarvamClient({
    apiKey: conf.apiKeyPresent ? process.env.SARVAM_API_KEY.trim() : undefined,
    mode: conf.requestedMode, cacheDir, log: clientLog,
  });
  // smallest.ai follows SARVAM_MODE: live needs SMALLEST_API_KEY, auto without a key replays the cache.
  const smallest = second.createSmallestClient({ apiKey: smallestKey || undefined, mode: conf.requestedMode, cacheDir, log: clientLog });
  const archive = createArchive({ file: path.join(ROOT, 'data', 'archive.jsonl'), log: warn });
  const watch = resolveWatchDirs({ env: process.env });
  const watchLang = H.LANGS.includes(process.env.WATCH_LANG) ? process.env.WATCH_LANG : 'en-IN';
  const caller = createCaller({ env: process.env, log: warn });
  const agent = createAgent({ apiKey: conf.apiKeyPresent ? process.env.SARVAM_API_KEY.trim() : undefined, log: warn });
  const app = createServer({
    sarvam, smallest, agent, caller, archive, log: warn,
    config: { mode: conf.mode, https: conf.https, sarvamKeyPresent: conf.apiKeyPresent, smallestKeyPresent: smallestKey !== '', watchDirs: watch.dirs.map((d) => d.dir), ...(conf.https ? { tls: readTls(conf) } : {}) },
  });
  const { port } = await app.listen(conf.port);
  for (const line of bannerLines({ ...conf, port, addresses: lanAddresses() })) say(line);
  say(`smallest.ai: ${smallest.mode === 'live' ? 'LIVE' : 'REPLAY'} (SMALLEST_API_KEY ${smallestKey ? 'set' : 'not set'})`);
  say(`note archive: data/archive.jsonl (${archive.size} entr${archive.size === 1 ? 'y' : 'ies'}, newest first, capped at 500)`);

  // Watched-folder ingest: audio files that appear in the inbox (or in
  // WATCH_DIRS folders) are posted to this server's own shout endpoint.
  // Over-limit notes are reported and skipped — never silently truncated.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const postWatchedNote = async (info) => {
    if (info.seconds !== null && info.seconds > SPEECH_MAX_SECONDS) {
      warn(`[watch] ${info.filename}: ${info.exact ? 'is' : 'is about'} ${Math.round(info.seconds)} s — over the ${SPEECH_MAX_SECONDS} s speech-to-text limit; ignored`);
      return;
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/shout`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audioBase64: info.bytes.toString('base64'), mime: info.mime,
            filename: info.filename, source: info.source, targetLang: watchLang,
          }),
        });
        const data = await res.json().catch(() => null);
        if (res.status === 429) {
          await sleep(3000);
          continue; // a note was in flight; try again
        }
        if (!res.ok || !data || data.ok === false) {
          warn(`[watch] ${info.filename}: ${(data && data.error && data.error.message) || `HTTP ${res.status}`}`);
        }
        return;
      } catch (err) {
        warn(`[watch] ${info.filename}: post failed (${err.code || err.name})`);
        return;
      }
    }
    warn(`[watch] ${info.filename}: the server stayed busy; dropped`);
  };
  const watcher = createWatcher({ dirs: watch.dirs, ingest: postWatchedNote, log: warn });
  const watching = await watcher.start();
  if (watching > 0) say(`watching: ${watch.dirs.map((d) => d.dir).join(', ')} (new audio files become voice notes, ${watchLang})`);
  for (const line of watch.warnings) warn(`Warning: ${line}`);

  const shutdown = () => {
    say('Shutting down');
    watcher.close();
    app.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // Node system errors (missing module, port in use) carry paths and ports, never secrets.
    const system = err && typeof err.code === 'string' && err.code.startsWith('E');
    const detail = err instanceof ConfigError || system ? err.message : errorName(err);
    process.stderr.write(`malayalam-notch could not start: ${detail}\n`);
    process.exit(1);
  });
}
