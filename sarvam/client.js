// Sarvam REST client with a file cache and replay mode.
//
// Endpoints and field names follow docs.sarvam.ai as read on 21 Nov 2026:
//   POST https://api.sarvam.ai/speech-to-text   multipart: file, model, mode, language_code
//        -> { request_id, transcript, language_code, language_probability? }
//   POST https://api.sarvam.ai/translate        json: input, source_language_code, target_language_code, model
//        -> { request_id, translated_text, source_language_code }
//   POST https://api.sarvam.ai/text-to-speech   json: text, language_code, speaker, model
//        -> { request_id, audios: [base64 wav] }
// Auth header on all three: api-subscription-key.
//
// The key and audio payloads are never passed to the log function.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE_URL = 'https://api.sarvam.ai';
export const STT_MODEL = 'saaras:v4';
export const STT_MODE = 'translate';
export const TTS_MODEL = 'bulbul:v3';
export const TEXT_MODEL = 'mayura:v1';
export const DEFAULT_SPEAKER = 'shubh';
export const TTS_MAX_CHARS = 2500;
export const TEXT_MAX_CHARS = 1000;
// The REST limit is 30 seconds of audio. Duration cannot be read without
// decoding, so this byte cap is only a sanity bound (matches the server's 8 MB body limit).
export const AUDIO_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_RETRY_DELAY_MS = 400;
export const DEFAULT_CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cache');

export const MODES = Object.freeze(['live', 'replay', 'auto']);
export const TTS_LANGS = Object.freeze([
  'bn-IN', 'en-IN', 'gu-IN', 'hi-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN', 'pa-IN', 'ta-IN', 'te-IN',
]);
export const STT_LANGS = Object.freeze([
  'unknown', 'hi-IN', 'bn-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN', 'pa-IN', 'ta-IN', 'te-IN', 'en-IN',
  'gu-IN', 'as-IN', 'ur-IN', 'ne-IN', 'kok-IN', 'ks-IN', 'sd-IN', 'sa-IN', 'sat-IN', 'mni-IN',
  'brx-IN', 'mai-IN', 'doi-IN',
]);
export const TEXT_SOURCE_LANGS = Object.freeze(['auto', ...TTS_LANGS]);
export const V3_SPEAKERS = Object.freeze([
  'shubh', 'aditya', 'ritu', 'priya', 'neha', 'rahul', 'pooja', 'rohan', 'simran', 'kavya', 'amit',
  'dev', 'ishita', 'shreya', 'ratan', 'varun', 'manan', 'sumit', 'roopa', 'kabir', 'aayan',
  'ashutosh', 'advait', 'anand', 'tanya', 'tarun', 'sunny', 'mani', 'gokul', 'vijay', 'shruti',
  'suhani', 'mohit', 'kavitha', 'rehan', 'soham', 'rupali',
]);

const EXT_BY_MIME = Object.freeze({
  'audio/webm': 'webm', 'video/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a', 'video/mp4': 'mp4', 'audio/aac': 'aac', 'audio/ogg': 'ogg',
  'audio/opus': 'opus', 'audio/flac': 'flac', 'audio/aiff': 'aiff', 'audio/amr': 'amr',
});

/** Thrown in replay mode (or auto without a key) when the cache has no entry for the input. */
export class NoReplayAvailable extends Error {
  constructor(op, key) {
    super(`No replay available for ${op}: nothing cached for this exact input (cache key ${key.slice(0, 12)}). ` +
      'Record it first with a key: node sarvam/record-fixtures.js');
    this.name = 'NoReplayAvailable';
    this.op = op;
    this.key = key;
    this.status = 503;
  }
}

/** Invalid caller input. Safe to show to a client as a 400. */
export class SarvamInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SarvamInputError';
    this.status = 400;
  }
}

