// smallest.ai REST client (Lightning v3.1 speech, Pulse transcription) with the same
// file cache and replay modes as sarvam/client.js.
//
// Endpoints and field names follow docs.smallest.ai as read on 21 Nov 2026 and were
// each checked with one live call the same day:
//   POST https://api.smallest.ai/waves/v1/tts     json: text, voice_id, model, language, sample_rate, output_format
//        -> raw audio bytes. output_format "wav" returns a RIFF/WAVE file (Content-Type audio/wav).
//           The documented default is "pcm" (headerless), which a browser cannot play.
//   POST https://api.smallest.ai/waves/v1/stt/?model=pulse&language=..   body: raw audio bytes,
//        Content-Type application/octet-stream  -> { status, transcription, words, utterances, metadata }
// Auth header on both: Authorization: Bearer <key>.
//
// HONESTY, Pulse and Malayalam: the pre-recorded reference lists these language values:
// en hi de es ru it fr nl pt zh ja ko multi-eu multi-asian multi-indic auto. "ml" is NOT in
// that list (the model card lists Malayalam for streaming). A live call on 21 Nov 2026 with
// language=ml returned HTTP 200 and the exact Malayalam text of a synthesized clip, so "ml"
// is accepted here as observed behaviour, not documented behaviour. It may stop working.
//
// HONESTY, model: the docs say lightning_v3.1 is retired on 30 Nov 2026 in favour of
// lightning_v3.1_pro. The Malayalam voices below were verified on lightning_v3.1 only;
// pass `ttsModel` to createSmallestClient to switch after checking the voices exist there.
//
// The key and audio payloads are never passed to the log function.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

import { cacheKey, DEFAULT_CACHE_DIR, MODES, NoReplayAvailable } from '../sarvam/client.js';

export { NoReplayAvailable };
export const BASE_URL = 'https://api.smallest.ai';
export const TTS_PATH = '/waves/v1/tts';
export const STT_PATH = '/waves/v1/stt/';
export const TTS_MODEL = 'lightning_v3.1';
export const STT_MODEL = 'pulse';
export const TTS_SAMPLE_RATE = 24000; // documented values: 8000, 16000, 24000, 44100
export const TTS_OUTPUT_FORMAT = 'wav';
export const TTS_MAX_CHARS = 250; // documented maximum chunk size per request
export const AUDIO_MAX_BYTES = 8 * 1024 * 1024; // sanity bound; matches the server body limit
export const DEFAULT_TIMEOUT_MS = 20000;
export const DEFAULT_RETRY_DELAY_MS = 400;
export const SPEAK_OP = 'smallest-speak';
export const TRANSCRIBE_OP = 'smallest-transcribe';

// App language code -> smallest.ai language code.
export const LANGUAGE_BY_APP_CODE = Object.freeze({
  'hi-IN': 'hi', 'bn-IN': 'bn', 'od-IN': 'or', 'ta-IN': 'ta', 'en-IN': 'en', 'ml-IN': 'ml',
});

// Default voice per language. Every id below was present in the live catalog
// (GET /waves/v1/lightning-v3.1/get_voices, 240 voices, 21 Nov 2026) with these tags:
//   devansh   accent indian     gender male  languages include english, hindi, bengali, odia, tamil, malayalam
//   debashis  accent indian     gender male  languages english, hindi, marathi, gujarati, punjabi, bengali, odia
//   jeevan    accent tamil      gender male  languages english, hindi, tamil, telugu, kannada, malayalam
//   shibi     accent malayalam  gender male  languages english, hindi, tamil, telugu, kannada, malayalam
//   vaisakh   accent malayalam  gender male  (the other Malayalam-accent voice; pass voiceId to use it)
// The catalog has no voice with a Bengali or Odia accent tag; debashis is a general Indian
// voice that lists both languages. The model card calls shibi female; the catalog tags it male.
// None of these choices has been judged by a native speaker.
export const DEFAULT_VOICES = Object.freeze({
  'hi-IN': 'devansh', 'bn-IN': 'debashis', 'od-IN': 'debashis', 'ta-IN': 'jeevan', 'en-IN': 'devansh', 'ml-IN': 'shibi',
});

// Documented pre-recorded values, plus "ml" (observed live, see the note at the top).
export const STT_LANGUAGES = Object.freeze([
  'en', 'hi', 'de', 'es', 'ru', 'it', 'fr', 'nl', 'pt', 'zh', 'ja', 'ko',
  'multi-eu', 'multi-asian', 'multi-indic', 'auto', 'ml',
]);

/** Invalid caller input. Safe to show to a client as a 400. */
export class SmallestInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SmallestInputError';
    this.status = 400;
  }
}

