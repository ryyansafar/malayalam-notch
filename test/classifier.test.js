import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createMeaningClassifier, parseModelAnswer, CLASSIFIER_MODEL, CLASSIFIER_TIMEOUT_MS, LABELS, RESPONSE_SCHEMA, SYSTEM_PROMPT,
} from '../sarvam/classifier.js';
import { SarvamInputError } from '../sarvam/client.js';
import { MEANINGS, matchMeaning, noMatchReason } from '../shared/calls.js';
import { evaluate } from '../shared/obedience.js';
import { createServer } from '../server/index.js';

const FAKE_KEY = 'test-key-not-a-real-secret-456';
const NO_MATCH_TEXT = 'Pull with all your strength';

function chatResponse(content, status = 200) {
  const body = status === 200
    ? { id: 'x', model: CLASSIFIER_MODEL, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] }
    : { error: { message: `upstream said no to ${FAKE_KEY}`, code: 'some_error' } };
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
const answer = (label) => chatResponse(JSON.stringify({ meaning: label }));

/** Fake fetch that replays a scripted list of responses, errors or functions and records calls. */
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
  const dir = await mkdtemp(path.join(tmpdir(), 'classifier-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function make(dir, script, extra = {}) {
  const fetcher = fakeFetch(script);
  const logs = [];
  const sleeps = [];
  const classifier = createMeaningClassifier({
    apiKey: FAKE_KEY, mode: 'live', cacheDir: dir, fetchImpl: fetcher.impl,
    log: (line) => logs.push(line), sleep: async (ms) => { sleeps.push(ms); }, retryDelayMs: 5, ...extra,
  });
  return { classifier, logs, sleeps, calls: fetcher.calls };
}

const timeoutError = () => Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });

// ---------------------------------------------------------------- request shape

test('classify live: documented endpoint, header, model, schema, no reasoning, temperature 0', async () => withTmp(async (dir) => {
  const { classifier, calls } = make(dir, [answer('speed_up')]);
  const out = await classifier.classify({ text: `  ${NO_MATCH_TEXT}  ` });
  assert.deepEqual({ ...out, latencyMs: 0 }, { meaning: 'speed_up', confidence: 'model', source: 'live', latencyMs: 0, model: 'sarvam-105b' });
  assert.equal(typeof out.latencyMs, 'number');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.sarvam.ai/v2/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['api-subscription-key'], FAKE_KEY);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'sarvam-105b');
  assert.equal(body.temperature, 0);
  assert.equal(body.reasoning_effort, null);
  assert.ok(Object.hasOwn(body, 'reasoning_effort'), 'null must be sent explicitly: omitting it means the default effort');
  assert.ok(body.max_tokens > 0 && body.max_tokens <= 128);
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.properties.meaning.enum, [...MEANINGS, 'none']);
  assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(body.messages[0].content, SYSTEM_PROMPT);
  assert.ok(body.messages[1].content.includes(NO_MATCH_TEXT));
  assert.equal(body.messages[1].content.includes(`  ${NO_MATCH_TEXT}`), false, 'text is trimmed');
}));

test('system prompt names every label and the refusal cases; schema enum is the six meanings plus none', () => {
  for (const label of LABELS) assert.ok(SYSTEM_PROMPT.includes(label), label);
  for (const word of ['ambiguous', 'negated', 'question', 'not a rowing command']) assert.ok(SYSTEM_PROMPT.includes(word), word);
  assert.deepEqual(LABELS, ['start', 'speed_up', 'slow_down', 'hold', 'ready', 'stop', 'none']);
  assert.deepEqual(RESPONSE_SCHEMA.required, ['meaning']);
  assert.equal(CLASSIFIER_TIMEOUT_MS, 6000);
});

// ---------------------------------------------------------------- strict validation

