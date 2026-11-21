import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createSarvamClient, cacheKey, NoReplayAvailable, SarvamApiError, SarvamInputError,
} from '../sarvam/client.js';
import { main, parseArgs, planJobs, UsageError } from '../sarvam/record-fixtures.js';

const FAKE_KEY = 'test-key-not-a-real-secret-123';
const WAV_B64 = Buffer.from('RIFFfakewavdata').toString('base64');

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Fake fetch that replays a scripted list of responses or thrown errors and records calls. */
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url, init) : next.clone();
  };
  return { impl, calls };
}

async function withTmp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sarvam-test-'));
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
  const client = createSarvamClient({
    apiKey: FAKE_KEY, mode: 'live', cacheDir: dir, fetchImpl: fetcher.impl,
    log: (line) => logs.push(line), sleep: async (ms) => { sleeps.push(ms); }, retryDelayMs: 5, ...extra,
  });
  return { client, logs, sleeps, calls: fetcher.calls };
}

const sttOk = () => jsonResponse(200, { request_id: 'r1', transcript: ' Row faster ', language_code: 'ml-IN' });
const ttsOk = () => jsonResponse(200, { request_id: 'r2', audios: [WAV_B64] });
const timeoutError = () => Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });

test('translate live: sends documented multipart fields and auth header', async () => withTmp(async (dir) => {
  const { client, calls } = makeClient(dir, [sttOk()]);
  const out = await client.translate({ audio: Buffer.from('abc'), mime: 'audio/webm;codecs=opus' });
  assert.equal(out.text, 'Row faster');
  assert.equal(out.source, 'live');
  assert.equal(typeof out.latencyMs, 'number');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.sarvam.ai/speech-to-text');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['api-subscription-key'], FAKE_KEY);
  assert.equal(calls[0].init.headers['Content-Type'], undefined);
  const form = calls[0].init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('model'), 'saaras:v4');
  assert.equal(form.get('mode'), 'translate');
  assert.equal(form.get('language_code'), 'ml-IN');
  assert.equal(form.get('file').type, 'audio/webm');
  assert.equal(form.get('file').name, 'shout.webm');
}));

test('translate live: returns languageProbability when the API gives one', async () => withTmp(async (dir) => {
  const res = jsonResponse(200, { transcript: 'Stop', language_code: 'ml-IN', language_probability: 0.91 });
  const { client, calls } = makeClient(dir, [res]);
  const out = await client.translate({ audio: Buffer.from('abc'), mime: 'audio/wav', sourceLang: 'auto' });
  assert.equal(out.languageProbability, 0.91);
  assert.equal(calls[0].init.body.get('language_code'), 'unknown');
}));

test('translate typed text: uses the text translate endpoint; English passes through', async () => withTmp(async (dir) => {
  const res = jsonResponse(200, { translated_text: 'Faster', source_language_code: 'ml-IN' });
  const { client, calls } = makeClient(dir, [res]);
  const out = await client.translate({ text: 'typed call' });
  assert.equal(out.text, 'Faster');
  assert.equal(calls[0].url, 'https://api.sarvam.ai/translate');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    input: 'typed call', source_language_code: 'ml-IN', target_language_code: 'en-IN', model: 'mayura:v1',
  });
  const pass = await client.translate({ text: ' go faster ', sourceLang: 'en-IN' });
  assert.equal(pass.text, 'go faster');
  assert.equal(pass.passthrough, true);
  assert.equal(calls.length, 1);
}));

test('speak live: sends bulbul:v3 json and returns base64 wav', async () => withTmp(async (dir) => {
  const { client, calls } = makeClient(dir, [ttsOk()]);
  const out = await client.speak({ text: 'Tez chalao', targetLang: 'hi-IN' });
  assert.deepEqual({ audioBase64: out.audioBase64, mime: out.mime, source: out.source }, { audioBase64: WAV_B64, mime: 'audio/wav', source: 'live' });
  assert.equal(calls[0].url, 'https://api.sarvam.ai/text-to-speech');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'Tez chalao', language_code: 'hi-IN', speaker: 'shubh', model: 'bulbul:v3' });
}));

test('speak tolerates a single audio field and multi-part audios', async () => withTmp(async (dir) => {
  const a = Buffer.from('ab').toString('base64'); // padded chunk
  const b = Buffer.from('cde').toString('base64');
  const { client } = makeClient(dir, [jsonResponse(200, { audio: WAV_B64 }), jsonResponse(200, { audios: [a, b] })]);
  assert.equal((await client.speak({ text: 'one', targetLang: 'hi-IN' })).audioBase64, WAV_B64);
  const joined = await client.speak({ text: 'two', targetLang: 'hi-IN' });
  assert.equal(Buffer.from(joined.audioBase64, 'base64').toString(), 'abcde');
}));

