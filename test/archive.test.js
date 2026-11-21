// Tests for the voice-note inbox plumbing: the archive store, the
// mime-from-extension helper, GET /api/archive, and the /api/shout path that
// files every heard call. No network, no keys.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArchive, ARCHIVE_MAX } from '../server/archive.js';
import { mimeFromName } from '../shared/audio-mime.js';
import { createServer } from '../server/index.js';

let tmp;
let fileSeq = 0;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'malayalam-notch-archive-'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const nextFile = () => path.join(tmp, `archive-${fileSeq++}.jsonl`);

// ---------- archive store ----------

test('archive store: add assigns ids, lists newest first, searches, round-trips the file', () => {
  const file = nextFile();
  const a = createArchive({ file, now: () => 1_700_000_000_000 });

  const e1 = a.add({ text: 'move faster', transcript: 'വേഗത്തില്‍ പോവുക', roman: 'vegam povuka', language: 'ml-IN', source: 'voice_note', filename: 'PTT-1.opus' });
  const e2 = a.add({ text: 'hold water', language: 'ml-IN', source: 'text' });
  assert.equal(e1.id, 'e-1');
  assert.equal(e2.id, 'e-2');
  assert.equal(e1.transcript, 'വേഗത്തില്‍ പോവുക');
  assert.equal(e1.roman, 'vegam povuka');
  assert.equal(e2.transcript, null);
  assert.equal(e2.filename, null);
  assert.equal(e1.time, 1_700_000_000_000);

  assert.deepEqual(a.list().map((e) => e.id), ['e-2', 'e-1']); // newest first
  assert.deepEqual(a.list({ q: 'faster' }).map((e) => e.id), ['e-1']);
  assert.deepEqual(a.list({ q: 'HOLD' }).map((e) => e.id), ['e-2']); // case-insensitive
  assert.deepEqual(a.list({ q: 'ml-in' }).map((e) => e.id), ['e-2', 'e-1']); // language searched
  assert.deepEqual(a.list({ q: 'PTT' }).map((e) => e.id), ['e-1']); // filename searched
  assert.deepEqual(a.list({ q: 'povuka' }).map((e) => e.id), ['e-1']); // romanised text searched
  assert.deepEqual(a.list({ q: 'nothing' }), []);

  // persistence round trip: a fresh store on the same file sees everything
  const b = createArchive({ file });
  assert.equal(b.size, 2);
  assert.equal(b.list({ q: 'faster' })[0].transcript, 'വേഗത്തില്‍ പോവുക');
  const e3 = b.add({ text: 'stop', source: 'mic' });
  assert.equal(e3.id, 'e-3'); // ids keep counting after a reload

  const raw = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(raw.length, 3);
  assert.equal(raw.every((l) => !l.includes('audioBase64')), true);
});

test('archive store: caps at maxEntries and drops the oldest; bad input is sanitized', () => {
  const file = nextFile();
  const a = createArchive({ file, maxEntries: 3 });
  for (let i = 1; i <= 5; i += 1) a.add({ text: `note ${i}` });
  assert.equal(a.size, 3);
  assert.deepEqual(a.list().map((e) => e.text), ['note 5', 'note 4', 'note 3']);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3);

  const odd = a.add({ text: 'x', source: 'carrier_pigeon', surprise: 'rigged', filename: 7 });
  assert.equal(odd.source, 'text');
  assert.equal(odd.filename, null);
  assert.equal('surprise' in odd, false); // unknown fields are never stored
});

test('archive store: countToday counts only entries since local midnight', () => {
  const noon = new Date('2026-11-22T12:00:00').getTime();
  const a = createArchive({ file: null });
  a.add({ text: 'old', time: noon - 24 * 3600 * 1000 });
  a.add({ text: 'new', time: noon });
  assert.equal(a.countToday(noon), 1);
});