test('parseModelAnswer: only {"meaning": <label>} is accepted', () => {
  for (const label of LABELS) assert.equal(parseModelAnswer(JSON.stringify({ meaning: label })), label);
  assert.equal(parseModelAnswer(' {"meaning":"stop"}\n'), 'stop');
  const rejected = [
    undefined, null, 42, { meaning: 'stop' }, '', 'stop', '"stop"', 'null', '[]', '["stop"]', '{}',
    '{"meaning":"STOP"}', '{"meaning":"faster"}', '{"meaning":"speed up"}', '{"meaning":null}', '{"meaning":1}',
    '{"meaning":["stop"]}', '{"Meaning":"stop"}', '{"meaning":"stop","confidence":0.9}', '{"meaning":"stop"} trailing',
    '```json\n{"meaning":"stop"}\n```', 'Sure! {"meaning":"stop"}', '{"meaning":"__proto__"}', '{"meaning":"toString"}',
  ];
  for (const value of rejected) assert.equal(parseModelAnswer(value), null, String(value));
});

test('classify: an answer of none is a valid null meaning, cached, with no error', async () => withTmp(async (dir) => {
  const { classifier } = make(dir, [answer('none')]);
  const out = await classifier.classify({ text: 'What time is it' });
  assert.equal(out.meaning, null);
  assert.equal(out.confidence, 'model');
  assert.equal(out.source, 'live');
  assert.equal('error' in out, false);
  assert.equal((await readdir(dir)).length, 1);
}));

test('classify: anything outside the schema becomes none (invalid_output), is not retried and not cached', async () => withTmp(async (dir) => {
  const bad = [
    chatResponse('{"meaning":"faster"}'), chatResponse('speed_up'), chatResponse('{"meaning":"stop","why":"x"}'),
    chatResponse(null), chatResponse('```json\n{"meaning":"stop"}\n```'),
    new Response(JSON.stringify({ choices: [] }), { status: 200 }), new Response('not json', { status: 200 }),
    new Response(JSON.stringify({ choices: [{ message: { content: { meaning: 'stop' } } }] }), { status: 200 }),
  ];
  for (const response of bad) {
    const { classifier, calls, sleeps } = make(dir, [response, answer('stop')]);
    const out = await classifier.classify({ text: NO_MATCH_TEXT });
    assert.equal(out.meaning, null);
    assert.equal(out.error, 'invalid_output');
    assert.equal(out.confidence, 'model');
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  }
  assert.deepEqual(await readdir(dir), []);
}));

test('classify: input validation throws SarvamInputError, long text is refused without a request', async () => withTmp(async (dir) => {
  const { classifier, calls } = make(dir, [answer('stop')]);
  for (const text of [undefined, null, 7, '', '   ']) {
    await assert.rejects(() => classifier.classify({ text }), SarvamInputError);
  }
  await assert.rejects(() => classifier.classify(), SarvamInputError);
  const long = await classifier.classify({ text: 'oars '.repeat(100) });
  assert.equal(long.meaning, null);
  assert.equal(long.skipped, 'too_long');
  assert.equal(calls.length, 0);
  assert.throws(() => createMeaningClassifier({ mode: 'sometimes' }), SarvamInputError);
  assert.throws(() => createMeaningClassifier({ fetchImpl: 'nope' }), SarvamInputError);
  const keyless = createMeaningClassifier({ mode: 'live', cacheDir: dir, fetchImpl: async () => answer('stop') });
  await assert.rejects(() => keyless.classify({ text: NO_MATCH_TEXT }), SarvamInputError);
}));

// ---------------------------------------------------------------- guardrails

test('guard: negation, conflict and rule-matched texts never reach the model', async () => withTmp(async (dir) => {
  const { classifier, calls } = make(dir, [answer('stop')]);
  const cases = [
    ['Do not stop', 'negation'], ["Don't slow down", 'negation'], ['Never mind the others', 'negation'],
    ['Stop, go faster', 'conflict'], ['Get ready and stop', 'conflict'], ['Row faster', 'matched'], ['?!', 'empty'],
  ];
  for (const [text, skipped] of cases) {
    const out = await classifier.classify({ text });
    assert.equal(out.meaning, null, text);
    assert.equal(out.skipped, skipped, text);
    assert.equal(out.confidence, 'model');
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(dir), []);
}));

test('guard: replay mode refuses negation too, even if a cache entry exists for it', async () => withTmp(async (dir) => {
  const open = make(dir, [answer('stop')], { guard: false });
  assert.equal((await open.classifier.classify({ text: 'Do not stop' })).meaning, 'stop'); // evaluation-only path writes a cache entry
  const replay = createMeaningClassifier({ mode: 'replay', cacheDir: dir, fetchImpl: async () => { throw new Error('no network in replay'); } });
  const out = await replay.classify({ text: 'Do not stop' });
  assert.equal(out.meaning, null);
  assert.equal(out.skipped, 'negation');
}));