test('live success is cached as JSON under the sha256 key, without the key or raw audio', async () => withTmp(async (dir) => {
  const { client } = makeClient(dir, [sttOk(), ttsOk()]);
  const audio = Buffer.from('shouted-audio-bytes');
  await client.translate({ audio, mime: 'audio/wav' });
  await client.speak({ text: 'Tez', targetLang: 'hi-IN' });
  const files = (await readdir(dir)).sort();
  assert.equal(files.length, 2);
  const expected = cacheKey({ op: 'speak', text: 'Tez', targetLang: 'hi-IN', speaker: 'shubh', model: 'bulbul:v3' });
  assert.ok(files.includes(`speak-${expected}.json`));
  assert.match(expected, /^[0-9a-f]{64}$/);
  const all = (await Promise.all(files.map((f) => readFile(path.join(dir, f), 'utf8')))).join('\n');
  assert.ok(!all.includes(FAKE_KEY));
  assert.ok(!all.includes(audio.toString('base64')));
  const entry = JSON.parse(await readFile(path.join(dir, `speak-${expected}.json`), 'utf8'));
  assert.equal(entry.result.audioBase64, WAV_B64);
  assert.equal(entry.key, expected);
}));

test('replay hit: reads the cache and never calls fetch', async () => withTmp(async (dir) => {
  const live = makeClient(dir, [sttOk(), ttsOk()]);
  const audio = Buffer.from('abc');
  await live.client.translate({ audio, mime: 'audio/wav' });
  await live.client.speak({ text: 'Tez', targetLang: 'hi-IN' });
  const replay = makeClient(dir, [new Error('fetch must not be called')], { mode: 'replay', apiKey: undefined });
  const t = await replay.client.translate({ audio, mime: 'audio/webm' });
  const s = await replay.client.speak({ text: 'Tez', targetLang: 'hi-IN' });
  assert.deepEqual({ text: t.text, source: t.source }, { text: 'Row faster', source: 'replay' });
  assert.deepEqual({ audioBase64: s.audioBase64, mime: s.mime, source: s.source }, { audioBase64: WAV_B64, mime: 'audio/wav', source: 'replay' });
  assert.equal(replay.calls.length, 0);
}));

test('replay miss: throws NoReplayAvailable with a clear message', async () => withTmp(async (dir) => {
  const { client, calls } = makeClient(dir, [sttOk()], { mode: 'replay' });
  await assert.rejects(client.speak({ text: 'never recorded', targetLang: 'hi-IN' }), (err) => {
    assert.ok(err instanceof NoReplayAvailable);
    assert.equal(err.name, 'NoReplayAvailable');
    assert.match(err.message, /No replay available for speak/);
    assert.ok(!err.message.includes(FAKE_KEY));
    return true;
  });
  assert.equal(calls.length, 0);
}));

test('a corrupt cache file counts as a miss', async () => withTmp(async (dir) => {
  const key = cacheKey({ op: 'speak', text: 'Tez', targetLang: 'hi-IN', speaker: 'shubh', model: 'bulbul:v3' });
  await writeFile(path.join(dir, `speak-${key}.json`), '{not json');
  const { client } = makeClient(dir, [], { mode: 'replay' });
  await assert.rejects(client.speak({ text: 'Tez', targetLang: 'hi-IN' }), NoReplayAvailable);
}));

test('auto mode: live with a key, replay without', async () => withTmp(async (dir) => {
  const withKey = makeClient(dir, [ttsOk()], { mode: 'auto' });
  assert.equal(withKey.client.mode, 'live');
  assert.equal((await withKey.client.speak({ text: 'Tez', targetLang: 'hi-IN' })).source, 'live');
  const noKey = makeClient(dir, [new Error('no network')], { mode: 'auto', apiKey: '' });
  assert.equal(noKey.client.mode, 'replay');
  assert.equal((await noKey.client.speak({ text: 'Tez', targetLang: 'hi-IN' })).source, 'replay');
  await assert.rejects(noKey.client.speak({ text: 'other', targetLang: 'hi-IN' }), NoReplayAvailable);
  assert.equal(noKey.calls.length, 0);
}));

test('retry then success: one retry after 429, with the injected delay', async () => withTmp(async (dir) => {
  const limited = jsonResponse(429, { error: { message: 'Rate limit', code: 'rate_limit_exceeded_error' } });
  const { client, calls, sleeps } = makeClient(dir, [limited, sttOk()]);
  const out = await client.translate({ audio: Buffer.from('abc'), mime: 'audio/wav' });
  assert.equal(out.source, 'live');
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [5]);
}));

