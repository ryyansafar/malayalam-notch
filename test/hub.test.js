import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as H from '../server/hub.js';

const MEANINGS = ['start', 'speed_up', 'slow_down', 'hold', 'ready', 'stop'];

function fakeTimers() {
  const handles = [];
  return {
    handles,
    setInterval: (fn, ms) => {
      const h = { fn, ms, cleared: false };
      handles.push(h);
      return h;
    },
    clearInterval: (h) => {
      if (h) h.cleared = true;
    },
  };
}

function fakeClient() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  Object.assign(res, {
    chunks: [],
    status: null,
    headers: null,
    ended: false,
    writableLength: 0,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    write(chunk) {
      res.chunks.push(chunk);
      return true;
    },
    end() {
      res.ended = true;
      res.writableEnded = true;
    },
  });
  return { req, res };
}

const stroke = (t, rateSpm, count) => ({ type: 'stroke', t, rateSpm, count });

test('phrase table covers every meaning in every language', () => {
  assert.deepEqual([...H.LANGS], ['en-IN', 'hi-IN', 'bn-IN', 'od-IN', 'ta-IN']);
  for (const meaning of MEANINGS) {
    for (const lang of H.LANGS) {
      const phrase = H.phraseFor(meaning, lang);
      assert.equal(typeof phrase, 'string', `${meaning}/${lang}`);
      assert.ok(phrase.length > 0 && phrase.length < 2500);
    }
  }
  assert.equal(H.phraseFor('speed_up', 'en-IN'), 'Row faster');
  assert.equal(H.phraseFor('dance', 'en-IN'), null);
  assert.equal(H.phraseFor('start', 'fr-FR'), null);
  assert.equal(H.phraseFor('constructor', 'en-IN'), null);
  assert.equal(H.phraseFor(null, 'en-IN'), null);
  assert.equal(H.PHRASES_REVIEWED, false);
});

test('initial state is deeply frozen and honest about unverified content', () => {
  const s = H.initialState({ mode: 'live', startedT: 5 });
  assert.equal(s.mode, 'live');
  assert.equal(s.callsVerified, false);
  assert.equal(s.phrasesReviewed, false);
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.phone) && Object.isFrozen(s.trials) && Object.isFrozen(s.tally));
  assert.throws(() => {
    s.phone.connected = true;
  }, TypeError);
});

test('reducers return new objects and leave the input untouched', () => {
  const s0 = H.initialState();
  const s1 = H.withPhone(s0, { connected: true, lastSeenT: 10 });
  assert.notEqual(s1, s0);
  assert.equal(s0.phone.connected, false);
  assert.equal(s1.phone.connected, true);
  assert.equal(s1.phone.userAgent, null);

  const s2 = H.withStrokes(s1, [stroke(100, 20, 1), stroke(200, 22, 2)]);
  assert.equal(s1.strokes.length, 0);
  assert.equal(s2.strokes.length, 2);
  assert.deepEqual(s2.stroke, stroke(200, 22, 2));
  assert.equal(H.withStrokes(s2, []), s2);
});

test('stroke and trial history are capped', () => {
  const many = Array.from({ length: H.MAX_STROKES + 50 }, (_, i) => stroke(i, 20, i));
  const s = H.withStrokes(H.initialState(), many);
  assert.equal(s.strokes.length, H.MAX_STROKES);
  assert.equal(s.strokes[0].t, 50);

  let t = H.initialState();
  for (let i = 0; i < H.MAX_TRIALS + 3; i += 1) t = H.withTrial(t, { callId: `c${i}`, outcome: 'obeyed' });
  assert.equal(t.trials.length, H.MAX_TRIALS);
  assert.equal(t.tally.total, H.MAX_TRIALS + 3);
});

test('withCall and withTrial never store audio; tally counts each outcome', () => {
  const call = { callId: 'c1', meaning: 'stop', ttsAudioBase64: 'QUJD', mime: 'audio/wav' };
  const s1 = H.withCall(H.initialState(), call);
  assert.equal('ttsAudioBase64' in s1.lastCall, false);
  assert.equal(s1.lastCall.meaning, 'stop');
  assert.equal(call.ttsAudioBase64, 'QUJD');

  let s = s1;
  s = H.withTrial(s, { callId: 'c1', outcome: 'obeyed', ttsAudioBase64: 'QUJD' });
  s = H.withTrial(s, { callId: 'c2', outcome: 'not_obeyed' });
  s = H.withTrial(s, { callId: 'c3', outcome: 'not_sure' });
  assert.deepEqual(s.tally, { obeyed: 1, notObeyed: 1, notSure: 1, total: 3 });
  assert.equal('ttsAudioBase64' in s.trials[0], false);
  assert.equal(s.lastResult.callId, 'c3');
  assert.throws(() => H.withTrial(s, { outcome: 'maybe' }), TypeError);
});

test('baselineSpm uses the latest fresh stroke before the call, else 0', () => {
  const s = H.withStrokes(H.initialState(), [stroke(1000, 18, 1), stroke(4000, 24, 2), stroke(9000, 30, 3)]);
  assert.equal(H.baselineSpm(s, 5000, 8000), 24);
  assert.equal(H.baselineSpm(s, 9000, 8000), 30);
  assert.equal(H.baselineSpm(s, 500, 8000), 0);
  assert.equal(H.baselineSpm(s, 30000, 8000), 0);
  assert.equal(H.baselineSpm(H.withStrokes(H.initialState(), [stroke(10, null, 1)]), 20, 8000), 0);
});

