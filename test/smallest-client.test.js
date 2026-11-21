import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createSmallestClient, toSmallestLanguage, DEFAULT_VOICES, LANGUAGE_BY_APP_CODE, NoReplayAvailable,
  SmallestApiError, SmallestInputError, TTS_MAX_CHARS,
} from '../smallest/client.js';
import { createServer } from '../server/index.js';

const FAKE_KEY = 'test-key-not-a-real-secret-456';
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WAVEfmt fake')]);

const wavResponse = () => new Response(WAV, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sttOk = (text = ' വേഗം ') => jsonResponse(200, { status: 'success', transcription: text, words: [], utterances: [] });
const timeoutError = () => Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });

/** Fake fetch that replays a scripted list of responses or thrown errors and records calls. */
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    if (next instanceof Error) throw next;
    return next.clone();
  };
  return { impl, calls };
}

async function withTmp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'smallest-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeClient(dir, script, extra = {}) {
  const fetcher = fakeFetch(script);
  const logs = [];
  const sleeps = [];
  const client = createSmallestClient({
    apiKey: FAKE_KEY, mode: 'live', cacheDir: dir, fetchImpl: fetcher.impl,
    log: (line) => logs.push(line), sleep: async (ms) => { sleeps.push(ms); }, retryDelayMs: 5, ...extra,
  });
  return { client, logs, sleeps, calls: fetcher.calls };
}

// ---- client ----

test('language mapping: app codes map to smallest.ai codes, every language has a default voice', () => {
  assert.deepEqual(
    ['hi-IN', 'bn-IN', 'od-IN', 'ta-IN', 'en-IN', 'ml-IN'].map(toSmallestLanguage),
    ['hi', 'bn', 'or', 'ta', 'en', 'ml'],
  );
  assert.deepEqual(Object.keys(DEFAULT_VOICES).sort(), Object.keys(LANGUAGE_BY_APP_CODE).sort());
  assert.equal(DEFAULT_VOICES['ml-IN'], 'shibi');
  for (const badCode of ['ml', 'gu-IN', '', undefined, 'toString']) {
    assert.throws(() => toSmallestLanguage(badCode), SmallestInputError);
  }
});

test('speak live: documented endpoint, bearer auth, json fields, WAV requested and returned', async () => withTmp(async (dir) => {
  const { client, calls } = makeClient(dir, [wavResponse()]);
  const out = await client.speak({ text: '  तेज़ चलाओ ', targetLang: 'hi-IN' });
  assert.equal(out.source, 'live');
  assert.equal(out.mime, 'audio/wav');
  assert.equal(out.audioBase64, WAV.toString('base64'));
  assert.equal(typeof out.latencyMs, 'number');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.smallest.ai/waves/v1/tts');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    text: 'तेज़ चलाओ', voice_id: 'devansh', model: 'lightning_v3.1', language: 'hi', sample_rate: 24000, output_format: 'wav',
  });
}));

test('speak: od-IN is sent as "or"; an explicit voiceId is used; ttsModel can be overridden', async () => withTmp(async (dir) => {
  const { client, calls } = makeClient(dir, [wavResponse()], { ttsModel: 'lightning_v3.1_pro' });
  await client.speak({ text: 'ଧୀରେ ମାର', targetLang: 'od-IN', voiceId: 'sunidhi' });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.language, 'or');
  assert.equal(body.voice_id, 'sunidhi');
  assert.equal(body.model, 'lightning_v3.1_pro');
}));

test('speakMalayalam: language ml with the default Malayalam voice', async () => withTmp(async (dir) => {
  const { client, calls } = makeClient(dir, [wavResponse()]);
  const out = await client.speakMalayalam({ text: 'വേഗം' });
  assert.equal(out.mime, 'audio/wav');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.language, 'ml');
  assert.equal(body.voice_id, 'shibi');
  await client.speakMalayalam({ text: 'വേഗം', voiceId: 'vaisakh' });
  assert.equal(JSON.parse(calls[1].init.body).voice_id, 'vaisakh');
}));