// ---------------------------------------------------------------- timeout, retry, errors

test('timeout: a model that never answers gives none within the budget and does not throw', async () => withTmp(async (dir) => {
  const hang = () => new Promise(() => {}); // ignores the abort signal on purpose
  const { classifier, calls } = make(dir, [hang], { timeoutMs: 40, retryDelayMs: 5 });
  const started = performance.now();
  const out = await classifier.classify({ text: NO_MATCH_TEXT });
  const elapsed = performance.now() - started;
  assert.equal(out.meaning, null);
  assert.equal(out.error, 'timeout');
  assert.equal(out.source, 'live');
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
  assert.equal(calls.length, 1, 'no budget left for a retry');
  assert.deepEqual(await readdir(dir), []);
}));

test('timeout: the abort signal passed to fetch fires at the deadline', async () => withTmp(async (dir) => {
  const untilAborted = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  const { classifier } = make(dir, [untilAborted], { timeoutMs: 30 });
  const out = await classifier.classify({ text: NO_MATCH_TEXT });
  assert.equal(out.meaning, null);
  assert.equal(out.error, 'timeout');
}));

test('retry: one retry on 429, 5xx, network error and timeout error; then success is used', async () => withTmp(async (dir) => {
  for (const first of [chatResponse(null, 429), chatResponse(null, 503), new TypeError('fetch failed'), timeoutError()]) {
    const { classifier, calls, sleeps } = make(dir, [first, answer('hold')]);
    const out = await classifier.classify({ text: `Keep the blades buried ${calls.length}${sleeps.length}${Math.random()}` });
    assert.equal(out.meaning, 'hold');
    assert.equal(out.source, 'live');
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [5]);
  }
}));

test('errors: two failures give none with a short code; 4xx is not retried; the key never reaches the log', async () => withTmp(async (dir) => {
  const twice = make(dir, [chatResponse(null, 500)]);
  const a = await twice.classifier.classify({ text: NO_MATCH_TEXT });
  assert.deepEqual([a.meaning, a.error, twice.calls.length], [null, 'http_500', 2]);

  const denied = make(dir, [chatResponse(null, 403), answer('stop')]);
  const b = await denied.classifier.classify({ text: NO_MATCH_TEXT });
  assert.deepEqual([b.meaning, b.error, denied.calls.length], [null, 'http_403', 1]);

  const offline = make(dir, [new TypeError(`connect failed for ${FAKE_KEY}`)]);
  const c = await offline.classifier.classify({ text: NO_MATCH_TEXT });
  assert.deepEqual([c.meaning, c.error], [null, 'network_error']);

  for (const { logs } of [twice, denied, offline]) {
    assert.ok(logs.length > 0);
    assert.ok(logs.every((line) => line.startsWith('[classifier] ')));
    assert.equal(logs.join('\n').includes(FAKE_KEY), false);
  }
  for (const out of [a, b, c]) assert.equal(JSON.stringify(out).includes(FAKE_KEY), false);
  assert.deepEqual(await readdir(dir), []);
}));

test('a broken logger never breaks a call', async () => withTmp(async (dir) => {
  const { classifier } = make(dir, [answer('ready')], { log: () => { throw new Error('logger down'); } });
  assert.equal((await classifier.classify({ text: 'Eyes in the boat' })).meaning, 'ready');
}));

// ---------------------------------------------------------------- cache and replay

test('cache: a live answer is written as classify-<sha256>.json without the key, and replays exactly', async () => withTmp(async (dir) => {
  const live = make(dir, [answer('speed_up')]);
  await live.classifier.classify({ text: NO_MATCH_TEXT });
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^classify-[0-9a-f]{64}\.json$/);
  const raw = await readFile(path.join(dir, files[0]), 'utf8');
  assert.equal(raw.includes(FAKE_KEY), false);
  const entry = JSON.parse(raw);
  assert.deepEqual(entry.input, { text: NO_MATCH_TEXT, model: 'sarvam-105b' });
  assert.deepEqual(entry.result, { label: 'speed_up' });

  const boom = async () => { throw new Error('replay must not touch the network'); };
  const replay = createMeaningClassifier({ mode: 'replay', cacheDir: dir, fetchImpl: boom });
  assert.equal(replay.mode, 'replay');
  const hit = await replay.classify({ text: ` ${NO_MATCH_TEXT} ` });
  assert.deepEqual({ ...hit, latencyMs: 0 }, { meaning: 'speed_up', confidence: 'model', source: 'replay', latencyMs: 0, model: 'sarvam-105b' });

  const miss = await replay.classify({ text: 'Everyone together now' });
  assert.deepEqual([miss.meaning, miss.source, miss.error], [null, 'replay', 'no_replay']);
}));