/** The smallest.ai API (or the network) failed. `status` is the upstream HTTP status, 0 for network or timeout. */
export class SmallestApiError extends Error {
  constructor(message, { status = 0, code = null, retryable = false } = {}) {
    super(message);
    this.name = 'SmallestApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Maps an app code such as 'od-IN' to the smallest.ai code ('or'). Throws on anything else. */
export function toSmallestLanguage(appCode) {
  if (typeof appCode !== 'string' || !Object.hasOwn(LANGUAGE_BY_APP_CODE, appCode)) {
    throw new SmallestInputError(`targetLang must be one of: ${Object.keys(LANGUAGE_BY_APP_CODE).join(', ')}`);
  }
  return LANGUAGE_BY_APP_CODE[appCode];
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const isRetryableStatus = (status) => status === 429 || status >= 500;

function requireText(value, maxChars) {
  if (typeof value !== 'string' || value.trim() === '') throw new SmallestInputError('text must be a non-empty string');
  const text = value.trim().normalize('NFC');
  if (text.length > maxChars) throw new SmallestInputError(`text is ${text.length} characters; the limit is ${maxChars}`);
  return text;
}

function normaliseSpeakInput({ text, targetLang, voiceId } = {}, model) {
  const clean = requireText(text, TTS_MAX_CHARS);
  const language = toSmallestLanguage(targetLang);
  const voice = voiceId ?? DEFAULT_VOICES[targetLang];
  if (typeof voice !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(voice)) {
    throw new SmallestInputError('voiceId must be 1 to 64 letters, digits, dashes or underscores');
  }
  const canonical = {
    op: SPEAK_OP, text: clean, language, voiceId: voice, model, sampleRate: TTS_SAMPLE_RATE, outputFormat: TTS_OUTPUT_FORMAT,
  };
  return { text: clean, targetLang, language, voiceId: voice, canonical };
}

function normaliseTranscribeInput({ audio, mime, language = 'ml' } = {}) {
  if (!(audio instanceof Uint8Array)) throw new SmallestInputError('audio must be a Buffer');
  if (audio.length === 0) throw new SmallestInputError('audio is empty');
  if (audio.length > AUDIO_MAX_BYTES) throw new SmallestInputError(`audio is larger than ${AUDIO_MAX_BYTES} bytes`);
  if (mime !== undefined && mime !== null && (typeof mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/.test(mime))) {
    throw new SmallestInputError('mime must look like audio/webm');
  }
  if (!STT_LANGUAGES.includes(language)) throw new SmallestInputError(`language must be one of: ${STT_LANGUAGES.join(', ')}`);
  const canonical = { op: TRANSCRIBE_OP, audioSha256: sha256Hex(audio), language, model: STT_MODEL };
  return { audio, mime: typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : null, language, canonical };
}

function ttsRequest(input, model) {
  const body = {
    text: input.text, voice_id: input.voiceId, model, language: input.language,
    sample_rate: TTS_SAMPLE_RATE, output_format: TTS_OUTPUT_FORMAT,
  };
  return { path: TTS_PATH, headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' }, body: JSON.stringify(body) };
}

// The documented upload is raw bytes with Content-Type application/octet-stream; the
// service detects the container itself, so the caller's mime is not sent.
function sttRequest(input) {
  const query = new URLSearchParams({ model: STT_MODEL, language: input.language });
  return { path: `${STT_PATH}?${query}`, headers: { 'Content-Type': 'application/octet-stream' }, body: input.audio };
}

async function parseSpeakResponse(res) {
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0) throw new SmallestApiError('smallest.ai returned a response without audio', { status: 502 });
  const isWav = audio.length >= 12 && audio.toString('latin1', 0, 4) === 'RIFF' && audio.toString('latin1', 8, 12) === 'WAVE';
  if (!isWav) {
    // Headerless PCM (the API default) is not playable in a browser; never pass it on as if it were.
    throw new SmallestApiError('smallest.ai returned audio that is not a WAV file', { status: 502 });
  }
  return { audioBase64: audio.toString('base64'), mime: 'audio/wav' };
}

async function parseTranscribeResponse(res) {
  const data = await res.json().catch(() => null);
  if (typeof data?.transcription !== 'string') {
    throw new SmallestApiError('smallest.ai returned a response without the transcription field', { status: 502 });
  }
  return { text: data.transcription.trim() };
}

async function errorDetail(res) {
  const raw = await res.text().catch(() => '');
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch { /* not JSON: fall through to the plain text */ }
  const candidates = [data?.error?.message, data?.error, data?.message, data?.error_code, data ? null : raw];
  const detail = candidates.find((c) => typeof c === 'string' && c.trim() !== '');
  const code = [data?.error_code, data?.error?.code].find((c) => typeof c === 'string') ?? null;
  return { detail: detail ? detail.trim().slice(0, 300) : 'no error message', code };
}

/**
 * @param {{apiKey?: string, mode?: 'live'|'replay'|'auto', cacheDir?: string, fetchImpl?: typeof fetch,
 *   log?: (message: string) => void, timeoutMs?: number, retryDelayMs?: number, ttsModel?: string,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number}} options
 * @returns {Readonly<{speak: Function, speakMalayalam: Function, transcribe: Function, mode: 'live'|'replay', cacheDir: string}>}
 */
export function createSmallestClient({
  apiKey, mode = 'auto', cacheDir = DEFAULT_CACHE_DIR, fetchImpl = globalThis.fetch, log,
  timeoutMs = DEFAULT_TIMEOUT_MS, retryDelayMs = DEFAULT_RETRY_DELAY_MS, ttsModel = TTS_MODEL,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => performance.now(),
} = {}) {
  if (!MODES.includes(mode)) throw new SmallestInputError(`mode must be one of: ${MODES.join(', ')}`);
  if (typeof fetchImpl !== 'function') throw new SmallestInputError('fetchImpl must be a function');
  if (typeof ttsModel !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(ttsModel)) throw new SmallestInputError('ttsModel is not a valid model name');
  const key = typeof apiKey === 'string' && apiKey.trim() !== '' ? apiKey.trim() : null;
  const effectiveMode = mode === 'auto' ? (key ? 'live' : 'replay') : mode;

  const redact = (value) => (key ? String(value).split(key).join('[redacted]') : String(value));
  const emit = (message) => {
    const line = redact(`[smallest] ${message}`);
    try {
      if (typeof log === 'function') log(line);
      else if (log && typeof log.info === 'function') log.info(line);
    } catch { /* a broken logger must not break a call */ }
  };

  const cachePath = (op, k) => `${cacheDir}/${op}-${k}.json`;

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
    const entry = { v: 1, provider: 'smallest', op, key: k, input: describe, result, recordedAt: new Date().toISOString() };
    const file = cachePath(op, k);
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(entry, null, 2), 'utf8');
      await rename(`${file}.tmp`, file);
    } catch (err) {
      emit(`cache write failed for ${op} ${k.slice(0, 12)}: ${err.code ?? err.name}`);
    }
  }

