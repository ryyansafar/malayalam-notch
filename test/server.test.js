import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.js';
import { createQrRenderer, validateQrUrl, matrixToSvg, landingPage, QR_URL_MAX } from '../server/qr.js';
import { parseEnv, loadEnvFile, resolveConfig, lanAddresses, bannerLines, ConfigError } from '../server/env.js';

const FAKE_KEY = 'not-a-real-key-fixture-123';
let rootDir;

before(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'malayalam-notch-test-'));
  fs.mkdirSync(path.join(rootDir, 'public', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'shared'));
  fs.mkdirSync(path.join(rootDir, 'server'));
  fs.writeFileSync(path.join(rootDir, 'public', 'app.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(rootDir, 'public', 'app.css'), 'body{}\n');
  fs.writeFileSync(path.join(rootDir, 'public', 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(rootDir, 'public', 'dashboard.html'), '<!doctype html><title>dash</title>');
  fs.writeFileSync(path.join(rootDir, 'public', 'data.bin'), 'binary');
  fs.writeFileSync(path.join(rootDir, 'public', '.hidden.js'), 'HIDDEN');
  fs.writeFileSync(path.join(rootDir, 'public', 'sub', 'deep.js'), 'export const d = 1;\n');
  fs.writeFileSync(path.join(rootDir, 'shared', 'x.js'), 'export const s = 1;\n');
  fs.writeFileSync(path.join(rootDir, 'server', 'secret.js'), 'TOP-SECRET');
  fs.writeFileSync(path.join(rootDir, '.env'), 'SARVAM_API_KEY=TOP-SECRET\n');
  fs.symlinkSync(path.join(rootDir, 'server', 'secret.js'), path.join(rootDir, 'public', 'link.js'));
});
after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

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
    fireIntervals: (ms) => list.filter((h) => h.kind === 'interval' && !h.cleared && h.ms === ms).forEach((h) => h.fn()),
  };
}

// A fake Sarvam that answers all three Saaras modes plus typed translation and TTS.
function fakeSarvam(calls, overrides = {}) {
  const STT_TEXT = { transcribe: ' വേഗത്തില്‍ പോവുക ', translit: ' vegam povuka ', translate: ' Move faster! ' };
  return {
    stt: async (args) => {
      calls.stt.push(args);
      return { text: STT_TEXT[args.mode] ?? ' x ', language: 'ml-IN', source: 'live', latencyMs: 120 };
    },
    translate: async (args) => {
      calls.translate.push(args);
      if (args.sourceLang === 'en-IN') return { text: ' तेज़ चलाओ ', language: 'en-IN', source: 'live', latencyMs: 30 };
      return { text: ' Move faster! ', language: 'ml-IN', source: 'live', latencyMs: 120 };
    },
    speak: async (args) => {
      calls.speak.push(args);
      return { audioBase64: 'QUJD', mime: 'audio/wav', source: 'live', latencyMs: 80 };
    },
    ...overrides,
  };
}