test('archive store: in-memory mode writes nothing and survives a corrupt line on load', () => {
  const mem = createArchive({ file: null });
  mem.add({ text: 'x' });
  assert.equal(mem.size, 1);
  assert.equal(mem.file, null);

  const file = nextFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"id":"e-4","text":"old"}\nnot json at all\n{"missing":"id"}\n');
  const logs = [];
  const a = createArchive({ file, log: (l) => logs.push(l) });
  assert.equal(a.size, 1);
  assert.equal(a.list()[0].id, 'e-4');
  assert.equal(a.add({ text: 'y' }).id, 'e-5'); // sequence continues past loaded ids
  assert.ok(logs.length >= 1);
});

// ---------- mime from extension ----------

test('mimeFromName: extension fills in when the browser reports nothing useful', () => {
  assert.equal(mimeFromName('PTT-20261121-WA0001.opus', ''), 'audio/ogg;codecs=opus');
  assert.equal(mimeFromName('note.OGG'), 'audio/ogg');
  assert.equal(mimeFromName('clip.m4a', ''), 'audio/mp4');
  assert.equal(mimeFromName('song.mp3', null), 'audio/mpeg');
  assert.equal(mimeFromName('a.wav'), 'audio/wav');
  assert.equal(mimeFromName('a.webm', 'application/octet-stream'), 'audio/webm'); // generic type: extension wins
  assert.equal(mimeFromName('note.opus', 'audio/ogg'), 'audio/ogg'); // a real audio type is trusted
  assert.equal(mimeFromName('note.opus', 'audio/webm;codecs=opus'), 'audio/webm;codecs=opus');
  assert.equal(mimeFromName('mystery.bin'), 'audio/ogg'); // unknown extension falls back to the WhatsApp container
  assert.equal(mimeFromName('noext'), 'audio/ogg');
});

// ---------- server: /api/archive + archived shout flow ----------

function fakeTimers() {
  const list = [];
  const add = (kind) => (fn, ms) => {
    const h = { kind, fn, ms, cleared: false };
    list.push(h);
    return h;
  };
  const clear = (h) => {
    if (h) h.cleared = true;
  };
  return {
    list,
    api: { setTimeout: add('timeout'), clearTimeout: clear, setInterval: add('interval'), clearInterval: clear },
    pendingTimeouts: () => list.filter((h) => h.kind === 'timeout' && !h.cleared && !h.fired),
    fireTimeouts() {
      for (const h of this.pendingTimeouts()) {
        h.fired = true;
        h.fn();
      }
    },
  };
}

async function start(overrides = {}) {
  const clock = { t: 1_000_000 };
  const timers = fakeTimers();
  const sarvam = {
    stt: async ({ mode }) => ({
      text: mode === 'transcribe' ? 'വേഗത്തില്‍ പോവുക' : mode === 'translit' ? 'vegam povuka' : 'Move faster!',
      language: 'ml-IN', source: 'live', latencyMs: 10,
    }),
    translate: async () => ({ text: 'Move faster!', language: 'ml-IN', source: 'live', latencyMs: 10 }),
    speak: async () => ({ audioBase64: 'QUJD', mime: 'audio/wav', source: 'live', latencyMs: 5 }),
    ...overrides.sarvam,
  };
  const file = nextFile();
  const archive = overrides.archive === undefined ? createArchive({ file, now: () => clock.t }) : overrides.archive;
  const app = createServer({
    sarvam, archive, now: () => clock.t, timers: timers.api,
    qr: async () => '<svg/>', log: () => {},
    config: { rootDir: tmp, mode: 'replay', lanAddresses: [], ...overrides.config },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  return { app, port, clock, timers, archive, file, stop: () => app.close() };
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload || undefined);
  });
}
const post = (port, p, body, headers) => request(port, { method: 'POST', path: p, body, headers });