test('mode auto: live with a key, replay without one', () => {
  assert.equal(createMeaningClassifier({ apiKey: FAKE_KEY, fetchImpl: async () => answer('stop') }).mode, 'live');
  assert.equal(createMeaningClassifier({ apiKey: '  ', fetchImpl: async () => answer('stop') }).mode, 'replay');
});

test('cache: a retryable live failure falls back to the recorded answer, labelled replay', async () => withTmp(async (dir) => {
  await make(dir, [answer('slow_down')]).classifier.classify({ text: 'Light pressure' });
  const flaky = make(dir, [chatResponse(null, 503)]);
  const out = await flaky.classifier.classify({ text: 'Light pressure' });
  assert.deepEqual([out.meaning, out.source, out.error], ['slow_down', 'replay', undefined]);
}));

test('cache: a tampered entry is validated like a model answer and ignored', async () => withTmp(async (dir) => {
  await make(dir, [answer('stop')]).classifier.classify({ text: 'Oars up' });
  const [file] = await readdir(dir);
  const replay = () => createMeaningClassifier({ mode: 'replay', cacheDir: dir, fetchImpl: async () => { throw new Error('no'); } });
  for (const content of ['{"result":{"label":"explode"}}', '{"result":{"label":7}}', '{"result":null}', 'not json']) {
    await writeFile(path.join(dir, file), content, 'utf8');
    const out = await replay().classify({ text: 'Oars up' });
    assert.deepEqual([out.meaning, out.error], [null, 'no_replay'], content);
  }
}));

// ---------------------------------------------------------------- server integration (real rules, fake classifier)

function request(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/shout', headers: { 'Content-Type': 'application/json' }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
const getJson = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
  }).on('error', reject);
});

function fakeTimers() {
  const list = [];
  const add = (kind) => (fn, ms) => {
    const h = { kind, fn, ms, cleared: false };
    list.push(h);
    return h;
  };
  return {
    list,
    api: { setTimeout: add('timeout'), clearTimeout: (h) => { if (h) h.cleared = true; }, setInterval: add('interval'), clearInterval: (h) => { if (h) h.cleared = true; } },
    pending: (ms) => list.filter((h) => h.kind === 'timeout' && !h.cleared && !h.fired && (ms === undefined || h.ms === ms)),
  };
}

/** Server with the real rules. The typed text is "translated" to itself so each test controls the English. */
async function startServer({ classify, config = {}, omit = [] } = {}) {
  const asked = [];
  const logs = [];
  const timers = fakeTimers();
  const deps = {
    sarvam: {
      translate: async ({ text }) => ({ text, source: 'live', latencyMs: 100 }),
      speak: async () => ({ audioBase64: 'QUJD', mime: 'audio/wav', source: 'live', latencyMs: 50 }),
    },
    classifier: { classify: async (args) => { asked.push(args); return classify(args); } },
    matchReason: noMatchReason, matchMeaning, evaluate, timers: timers.api, log: (l) => logs.push(l),
    qr: async () => '<svg/>',
    config: { rootDir: tmpdir(), mode: 'live', lanAddresses: [], ...config },
  };
  for (const name of omit) delete deps[name];
  const app = createServer(deps);
  const { port } = await app.listen(0, '127.0.0.1');
  const shout = (text) => request(port, { text, targetLang: 'en-IN' });
  return { app, port, asked, logs, timers, shout, state: () => getJson(port, '/api/state'), stop: () => app.close() };
}
const modelSays = (meaning, extra = {}) => async () => ({ meaning, confidence: 'model', source: 'live', latencyMs: 900, model: 'sarvam-105b', ...extra });
const ON = { modelFallback: true };