async function start(overrides = {}) {
  const clock = { t: 1_000_000 };
  const timers = fakeTimers();
  const calls = { stt: [], translate: [], speak: [] };
  const sarvam = fakeSarvam(calls, overrides.sarvam);
  const logs = [];
  const app = createServer({
    sarvam, smallest: overrides.smallest ?? null, now: () => clock.t, timers: timers.api, log: (l) => logs.push(l),
    qr: overrides.qr || (async (url) => `<svg data-url="${encodeURIComponent(url)}"/>`),
    config: { rootDir, mode: 'replay', lanAddresses: [], ...overrides.config },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  return { app, port, clock, timers, calls, logs, stop: () => app.close() };
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
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

// Minimal SSE reader: collects parsed events and comments, resolves waiters as frames arrive.
function openEvents(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, (res) => {
      const events = [];
      const comments = [];
      let waiters = [];
      let buffer = '';
      const check = () => {
        waiters = waiters.filter((w) => {
          const hit = w.pred();
          if (hit) w.resolve(hit);
          return !hit;
        });
      };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let cut = buffer.indexOf('\n\n');
        while (cut !== -1) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const event = /^event: (.+)$/m.exec(frame);
          const data = /^data: (.+)$/m.exec(frame);
          if (event && data) events.push({ event: event[1], data: JSON.parse(data[1]) });
          else if (frame.startsWith(':')) comments.push(frame);
          cut = buffer.indexOf('\n\n');
        }
        check();
      });
      const waitFor = (pred) => new Promise((ok, fail) => {
        const timer = setTimeout(() => fail(new Error('timed out waiting for SSE frame')), 2000);
        waiters.push({ pred, resolve: (v) => { clearTimeout(timer); ok(v); } });
        check();
      });
      resolve({
        res, events, comments,
        next: (name, n = 1) => waitFor(() => {
          const hits = events.filter((e) => e.event === name);
          return hits.length >= n ? hits[n - 1].data : null;
        }),
        waitFor,
        ended: new Promise((done) => res.on('end', done).on('close', done)),
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });
}

// ---------- pages, static files, traversal ----------

test('GET / shows the QR, the desk link and the mode badge', async () => {
  const s = await start();
  try {
    const r = await request(s.port, { headers: { Host: 'example-laptop.local:8443' } });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.match(r.text, /REPLAY/);
    assert.match(r.text, /href="\/dashboard"/);
    assert.match(r.text, /Malayalam in the notch/);
    assert.match(r.text, /language, not a dialect/);
    assert.ok(r.text.includes(`/qr.svg?url=${encodeURIComponent('http://example-laptop.local:8443/phone')}`));
    const evil = await request(s.port, { headers: { Host: 'x"><script>alert(1)</script>' } });
    assert.equal(evil.text.includes('<script>'), false);
  } finally {
    await s.stop();
  }
});

test('landing behind an HTTPS tunnel points the QR at the https tunnel address', async () => {
  const s = await start();
  try {
    const r = await request(s.port, { headers: { Host: 'some-words.trycloudflare.com', 'X-Forwarded-Proto': 'https' } });
    assert.ok(r.text.includes(`/qr.svg?url=${encodeURIComponent('https://some-words.trycloudflare.com/phone')}`));
    assert.equal(r.text.includes('Served over HTTP'), false);
    const plain = await request(s.port, { headers: { Host: 'some-words.trycloudflare.com' } });
    assert.ok(plain.text.includes(`/qr.svg?url=${encodeURIComponent('http://some-words.trycloudflare.com/phone')}`));
    assert.match(plain.text, /Served over HTTP/);
  } finally {
    await s.stop();
  }
});

test('landing prefers a LAN address over localhost and shows LIVE when live', async () => {
  const s = await start({ config: { mode: 'live', lanAddresses: ['192.168.1.20'] } });
  try {
    const r = await request(s.port);
    assert.ok(r.text.includes(`http://192.168.1.20:${s.port}/phone`));
    assert.match(r.text, /badge live">LIVE</);
  } finally {
    await s.stop();
  }
});

test('/dashboard is served when present; /phone gives a clear 404 page when missing', async () => {
  const s = await start();
  try {
    const dash = await request(s.port, { path: '/dashboard' });
    assert.equal(dash.status, 200);
    assert.match(dash.headers['content-type'], /^text\/html/);
    assert.match(dash.text, /<title>dash<\/title>/);
    const phone = await request(s.port, { path: '/phone' });
    assert.equal(phone.status, 404);
    assert.match(phone.text, /public\/phone\.html is missing/);
  } finally {
    await s.stop();
  }
});

test('static files get the right MIME types from /public and /shared', async () => {
  const s = await start();
  try {
    const cases = [
      ['/public/app.js', /^text\/javascript/], ['/shared/x.js', /^text\/javascript/], ['/public/sub/deep.js', /^text\/javascript/],
      ['/public/app.css', /^text\/css/], ['/public/dashboard.html', /^text\/html/], ['/public/pic.svg', /^image\/svg\+xml/],
      ['/app.js', /^text\/javascript/],
    ];
    for (const [p, type] of cases) {
      const r = await request(s.port, { path: p });
      assert.equal(r.status, 200, p);
      assert.match(r.headers['content-type'], type, p);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
    }
    const head = await request(s.port, { method: 'HEAD', path: '/public/app.js' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(head.headers['content-length'], String('export const a = 1;\n'.length));
  } finally {
    await s.stop();
  }
});

test('no directory traversal, no dotfiles, no symlink escape, no listing, no unknown types', async () => {
  const s = await start();
  try {
    const attempts = [
      '/public/../server/secret.js', '/public/%2e%2e/server/secret.js', '/public/..%2fserver%2fsecret.js',
      '/public/%2e%2e%2f%2e%2e%2fetc/passwd', '/shared/../.env', '/public/..%5cserver%5csecret.js', '/public/sub/../../server/secret.js',
      '/public/%00.js', '/public/.hidden.js', '/public/link.js', '/public//app.js', '/../server/secret.js', '/.env', '/%2e%2e%2fserver%2fsecret.js',
      '/public/', '/public/sub', '/public/sub/', '/shared/', '/public/data.bin', '/public/missing.js', '/public/%E0%A4%A.js', '/server/secret.js',
    ];
    for (const p of attempts) {
      const r = await request(s.port, { path: p });
      assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.equal(/TOP-SECRET|HIDDEN|binary/.test(r.text), false, p);
      assert.equal(/deep\.js|app\.css/.test(r.text), false, `${p} must not list files`);
    }
  } finally {
    await s.stop();
  }
});

test('unknown routes and wrong methods get clear errors', async () => {
  const s = await start();
  try {
    const api = await request(s.port, { path: '/api/nope' });
    assert.equal(api.status, 404);
    assert.equal(api.json.error.code, 'not_found');
    const page = await request(s.port, { path: '/nope' });
    assert.equal(page.status, 404);
    assert.match(page.headers['content-type'], /^text\/html/);
    const wrong = await request(s.port, { method: 'GET', path: '/api/shout' });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.allow, 'POST');
    const del = await request(s.port, { method: 'DELETE', path: '/api/state' });
    assert.equal(del.status, 405);
    assert.equal((await post(s.port, '/public/app.js', {})).status, 405);
  } finally {
    await s.stop();
  }
});

// ---------- QR ----------

test('/qr.svg validates the url parameter and returns SVG', async () => {
  const s = await start();
  try {
    const ok = await request(s.port, { path: `/qr.svg?url=${encodeURIComponent('http://192.168.1.5:3000/phone')}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'image/svg+xml');
    assert.ok(ok.text.includes(encodeURIComponent('http://192.168.1.5:3000/phone')));
    const long = `http://a.test/${'x'.repeat(QR_URL_MAX)}`;
    const badOnes = ['/qr.svg', '/qr.svg?url=', '/qr.svg?url=javascript%3Aalert(1)', '/qr.svg?url=ftp%3A%2F%2Fa.test', '/qr.svg?url=not-a-url', `/qr.svg?url=${encodeURIComponent(long)}`];
    for (const p of badOnes) {
      const r = await request(s.port, { path: p });
      assert.equal(r.status, 400, p);
      assert.equal(r.json.error.code, 'invalid_url');
      assert.match(r.json.error.message, /url/);
    }
  } finally {
    await s.stop();
  }
});

test('/qr.svg reports 503 when the generator is unavailable', async () => {
  const s = await start({ qr: createQrRenderer(async () => { throw new Error('Cannot find package'); }) });
  try {
    const r = await request(s.port, { path: '/qr.svg?url=http%3A%2F%2Fa.test%2Fphone' });
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'qr_unavailable');
  } finally {
    await s.stop();
  }
});

test('qr helpers: validation, SVG path, renderer with an injected generator', async () => {
  assert.deepEqual(validateQrUrl('https://a.test/phone'), { ok: true, url: 'https://a.test/phone' });
  assert.equal(validateQrUrl(null).ok, false);
  assert.equal(validateQrUrl('data:text/html,hi').ok, false);
  const svg = matrixToSvg(2, (r, c) => r === c, { margin: 1 });
  assert.match(svg, /viewBox="0 0 4 4"/);
  assert.match(svg, /d="M1 1h1v1h-1zM2 2h1v1h-1z"/);
  const seen = [];
  const fakeModule = { default: (type, level) => ({ addData: (d) => seen.push([type, level, d]), make: () => {}, getModuleCount: () => 1, isDark: () => true }) };
  const render = createQrRenderer(async () => fakeModule);
  assert.match(await render('http://a.test/'), /^<svg /);
  assert.deepEqual(seen, [[0, 'M', 'http://a.test/']]);
  assert.equal(landingPage({ phoneUrl: 'http://a.test/phone?x=<b>', mode: 'replay', https: false }).includes('<b>'), false);
});

test('real qrcode-generator renders a scannable-size matrix when installed', async (t) => {
  try {
    await import('qrcode-generator');
  } catch {
    t.skip('qrcode-generator is not installed yet');
    return;
  }
  const svg = await createQrRenderer()('http://192.168.1.5:3000/phone');
  assert.match(svg, /^<svg xmlns/);
  assert.ok(svg.length > 500);
});

// ---------- state, phone, SSE ----------

test('GET /api/state returns the public state shape', async () => {
  const s = await start();
  try {
    const r = await request(s.port, { path: '/api/state' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.json.mode, 'replay');
    assert.deepEqual(r.json.phone, { connected: false, lastSeenT: null, userAgent: null });
    assert.equal(r.json.lastNote, null);
    assert.equal(r.json.notesToday, 0);
    assert.deepEqual(r.json.langs, ['en-IN', 'hi-IN', 'bn-IN', 'od-IN', 'ta-IN']);
    assert.equal(r.json.serverT, s.clock.t);
  } finally {
    await s.stop();
  }
});

test('SSE delivers the initial state, phone events and keep-alive comments', async () => {
  const s = await start({ config: { keepAliveMs: 4321 } });
  const sse = await openEvents(s.port);
  try {
    assert.match(sse.res.headers['content-type'], /^text\/event-stream/);
    const initial = await sse.next('state');
    assert.equal(initial.mode, 'replay');

    const hello = await post(s.port, '/api/phone', { userAgent: 'TestPhone/1.0' });
    assert.equal(hello.status, 200);
    const phone = await sse.next('phone');
    assert.deepEqual(phone, { connected: true, lastSeenT: s.clock.t, userAgent: 'TestPhone/1.0' });

    s.timers.fireIntervals(4321);
    await sse.waitFor(() => sse.comments.length > 0);
    assert.equal(sse.comments[0], ': keep-alive');
  } finally {
    sse.close();
    await s.stop();
  }
});

test('SSE clients are cleaned up on disconnect and ended on shutdown', async () => {
  const s = await start();
  const a = await openEvents(s.port);
  const b = await openEvents(s.port);
  await a.next('state');
  await b.next('state');
  assert.equal(s.app.hub.clientCount(), 2);
  a.close();
  for (let i = 0; i < 100 && s.app.hub.clientCount() !== 1; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.app.hub.clientCount(), 1);
  await s.stop();
  await b.ended;
  assert.equal(s.app.hub.clientCount(), 0);
  assert.ok(s.timers.list.filter((h) => h.kind === 'interval').every((h) => h.cleared));
});

test('phone is marked disconnected after heartbeats stop', async () => {
  const s = await start({ config: { phoneTimeoutMs: 10000 } });
  const sse = await openEvents(s.port);
  try {
    await post(s.port, '/api/phone', {}, { 'User-Agent': 'HeaderUA/2' });
    assert.equal((await sse.next('phone')).userAgent, 'HeaderUA/2');
    s.clock.t += 9000;
    s.timers.fireIntervals(5000);
    assert.equal(s.app.hub.getState().phone.connected, true);
    s.clock.t += 2000;
    s.timers.fireIntervals(5000);
    assert.equal((await sse.next('phone', 2)).connected, false);
  } finally {
    sse.close();
    await s.stop();
  }
});

test('POST bodies are validated with precise 400 errors', async () => {
  const s = await start();
  try {
    const cases = [
      ['/api/phone', '{not json', 'invalid_json'], ['/api/phone', '', 'empty_body'], ['/api/phone', '[1]', 'invalid_body'],
      ['/api/phone', { userAgent: 42 }, 'invalid_user_agent'],
      ['/api/shout', { text: 'go' }, 'invalid_target_lang'], ['/api/shout', { text: 'go', targetLang: 'fr-FR' }, 'invalid_target_lang'],
      ['/api/shout', { targetLang: 'hi-IN' }, 'missing_input'], ['/api/shout', { targetLang: 'hi-IN', text: '', audioBase64: '' }, 'missing_input'],
      ['/api/shout', { targetLang: 'hi-IN', text: 'go', audioBase64: 'QUJD' }, 'ambiguous_input'],
      ['/api/shout', { targetLang: 'hi-IN', text: 7 }, 'invalid_text'], ['/api/shout', { targetLang: 'hi-IN', text: 'x'.repeat(501) }, 'invalid_text'],
      ['/api/shout', { targetLang: 'hi-IN', audioBase64: 'not base64!!' }, 'invalid_audio'], ['/api/shout', { targetLang: 'hi-IN', audioBase64: 12 }, 'invalid_audio'],
      ['/api/shout', { targetLang: 'hi-IN', audioBase64: 'QUJD', mime: 'text/html' }, 'invalid_mime'],
      ['/api/shout', { text: 'x', targetLang: 'hi-IN', ttsProvider: 'nonsense' }, 'invalid_tts_provider'],
      ['/api/shout', 'null', 'invalid_body'],
      ['/api/speak', { targetLang: 'hi-IN' }, 'invalid_text'], ['/api/speak', { text: 'hi', targetLang: 'fr-FR' }, 'invalid_target_lang'],
    ];
    for (const [p, body, code] of cases) {
      const r = await post(s.port, p, body);
      assert.equal(r.status, 400, `${p} ${code}`);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.error.code, code, `${p} ${JSON.stringify(body).slice(0, 60)}`);
      assert.ok(r.json.error.message.length > 5);
      assert.equal(/\bat .*\.js:\d+/.test(r.text), false, 'no stack trace');
    }
    assert.equal(s.calls.translate.length, 0);
  } finally {
    await s.stop();
  }
});

test('body limit: declared and streamed oversize bodies get 413', async () => {
  const s = await start();
  const small = await start({ config: { maxBodyBytes: 1024 } });
  try {
    const declared = await post(s.port, '/api/phone', '{}', { 'Content-Length': String(8 * 1024 * 1024 + 1) }).catch((e) => e);
    // the server answers before reading; a reset while we are still "sending" is also acceptable
    if (!(declared instanceof Error)) {
      assert.equal(declared.status, 413);
      assert.equal(declared.json.error.code, 'body_too_large');
    }
    const streamed = await post(small.port, '/api/shout', JSON.stringify({ targetLang: 'hi-IN', text: 'x'.repeat(5000) }), { 'Transfer-Encoding': 'chunked' });
    assert.equal(streamed.status, 413);
    assert.equal(streamed.json.error.code, 'body_too_large');
    assert.equal(small.calls.translate.length, 0);
    const within = await post(small.port, '/api/phone', { userAgent: 'ok' });
    assert.equal(within.status, 200);
  } finally {
    await s.stop();
    await small.stop();
  }
});

// ---------- shout flow ----------

test('audio shout: three Saaras modes run in parallel and fill the card fields', async () => {
  const s = await start();
  const sse = await openEvents(s.port);
  try {
    const audioBase64 = Buffer.from('fake-audio-bytes').toString('base64');
    const r = await post(s.port, '/api/shout', {
      audioBase64, mime: 'audio/webm;codecs=opus', targetLang: 'hi-IN',
      source: 'notch_drop', filename: 'PTT-1.opus', mode: 'translate', // mode is ignored
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.noteId, 'note-1');
    assert.equal(r.json.input, 'audio');
    assert.equal(r.json.origin, 'notch_drop');
    assert.equal(r.json.filename, 'PTT-1.opus');
    assert.equal(r.json.sourceText, 'വേഗത്തില്‍ പോവുക');
    assert.equal(r.json.romanText, 'vegam povuka');
    assert.equal(r.json.translatedText, 'Move faster!');
    assert.equal(r.json.detectedLanguage, 'ml-IN');
    assert.equal(r.json.status, 'ok');
    assert.deepEqual(r.json.failedOps, []);
    assert.equal(r.json.ttsAudioBase64, 'QUJD');
    assert.equal(r.json.ttsAvailable, true);

    // same bytes, same mime, one call per mode — all three fired
    assert.equal(s.calls.stt.length, 3);
    assert.deepEqual(s.calls.stt.map((c) => c.mode).sort(), ['transcribe', 'translate', 'translit']);
    for (const c of s.calls.stt) {
      assert.deepEqual(c.audio, Buffer.from('fake-audio-bytes'));
      assert.equal(c.mime, 'audio/webm;codecs=opus');
      assert.equal(c.sourceLang, 'ml-IN');
    }

    // hi-IN target: translation was re-translated en-IN -> hi-IN before TTS
    assert.deepEqual(s.calls.speak, [{ text: 'तेज़ चलाओ', targetLang: 'hi-IN' }]);
    assert.equal(r.json.spokenText, 'तेज़ चलाओ');
    assert.equal(r.json.spokenLang, 'hi-IN');

    const received = await sse.next('received');
    assert.equal(received.noteId, 'note-1');
    assert.equal(received.filename, 'PTT-1.opus');
    const note = await sse.next('note');
    assert.equal(note.noteId, 'note-1');
    assert.equal(note.translatedText, 'Move faster!');
    const state = await sse.next('state', 2);
    assert.equal(state.lastNote.noteId, 'note-1');
    assert.equal(state.notesToday, 1);
    assert.equal('ttsAudioBase64' in state.lastNote, false, 'audio is never stored in state');
  } finally {
    sse.close();
    await s.stop();
  }
});

test('audio shout: one failed mode leaves the others in place', async () => {
  const s = await start({
    sarvam: {
      stt: async ({ mode }) => {
        if (mode === 'translit') throw new Error('translit down');
        return { text: mode === 'transcribe' ? 'വാചകം' : 'A sentence', language: 'ml-IN', source: 'live', latencyMs: 10 };
      },
    },
  });
  try {
    const r = await post(s.port, '/api/shout', {
      audioBase64: 'QUJD', mime: 'audio/ogg', targetLang: 'en-IN',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.sourceText, 'വാചകം');
    assert.equal(r.json.romanText, null);
    assert.equal(r.json.translatedText, 'A sentence');
    assert.deepEqual(r.json.failedOps, ['translit']);
    assert.deepEqual(r.json.sources.translit, null);
  } finally {
    await s.stop();
  }
});

test('audio shout: all three modes failing is a 502, and no note is archived', async () => {
  const s = await start({
    sarvam: { stt: async () => { throw new Error('dead'); } },
  });
  try {
    const r = await post(s.port, '/api/shout', { audioBase64: 'QUJD', mime: 'audio/ogg', targetLang: 'en-IN' });
    assert.equal(r.status, 502);
    const entries = s.app.archive.list();
    assert.equal(entries.length, 0);
    const lastNote = s.app.hub.getState().lastNote;
    assert.equal(lastNote.status, 'error');
    assert.equal(lastNote.error.code, 'transcribe_failed');
  } finally {
    await s.stop();
  }
});

test('audio shout: a client without stt still gets the English translation', async () => {
  const s = await start({
    sarvam: {
      stt: undefined,
      translate: async (args) => ({ text: args.audio ? 'English only' : 'x', language: 'ml-IN', source: 'live', latencyMs: 5 }),
      speak: async () => ({ audioBase64: 'QUJD', mime: 'audio/wav', source: 'live', latencyMs: 5 }),
    },
  });
  try {
    const r = await post(s.port, '/api/shout', { audioBase64: 'QUJD', mime: 'audio/ogg', targetLang: 'en-IN' });
    assert.equal(r.status, 200);
    assert.equal(r.json.translatedText, 'English only');
    assert.equal(r.json.sourceText, null);
    assert.equal(r.json.romanText, null);
    assert.deepEqual(r.json.failedOps.sort(), ['transcribe', 'translit']);
  } finally {
    await s.stop();
  }
});

test('text shout: the typed Malayalam is kept as sourceText and spoken back', async () => {
  const s = await start();
  try {
    const r = await post(s.port, '/api/shout', { text: '  ഇത് ഒരു പരീക്ഷണമാണ്  ', targetLang: 'hi-IN' });
    assert.equal(r.status, 200);
    assert.equal(r.json.input, 'text');
    assert.equal(r.json.sourceText, 'ഇത് ഒരു പരീക്ഷണമാണ്');
    assert.equal(r.json.romanText, null);
    assert.equal(r.json.translatedText, 'Move faster!');
    assert.equal(r.json.detectedLanguage, 'ml-IN');
    assert.equal(s.calls.stt.length, 0);
    assert.deepEqual(s.calls.translate[0], { text: 'ഇത് ഒരു പരീക്ഷണമാണ്', sourceLang: 'ml-IN' });
    assert.deepEqual(s.calls.speak, [{ text: 'तेज़ चलाओ', targetLang: 'hi-IN' }]);
    assert.equal(s.app.archive.list()[0].source, 'text');
    assert.equal(s.app.archive.list()[0].transcript, 'ഇത് ഒരു പരീക്ഷണമാണ്');
  } finally {
    await s.stop();
  }
});

test('audio shout passes a Buffer and mime to stt; data URLs are accepted', async () => {
  const s = await start();
  try {
    const audioBase64 = Buffer.from('fake-audio-bytes').toString('base64');
    const r = await post(s.port, '/api/shout', { audioBase64, mime: 'audio/webm;codecs=opus', targetLang: 'ta-IN' });
    assert.equal(r.status, 200);
    assert.equal(r.json.input, 'audio');
    const sent = s.calls.stt[0];
    assert.ok(Buffer.isBuffer(sent.audio));
    assert.equal(sent.audio.toString(), 'fake-audio-bytes');
    assert.equal(sent.mime, 'audio/webm;codecs=opus');
    assert.equal('text' in sent, false);
    assert.equal(s.calls.speak[0].targetLang, 'ta-IN');

    const r2 = await post(s.port, '/api/shout', { audioBase64: `data:audio/mp4;base64,${audioBase64}`, targetLang: 'en-IN' });
    assert.equal(r2.status, 200);
    assert.equal(s.calls.stt[3].mime, 'audio/mp4');
    assert.equal(s.calls.stt[3].audio.toString(), 'fake-audio-bytes');
  } finally {
    await s.stop();
  }
});

test('replay is stated whenever any part was replayed', async () => {
  const s = await start({
    sarvam: { speak: async () => ({ audioBase64: 'QUJD', mime: 'audio/wav', source: 'replay', latencyMs: 1 }) },
  });
  try {
    const r = await post(s.port, '/api/shout', { text: 'x', targetLang: 'od-IN' });
    assert.equal(r.json.source, 'replay');
    assert.equal(r.json.sources.speak, 'replay');
  } finally {
    await s.stop();
  }
});

test('upstream failures: 503 for missing replay, 502 otherwise, and nothing sensitive leaks', async () => {
  const noReplay = Object.assign(new Error(`no cache for key ${FAKE_KEY}`), { name: 'NoReplayAvailable' });
  const s1 = await start({ sarvam: { translate: async () => { throw noReplay; } } });
  const s2 = await start({ sarvam: { translate: async () => { throw new Error(`401 for ${FAKE_KEY}`); } } });
  try {
    const r1 = await post(s1.port, '/api/shout', { text: 'x', targetLang: 'hi-IN' });
    assert.equal(r1.status, 503);
    assert.equal(r1.json.error.code, 'no_replay_available');
    assert.match(r1.json.error.message, /REPLAY/);
    const r2 = await post(s2.port, '/api/shout', { text: 'x', targetLang: 'hi-IN' });
    assert.equal(r2.status, 502);
    assert.equal(r2.json.error.code, 'translate_failed');
    for (const [r, s] of [[r1, s1], [r2, s2]]) {
      assert.equal(r.text.includes(FAKE_KEY), false);
      assert.equal(s.logs.join('\n').includes(FAKE_KEY), false);
      assert.equal(/\bat .*:\d+:\d+/.test(r.text), false);
    }
    // the in-flight guard is released after a failure
    assert.equal((await post(s2.port, '/api/shout', { text: 'x', targetLang: 'hi-IN' })).status, 502);
  } finally {
    await s1.stop();
    await s2.stop();
  }
});

test('speech failure still delivers the note, marked as having no audio', async () => {
  const s = await start({ sarvam: { speak: async () => { throw new Error('tts down'); } } });
  try {
    const r = await post(s.port, '/api/shout', { text: 'x', targetLang: 'hi-IN' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ttsAvailable, false);
    assert.equal(r.json.ttsAudioBase64, null);
    assert.equal(r.json.translatedText, 'Move faster!');
    assert.equal(r.json.sources.speak, null);
  } finally {
    await s.stop();
  }
});

test('a failed re-translation means no speech rather than the wrong language', async () => {
  const s = await start({
    sarvam: {
      translate: async ({ sourceLang }) => {
        if (sourceLang === 'en-IN') throw new Error('downstream down');
        return { text: 'English text', language: 'ml-IN', source: 'live', latencyMs: 5 };
      },
    },
  });
  try {
    const r = await post(s.port, '/api/shout', { text: 'x', targetLang: 'hi-IN' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ttsAvailable, false);
    assert.equal(r.json.spokenText, null);
    assert.deepEqual(r.json.failedOps, ['speak_translate']);
    assert.equal(s.calls.speak.length, 0);
  } finally {
    await s.stop();
  }
});

test('concurrent shouts get 429 and the guard is released after the first finishes', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await start({
    sarvam: {
      translate: async (args) => {
        if (args.text === 'hold') await gate;
        return { text: 'done', language: 'ml-IN', source: 'live', latencyMs: 1 };
      },
    },
  });
  try {
    const first = post(s.port, '/api/shout', { text: 'hold', targetLang: 'en-IN' });
    for (let i = 0; i < 200 && s.calls.translate.length < 1; i += 1) await new Promise((r) => setTimeout(r, 2));
    const busy = await post(s.port, '/api/shout', { text: 'other', targetLang: 'en-IN' });
    assert.equal(busy.status, 429);
    assert.equal(busy.json.error.code, 'busy');
    release();
    assert.equal((await first).status, 200);
  } finally {
    release();
    await s.stop();
  }
});

test('POST /api/speak re-speaks stored text in the chosen language', async () => {
  const s = await start();
  try {
    const r = await post(s.port, '/api/speak', { text: 'Move faster!', targetLang: 'hi-IN' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ttsAudioBase64, 'QUJD');
    assert.equal(r.json.spokenLang, 'hi-IN');
    assert.equal(r.json.spokenText, 'तेज़ चलाओ');
    assert.equal(r.json.ttsProvider, 'sarvam');
    assert.deepEqual(s.calls.translate[0], { text: 'Move faster!', sourceLang: 'en-IN', targetLang: 'hi-IN' });

    const en = await post(s.port, '/api/speak', { text: 'Move faster!', targetLang: 'en-IN' });
    assert.equal(en.status, 200);
    assert.equal(en.json.spokenText, 'Move faster!');
    assert.equal(s.calls.translate.length, 1); // English is not re-translated
  } finally {
    await s.stop();
  }
});

test('ttsProvider "smallest" speaks through the injected client', async () => {
  const spoke = [];
  const smallest = {
    speak: async (args) => {
      spoke.push(args);
      return { audioBase64: 'U01T', mime: 'audio/wav', source: 'live', latencyMs: 7 };
    },
    mode: 'live',
  };
  const s = await start({ smallest });
  try {
    const r = await post(s.port, '/api/shout', { text: 'x', targetLang: 'en-IN', ttsProvider: 'smallest' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ttsAudioBase64, 'U01T');
    assert.equal(r.json.ttsProvider, 'smallest');
    assert.deepEqual(spoke, [{ text: 'Move faster!', targetLang: 'en-IN' }]);
    const bad = await post(s.port, '/api/shout', { text: 'x', targetLang: 'en-IN', ttsProvider: 'smallest', mime: null });
    assert.equal(bad.status, 200);
  } finally {
    await s.stop();
  }
});

test('ttsProvider "smallest" without a configured client is a clear 400', async () => {
  const s = await start();
  try {
    const r = await post(s.port, '/api/shout', { text: 'x', targetLang: 'en-IN', ttsProvider: 'smallest' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'tts_provider_unavailable');
  } finally {
    await s.stop();
  }
});

// ---------- env loader, config, banner ----------

test('parseEnv handles comments, quotes, export and malformed lines', () => {
  const parsed = parseEnv(['# comment', '', 'A=1', 'export B = two ', 'C="x y # z"', "D='q'", 'E=val # trailing', 'bad line', '=nokey', '1X=no', 'F='].join('\r\n'));
  assert.deepEqual(parsed, { A: '1', B: 'two', C: 'x y # z', D: 'q', E: 'val', F: '' });
});

test('loadEnvFile applies without overriding and returns only names', () => {
  const file = path.join(rootDir, 'test.env');
  fs.writeFileSync(file, `SARVAM_API_KEY=${FAKE_KEY}\nPORT=4000\n`);
  const env = { PORT: '5000' };
  const applied = loadEnvFile(file, env);
  assert.deepEqual(applied, ['SARVAM_API_KEY']);
  assert.equal(env.PORT, '5000');
  assert.equal(env.SARVAM_API_KEY, FAKE_KEY);
  assert.deepEqual(loadEnvFile(path.join(rootDir, 'absent.env'), {}), []);
});

test('resolveConfig validates and never returns the key', () => {
  assert.deepEqual(resolveConfig({}), { port: 3000, requestedMode: 'auto', mode: 'replay', apiKeyPresent: false, certFile: '', keyFile: '', https: false });
  const live = resolveConfig({ SARVAM_API_KEY: FAKE_KEY, PORT: '8443', CERT_FILE: 'c.pem', KEY_FILE: 'k.pem' });
  assert.equal(live.mode, 'live');
  assert.equal(live.https, true);
  assert.equal(JSON.stringify(live).includes(FAKE_KEY), false);
  assert.equal(resolveConfig({ SARVAM_API_KEY: FAKE_KEY, SARVAM_MODE: 'REPLAY' }).mode, 'replay');
  for (const env of [{ PORT: 'abc' }, { PORT: '70000' }, { PORT: '-1' }, { SARVAM_MODE: 'fast' }, { CERT_FILE: 'c.pem' }, { KEY_FILE: 'k.pem' }]) {
    assert.throws(() => resolveConfig(env), ConfigError);
  }
});

test('banner prints LAN URLs and the mode but never a secret', () => {
  const addresses = lanAddresses({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], en0: [{ family: 'IPv4', internal: false, address: '10.0.0.7' }, { family: 'IPv6', internal: false, address: 'fe80::1' }] });
  assert.deepEqual(addresses, ['10.0.0.7']);
  const conf = resolveConfig({ SARVAM_API_KEY: FAKE_KEY });
  const text = bannerLines({ ...conf, port: 3000, addresses }).join('\n');
  assert.match(text, /LIVE/);
  assert.match(text, /malayalam-notch/);
  assert.match(text, /http:\/\/10\.0\.0\.7:3000\/phone/);
  assert.match(text, /SARVAM_API_KEY set/);
  assert.equal(text.includes(FAKE_KEY), false);
  const replay = bannerLines({ ...resolveConfig({ SARVAM_MODE: 'live' }), port: 1, addresses: [] }).join('\n');
  assert.match(replay, /SARVAM_API_KEY is not set/);
  assert.match(replay, /no LAN address/);
});
