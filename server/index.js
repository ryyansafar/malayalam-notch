// rowing-call HTTP(S) server: routes, validation, static files and the shout flow.
// Everything external is injected into createServer so tests never touch the network.
import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as H from './hub.js';
import { createQrRenderer, validateQrUrl, landingPage, messagePage, QrUnavailableError } from './qr.js';
import { loadEnvFile, resolveConfig, readTls, lanAddresses, bannerLines, ConfigError } from './env.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_LANG = 'ml-IN';
const TTS_PROVIDERS = Object.freeze(['sarvam', 'smallest']);
const DEFAULT_TTS_PROVIDER = 'sarvam';
const SECOND_EAR_LANGUAGE = 'ml'; // Pulse language code for the coach's Malayalam
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
  windowMs: 8000, // observation window passed to evaluate()
  graceMs: 750, // wait for the phone's last 500 ms stroke batch before judging
  baselineStaleMs: 8000, // no stroke this long before the call means baseline 0 spm
  phoneTimeoutMs: 10000, // heartbeats arrive every 3 s
  maxBodyBytes: 8 * 1024 * 1024, keepAliveMs: 15000, maxSseClients: 50,
  maxTextChars: 500, maxStrokeBatch: 200,
  secondEar: false, // SECOND_EAR=1: also transcribe the shout with smallest.ai Pulse and compare meanings
  modelFallback: false, // MODEL_FALLBACK=1: ask the classifier when the rules found no keyword at all
  modelTimeoutMs: 6500, // hard stop for the classifier; a slow model becomes "not sure"
});
const ROUTES = Object.freeze({
  '/': ['GET'], '/phone': ['GET'], '/dashboard': ['GET'], '/qr.svg': ['GET'], '/events': ['GET'],
  '/api/state': ['GET'], '/api/phone': ['POST'], '/api/stroke': ['POST'], '/api/shout': ['POST'],
  '/api/providers': ['GET'],
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

function readJson(req, limit) {
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
    req.on('end', () => {
      if (done) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return finish(reject, bad('empty_body', 'Request body must be JSON'));
      try {
        finish(resolve, JSON.parse(text));
      } catch {
        finish(reject, bad('invalid_json', 'Request body is not valid JSON'));
      }
    });
  });
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

// Optional shout fields that pick the speech provider and ask for the coach's call to be spoken back.
function shoutOptions(body, smallest) {
  const provider = body.ttsProvider === undefined || body.ttsProvider === null ? DEFAULT_TTS_PROVIDER : body.ttsProvider;
  if (!TTS_PROVIDERS.includes(provider)) throw bad('invalid_tts_provider', `ttsProvider must be one of: ${TTS_PROVIDERS.join(', ')}`);
  if (provider === 'smallest' && !smallest) throw bad('tts_provider_unavailable', 'ttsProvider "smallest" is not configured on this server');
  const coach = body.coachPlayback === undefined || body.coachPlayback === null ? false : body.coachPlayback;
  if (typeof coach !== 'boolean') throw bad('invalid_coach_playback', 'coachPlayback must be true or false');
  if (coach && !smallest) throw bad('coach_playback_unavailable', 'coachPlayback needs the smallest.ai client, which is not configured on this server');
  return { ttsProvider: provider, coachPlayback: coach };
}

// Combines the two independent readings of one shout. `a` is Saaras, `b` is Pulse plus text translation.
function combineEars(a, b) {
  if (a.meaning && b.meaning) {
    return a.meaning === b.meaning
      ? { ears: 'agree', match: { ...a, confidence: 'high' } }
      : { ears: 'disagree', match: { meaning: null, confidence: 'none' } };
  }
  if (a.meaning || b.meaning) return { ears: 'single', match: a.meaning ? a : b };
  return { ears: 'none', match: a };
}

/**
 * @param {{ sarvam: object, smallest?: object, matchMeaning: Function, evaluate: Function, now?: () => number,
 *   classifier?: { classify: Function }, matchReason?: (text: string) => string|null, timers?: object, qr?: (url: string) => Promise<string>, log?: (line: string) => void, config?: object }} deps
 * @returns {{ server: import('node:http').Server, hub: object, listen: Function, close: Function }}
 */
export function createServer(deps = {}) {
  const { sarvam, smallest = null, classifier = null, matchReason = null, matchMeaning, evaluate, now = Date.now, timers = globalThis, qr = createQrRenderer(), log = () => {} } = deps;
  const cfg = Object.freeze({ lanAddresses: lanAddresses(), ...DEFAULTS, ...deps.config });
  const hub = H.createHub({ initial: H.initialState({ mode: cfg.mode, startedT: now() }), timers, keepAliveMs: cfg.keepAliveMs, maxClients: cfg.maxSseClients });
  const publicDir = path.join(cfg.rootDir, 'public');
  const snapshot = () => H.publicState(hub.getState(), now());
  let seq = 0;
  let shoutInFlight = false;
  let pending = null;

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

  function judge(args) {
    try {
      const v = evaluate(args);
      if (!isObject(v) || ![true, false, null].includes(v.obeyed)) throw new TypeError('bad verdict');
      const num = (x) => (Number.isFinite(x) ? x : null);
      return { obeyed: v.obeyed, strokesUntilObeyed: num(v.strokesUntilObeyed), deltaSpm: num(v.deltaSpm), reason: String(v.reason || '').slice(0, 300) };
    } catch (err) {
      log(`[shout] evaluate failed: ${errorName(err)}`);
      return { obeyed: null, strokesUntilObeyed: null, deltaSpm: null, reason: 'Obedience could not be evaluated.' };
    }
  }

  function record(trial) {
    hub.update((s) => H.withTrial(s, trial));
    hub.broadcast('result', trial);
    hub.broadcast('state', snapshot());
    return trial;
  }

  function finalize(call, windowMs, superseded) {
    const events = H.strokesBetween(hub.getState(), call.t, call.t + windowMs);
    const verdict = windowMs > 0
      ? judge({ meaning: call.meaning, callT: call.t, events, baselineSpm: call.baselineSpm, windowMs })
      : { obeyed: null, strokesUntilObeyed: null, deltaSpm: null, reason: 'not sure: superseded before any observation time' };
    const outcome = verdict.obeyed === true ? 'obeyed' : verdict.obeyed === false ? 'not_obeyed' : 'not_sure';
    record({ ...H.stripAudio(call), ...verdict, status: 'judged', stage: 'obedience', outcome, windowMs, strokesObserved: events.length, superseded });
  }

  // Watches strokes for windowMs after the call, then judges. A newer call ends an open window early.
  function observe(call) {
    if (pending) pending.finish(true);
    const entry = { done: false };
    entry.finish = (superseded) => {
      if (entry.done) return;
      entry.done = true;
      timers.clearTimeout(entry.timer);
      if (pending === entry) pending = null;
      finalize(call, superseded ? Math.max(0, now() - call.t) : cfg.windowMs, superseded);
    };
    entry.timer = timers.setTimeout(() => entry.finish(false), cfg.windowMs + cfg.graceMs);
    pending = entry;
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

  // matchMeaning result reduced to a plain record; meaning is null unless the matcher was confident.
  function meaningOf(text) {
    const found = matchMeaning(text);
    const m = isObject(found) ? found : {};
    const known = m.confidence !== 'none' && typeof m.meaning === 'string';
    return {
      meaning: known ? m.meaning : null, confidence: known ? m.confidence : 'none',
      matchedKeyword: typeof m.matchedKeyword === 'string' ? m.matchedKeyword : null,
    };
  }

  // Model fallback. All three must hold: the flag, a classifier and the rules' own reason helper.
  const modelFallbackOn = Boolean(cfg.modelFallback && classifier && typeof classifier.classify === 'function' && typeof matchReason === 'function');
  const reasonOf = (text) => {
    try {
      return matchReason(text);
    } catch {
      return 'error'; // an unknown reason is never 'no_match'
    }
  };

  // The model may be asked only when the rules found no keyword at all ('no_match').
  // Negation, conflict, empty text and disagreeing ears stay "not sure" and never reach it.
  function mayAskModel({ translatedText, match, ears, second }) {
    if (!modelFallbackOn || match.meaning || ears === 'disagree') return false;
    if (reasonOf(translatedText) !== 'no_match') return false;
    const other = second && typeof second.translatedText === 'string' ? second.translatedText.trim() : '';
    return other === '' || reasonOf(other) === 'no_match';
  }

  // Never rejects: an error, a timeout or an answer outside the six meanings counts as "none".
  async function askModel(text) {
    let timer = null;
    const started = now();
    try {
      const timeout = new Promise((_, reject) => {
        timer = timers.setTimeout(() => reject(Object.assign(new Error('model timeout'), { name: 'ModelTimeout' })), cfg.modelTimeoutMs);
      });
      const out = await Promise.race([classifier.classify({ text }), timeout]);
      const meaning = isObject(out) && H.phraseFor(out.meaning, 'en-IN') ? out.meaning : null;
      return {
        meaning, name: isObject(out) && typeof out.model === 'string' ? out.model.slice(0, 60) : null,
        latencyMs: ms(out), source: lane(out), error: isObject(out) && typeof out.error === 'string' ? out.error.slice(0, 40) : null,
      };
    } catch (err) {
      const name = errorName(err);
      log(`[shout] model fallback failed: ${name}`);
      return { meaning: null, name: null, latencyMs: Math.max(0, now() - started), source: 'replay', error: name };
    } finally {
      timers.clearTimeout(timer);
    }
  }

  // Applies the model fallback to a finished hearing. `model` is null when the model was not asked.
  async function withModel(heard) {
    if (!mayAskModel(heard)) return { ...heard, match: { ...heard.match, matchedBy: heard.match.meaning ? 'rules' : null }, model: null };
    const model = await askModel(heard.translatedText);
    const match = model.meaning
      ? { meaning: model.meaning, confidence: 'model', matchedKeyword: null, matchedBy: 'model' }
      : { ...heard.match, matchedBy: null };
    return { ...heard, match, model };
  }

  const secondEarOn = (input) => Boolean(cfg.secondEar && input.audio && smallest && typeof smallest.transcribe === 'function');

  // Second ear: Pulse transcript in Malayalam, then the existing text translation to English.
  // Any failure here leaves the first ear to stand alone; it never fails the shout.
  async function secondEar(input) {
    try {
      const heard = await smallest.transcribe({ audio: input.audio, mime: input.mime, language: SECOND_EAR_LANGUAGE });
      const transcript = textOf(heard);
      if (transcript === '') return { transcript, translatedText: '', meaning: null, source: lane(heard), latencyMs: ms(heard) };
      const en = await sarvam.translate({ text: transcript, sourceLang: SOURCE_LANG });
      const translatedText = textOf(en);
      const source = lane(heard) === 'live' && lane(en) === 'live' ? 'live' : 'replay';
      return { transcript, translatedText, ...meaningOf(translatedText), source, latencyMs: ms(heard) + ms(en) };
    } catch (err) {
      log(`[shout] second ear failed: ${errorName(err)}`);
      return null;
    }
  }

  // Returns the translation, the chosen meaning and how the two ears compared (ears is null when the second ear is off).
  async function hear(input) {
    const query = input.audio ? { audio: input.audio, mime: input.mime } : { text: input.text };
    const first = upstream('translate', () => sarvam.translate({ ...query, sourceLang: SOURCE_LANG }));
    if (!secondEarOn(input)) {
      const tr = await first;
      return { tr, translatedText: textOf(tr), match: meaningOf(textOf(tr)), ears: null, second: null };
    }
    const [tr, second] = await Promise.all([first, secondEar(input)]);
    const translatedText = textOf(tr);
    const { ears, match } = combineEars(meaningOf(translatedText), second || { meaning: null });
    const { meaning, transcript, translatedText: english, source, latencyMs } = second || {};
    return { tr, translatedText, match, ears, second: second ? { transcript, translatedText: english, meaning, source, latencyMs } : null };
  }

  async function speakWith(provider, text, targetLang) {
    const client = provider === 'smallest' ? smallest : sarvam;
    const tts = await upstream('speak', () => client.speak({ text, targetLang })).catch(() => null);
    return tts && typeof tts.audioBase64 === 'string' && tts.audioBase64 !== '' ? tts : null;
  }

  // The coach's own typed call spoken back in Malayalam. Empty when not asked for, not typed, or it failed.
  async function coachPlayback(input) {
    if (!input.coachPlayback || !input.text) return {};
    try {
      const out = await smallest.speakMalayalam({ text: input.text });
      if (!out || typeof out.audioBase64 !== 'string' || out.audioBase64 === '') return {};
      return { coachAudioBase64: out.audioBase64, coachMime: out.mime || 'audio/wav', coachSource: lane(out), coachLatencyMs: ms(out) };
    } catch (err) {
      log(`[shout] coach playback failed: ${errorName(err)}`);
      return {};
    }
  }

  function notSure(base, heard) {
    const { tr, ears, model } = heard;
    return record({
      ...base, t: now(), meaning: null, source: model && model.source !== 'live' ? 'replay' : lane(tr),
      sources: { translate: lane(tr), speak: null, ...(model ? { model: model.source } : {}) }, latencyMs: heardMs(heard),
      ttsProvider: null, tts: null,
      status: 'not_sure', stage: 'meaning', outcome: 'not_sure', obeyed: null, strokesUntilObeyed: null, deltaSpm: null,
      reason: ears === 'disagree' ? 'two ears disagree' : 'Meaning not recognised from the translated text. Ask for the call again.',
    });
  }

  // The two ears run in parallel, so the hearing stage costs the slower of the two.
  // The model fallback runs after them and adds its own time.
  const heardMs = ({ tr, second, model }) => Math.max(ms(tr), second ? ms(second) : 0) + (model ? ms(model) : 0);

  async function runShout(input) {
    const heard = await withModel(await hear(input));
    const { tr, translatedText, match, ears, second, model } = heard;
    const modelLive = !model || model.source === 'live';
    const spokenText = match.meaning ? H.phraseFor(match.meaning, input.targetLang) : null;
    seq += 1;
    const base = {
      callId: `call-${seq}`, targetLang: input.targetLang, input: input.audio ? 'audio' : 'text', translatedText,
      confidence: spokenText ? match.confidence : 'none', matchedKeyword: match.matchedKeyword ?? null,
      // Only with MODEL_FALLBACK on, so the default payload is unchanged. matchedBy: 'rules' | 'model' | null (not sure).
      // model is null unless the model was asked: { meaning, name, latencyMs, source, error }.
      ...(modelFallbackOn ? { matchedBy: spokenText ? match.matchedBy : null, model } : {}),
      ...(ears ? { ears, secondEar: second } : {}), // present only when the second ear ran
    };
    if (!spokenText) return notSure(base, heard);
    const tts = await speakWith(input.ttsProvider, spokenText, input.targetLang);
    const hasAudio = Boolean(tts);
    const t = now();
    const call = {
      ...base, t, meaning: match.meaning, spokenText, status: 'ok',
      ttsAudioBase64: hasAudio ? tts.audioBase64 : null, mime: hasAudio ? tts.mime || 'audio/wav' : null, ttsAvailable: hasAudio,
      ttsProvider: input.ttsProvider, tts: hasAudio ? { provider: input.ttsProvider, latencyMs: ms(tts), source: lane(tts) } : null,
      source: lane(tr) === 'live' && modelLive && (!hasAudio || lane(tts) === 'live') ? 'live' : 'replay',
      sources: { translate: lane(tr), speak: hasAudio ? lane(tts) : null, ...(model ? { model: model.source } : {}) },
      latencyMs: heardMs(heard) + ms(tts), baselineSpm: H.baselineSpm(hub.getState(), t, cfg.baselineStaleMs), windowMs: cfg.windowMs,
    };
    hub.update((s) => H.withCall(s, call));
    hub.broadcast('call', call);
    observe(call);
    return call;
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
      coachPlayback: Boolean(smallest && typeof smallest.speakMalayalam === 'function'),
      secondEar: Boolean(cfg.secondEar && smallest && typeof smallest.transcribe === 'function'),
      ...(modelFallbackOn ? { modelFallback: true } : {}), // absent when off, so the default answer is unchanged
    };
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
    'POST /api/phone': async (req, res) => {
      const info = H.validatePhone(await readJson(req, cfg.maxBodyBytes), req);
      const { phone } = hub.update((s) => H.withPhone(s, { ...info, connected: true, lastSeenT: now() }));
      hub.broadcast('phone', phone);
      sendJson(res, 200, { ok: true, phone });
    },
    'POST /api/stroke': async (req, res) => {
      const t = now();
      const events = H.toServerEvents(H.validateStrokes(await readJson(req, cfg.maxBodyBytes), cfg), t);
      const wasConnected = hub.getState().phone.connected;
      const next = hub.update((s) => H.withPhone(H.withStrokes(s, events), { connected: true, lastSeenT: t }));
      if (!wasConnected) hub.broadcast('phone', next.phone);
      for (const event of events) hub.broadcast('stroke', event);
      sendJson(res, 200, { ok: true, accepted: events.length });
    },
    'POST /api/shout': async (req, res) => {
      const body = await readJson(req, cfg.maxBodyBytes);
      const input = { ...H.validateShout(body, cfg), ...shoutOptions(body, smallest) };
      if (shoutInFlight) throw new HttpError(429, 'busy', 'Another shout is being processed. Try again in a moment.', { 'Retry-After': '1' });
      shoutInFlight = true;
      try {
        const [result, coach] = await Promise.all([runShout(input), coachPlayback(input)]);
        sendJson(res, 200, { ok: true, ...result, ...coach });
      } finally {
        shoutInFlight = false;
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
    listen: (port = 0, host = '0.0.0.0') => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve({ port: server.address().port }));
    }),
    close: () => new Promise((resolve) => {
      timers.clearInterval(sweep);
      if (pending) timers.clearTimeout(pending.timer);
      pending = null;
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
  const [calls, obedience, client, second, fallback] = await Promise.all([
    import('../shared/calls.js'), import('../shared/obedience.js'), import('../sarvam/client.js'), import('../smallest/client.js'),
    import('../sarvam/classifier.js'),
  ]);
  const cacheDir = path.join(ROOT, 'sarvam', 'cache');
  const smallestKey = (process.env.SMALLEST_API_KEY || '').trim();
  const flag = (name) => ['1', 'true', 'on', 'yes'].includes((process.env[name] || '').trim().toLowerCase());
  const secondEar = flag('SECOND_EAR');
  const modelFallback = flag('MODEL_FALLBACK');
  const clientLog = Object.assign((line) => warn(String(line)), { info: warn, warn, error: warn, debug: () => {} });
  const sarvam = client.createSarvamClient({
    apiKey: conf.apiKeyPresent ? process.env.SARVAM_API_KEY.trim() : undefined,
    mode: conf.requestedMode, cacheDir, log: clientLog,
  });
  // smallest.ai follows SARVAM_MODE: live needs SMALLEST_API_KEY, auto without a key replays the cache.
  const smallest = second.createSmallestClient({ apiKey: smallestKey || undefined, mode: conf.requestedMode, cacheDir, log: clientLog });
  // The classifier is built only when the flag is on; it shares the Sarvam key, mode and cache folder.
  const classifier = modelFallback
    ? fallback.createMeaningClassifier({ apiKey: conf.apiKeyPresent ? process.env.SARVAM_API_KEY.trim() : undefined, mode: conf.requestedMode, cacheDir, log: clientLog })
    : null;
  const app = createServer({
    sarvam, smallest, classifier, matchReason: calls.noMatchReason, matchMeaning: calls.matchMeaning, evaluate: obedience.evaluate, log: warn,
    config: { mode: conf.mode, https: conf.https, secondEar, modelFallback, sarvamKeyPresent: conf.apiKeyPresent, smallestKeyPresent: smallestKey !== '', ...(conf.https ? { tls: readTls(conf) } : {}) },
  });
  const { port } = await app.listen(conf.port);
  for (const line of bannerLines({ ...conf, port, addresses: lanAddresses() })) say(line);
  say(`smallest.ai: ${smallest.mode === 'live' ? 'LIVE' : 'REPLAY'} (SMALLEST_API_KEY ${smallestKey ? 'set' : 'not set'}), second ear ${secondEar ? 'ON' : 'off'}`);
  say(`model fallback: ${classifier ? `ON (${classifier.model}, ${classifier.mode === 'live' ? 'LIVE' : 'REPLAY'}, only when the rules find no keyword)` : 'off'}`);
  const shutdown = () => {
    say('Shutting down');
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
    process.stderr.write(`rowing-call could not start: ${detail}\n`);
    process.exit(1);
  });
}