test('server: flag off by default, the classifier is never asked and payloads carry no model fields', async () => {
  const s = await startServer({ classify: modelSays('speed_up') });
  try {
    const miss = await s.shout(NO_MATCH_TEXT);
    assert.equal(miss.json.status, 'not_sure');
    assert.equal(miss.json.confidence, 'none');
    const hit = await s.shout('Row faster');
    assert.equal(hit.json.meaning, 'speed_up');
    assert.equal(hit.json.confidence, 'high');
    assert.deepEqual(hit.json.sources, { translate: 'live', speak: 'live' });
    for (const r of [miss, hit]) {
      assert.equal('matchedBy' in r.json, false);
      assert.equal('model' in r.json, false);
    }
    assert.deepEqual(s.asked, []);
    assert.equal('modelFallback' in (await getJson(s.port, '/api/providers')), false);
  } finally {
    await s.stop();
  }
});

test('server: flag on, a no_match text is decided by the model and marked matchedBy model', async () => {
  const s = await startServer({ classify: modelSays('speed_up'), config: ON });
  try {
    const r = await s.shout(NO_MATCH_TEXT);
    assert.equal(r.status, 200);
    assert.deepEqual(s.asked, [{ text: NO_MATCH_TEXT }]);
    assert.equal(r.json.status, 'ok');
    assert.equal(r.json.meaning, 'speed_up');
    assert.equal(r.json.confidence, 'model');
    assert.equal(r.json.matchedBy, 'model');
    assert.equal(r.json.matchedKeyword, null);
    assert.deepEqual(r.json.model, { meaning: 'speed_up', name: 'sarvam-105b', latencyMs: 900, source: 'live', error: null });
    assert.equal(r.json.latencyMs, 100 + 900 + 50);
    assert.equal(r.json.source, 'live');
    assert.deepEqual(r.json.sources, { translate: 'live', speak: 'live', model: 'live' });
    assert.equal(r.json.spokenText, 'Row faster');
    assert.equal(s.timers.pending(6500).length, 0, 'the model timeout timer is cleared');

    const state = await s.state();
    assert.equal(state.lastCall.matchedBy, 'model');
    assert.equal(state.lastCall.model.latencyMs, 900);
    assert.equal((await getJson(s.port, '/api/providers')).modelFallback, true);

    // the trial row (written when a newer call supersedes the open window) keeps the fields
    await s.shout('Row faster');
    const after = await s.state();
    assert.equal(after.trials.length, 1);
    assert.equal(after.trials[0].matchedBy, 'model');
    assert.equal(after.trials[0].confidence, 'model');
    assert.equal(after.trials[0].model.name, 'sarvam-105b');
  } finally {
    await s.stop();
  }
});

test('server: flag on, the deterministic path is unchanged and marked matchedBy rules', async () => {
  const s = await startServer({ classify: modelSays('stop'), config: ON });
  try {
    const r = await s.shout('Row faster');
    assert.equal(r.json.meaning, 'speed_up');
    assert.equal(r.json.confidence, 'high');
    assert.equal(r.json.matchedKeyword, 'row faster');
    assert.equal(r.json.matchedBy, 'rules');
    assert.equal(r.json.model, null);
    assert.equal(r.json.latencyMs, 150);
    assert.deepEqual(r.json.sources, { translate: 'live', speak: 'live' });
    assert.deepEqual(s.asked, []);
  } finally {
    await s.stop();
  }
});

test('server: flag on, negation and conflict never reach the model and stay not_sure', async () => {
  const s = await startServer({ classify: modelSays('stop'), config: ON });
  try {
    for (const text of ['Do not stop', "Don't slow down", 'Never', 'Stop, go faster', 'Get ready and stop']) {
      const r = await s.shout(text);
      assert.equal(r.json.status, 'not_sure', text);
      assert.equal(r.json.meaning, null, text);
      assert.equal(r.json.confidence, 'none', text);
      assert.equal(r.json.matchedBy, null, text);
      assert.equal(r.json.model, null, text);
    }
    assert.deepEqual(s.asked, []);
    const state = await s.state();
    assert.equal(state.tally.notSure, 5);
    assert.ok(state.trials.every((t) => t.matchedBy === null && t.model === null));
  } finally {
    await s.stop();
  }
});