test('strokesBetween is exclusive of the call time and inclusive of the window end', () => {
  const s = H.withStrokes(H.initialState(), [stroke(100, 20, 1), stroke(200, 20, 2), stroke(300, 20, 3)]);
  assert.deepEqual(H.strokesBetween(s, 100, 300).map((e) => e.t), [200, 300]);
});

test('publicState hides the full stroke log and adds serverT', () => {
  const many = Array.from({ length: 300 }, (_, i) => stroke(i, 20, i));
  const p = H.publicState(H.withStrokes(H.initialState(), many), 777);
  assert.equal('strokes' in p, false);
  assert.equal(p.recentStrokes.length, 120);
  assert.equal(p.serverT, 777);
});

test('formatSse produces a single-line data frame and rejects unknown events', () => {
  assert.equal(H.formatSse('phone', { a: 'x\ny' }), 'event: phone\ndata: {"a":"x\\ny"}\n\n');
  assert.throws(() => H.formatSse('evil\nevent', {}), TypeError);
});

test('hub.update swaps in a new frozen state and rejects non-objects', () => {
  const hub = H.createHub({ timers: fakeTimers() });
  const before = hub.getState();
  const after = hub.update((s) => H.withPhone(s, { connected: true }));
  assert.notEqual(after, before);
  assert.equal(before.phone.connected, false);
  assert.equal(hub.getState(), after);
  assert.ok(Object.isFrozen(after.phone));
  assert.throws(() => hub.update(() => undefined), TypeError);
  assert.equal(hub.getState(), after);
});

test('addClient writes SSE headers, retry hint and initial events', () => {
  const hub = H.createHub({ timers: fakeTimers() });
  const { req, res } = fakeClient();
  assert.equal(hub.addClient(req, res, [['state', { n: 1 }]]), true);
  assert.equal(res.status, 200);
  assert.match(res.headers['Content-Type'], /^text\/event-stream/);
  assert.equal(res.headers['Cache-Control'], 'no-cache, no-transform');
  assert.deepEqual(res.chunks, ['retry: 2000\n\n', 'event: state\ndata: {"n":1}\n\n']);
  assert.equal(hub.clientCount(), 1);
});

test('broadcast reaches every client; closed clients are removed', () => {
  const hub = H.createHub({ timers: fakeTimers() });
  const a = fakeClient();
  const b = fakeClient();
  hub.addClient(a.req, a.res);
  hub.addClient(b.req, b.res);
  assert.equal(hub.broadcast('stroke', { count: 1 }), 2);
  assert.equal(a.res.chunks.at(-1), 'event: stroke\ndata: {"count":1}\n\n');
  assert.equal(b.res.chunks.at(-1), a.res.chunks.at(-1));

  a.req.emit('close');
  assert.equal(hub.clientCount(), 1);
  assert.equal(a.res.ended, true);
  const sizeBefore = a.res.chunks.length;
  hub.broadcast('stroke', { count: 2 });
  assert.equal(a.res.chunks.length, sizeBefore);
  assert.equal(b.res.chunks.at(-1), 'event: stroke\ndata: {"count":2}\n\n');
});

test('a client whose write throws, errors or stalls is dropped without affecting others', () => {
  const hub = H.createHub({ timers: fakeTimers() });
  const broken = fakeClient();
  const stalled = fakeClient();
  const errored = fakeClient();
  const healthy = fakeClient();
  for (const c of [broken, stalled, errored, healthy]) hub.addClient(c.req, c.res);
  broken.res.write = () => {
    throw new Error('EPIPE');
  };
  stalled.res.writableLength = 64 * 1024 * 1024;
  errored.res.emit('error', new Error('reset'));
  hub.broadcast('phone', { connected: true });
  assert.equal(hub.clientCount(), 1);
  assert.equal(healthy.res.chunks.at(-1), 'event: phone\ndata: {"connected":true}\n\n');
});

test('keep-alive comments are sent on the injected interval', () => {
  const timers = fakeTimers();
  const hub = H.createHub({ timers, keepAliveMs: 1234 });
  const { req, res } = fakeClient();
  hub.addClient(req, res);
  assert.equal(timers.handles.length, 1);
  assert.equal(timers.handles[0].ms, 1234);
  timers.handles[0].fn();
  assert.equal(res.chunks.at(-1), ': keep-alive\n\n');
});

test('maxClients is enforced and close ends all clients and the timer', () => {
  const timers = fakeTimers();
  const hub = H.createHub({ timers, maxClients: 1 });
  const a = fakeClient();
  const b = fakeClient();
  assert.equal(hub.addClient(a.req, a.res), true);
  assert.equal(hub.addClient(b.req, b.res), false);
  assert.equal(b.res.status, null);
  hub.close();
  assert.equal(a.res.ended, true);
  assert.equal(hub.clientCount(), 0);
  assert.equal(timers.handles[0].cleared, true);
  const c = fakeClient();
  assert.equal(hub.addClient(c.req, c.res), false);
});
