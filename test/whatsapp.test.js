// WhatsApp voice-note routes and helpers: the /share share target, the
// archive export endpoints, the new shout sources, and the ingest CLI.
// A fake Sarvam client is injected — nothing here touches the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.js';
import { createArchive, archiveCsv, archiveJson, CSV_COLUMNS, SOURCES } from '../server/archive.js';
import { main as ingestMain } from '../server/ingest.js';
import { cutOgg, SPEECH_MAX_SECONDS, NOTE_MAX_BYTES } from '../shared/audio-sniff.js';

let rootDir;
before(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'malayalam-notch-wa-'));
  fs.mkdirSync(path.join(rootDir, 'public'), { recursive: true });
});
after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

// ---------- fixtures (same builders as test/audio-sniff.test.js) ----------

function oggPage(granule, payload = Buffer.alloc(20, 0x55)) {
  const head = Buffer.alloc(27);
  head.write('OggS', 0, 'latin1');
  head.writeBigUInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(7, 14);
  head[26] = 1;
  return Buffer.concat([head, Buffer.from([payload.length]), payload]);
}
function whatsappNote(...granules) {
  const bos = Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11, 0)]);
  return Buffer.concat([oggPage(0n, bos), ...granules.map((g) => oggPage(g))]);
}
function wav(seconds, byteRate = 4000) {
  const dataBytes = Math.round(seconds * byteRate);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(4 + 8 + 16 + 8 + dataBytes, 4);
  riff.write('WAVE', 8, 'latin1');
  const fmtHead = Buffer.alloc(8);
  fmtHead.write('fmt ', 0, 'latin1');
  fmtHead.writeUInt32LE(16, 4);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(8000, 4);
  fmt.writeUInt32LE(byteRate, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const dataHead = Buffer.alloc(8);
  dataHead.write('data', 0, 'latin1');
  dataHead.writeUInt32LE(dataBytes, 4);
  return Buffer.concat([riff, fmtHead, fmt, dataHead, Buffer.alloc(dataBytes)]);
}

function multipartBody(filename, data, { field = 'media', contentType = 'audio/ogg' } = {}) {
  const boundary = 'WaBoundaryX7';
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    body: Buffer.concat([Buffer.from(head, 'latin1'), data, Buffer.from(tail, 'latin1')]),
    type: `multipart/form-data; boundary=${boundary}`,
  };
}

// ---------- test server (fake translator, real HTTP) ----------

function fakeTimers() {
  const list = [];
  const add = (kind) => (fn, ms) => {
    const h = { kind, fn, ms, cleared: false };
    list.push(h);
    return h;
  };
  const clear = (h) => { if (h) h.cleared = true; };
  return {
    list,
    api: { setTimeout: add('timeout'), clearTimeout: clear, setInterval: add('interval'), clearInterval: clear },
    fireTimeouts() {
      for (const h of list.filter((x) => x.kind === 'timeout' && !x.cleared && !x.fired)) {
        h.fired = true;
        h.fn();
      }
    },
  };
}