test('a dropped voice note is archived with its name, language and the three texts', async () => {
  const s = await start();
  try {
    const audioBase64 = Buffer.from('fake-opus-bytes').toString('base64');
    const r = await post(s.port, '/api/shout', {
      audioBase64, mime: 'audio/ogg;codecs=opus', filename: 'PTT-20261121.opus', source: 'voice_note', targetLang: 'hi-IN',
    });
    assert.equal(r.status, 200);

    const before = (await request(s.port, { path: '/api/archive' })).json;
    assert.equal(before.ok, true);
    assert.equal(before.entries.length, 1);
    const e = before.entries[0];
    assert.equal(e.source, 'voice_note');
    assert.equal(e.filename, 'PTT-20261121.opus');
    assert.equal(e.language, 'ml-IN');
    assert.equal(e.text, 'Move faster!');
    assert.equal(e.transcript, 'വേഗത്തില്‍ പോവുക');
    assert.equal(e.roman, 'vegam povuka');
    assert.equal('audioBase64' in e, false);
    assert.equal('audio' in e, false);

    // search hits on translation, transcript, filename and language
    assert.equal((await request(s.port, { path: '/api/archive?q=faster' })).json.entries.length, 1);
    assert.equal((await request(s.port, { path: '/api/archive?q=povuka' })).json.entries.length, 1);
    assert.equal((await request(s.port, { path: '/api/archive?q=ptt' })).json.entries.length, 1);
    assert.equal((await request(s.port, { path: '/api/archive?q=ml-in' })).json.entries.length, 1);
    assert.equal((await request(s.port, { path: '/api/archive?q=zzz' })).json.entries.length, 0);

    // the file on disk carries no audio and no keys; a fresh store reloads it
    const raw = fs.readFileSync(s.file, 'utf8');
    assert.equal(raw.includes('fake-opus-bytes'), false);
    assert.equal(raw.includes('QUJD'), false);
    const reloaded = createArchive({ file: s.file });
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.list()[0].roman, 'vegam povuka');
  } finally {
    await s.stop();
  }
});

test('sources: typed shouts archive as text, recordings as mic', async () => {
  const s = await start();
  try {
    await post(s.port, '/api/shout', { text: 'povuka', targetLang: 'en-IN' });
    await post(s.port, '/api/shout', { audioBase64: 'QUJD', mime: 'audio/webm', targetLang: 'en-IN' }); // no source -> mic
    const entries = (await request(s.port, { path: '/api/archive' })).json.entries;
    assert.equal(entries.length, 2); // newest first
    assert.equal(entries[0].source, 'mic');
    assert.equal(entries[1].source, 'text');
    assert.equal(entries[1].transcript, 'povuka'); // typed text is kept as the transcript
  } finally {
    await s.stop();
  }
});

test('archive input validation: bad source and bad filename are 400; a failed translation archives nothing', async () => {
  const s = await start();
  const failing = await start({
    sarvam: { translate: async () => { throw new Error('upstream down'); } },
  });
  try {
    const audioBase64 = Buffer.from('x').toString('base64');
    const badSource = await post(s.port, '/api/shout', { audioBase64, filename: 'a.opus', source: 'pigeon', targetLang: 'en-IN' });
    assert.equal(badSource.status, 400);
    assert.equal(badSource.json.error.code, 'invalid_source');
    const badName = await post(s.port, '/api/shout', { audioBase64, filename: '../escape.opus', targetLang: 'en-IN' });
    assert.equal(badName.status, 400);
    assert.equal(badName.json.error.code, 'invalid_filename');
    assert.equal((await request(s.port, { path: '/api/archive' })).json.entries.length, 0);

    const failed = await post(failing.port, '/api/shout', { text: 'x', targetLang: 'en-IN' });
    assert.equal(failed.status, 502);
    assert.equal((await request(failing.port, { path: '/api/archive' })).json.entries.length, 0);

    const wrongMethod = await post(s.port, '/api/archive', {});
    assert.equal(wrongMethod.status, 405);
  } finally {
    await s.stop();
    await failing.stop();
  }
});

test('the archive cap is 500 entries', () => {
  assert.equal(ARCHIVE_MAX, 500);
});
