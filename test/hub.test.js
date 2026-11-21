import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as H from '../server/hub.js';

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

const CFG = { maxBodyBytes: 8 * 1024 * 1024, maxTextChars: 500 };

test('the language and source lists are the product lists', () => {
  assert.deepEqual([...H.LANGS], ['en-IN', 'hi-IN', 'bn-IN', 'od-IN', 'ta-IN']);
  assert.deepEqual([...H.SHOUT_SOURCES], [
    'voice_note', 'text', 'mic', 'phone_mic', 'whatsapp_share', 'whatsapp_desktop', 'watched_folder', 'ingest', 'notch_drop',
  ]);
  assert.deepEqual([...H.SSE_EVENTS], ['state', 'received', 'note', 'phone']);
});

test('initial state is deeply frozen', () => {
  const s = H.initialState({ mode: 'live', startedT: 5 });
  assert.equal(s.mode, 'live');
  assert.equal(s.startedT, 5);
  assert.equal(s.lastNote, null);
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.phone) && Object.isFrozen(s.langs));
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
});

test('withNote stores the note without TTS audio; the payload keeps it', () => {
  const note = { noteId: 'note-1', ttsAudioBase64: 'QUJD', translatedText: 'Hello' };
  const s = H.withNote(H.initialState(), note);
  assert.equal('ttsAudioBase64' in s.lastNote, false);
  assert.equal(s.lastNote.translatedText, 'Hello');
  assert.equal(note.ttsAudioBase64, 'QUJD');
});

test('publicState adds serverT', () => {
  const p = H.publicState(H.initialState(), 777);
  assert.equal(p.serverT, 777);
});

test('formatSse produces a single-line data frame and rejects unknown events', () => {
  assert.equal(H.formatSse('phone', { a: 'x\ny' }), 'event: phone\ndata: {"a":"x\\ny"}\n\n');
  assert.equal(H.formatSse('note', {}), 'event: note\ndata: {}\n\n');
  assert.throws(() => H.formatSse('evil\nevent', {}), TypeError);
  assert.throws(() => H.formatSse('call', {}), TypeError); // old event names are gone
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
  assert.equal(hub.broadcast('note', { noteId: 'note-1' }), 2);
  assert.equal(a.res.chunks.at(-1), 'event: note\ndata: {"noteId":"note-1"}\n\n');
  assert.equal(b.res.chunks.at(-1), a.res.chunks.at(-1));

  a.req.emit('close');
  assert.equal(hub.clientCount(), 1);
  assert.equal(a.res.ended, true);
  const sizeBefore = a.res.chunks.length;
  hub.broadcast('note', { noteId: 'note-2' });
  assert.equal(a.res.chunks.length, sizeBefore);
  assert.equal(b.res.chunks.at(-1), 'event: note\ndata: {"noteId":"note-2"}\n\n');
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

// ---- validateShout ----

test('validateShout: text and audio paths, defaults and the ignored mode', () => {
  const text = H.validateShout({ text: '  vannam  ', targetLang: 'hi-IN' }, CFG);
  assert.equal(text.text, 'vannam');
  assert.equal(text.targetLang, 'hi-IN');
  assert.equal(text.source, 'text');
  assert.equal(text.filename, null);

  const audio = H.validateShout({ audioBase64: 'QUJD', mime: 'audio/ogg', targetLang: 'en-IN', source: 'notch_drop', filename: 'n.opus' }, CFG);
  assert.equal(audio.source, 'notch_drop');
  assert.deepEqual(audio.audio, Buffer.from('QUJD', 'base64'));
  assert.equal(audio.filename, 'n.opus');

  // a legacy `mode` field is accepted and ignored
  const legacy = H.validateShout({ text: 'x', targetLang: 'en-IN', mode: 'translate' }, CFG);
  assert.equal(legacy.text, 'x');

  // audio without a source defaults to mic; data URLs carry their own mime
  const dataUrl = H.validateShout({ audioBase64: `data:audio/mp4;base64,${'QUJD'}`, targetLang: 'en-IN' }, CFG);
  assert.equal(dataUrl.source, 'mic');
  assert.equal(dataUrl.mime, 'audio/mp4');
});

test('validateShout: precise errors for bad input', () => {
  const cases = [
    [{ text: 'go' }, 'invalid_target_lang'],
    [{ text: 'go', targetLang: 'fr-FR' }, 'invalid_target_lang'],
    [{ targetLang: 'en-IN' }, 'missing_input'],
    [{ targetLang: 'en-IN', text: '', audioBase64: '' }, 'missing_input'],
    [{ targetLang: 'en-IN', text: 'go', audioBase64: 'QUJD' }, 'ambiguous_input'],
    [{ targetLang: 'en-IN', text: 7 }, 'invalid_text'],
    [{ targetLang: 'en-IN', text: 'x'.repeat(501) }, 'invalid_text'],
    [{ targetLang: 'en-IN', audioBase64: 'not base64!!' }, 'invalid_audio'],
    [{ targetLang: 'en-IN', audioBase64: 12 }, 'invalid_audio'],
    [{ targetLang: 'en-IN', audioBase64: 'QUJD', mime: 'text/html' }, 'invalid_mime'],
    [{ targetLang: 'en-IN', text: 'x', source: 'carrier_pigeon' }, 'invalid_source'],
    [{ targetLang: 'en-IN', audioBase64: 'QUJD', filename: '../escape.opus' }, 'invalid_filename'],
    [null, 'invalid_body'],
    [[1], 'invalid_body'],
  ];
  for (const [body, code] of cases) {
    try {
      H.validateShout(body, CFG);
      assert.fail(`expected ${code} for ${JSON.stringify(body).slice(0, 60)}`);
    } catch (err) {
      assert.equal(err.name, 'ValidationError');
      assert.equal(err.code, code, JSON.stringify(body).slice(0, 60));
    }
  }
});

test('validatePhone: user agent from body or header, capped at 300 chars', () => {
  const req = { headers: { 'user-agent': 'HeaderUA/2' } };
  assert.equal(H.validatePhone({}, req).userAgent, 'HeaderUA/2');
  assert.equal(H.validatePhone({ userAgent: '  BodyUA  ' }, req).userAgent, '  BodyUA  ');
  assert.equal(H.validatePhone({ userAgent: 'x'.repeat(400) }, req).userAgent.length, 300);
  assert.throws(() => H.validatePhone({ userAgent: 42 }, req), H.ValidationError);
});