  async function attempt(op, request, parse) {
    let res;
    try {
      res = await fetchImpl(`${BASE_URL}${request.path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, ...request.headers },
        body: request.body, signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const what = timedOut ? `timed out after ${timeoutMs} ms` : 'network error';
      throw new SmallestApiError(`smallest.ai ${op} ${what}`, { status: 0, code: timedOut ? 'timeout' : 'network_error', retryable: true });
    }
    if (!res.ok) {
      const { detail, code } = await errorDetail(res);
      throw new SmallestApiError(redact(`smallest.ai ${op} failed with HTTP ${res.status}: ${detail}`), {
        status: res.status, code, retryable: isRetryableStatus(res.status),
      });
    }
    return parse(res);
  }

  /** One retry for 429, 5xx, network errors and timeouts. Never retries other 4xx. */
  async function callWithRetry(op, buildRequest, parse) {
    try {
      return await attempt(op, buildRequest(), parse);
    } catch (err) {
      if (!(err instanceof SmallestApiError) || !err.retryable) throw err;
      emit(`${op} attempt 1 failed (${err.code ?? err.status}); retrying once in ${retryDelayMs} ms`);
      await sleep(retryDelayMs);
      return attempt(op, buildRequest(), parse);
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
    if (!key) throw new SmallestInputError('mode is live but no API key was provided (set SMALLEST_API_KEY)');

    try {
      const result = await callWithRetry(op, buildRequest, parse);
      await writeCache(op, k, describe, result);
      const out = done(result, 'live');
      emit(`${op} live ok ${out.latencyMs} ms`);
      return out;
    } catch (err) {
      const mayFallBack = err instanceof SmallestApiError && (err.retryable || err.status === 402);
      const cached = mayFallBack ? await readCache(op, k) : null;
      if (!cached) throw err;
      emit(`${op} live failed (${err.code ?? err.status}); serving cached replay ${k.slice(0, 12)}`);
      return done(cached, 'replay');
    }
  }

  /** Text to speech with Lightning. Returns base64 WAV: { audioBase64, mime, source, latencyMs }. */
  async function speak(args) {
    const input = normaliseSpeakInput(args, ttsModel);
    const describe = { text: input.text, targetLang: input.targetLang, language: input.language, voiceId: input.voiceId, model: ttsModel };
    return run(SPEAK_OP, input, describe, () => ttsRequest(input, ttsModel), parseSpeakResponse);
  }

  /** Speak text back in Malayalam (default voice shibi). */
  const speakMalayalam = ({ text, voiceId } = {}) => speak({ text, targetLang: 'ml-IN', voiceId });

  /** Pulse pre-recorded transcription. Returns { text, source, latencyMs }. See the Malayalam note at the top. */
  async function transcribe(args) {
    const input = normaliseTranscribeInput(args);
    const describe = { audioSha256: input.canonical.audioSha256, audioBytes: input.audio.length, mime: input.mime, language: input.language };
    return run(TRANSCRIBE_OP, input, describe, () => sttRequest(input), parseTranscribeResponse);
  }

  return Object.freeze({ speak, speakMalayalam, transcribe, mode: effectiveMode, cacheDir });
}