test('server: flag on, model answers none or something outside the six meanings: not_sure, with the latency kept', async () => {
  for (const meaning of [null, 'none', 'faster', 'toString', 42]) {
    const s = await startServer({ classify: modelSays(meaning), config: ON });
    try {
      const r = await s.shout('What time is it');
      assert.equal(r.json.status, 'not_sure');
      assert.equal(r.json.confidence, 'none');
      assert.equal(r.json.matchedBy, null);
      assert.equal(r.json.model.meaning, null);
      assert.equal(r.json.model.latencyMs, 900);
      assert.equal(r.json.latencyMs, 1000);
      assert.deepEqual(r.json.sources, { translate: 'live', speak: null, model: 'live' });
      assert.equal(s.asked.length, 1);
    } finally {
      await s.stop();
    }
  }
});

test('server: flag on, a classifier that throws falls back to not_sure and logs only the error name', async () => {
  const s = await startServer({ classify: async () => { throw new Error(`boom with ${FAKE_KEY}`); }, config: ON });
  try {
    const r = await s.shout(NO_MATCH_TEXT);
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'not_sure');
    assert.equal(r.json.matchedBy, null);
    assert.equal(r.json.model.error, 'Error');
    assert.ok(s.logs.includes('[shout] model fallback failed: Error'));
    assert.equal(s.logs.join('\n').includes(FAKE_KEY), false);
    assert.equal(JSON.stringify(r.json).includes(FAKE_KEY), false);
  } finally {
    await s.stop();
  }
});

test('server: flag on, a classifier that never answers is cut off by the server timer: not_sure', async () => {
  const s = await startServer({ classify: () => new Promise(() => {}), config: ON });
  try {
    const pending = s.shout(NO_MATCH_TEXT);
    while (s.timers.pending(6500).length === 0) await new Promise((resolve) => setImmediate(resolve));
    const [timer] = s.timers.pending(6500);
    timer.fired = true;
    timer.fn();
    const r = await pending;
    assert.equal(r.json.status, 'not_sure');
    assert.equal(r.json.model.error, 'ModelTimeout');
    assert.ok(s.logs.includes('[shout] model fallback failed: ModelTimeout'));
  } finally {
    await s.stop();
  }
});

test('server: a replayed model answer makes the whole call REPLAY', async () => {
  const s = await startServer({ classify: modelSays('hold', { source: 'replay', latencyMs: 2 }), config: ON });
  try {
    const r = await s.shout('Keep the blades buried');
    assert.equal(r.json.meaning, 'hold');
    assert.equal(r.json.source, 'replay');
    assert.deepEqual(r.json.sources, { translate: 'live', speak: 'live', model: 'replay' });
  } finally {
    await s.stop();
  }
});

test('server: flag on but no classifier, or no reason helper: the model path stays off', async () => {
  for (const omit of [['classifier'], ['matchReason']]) {
    const s = await startServer({ classify: modelSays('speed_up'), config: ON, omit });
    try {
      const r = await s.shout(NO_MATCH_TEXT);
      assert.equal(r.json.status, 'not_sure');
      assert.equal('matchedBy' in r.json, false);
      assert.deepEqual(s.asked, []);
    } finally {
      await s.stop();
    }
  }
});

test('server: a reason helper that throws or answers something unknown never opens the model path', async () => {
  for (const matchReason of [() => { throw new Error('x'); }, () => undefined, () => 'maybe', () => null]) {
    const asked = [];
    const app = createServer({
      sarvam: { translate: async ({ text }) => ({ text, source: 'live', latencyMs: 1 }), speak: async () => null },
      classifier: { classify: async (a) => { asked.push(a); return { meaning: 'stop' }; } },
      matchReason, matchMeaning, evaluate, timers: fakeTimers().api, qr: async () => '<svg/>',
      config: { rootDir: tmpdir(), lanAddresses: [], modelFallback: true },
    });
    const { port } = await app.listen(0, '127.0.0.1');
    try {
      const r = await request(port, { text: NO_MATCH_TEXT, targetLang: 'en-IN' });
      assert.equal(r.json.status, 'not_sure');
      assert.deepEqual(asked, []);
    } finally {
      await app.close();
    }
  }
});