test('retry then success: one retry after a network timeout', async () => withTmp(async (dir) => {
  const { client, calls } = makeClient(dir, [timeoutError(), ttsOk()]);
  assert.equal((await client.speak({ text: 'Tez', targetLang: 'hi-IN' })).source, 'live');
  assert.equal(calls.length, 2);
}));

test('retry then cache fallback: serves the cached answer marked replay', async () => withTmp(async (dir) => {
  await makeClient(dir, [ttsOk()]).client.speak({ text: 'Tez', targetLang: 'hi-IN' });
  const limited = jsonResponse(429, { error: { message: 'Rate limit', code: 'rate_limit_exceeded_error' } });
  const failing = makeClient(dir, [limited, timeoutError()]);
  const out = await failing.client.speak({ text: 'Tez', targetLang: 'hi-IN' });
  assert.equal(out.source, 'replay');
  assert.equal(out.audioBase64, WAV_B64);
  assert.equal(failing.calls.length, 2);
}));

test('retry then no cache: throws SarvamApiError after exactly two attempts', async () => withTmp(async (dir) => {
  const { client, calls } = makeClient(dir, [timeoutError()]);
  await assert.rejects(client.speak({ text: 'Tez', targetLang: 'hi-IN' }), (err) => {
    assert.ok(err instanceof SarvamApiError);
    assert.equal(err.status, 0);
    assert.equal(err.code, 'timeout');
    return true;
  });
  assert.equal(calls.length, 2);
}));