test('cache: a live speak is written as smallest-speak-<sha256>.json and replayed without a key or network', async () => withTmp(async (dir) => {
  const { client } = makeClient(dir, [wavResponse()]);
  await client.speak({ text: 'Move faster', targetLang: 'en-IN' });
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^smallest-speak-[0-9a-f]{64}\.json$/);
  const entry = JSON.parse(await readFile(path.join(dir, files[0]), 'utf8'));
  assert.equal(entry.provider, 'smallest');
  assert.equal(entry.input.voiceId, 'devansh');
  assert.equal(JSON.stringify(entry).includes(FAKE_KEY), false);

  const offline = fakeFetch([new Error('network must not be used')]);
  const replay = createSmallestClient({ mode: 'replay', cacheDir: dir, fetchImpl: offline.impl });
  assert.equal(replay.mode, 'replay');
  const out = await replay.speak({ text: 'Move faster', targetLang: 'en-IN' });
  assert.equal(out.source, 'replay');
  assert.equal(out.audioBase64, WAV.toString('base64'));
  assert.equal(offline.calls.length, 0);
  await assert.rejects(replay.speak({ text: 'Speak slower', targetLang: 'en-IN' }), NoReplayAvailable);
  await assert.rejects(replay.speak({ text: 'Move faster', targetLang: 'en-IN', voiceId: 'jeevan' }), NoReplayAvailable);
}));

test('modes: auto is live with a key and replay without; live without a key is an input error', async () => withTmp(async (dir) => {
  const f = fakeFetch([wavResponse()]);
  assert.equal(createSmallestClient({ apiKey: FAKE_KEY, cacheDir: dir, fetchImpl: f.impl }).mode, 'live');
  assert.equal(createSmallestClient({ apiKey: '  ', cacheDir: dir, fetchImpl: f.impl }).mode, 'replay');
  const keyless = createSmallestClient({ mode: 'live', cacheDir: dir, fetchImpl: f.impl });
  await assert.rejects(keyless.speak({ text: 'Hold', targetLang: 'en-IN' }), SmallestInputError);
  assert.equal(f.calls.length, 0);
  assert.throws(() => createSmallestClient({ mode: 'sometimes' }), SmallestInputError);
  assert.throws(() => createSmallestClient({ fetchImpl: null }), SmallestInputError);
}));

test('retry: one retry on 429, 5xx, network error and timeout, then success', async () => {
  const failures = [jsonResponse(429, { error: 'slow down' }), jsonResponse(503, {}), new TypeError('fetch failed'), timeoutError()];
  for (const failure of failures) {
    await withTmp(async (dir) => {
      const { client, calls, sleeps } = makeClient(dir, [failure, wavResponse()]);
      const out = await client.speak({ text: 'Hold', targetLang: 'en-IN' });
      assert.equal(out.source, 'live');
      assert.equal(calls.length, 2);
      assert.deepEqual(sleeps, [5]);
    });
  }
});

test('error mapping: 4xx is not retried, a second failure surfaces, a cached answer is used as fallback', async () => withTmp(async (dir) => {
  const unauthorised = makeClient(dir, [jsonResponse(401, { error: 'Invalid API key' })]);
  await assert.rejects(unauthorised.client.speak({ text: 'Hold', targetLang: 'en-IN' }), (err) => {
    assert.ok(err instanceof SmallestApiError);
    assert.equal(err.status, 401);
    assert.equal(err.retryable, false);
    assert.match(err.message, /HTTP 401: Invalid API key/);
    return true;
  });
  assert.equal(unauthorised.calls.length, 1);

  const twice = makeClient(dir, [jsonResponse(500, { message: 'boom' })]);
  await assert.rejects(twice.client.speak({ text: 'Hold', targetLang: 'en-IN' }), (err) => err.status === 500 && err.retryable === true);
  assert.equal(twice.calls.length, 2);

  const offline = makeClient(dir, [new TypeError('fetch failed')]);
  await assert.rejects(offline.client.speak({ text: 'Hold', targetLang: 'en-IN' }), (err) => err.status === 0 && err.code === 'network_error');

  const ok = makeClient(dir, [wavResponse()]);
  await ok.client.speak({ text: 'Hold', targetLang: 'en-IN' });
  const fallback = makeClient(dir, [jsonResponse(503, {})]);
  const out = await fallback.client.speak({ text: 'Hold', targetLang: 'en-IN' });
  assert.equal(out.source, 'replay');
  assert.equal(fallback.calls.length, 2);
}));