async function start(overrides = {}) {
  const clock = { t: 1_000_000 };
  const timers = fakeTimers();
  const calls = { stt: [], translate: [] };
  const sarvam = {
    stt: async (args) => {
      calls.stt.push(args);
      const text = args.mode === 'transcribe' ? 'വേഗത്തില്‍ പോവുക' : args.mode === 'translit' ? 'vegam povuka' : ' Move faster! ';
      return { text, language: 'ml-IN', source: 'live', latencyMs: 120 };
    },
    translate: async (args) => {
      calls.translate.push(args);
      return { text: ' Move faster! ', language: 'ml-IN', source: 'live', latencyMs: 120 };
    },
    speak: async () => ({ audioBase64: 'QUJD', mime: 'audio/wav', source: 'live', latencyMs: 80 }),
    ...overrides.sarvam,
  };
  const app = createServer({
    sarvam,
    now: () => clock.t,
    timers: timers.api,
    qr: async () => '<svg/>',
    config: { rootDir, mode: 'replay', lanAddresses: [], watchDirs: ['/tmp/inbox-a', '/tmp/inbox-b'], ...overrides.config },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  return { app, port, clock, timers, calls, archive: app.archive, stop: () => app.close() };
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

// ---------- shout sources ----------

test('the WhatsApp-era sources are accepted and archived; a bogus source is rejected', async () => {
  const t = await start();
  try {
    for (const source of ['whatsapp_desktop', 'watched_folder', 'ingest', 'phone_mic', 'whatsapp_share']) {
      const res = await request(t.port, {
        method: 'POST', path: '/api/shout',
        headers: { 'Content-Type': 'application/json' },
        body: { text: 'move faster', targetLang: 'en-IN', source },
      });
      assert.equal(res.status, 200, `${source}: ${res.text}`);
      assert.equal(res.json.ok, true);
    }
    const bad = await request(t.port, {
      method: 'POST', path: '/api/shout',
      headers: { 'Content-Type': 'application/json' },
      body: { text: 'move faster', targetLang: 'en-IN', source: 'carrier_pigeon' },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'invalid_source');
    assert.deepEqual(
      t.archive.list({ limit: 5 }).map((e) => e.source).sort(),
      ['ingest', 'phone_mic', 'watched_folder', 'whatsapp_desktop', 'whatsapp_share'],
    );
  } finally {
    await t.stop();
  }
});

test('the archive stores the Sarvam language code — a language id, never a dialect claim', async () => {
  const t = await start();
  try {
    const res = await request(t.port, {
      method: 'POST', path: '/api/shout',
      headers: { 'Content-Type': 'application/json' },
      body: { audioBase64: whatsappNote(48000).toString('base64'), mime: 'audio/ogg;codecs=opus', filename: 'PTT-20261121-WA0001.opus', source: 'whatsapp_desktop', targetLang: 'en-IN' },
    });
    assert.equal(res.status, 200);
    const entry = t.archive.list()[0];
    assert.equal(entry.language, 'ml-IN'); // exactly the code Sarvam reported
    assert.equal(entry.filename, 'PTT-20261121-WA0001.opus');
    assert.equal(entry.source, 'whatsapp_desktop');
    // the shout path passed the fake stt real bytes, once per mode
    assert.equal(t.calls.stt.length, 3);
    assert.deepEqual(t.calls.stt[0].audio, whatsappNote(48000));
    assert.equal(t.calls.stt[0].mime, 'audio/ogg;codecs=opus');
  } finally {
    await t.stop();
  }
});

// ---------- /share share target ----------

test('POST /share: a WhatsApp voice note is heard and the answer is a small page', async () => {
  const t = await start();
  try {
    const note = whatsappNote(48000);
    const { body, type } = multipartBody('PTT-20261121-WA0001.opus', note);
    const res = await request(t.port, { method: 'POST', path: '/share', headers: { 'Content-Type': type }, body });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /Voice note heard/);
    assert.match(res.text, /Move faster!/); // the translation spelled out for a human
    assert.match(res.text, /Malayalam/);
    assert.equal(t.calls.stt.length, 3); // transcribe + translit + translate in parallel
    assert.deepEqual(t.calls.stt[0].audio, note);
    assert.equal(t.calls.stt[0].mime, 'audio/ogg;codecs=opus'); // sniffed mime, not the part header
    assert.equal(t.archive.list()[0].source, 'whatsapp_share');
  } finally {
    await t.stop();
  }
});

test('POST /share: wrong content type, no file part and non-audio bytes get plain pages', async () => {
  const t = await start();
  try {
    const wrong = await request(t.port, { method: 'POST', path: '/share', headers: { 'Content-Type': 'application/json' }, body: { a: 1 } });
    assert.equal(wrong.status, 400);
    assert.match(wrong.text, /No file shared/);

    const empty = multipartBody('clip.opus', Buffer.alloc(0));
    const noFile = await request(t.port, { method: 'POST', path: '/share', headers: { 'Content-Type': empty.type }, body: empty.body });
    assert.equal(noFile.status, 400);
    assert.match(noFile.text, /No audio file/);

    const notAudio = multipartBody('letter.txt', Buffer.from('dear diary, definitely not audio'));
    const bad = await request(t.port, { method: 'POST', path: '/share', headers: { 'Content-Type': notAudio.type }, body: notAudio.body });
    assert.equal(bad.status, 200);
    assert.match(bad.text, /Not an audio file/);
    assert.match(bad.text, /letter\.txt/);
    assert.equal(t.calls.stt.length, 0); // never reached the translator
  } finally {
    await t.stop();
  }
});

test('POST /share: over 5 MB and unrecognised-but-huge files are refused before any work', async () => {
  const t = await start();
  try {
    const big = multipartBody('long.opus', Buffer.alloc(NOTE_MAX_BYTES + 1));
    const res = await request(t.port, { method: 'POST', path: '/share', headers: { 'Content-Type': big.type }, body: big.body });
    assert.equal(res.status, 200);
    assert.match(res.text, /Note too large/);
    assert.equal(t.calls.stt.length, 0);
  } finally {
    await t.stop();
  }
});

test('POST /share: a long Ogg note offers a lossless "first 30 s" cut, and /share/cut sends it', async () => {
  const t = await start();
  try {
    const note = whatsappNote(48000 * 10, 48000 * 20, 48000 * 40); // ~40 s
    const { body, type } = multipartBody('long-note.opus', note);
    const res = await request(t.port, { method: 'POST', path: '/share', headers: { 'Content-Type': type }, body });
    assert.equal(res.status, 200);
    assert.match(res.text, /Note too long/);
    assert.match(res.text, /Use the first 30 seconds/);
    const token = /name="token" value="([a-f0-9]{20})"/.exec(res.text)[1];
    assert.equal(t.calls.stt.length, 0); // nothing sent yet

    const cut = await request(t.port, {
      method: 'POST', path: '/share/cut',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${token}`,
    });
    assert.equal(cut.status, 200);
    assert.match(cut.text, /Voice note heard/);
    assert.match(cut.text, /first 30 s/);
    assert.equal(t.calls.stt.length, 3);
    assert.deepEqual(t.calls.stt[0].audio, cutOgg(note, SPEECH_MAX_SECONDS));

    // the token is spent: a second use reports the offer is gone
    const again = await request(t.port, {
      method: 'POST', path: '/share/cut',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${token}`,
    });
    assert.match(again.text, /Offer expired/);
    assert.equal(t.calls.stt.length, 3);
  } finally {
    await t.stop();
  }
});

test('POST /share: a long WAV cannot be cut — honest page, no offer; stale tokens expire', async () => {
  const t = await start();
  try {
    const { body, type } = multipartBody('long.wav', wav(45));
    const res = await request(t.port, { method: 'POST', path: '/share', headers: { 'Content-Type': type }, body });
    assert.equal(res.status, 200);
    assert.match(res.text, /Note too long/);
    assert.match(res.text, /Send a shorter note/);
    assert.doesNotMatch(res.text, /Use the first 30 seconds/);
    assert.equal(t.calls.stt.length, 0);

    const dead = await request(t.port, {
      method: 'POST', path: '/share/cut',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'token=deadbeefdeadbeef0000',
    });
    assert.equal(dead.status, 200);
    assert.match(dead.text, /Offer expired/);
  } finally {
    await t.stop();
  }
});

// ---------- archive export ----------

test('archiveCsv/archiveJson: commas, quotes and line breaks are escaped; no audio inside', () => {
  const archive = createArchive();
  archive.add({ source: 'text', text: 'plain' }); // older entry: list() is newest first
  archive.add({
    time: 1_700_000_000_000, source: 'whatsapp_desktop', filename: 'note,"x".opus',
    language: 'ml-IN', text: 'move "faster",\nnow', transcript: 'വേഗം', roman: 'vegam',
  });
  const csv = archiveCsv(archive.list());
  const [head] = csv.split('\n');
  assert.equal(head, CSV_COLUMNS.join(','));
  // every problematic cell is quoted; inner quotes are doubled (a quoted cell
  // may itself contain a newline — match the text, not the physical lines)
  assert.match(csv, /"note,""x""\.opus"/);
  assert.match(csv, /"move ""faster"",\nnow"/);
  assert.match(csv, /,text,,,,,plain$/m); // the plain entry has no quoted cells
  const exported = JSON.parse(archiveJson(archive.list()));
  assert.equal(exported.entries.length, 2);
  assert.ok(typeof exported.exportedAt === 'string');
  assert.equal(exported.entries[0].text, 'move "faster",\nnow');
  assert.equal(exported.entries[0].roman, 'vegam');
  for (const e of exported.entries) assert.ok(!('audio' in e) && !('audioBase64' in e));
});

test('GET /api/archive.csv and /api/archive.json download the archive as files', async () => {
  const t = await start();
  try {
    await request(t.port, {
      method: 'POST', path: '/api/shout',
      headers: { 'Content-Type': 'application/json' },
      body: { text: 'move faster', targetLang: 'en-IN', source: 'watched_folder', filename: 'w.opus' },
    });
    const csv = await request(t.port, { path: '/api/archive.csv' });
    assert.equal(csv.status, 200);
    assert.match(csv.headers['content-type'], /text\/csv/);
    assert.match(csv.headers['content-disposition'], /attachment.*malayalam-notes\.csv/);
    const lines = csv.text.split('\n').filter(Boolean);
    assert.equal(lines[0], CSV_COLUMNS.join(','));
    assert.match(lines[1], /watched_folder,w\.opus,ml-IN/);

    const json = await request(t.port, { path: '/api/archive.json' });
    assert.equal(json.status, 200);
    assert.match(json.headers['content-disposition'], /malayalam-notes\.json/);
    const data = JSON.parse(json.text);
    assert.equal(data.entries[0].source, 'watched_folder');
    assert.equal(data.entries[0].filename, 'w.opus');
  } finally {
    await t.stop();
  }
});

test('GET /api/providers lists the watched folders; the SOURCES list stays in sync', async () => {
  const t = await start();
  try {
    const res = await request(t.port, { path: '/api/providers' });
    assert.deepEqual(res.json.watchDirs, ['/tmp/inbox-a', '/tmp/inbox-b']);
    assert.deepEqual(SOURCES, ['voice_note', 'text', 'mic', 'phone_mic', 'whatsapp_share', 'whatsapp_desktop', 'watched_folder', 'ingest', 'notch_drop']);
  } finally {
    await t.stop();
  }
});

// ---------- ingest CLI ----------

const collect = () => { const out = []; return { lines: out, fn: (l) => out.push(l) }; };

test('ingest CLI: a WhatsApp voice note is posted to the running shout path', async () => {
  const note = whatsappNote(48000);
  const file = path.join(rootDir, 'PTT-20261121-WA0002.opus');
  fs.writeFileSync(file, note);
  let posted = null;
  const out = collect(); const err = collect();
  const code = await ingestMain([file, '--lang=hi-IN', '--port=4321'], {
    fetchImpl: async (url, req) => {
      posted = { url, req };
      return { ok: true, status: 200, json: async () => ({ ok: true, translatedText: 'Move faster!', sourceText: 'വേഗം', romanText: 'vegam', detectedLanguage: 'ml-IN' }) };
    },
    say: out.fn, fail: err.fn,
  });
  assert.equal(code, 0);
  assert.equal(posted.url, 'http://127.0.0.1:4321/api/shout');
  const payload = JSON.parse(posted.req.body);
  assert.equal(payload.source, 'ingest');
  assert.equal(payload.targetLang, 'hi-IN');
  assert.equal(payload.filename, 'PTT-20261121-WA0002.opus');
  assert.equal(payload.mime, 'audio/ogg;codecs=opus');
  assert.deepEqual(Buffer.from(payload.audioBase64, 'base64'), note);
  assert.match(out.lines[0], /Move faster!/);
  assert.match(out.lines.join('\n'), /malayalam: വേഗം/);
  assert.match(out.lines.join('\n'), /romanised: vegam/);
  assert.match(out.lines.join('\n'), /lang: ml-IN/);
  assert.deepEqual(err.lines, []);
});

test('ingest CLI: refuses missing files, non-audio, over-size and over-length notes; never posts', async () => {
  const nonAudio = path.join(rootDir, 'notes.txt');
  fs.writeFileSync(nonAudio, 'not audio');
  const tooBig = path.join(rootDir, 'big.opus');
  fs.writeFileSync(tooBig, Buffer.alloc(NOTE_MAX_BYTES + 1));
  const tooLong = path.join(rootDir, 'long.opus');
  fs.writeFileSync(tooLong, whatsappNote(48000 * 60));

  let fetches = 0;
  const deps = () => ({
    fetchImpl: async () => { fetches += 1; return { ok: true, status: 200, json: async () => ({}) }; },
    say: () => {}, fail: (l) => { deps.lastFail = l; },
  });
  const runs = [
    [['/no/such/file.opus'], /cannot read/],
    [[nonAudio], /not a recognised audio file/],
    [[tooBig], /5 MB/],
    [[tooLong], /60 s.*30 s/],
    [[nonAudio, '--lang=fr-FR'], /--lang must be/],
    [[], /usage/],
  ];
  for (const [argv, pattern] of runs) {
    deps.lastFail = null;
    const code = await ingestMain(argv, deps());
    assert.equal(code, 2, String(argv));
  }
  assert.equal(fetches, 0);
});

test('ingest CLI: an unreachable server is 1, a server error is 1 with the sanitized message', async () => {
  const file = path.join(rootDir, 'ok.opus');
  fs.writeFileSync(file, whatsappNote(48000));
  const err = collect();
  const down = await ingestMain([file], {
    fetchImpl: async () => { throw Object.assign(new Error('conn'), { code: 'ECONNREFUSED' }); },
    say: () => {}, fail: err.fn,
  });
  assert.equal(down, 1);
  assert.match(err.lines[0], /could not reach the server.*ECONNREFUSED.*npm start/s);

  const err2 = collect();
  const failed = await ingestMain([file], {
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: { message: 'bad shout' } }) }),
    say: () => {}, fail: err2.fn,
  });
  assert.equal(failed, 1);
  assert.match(err2.lines[0], /shout failed: bad shout/);
});