test('4xx mapping: no retry, status and code carried, nothing cached', async () => withTmp(async (dir) => {
  const forbidden = jsonResponse(403, { error: { message: `Invalid key ${FAKE_KEY}`, code: 'invalid_api_key_error', request_id: null } });
  const { client, calls } = makeClient(dir, [forbidden]);
  await assert.rejects(client.translate({ audio: Buffer.from('abc'), mime: 'audio/wav' }), (err) => {
    assert.ok(err instanceof SarvamApiError);
    assert.equal(err.status, 403);
    assert.equal(err.code, 'invalid_api_key_error');
    assert.equal(err.retryable, false);
    assert.match(err.message, /HTTP 403/);
    assert.ok(!err.message.includes(FAKE_KEY));
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(await readdir(dir), []);
}));

test('402 does not retry but falls back to cache when present', async () => withTmp(async (dir) => {
  await makeClient(dir, [ttsOk()]).client.speak({ text: 'Tez', targetLang: 'hi-IN' });
  const broke = jsonResponse(402, { error: { message: 'No credits', code: 'insufficient_quota_error' } });
  const { client, calls } = makeClient(dir, [broke]);
  assert.equal((await client.speak({ text: 'Tez', targetLang: 'hi-IN' })).source, 'replay');
  assert.equal(calls.length, 1);
  await assert.rejects(client.speak({ text: 'uncached', targetLang: 'hi-IN' }), (err) => err.status === 402);
}));

test('a 200 without the expected field is an upstream error, not a crash', async () => withTmp(async (dir) => {
  const { client } = makeClient(dir, [jsonResponse(200, { request_id: 'x' })]);
  await assert.rejects(client.speak({ text: 'Tez', targetLang: 'hi-IN' }), (err) => err instanceof SarvamApiError && err.status === 502);
}));

test('input validation: clear SarvamInputError before any network call', async () => withTmp(async (dir) => {
  const { client, calls } = makeClient(dir, [sttOk()]);
  const bad = [
    () => client.translate({}),
    () => client.translate({ audio: 'not a buffer' }),
    () => client.translate({ audio: Buffer.alloc(0) }),
    () => client.translate({ audio: Buffer.from('a'), sourceLang: 'xx-XX' }),
    () => client.translate({ audio: Buffer.from('a'), mime: 'not a mime' }),
    () => client.translate({ text: 'x'.repeat(1001) }),
    () => client.speak({ text: '', targetLang: 'hi-IN' }),
    () => client.speak({ text: 'x'.repeat(2501), targetLang: 'hi-IN' }),
    () => client.speak({ text: 'ok', targetLang: 'fr-FR' }),
    () => client.speak({ text: 'ok', targetLang: 'hi-IN', speaker: 'nobody' }),
    () => client.speak(),
  ];
  for (const call of bad) {
    await assert.rejects(call(), (err) => err instanceof SarvamInputError && err.status === 400);
  }
  assert.equal(calls.length, 0);
  assert.throws(() => createSarvamClient({ mode: 'sometimes' }), SarvamInputError);
  const liveNoKey = createSarvamClient({ mode: 'live', cacheDir: dir, fetchImpl: async () => sttOk() });
  await assert.rejects(liveNoKey.speak({ text: 'ok', targetLang: 'hi-IN' }), /no API key/);
}));

test('no key and no audio appear in any logged string', async () => withTmp(async (dir) => {
  const audio = Buffer.from('very-secret-shout-audio');
  const limited = jsonResponse(429, { error: { message: `slow down ${FAKE_KEY}`, code: 'rate_limit_exceeded_error' } });
  const { client, logs } = makeClient(dir, [limited, sttOk(), ttsOk(), limited, limited]);
  await client.translate({ audio, mime: 'audio/wav' });
  await client.speak({ text: 'Tez', targetLang: 'hi-IN' });
  await client.speak({ text: 'Tez', targetLang: 'hi-IN' }); // retry then cache fallback
  assert.ok(logs.length >= 4);
  for (const line of logs) {
    assert.equal(typeof line, 'string');
    assert.ok(!line.includes(FAKE_KEY), 'key leaked into a log line');
    assert.ok(!line.includes(audio.toString('base64')) && !line.includes(WAV_B64), 'audio leaked into a log line');
  }
}));

test('record-fixtures: parseArgs and planJobs', () => {
  const opts = parseArgs(['--text', 'call one', '--audio', 'a.webm', '--speak', 'hi-IN=Tez', '--speak', 'Faster', '--lang', 'en-IN,bn-IN']);
  const jobs = planJobs(opts);
  assert.deepEqual(jobs.map((j) => j.op), ['translate', 'translate', 'speak', 'speak', 'speak']);
  assert.deepEqual(jobs.slice(2).map((j) => j.args.targetLang), ['hi-IN', 'en-IN', 'bn-IN']);
  assert.throws(() => parseArgs([]), UsageError);
  assert.throws(() => parseArgs(['--speak', 'Faster']), /needs --lang/);
  assert.throws(() => parseArgs(['--lang', 'fr-FR', '--text', 'x']), /Unsupported target language/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
  assert.throws(() => parseArgs(['--text']), /needs a value/);
});

test('record-fixtures: --phrases plans the phrases the server speaks', async () => {
  const hub = await import('../server/hub.js');
  const all = planJobs(parseArgs(['--phrases']));
  assert.equal(all.length, Object.keys(hub.PHRASES).length * hub.LANGS.length);
  assert.ok(all.every((j) => j.op === 'speak' && j.args.text === hub.phraseFor(
    Object.keys(hub.PHRASES).find((m) => hub.PHRASES[m][j.args.targetLang] === j.args.text), j.args.targetLang)));
  const hindi = planJobs(parseArgs(['--phrases', '--lang', 'hi-IN']));
  assert.equal(hindi.length, Object.keys(hub.PHRASES).length);
  assert.ok(hindi.every((j) => j.args.targetLang === 'hi-IN'));
  assert.equal(planJobs(parseArgs(['--text', 'x'])).length, 1);
});

test('record-fixtures: refuses to run without a key', async () => {
  const errs = [];
  const code = await main({ argv: ['--text', 'x'], env: {}, out: () => {}, err: (l) => errs.push(l), fetchImpl: async () => { throw new Error('no network'); } });
  assert.equal(code, 1);
  assert.match(errs.join('\n'), /SARVAM_API_KEY is not set/);
});

test('record-fixtures: records live, prints a table, never prints the key', async () => withTmp(async (dir) => {
  const audioFile = path.join(dir, 'call.wav');
  await writeFile(audioFile, Buffer.from('abc'));
  const cache = path.join(dir, 'cache');
  const fetcher = fakeFetch([(url) => (url.endsWith('/text-to-speech') ? ttsOk()
    : url.endsWith('/translate') ? jsonResponse(200, { translated_text: `Faster ${FAKE_KEY}` }) : sttOk())]);
  const lines = [];
  const argv = ['--text', 'typed', '--audio', audioFile, '--audio', path.join(dir, 'missing.wav'), '--speak', 'Tez', '--lang', 'hi-IN', '--cache-dir', cache];
  const code = await main({ argv, env: { SARVAM_API_KEY: FAKE_KEY }, out: (l) => lines.push(l), err: (l) => lines.push(l), fetchImpl: fetcher.impl });
  const printed = lines.join('\n');
  assert.equal(code, 1); // one job (missing file) failed
  assert.match(printed, /3 of 4 recorded live/);
  assert.match(printed, /file not found/);
  assert.ok(!printed.includes(FAKE_KEY));
  assert.equal((await readdir(cache)).length, 3);
}));