test('speak: headerless audio and empty bodies are rejected as 502 and never cached', async () => withTmp(async (dir) => {
  const pcm = makeClient(dir, [new Response(Buffer.from('not-a-riff-header-pcm'), { status: 200 })]);
  await assert.rejects(pcm.client.speak({ text: 'Hold', targetLang: 'en-IN' }), (err) => err instanceof SmallestApiError && err.status === 502);
  const empty = makeClient(dir, [new Response(null, { status: 200 })]);
  await assert.rejects(empty.client.speak({ text: 'Hold', targetLang: 'en-IN' }), (err) => err.status === 502);
  assert.deepEqual(await readdir(dir), []);
}));

test('input validation: text, language and voiceId', async () => withTmp(async (dir) => {
  const { client, calls } = makeClient(dir, [wavResponse()]);
  const cases = [
    { text: '', targetLang: 'hi-IN' }, { text: 5, targetLang: 'hi-IN' }, { text: 'x'.repeat(TTS_MAX_CHARS + 1), targetLang: 'hi-IN' },
    { text: 'ok', targetLang: 'fr-FR' }, { text: 'ok' }, { text: 'ok', targetLang: 'hi-IN', voiceId: 'bad voice!' },
  ];
  for (const args of cases) await assert.rejects(client.speak(args), SmallestInputError);
  await assert.rejects(client.speak(), SmallestInputError);
  assert.equal(calls.length, 0);
}));

test('no key in any logged string or error message, even when the server echoes it', async () => withTmp(async (dir) => {
  const echo = jsonResponse(500, { error: `bad token ${FAKE_KEY}` });
  const { client, logs } = makeClient(dir, [echo, echo, wavResponse(), sttOk()]);
  await assert.rejects(client.speak({ text: 'Hold', targetLang: 'en-IN' }), (err) => {
    assert.equal(err.message.includes(FAKE_KEY), false);
    assert.match(err.message, /\[redacted\]/);
    return true;
  });
  await client.speak({ text: 'Hold', targetLang: 'en-IN' });
  await client.transcribe({ audio: Buffer.from('abc') });
  assert.ok(logs.length >= 3);
  for (const line of logs) {
    assert.equal(line.includes(FAKE_KEY), false);
    assert.equal(line.includes(WAV.toString('base64')), false);
    assert.match(line, /^\[smallest\] /);
  }
  const broken = makeClient(dir, [wavResponse()], { log: () => { throw new Error('logger down'); } });
  await broken.client.speak({ text: 'Ready', targetLang: 'en-IN' });
}));

test('transcribe live: raw bytes to the Pulse endpoint with model and language in the query', async () => withTmp(async (dir) => {
  const { client, calls } = makeClient(dir, [sttOk()]);
  const audio = Buffer.from('fake-audio');
  const out = await client.transcribe({ audio, mime: 'audio/webm;codecs=opus' });
  assert.deepEqual({ text: out.text, source: out.source }, { text: 'വേഗം', source: 'live' });
  assert.equal(typeof out.latencyMs, 'number');
  assert.equal(calls[0].url, 'https://api.smallest.ai/waves/v1/stt/?model=pulse&language=ml');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(calls[0].init.body, audio);
  const files = await readdir(dir);
  assert.match(files[0], /^smallest-transcribe-[0-9a-f]{64}\.json$/);

  const replay = createSmallestClient({ mode: 'replay', cacheDir: dir, fetchImpl: fakeFetch([new Error('no network')]).impl });
  assert.equal((await replay.transcribe({ audio })).source, 'replay');
  await assert.rejects(replay.transcribe({ audio: Buffer.from('other') }), NoReplayAvailable);
}));