/** The Sarvam API (or the network) failed. `status` is the upstream HTTP status, 0 for network or timeout. */
export class SarvamApiError extends Error {
  constructor(message, { status = 0, code = null, retryable = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SarvamApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 of JSON with sorted keys, so the same logical input always maps to the same cache file. */
export function cacheKey(canonical) {
  const sorted = Object.fromEntries(Object.keys(canonical).sort().map((k) => [k, canonical[k]]));
  return sha256Hex(JSON.stringify(sorted));
}

function requireText(value, name, maxChars) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SarvamInputError(`${name} must be a non-empty string`);
  }
  const text = value.trim().normalize('NFC');
  if (text.length > maxChars) {
    throw new SarvamInputError(`${name} is ${text.length} characters; the limit is ${maxChars}`);
  }
  return text;
}

function requireOneOf(value, name, allowed) {
  if (!allowed.includes(value)) {
    throw new SarvamInputError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function baseMime(mime) {
  if (mime === undefined || mime === null) return 'application/octet-stream';
  if (typeof mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/.test(mime)) {
    throw new SarvamInputError('mime must look like audio/webm');
  }
  return mime.split(';')[0].trim().toLowerCase();
}

function normaliseTranslateInput({ audio, mime, text, sourceLang = 'ml-IN' } = {}) {
  const hasAudio = audio !== undefined && audio !== null;
  if (hasAudio) {
    if (!(audio instanceof Uint8Array)) throw new SarvamInputError('audio must be a Buffer');
    if (audio.length === 0) throw new SarvamInputError('audio is empty');
    if (audio.length > AUDIO_MAX_BYTES) {
      throw new SarvamInputError(`audio is larger than ${AUDIO_MAX_BYTES} bytes (the REST limit is 30 seconds)`);
    }
    const lang = requireOneOf(sourceLang === 'auto' ? 'unknown' : sourceLang, 'sourceLang', STT_LANGS);
    const canonical = { op: 'translate', kind: 'audio', audioSha256: sha256Hex(audio), sourceLang: lang, model: STT_MODEL, mode: STT_MODE };
    return { kind: 'audio', audio, mime: baseMime(mime), sourceLang: lang, canonical };
  }
  const clean = requireText(text, 'text (or audio)', TEXT_MAX_CHARS);
  const lang = requireOneOf(sourceLang === 'unknown' ? 'auto' : sourceLang, 'sourceLang', TEXT_SOURCE_LANGS);
  const canonical = { op: 'translate', kind: 'text', text: clean, sourceLang: lang, model: TEXT_MODEL };
  return { kind: 'text', text: clean, sourceLang: lang, canonical };
}

function normaliseSpeakInput({ text, targetLang, speaker } = {}) {
  const clean = requireText(text, 'text', TTS_MAX_CHARS);
  const lang = requireOneOf(targetLang, 'targetLang', TTS_LANGS);
  const voice = requireOneOf(speaker ?? DEFAULT_SPEAKER, 'speaker', V3_SPEAKERS);
  const canonical = { op: 'speak', text: clean, targetLang: lang, speaker: voice, model: TTS_MODEL };
  return { text: clean, targetLang: lang, speaker: voice, canonical };
}

function sttRequest(input) {
  const form = new FormData();
  const ext = EXT_BY_MIME[input.mime] ?? 'bin';
  form.append('file', new Blob([input.audio], { type: input.mime }), `shout.${ext}`);
  form.append('model', STT_MODEL);
  form.append('mode', STT_MODE);
  form.append('language_code', input.sourceLang);
  return { path: '/speech-to-text', body: form, json: false };
}

function textRequest(input) {
  const body = { input: input.text, source_language_code: input.sourceLang, target_language_code: 'en-IN', model: TEXT_MODEL };
  return { path: '/translate', body: JSON.stringify(body), json: true };
}

function ttsRequest(input) {
  const body = { text: input.text, language_code: input.targetLang, speaker: input.speaker, model: TTS_MODEL };
  return { path: '/text-to-speech', body: JSON.stringify(body), json: true };
}

function parseTranslateResponse(data, kind) {
  const raw = kind === 'audio' ? data?.transcript : data?.translated_text;
  if (typeof raw !== 'string') {
    throw new SarvamApiError('Sarvam returned a response without the expected text field', { status: 502 });
  }
  const prob = data.language_probability;
  return typeof prob === 'number' ? { text: raw.trim(), languageProbability: prob } : { text: raw.trim() };
}

/** Documented shape is { audios: [base64] }. A single `audio` string is also accepted (not documented). */
function parseSpeakResponse(data) {
  const parts = Array.isArray(data?.audios) ? data.audios : typeof data?.audio === 'string' ? [data.audio] : [];
  const chunks = parts.filter((p) => typeof p === 'string' && p !== '').map((p) => Buffer.from(p, 'base64'));
  const audio = Buffer.concat(chunks);
  if (audio.length === 0) {
    throw new SarvamApiError('Sarvam returned a response without audio', { status: 502 });
  }
  return { audioBase64: audio.toString('base64'), mime: 'audio/wav' };
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

/**
 * @param {{apiKey?: string, mode?: 'live'|'replay'|'auto', cacheDir?: string, fetchImpl?: typeof fetch,
 *   log?: (message: string) => void, timeoutMs?: number, retryDelayMs?: number,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number}} options
 */
export function createSarvamClient({
  apiKey, mode = 'auto', cacheDir = DEFAULT_CACHE_DIR, fetchImpl = globalThis.fetch, log,
  timeoutMs = DEFAULT_TIMEOUT_MS, retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => performance.now(),
} = {}) {
  if (!MODES.includes(mode)) throw new SarvamInputError(`mode must be one of: ${MODES.join(', ')}`);
  if (typeof fetchImpl !== 'function') throw new SarvamInputError('fetchImpl must be a function');
  const key = typeof apiKey === 'string' && apiKey.trim() !== '' ? apiKey.trim() : null;
  const effectiveMode = mode === 'auto' ? (key ? 'live' : 'replay') : mode;

  const redact = (value) => (key ? String(value).split(key).join('[redacted]') : String(value));
  const emit = (message) => {
    const line = redact(`[sarvam] ${message}`);
    try {
      if (typeof log === 'function') log(line);
      else if (log && typeof log.info === 'function') log.info(line);
    } catch { /* a broken logger must not break a call */ }
  };

  const cachePath = (op, k) => path.join(cacheDir, `${op}-${k}.json`);

  async function readCache(op, k) {
    let raw;
    try {
      raw = await readFile(cachePath(op, k), 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') emit(`cache read failed for ${op} ${k.slice(0, 12)}: ${err.code ?? err.name}`);
      return null;
    }
    try {
      const entry = JSON.parse(raw);
      return entry && typeof entry.result === 'object' && entry.result !== null ? entry.result : null;
    } catch {
      emit(`cache entry for ${op} ${k.slice(0, 12)} is not valid JSON; ignoring it`);
      return null;
    }
  }

  async function writeCache(op, k, describe, result) {
    const entry = { v: 1, op, key: k, input: describe, result, recordedAt: new Date().toISOString() };
    const file = cachePath(op, k);
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(entry, null, 2), 'utf8');
      await rename(`${file}.tmp`, file);
    } catch (err) {
      emit(`cache write failed for ${op} ${k.slice(0, 12)}: ${err.code ?? err.name}`);
    }
  }

  async function attempt(op, request) {
    const headers = request.json
      ? { 'api-subscription-key': key, 'Content-Type': 'application/json' }
      : { 'api-subscription-key': key };
    let res;
    try {
      res = await fetchImpl(`${BASE_URL}${request.path}`, {
        method: 'POST', headers, body: request.body, signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const what = timedOut ? `timed out after ${timeoutMs} ms` : 'network error';
      throw new SarvamApiError(`Sarvam ${op} ${what}`, { status: 0, code: timedOut ? 'timeout' : 'network_error', retryable: true });
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = typeof data?.error?.message === 'string' ? data.error.message.slice(0, 300) : 'no error message';
      const code = typeof data?.error?.code === 'string' ? data.error.code : null;
      throw new SarvamApiError(redact(`Sarvam ${op} failed with HTTP ${res.status}: ${detail}`), {
        status: res.status, code, retryable: isRetryableStatus(res.status),
      });
    }
    return data;
  }

  /** One retry for 429, 5xx, network errors and timeouts. Never retries other 4xx. */
  async function callWithRetry(op, buildRequest, parse) {
    try {
      return parse(await attempt(op, buildRequest()));
    } catch (err) {
      if (!(err instanceof SarvamApiError) || !err.retryable) throw err;
      emit(`${op} attempt 1 failed (${err.code ?? err.status}); retrying once in ${retryDelayMs} ms`);
      await sleep(retryDelayMs);
      return parse(await attempt(op, buildRequest()));
    }
  }

  async function run(op, input, describe, buildRequest, parse) {
    const k = cacheKey(input.canonical);
    const started = now();
    const done = (result, source) => ({ ...result, source, latencyMs: Math.max(0, Math.round(now() - started)) });

    if (effectiveMode === 'replay') {
      const cached = await readCache(op, k);
      if (!cached) throw new NoReplayAvailable(op, k);
      emit(`${op} replay hit ${k.slice(0, 12)}`);
      return done(cached, 'replay');
    }
    if (!key) throw new SarvamInputError('mode is live but no API key was provided (set SARVAM_API_KEY)');

    try {
      const result = await callWithRetry(op, buildRequest, parse);
      await writeCache(op, k, describe, result);
      const out = done(result, 'live');
      emit(`${op} live ok ${out.latencyMs} ms`);
      return out;
    } catch (err) {
      // 402 (credits exhausted) will not clear by retrying, but a recorded answer is still usable.
      const mayFallBack = err instanceof SarvamApiError && (err.retryable || err.status === 402);
      const cached = mayFallBack ? await readCache(op, k) : null;
      if (!cached) throw err;
      emit(`${op} live failed (${err.code ?? err.status}); serving cached replay ${k.slice(0, 12)}`);
      return done(cached, 'replay');
    }
  }

  /**
   * Shout to English. Audio goes to Saaras v4 in translate mode. Typed text goes to
   * Mayura (text translation to en-IN); typed text already marked en-IN is returned
   * unchanged with `passthrough: true` and no API call.
   */
  async function translate(args) {
    const input = normaliseTranslateInput(args);
    if (input.kind === 'text' && input.sourceLang === 'en-IN') {
      return { text: input.text, passthrough: true, source: effectiveMode === 'replay' ? 'replay' : 'live', latencyMs: 0 };
    }
    const describe = input.kind === 'audio'
      ? { kind: 'audio', audioSha256: input.canonical.audioSha256, audioBytes: input.audio.length, mime: input.mime, sourceLang: input.sourceLang }
      : { kind: 'text', text: input.text, sourceLang: input.sourceLang };
    const build = () => (input.kind === 'audio' ? sttRequest(input) : textRequest(input));
    return run('translate', input, describe, build, (data) => parseTranslateResponse(data, input.kind));
  }

  /** Text to speech with Bulbul v3. Returns base64 WAV (the documented default codec). */
  async function speak(args) {
    const input = normaliseSpeakInput(args);
    const describe = { text: input.text, targetLang: input.targetLang, speaker: input.speaker };
    return run('speak', input, describe, () => ttsRequest(input), parseSpeakResponse);
  }

  return Object.freeze({ translate, speak, mode: effectiveMode, cacheDir });
}