test('transcribe: validation and a response without the transcription field', async () => withTmp(async (dir) => {
  const { client, calls } = makeClient(dir, [jsonResponse(200, { status: 'success' })]);
  for (const args of [{}, { audio: 'text' }, { audio: Buffer.alloc(0) }, { audio: Buffer.from('a'), language: 'xx' }, { audio: Buffer.from('a'), mime: 'nonsense' }]) {
    await assert.rejects(client.transcribe(args), SmallestInputError);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(client.transcribe({ audio: Buffer.from('a'), language: 'hi' }), (err) => err instanceof SmallestApiError && err.status === 502);
  assert.match(calls[0].url, /language=hi$/);
}));

test('cache: a corrupt entry is ignored in replay', async () => withTmp(async (dir) => {
  const { client } = makeClient(dir, [wavResponse()]);
  await client.speak({ text: 'Hold', targetLang: 'en-IN' });
  const [file] = await readdir(dir);
  await writeFile(path.join(dir, file), '{not json', 'utf8');
  const replay = createSmallestClient({ mode: 'replay', cacheDir: dir, fetchImpl: fakeFetch([wavResponse()]).impl });
  await assert.rejects(replay.speak({ text: 'Hold', targetLang: 'en-IN' }), NoReplayAvailable);
}));

// ---- server: ttsProvider and /api/providers ----

function fakeTimers() {
  const list = [];
  const add = (fn) => { const h = { fn, cleared: false }; list.push(h); return h; };
  const clear = (h) => { if (h) h.cleared = true; };
  return { setTimeout: add, clearTimeout: clear, setInterval: add, clearInterval: clear };
}

async function startServer({ sarvam = {}, smallest, config = {} } = {}) {
  const calls = { stt: [], translate: [], sarvamSpeak: [], smallestSpeak: [] };
  const logs = [];
  const sarvamFake = {
    mode: 'replay',
    stt: async (args) => {
      calls.stt.push(args);
      return { text: args.mode === 'transcribe' ? 'വേഗം' : args.mode === 'translit' ? 'vegam' : 'Move faster', language: 'ml-IN', source: 'live', latencyMs: 100 };
    },
    translate: async (args) => {
      calls.translate.push(args);
      return { text: args.sourceLang === 'en-IN' ? 'move faster in hindi' : 'Move faster', language: 'ml-IN', source: 'live', latencyMs: 40 };
    },
    speak: async (args) => { calls.sarvamSpeak.push(args); return { audioBase64: 'U0FSVkFN', mime: 'audio/wav', source: 'live', latencyMs: 80 }; },
    ...sarvam,
  };
  const smallestFake = smallest === null ? null : {
    mode: 'live',
    speak: async (args) => { calls.smallestSpeak.push(args); return { audioBase64: 'U01BTEw=', mime: 'audio/wav', source: 'live', latencyMs: 30 }; },
    ...smallest,
  };
  const app = createServer({
    sarvam: sarvamFake, smallest: smallestFake,
    now: () => 5000, timers: fakeTimers(), log: (l) => logs.push(l),
    config: { rootDir: tmpdir(), lanAddresses: [], ...config },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  return { app, port, calls, logs, stop: () => app.close() };
}

function call(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: payload ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text, json: JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(payload || undefined);
  });
}
const shout = (port, body) => call(port, 'POST', '/api/shout', body);
const AUDIO = { audioBase64: Buffer.from('note-bytes').toString('base64'), mime: 'audio/webm', targetLang: 'hi-IN' };

test('server default: sarvam speaks, smallest is never called', async () => {
  const s = await startServer();
  try {
    const r = await shout(s.port, { text: 'vegam', targetLang: 'hi-IN' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ttsAudioBase64, 'U0FSVkFN');
    assert.equal(r.json.ttsProvider, 'sarvam');
    assert.deepEqual(r.json.tts, { provider: 'sarvam', latencyMs: 80, source: 'live' });
    const a = await shout(s.port, AUDIO);
    assert.equal(a.status, 200);
    assert.equal(s.calls.smallestSpeak.length, 0);
    assert.equal(s.calls.stt.length, 3);
  } finally {
    await s.stop();
  }
});

test('server ttsProvider smallest: smallest speaks, provider and latency recorded', async () => {
  const s = await startServer();
  try {
    const r = await shout(s.port, { text: 'vegam', targetLang: 'hi-IN', ttsProvider: 'smallest' });
    assert.equal(r.status, 200);
    assert.deepEqual(s.calls.smallestSpeak, [{ text: 'move faster in hindi', targetLang: 'hi-IN' }]);
    assert.equal(s.calls.sarvamSpeak.length, 0);
    assert.equal(r.json.ttsAudioBase64, 'U01BTEw=');
    assert.deepEqual(r.json.tts, { provider: 'smallest', latencyMs: 30, source: 'live' });
    const state = await call(s.port, 'GET', '/api/state');
    assert.equal(state.text.includes('U01BTEw='), false); // audio never enters state
  } finally {
    await s.stop();
  }
});

test('server ttsProvider smallest: a failed speak leaves the note without audio and tts null', async () => {
  const s = await startServer({ smallest: { speak: async () => { throw new Error(`secret ${FAKE_KEY}`); } } });
  try {
    const r = await shout(s.port, { text: 'vegam', targetLang: 'hi-IN', ttsProvider: 'smallest' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ttsAvailable, false);
    assert.equal(r.json.tts, null);
    assert.equal(r.json.ttsProvider, 'smallest');
    assert.equal(s.logs.join('\n').includes(FAKE_KEY), false);
  } finally {
    await s.stop();
  }
});

test('server validation: bad ttsProvider gets a clear 400; smallest missing is a 400', async () => {
  const s = await startServer();
  const bare = await startServer({ smallest: null });
  try {
    for (const [port, extra, code] of [
      [s.port, { ttsProvider: 'other' }, 'invalid_tts_provider'],
      [s.port, { ttsProvider: 5 }, 'invalid_tts_provider'],
      [bare.port, { ttsProvider: 'smallest' }, 'tts_provider_unavailable'],
    ]) {
      const r = await shout(port, { text: 'vegam', targetLang: 'hi-IN', ...extra });
      assert.equal(r.status, 400, code);
      assert.equal(r.json.error.code, code);
    }
    assert.equal(s.calls.translate.length, 0);
    const ok = await shout(bare.port, { text: 'vegam', targetLang: 'hi-IN', ttsProvider: 'sarvam' });
    assert.equal(ok.status, 200);
  } finally {
    await s.stop();
    await bare.stop();
  }
});

test('GET /api/providers: booleans and modes only', async () => {
  const s = await startServer({ config: { sarvamKeyPresent: true, smallestKeyPresent: true, mode: 'live' } });
  const bare = await startServer({ smallest: null });
  try {
    const r = await call(s.port, 'GET', '/api/providers');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      ok: true,
      providers: { sarvam: { configured: true, mode: 'replay' }, smallest: { configured: true, mode: 'live' } },
      ttsProviders: ['sarvam', 'smallest'], defaultTtsProvider: 'sarvam',
      watchDirs: [],
    });
    const b = await call(bare.port, 'GET', '/api/providers');
    assert.deepEqual(b.json.providers.smallest, { configured: false, mode: null });
    assert.deepEqual(b.json.ttsProviders, ['sarvam']);
    assert.equal((await call(s.port, 'POST', '/api/providers', {})).status, 405);
  } finally {
    await s.stop();
    await bare.stop();
  }
});
