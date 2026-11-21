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
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowing-call-test-'));
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
  fs.writeFileSync(path.join(rootDir, 'shared', 'stroke.js'), 'export const s = 1;\n');
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

async function start(overrides = {}) {
  const clock = { t: 1_000_000 };
  const timers = fakeTimers();
  const calls = { translate: [], speak: [], match: [], evaluate: [] };
  const sarvam = {
    translate: async (args) => {
      calls.translate.push(args);
      return { text: ' Row faster! ', source: 'live', latencyMs: 120 };
    },
    speak: async (args) => {
      calls.speak.push(args);
      return { audioBase64: 'QUJD', mime: 'audio/wav', source: 'live', latencyMs: 80 };
    },
    ...overrides.sarvam,
  };
  const matchMeaning = overrides.matchMeaning || ((text) => {
    calls.match.push(text);
    return /faster/i.test(text) ? { meaning: 'speed_up', confidence: 'high', matchedKeyword: 'faster' } : { meaning: null, confidence: 'none' };
  });
  const evaluate = overrides.evaluate || ((args) => {
    calls.evaluate.push(args);
    return { obeyed: true, strokesUntilObeyed: 2, deltaSpm: 6, reason: 'rate rose' };
  });
  const logs = [];
  const app = createServer({
    sarvam, matchMeaning, evaluate, now: () => clock.t, timers: timers.api, log: (l) => logs.push(l),
    qr: overrides.qr || (async (url) => `<svg data-url="${encodeURIComponent(url)}"/>`),
    config: { rootDir, mode: 'replay', lanAddresses: [], windowMs: 8000, graceMs: 750, ...overrides.config },
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

const strokes = (...rows) => ({ events: rows.map(([t, rateSpm, count]) => ({ type: 'stroke', t, rateSpm, count })) });

// ---------- pages, static files, traversal ----------

test('GET / shows the QR, the dashboard link, the mode badge and the UNVERIFIED notice', async () => {
  const s = await start();
  try {
    const r = await request(s.port, { headers: { Host: 'example-laptop.local:8443' } });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.match(r.text, /REPLAY/);
    assert.match(r.text, /href="\/dashboard"/);
    assert.ok(r.text.includes(`/qr.svg?url=${encodeURIComponent('http://example-laptop.local:8443/phone')}`));
    assert.match(r.text, /UNVERIFIED/);
    assert.match(r.text, /not race equipment/);
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
      ['/public/app.js', /^text\/javascript/], ['/shared/stroke.js', /^text\/javascript/], ['/public/sub/deep.js', /^text\/javascript/],
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

// ---------- state, phone, strokes, SSE ----------

test('GET /api/state returns the public state shape', async () => {
  const s = await start();
  try {
    const r = await request(s.port, { path: '/api/state' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.json.mode, 'replay');
    assert.deepEqual(r.json.phone, { connected: false, lastSeenT: null, userAgent: null, simulated: false });
    assert.deepEqual(r.json.trials, []);
    assert.deepEqual(r.json.tally, { obeyed: 0, notObeyed: 0, notSure: 0, total: 0 });
    assert.deepEqual(r.json.langs, ['en-IN', 'hi-IN', 'bn-IN', 'od-IN', 'ta-IN']);
    assert.equal(r.json.callsVerified, false);
    assert.equal(r.json.serverT, s.clock.t);
    assert.equal('strokes' in r.json, false);
  } finally {
    await s.stop();
  }
});

test('SSE delivers the initial state, phone and stroke events, and keep-alive comments', async () => {
  const s = await start({ config: { keepAliveMs: 4321 } });
  const sse = await openEvents(s.port);
  try {
    assert.match(sse.res.headers['content-type'], /^text\/event-stream/);
    const initial = await sse.next('state');
    assert.equal(initial.mode, 'replay');

    const hello = await post(s.port, '/api/phone', { userAgent: 'TestPhone/1.0', motion: 'simulated' });
    assert.equal(hello.status, 200);
    const phone = await sse.next('phone');
    assert.deepEqual(phone, { connected: true, lastSeenT: s.clock.t, userAgent: 'TestPhone/1.0', simulated: true });

    s.clock.t += 500;
    const batch = await post(s.port, '/api/stroke', strokes([5000, 20, 1], [5300, 24.5, 2]));
    assert.deepEqual(batch.json, { ok: true, accepted: 2 });
    const second = await sse.next('stroke', 2);
    const first = await sse.next('stroke', 1);
    // newest event is anchored to the server clock; spacing is preserved
    assert.deepEqual(second, { type: 'stroke', t: s.clock.t, phoneT: 5300, rateSpm: 24.5, count: 2, simulated: false });
    assert.equal(first.t, s.clock.t - 300);

    s.timers.fireIntervals(4321);
    await sse.waitFor(() => sse.comments.length > 0);
    assert.equal(sse.comments[0], ': keep-alive');

    const state = (await request(s.port, { path: '/api/state' })).json;
    assert.equal(state.stroke.count, 2);
    assert.equal(state.recentStrokes.length, 2);
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
      ['/api/stroke', { nope: 1 }, 'invalid_events'], ['/api/stroke', { events: ['x'] }, 'invalid_event'],
      ['/api/stroke', { events: [{ t: 'now', rateSpm: 20, count: 1 }] }, 'invalid_event'],
      ['/api/stroke', { events: [{ type: 'tap', t: 1, rateSpm: 20, count: 1 }] }, 'invalid_event'],
      ['/api/stroke', { events: [{ t: 1, rateSpm: -5, count: 1 }] }, 'invalid_event'],
      ['/api/stroke', { events: [{ t: 1, rateSpm: 20, count: 1.5 }] }, 'invalid_event'],
      ['/api/stroke', { events: Array.from({ length: 201 }, (_, i) => ({ t: i, rateSpm: 20, count: i })) }, 'too_many_events'],
      ['/api/shout', { text: 'go' }, 'invalid_target_lang'], ['/api/shout', { text: 'go', targetLang: 'fr-FR' }, 'invalid_target_lang'],
      ['/api/shout', { targetLang: 'hi-IN' }, 'missing_input'], ['/api/shout', { targetLang: 'hi-IN', text: '', audioBase64: '' }, 'missing_input'],
      ['/api/shout', { targetLang: 'hi-IN', text: 'go', audioBase64: 'QUJD' }, 'ambiguous_input'],
      ['/api/shout', { targetLang: 'hi-IN', text: 7 }, 'invalid_text'], ['/api/shout', { targetLang: 'hi-IN', text: 'x'.repeat(501) }, 'invalid_text'],
      ['/api/shout', { targetLang: 'hi-IN', audioBase64: 'not base64!!' }, 'invalid_audio'], ['/api/shout', { targetLang: 'hi-IN', audioBase64: 12 }, 'invalid_audio'],
      ['/api/shout', { targetLang: 'hi-IN', audioBase64: 'QUJD', mime: 'text/html' }, 'invalid_mime'],
      ['/api/shout', 'null', 'invalid_body'],
    ];
    for (const [p, body, code] of cases) {
      const r = await post(s.port, p, body);
      assert.equal(r.status, 400, `${p} ${code}`);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.error.code, code, `${p} ${JSON.stringify(body).slice(0, 60)}`);
      assert.ok(r.json.error.message.length > 5);
      assert.equal(/\bat .*\.js:\d+/.test(r.text), false, 'no stack trace');
    }
    assert.match((await post(s.port, '/api/stroke', { events: [{ t: 1, rateSpm: 20, count: -1 }] })).json.error.message, /events\[0\]\.count/);
    assert.equal(s.calls.translate.length, 0);
    assert.equal(s.app.hub.getState().strokes.length, 0);
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

test('full shout flow: translate, match, speak, call, observe window, evaluate, result, trial table', async () => {
  const s = await start();
  const sse = await openEvents(s.port);
  try {
    await post(s.port, '/api/stroke', strokes([100, 22, 7]));
    s.clock.t += 1000;
    const r = await post(s.port, '/api/shout', { text: '  vegam  ', targetLang: 'hi-IN' });
    assert.equal(r.status, 200);
    const callT = s.clock.t;
    assert.deepEqual(s.calls.translate, [{ text: 'vegam', sourceLang: 'ml-IN' }]);
    assert.deepEqual(s.calls.match, ['Row faster!']);
    assert.deepEqual(s.calls.speak, [{ text: 'तेज़ चलाओ', targetLang: 'hi-IN' }]);
    assert.equal(r.json.status, 'ok');
    assert.equal(r.json.meaning, 'speed_up');
    assert.equal(r.json.confidence, 'high');

    const call = await sse.next('call');
    assert.deepEqual(call, {
      callId: 'call-1', targetLang: 'hi-IN', input: 'text', translatedText: 'Row faster!', confidence: 'high', matchedKeyword: 'faster',
      t: callT, meaning: 'speed_up', spokenText: 'तेज़ चलाओ', status: 'ok', ttsAudioBase64: 'QUJD', mime: 'audio/wav', ttsAvailable: true,
      source: 'live', sources: { translate: 'live', speak: 'live' }, latencyMs: 200, baselineSpm: 22, windowMs: 8000,
      ttsProvider: 'sarvam', tts: { provider: 'sarvam', latencyMs: 80, source: 'live' },
    });

    // the window is driven by the injected timer: nothing is judged until it fires
    assert.equal(s.timers.pendingTimeouts().length, 1);
    assert.equal(s.timers.pendingTimeouts()[0].ms, 8750);
    assert.equal(s.calls.evaluate.length, 0);

    s.clock.t += 2000;
    await post(s.port, '/api/stroke', strokes([3000, 26, 8], [4000, 30, 9]));
    s.clock.t += 7000; // callT + 9000: outside the 8000 ms window
    await post(s.port, '/api/stroke', strokes([9000, 31, 10]));
    s.timers.fireTimeouts();

    const result = await sse.next('result');
    assert.equal(s.calls.evaluate.length, 1);
    const args = s.calls.evaluate[0];
    assert.equal(args.meaning, 'speed_up');
    assert.equal(args.callT, callT);
    assert.equal(args.baselineSpm, 22);
    assert.equal(args.windowMs, 8000);
    assert.deepEqual(args.events.map((e) => [e.t - callT, e.rateSpm, e.count]), [[1000, 26, 8], [2000, 30, 9]]);
    assert.ok(args.events.every((e) => e.type === 'stroke'));

    assert.equal(result.callId, 'call-1');
    assert.equal(result.outcome, 'obeyed');
    assert.equal(result.obeyed, true);
    assert.equal(result.strokesUntilObeyed, 2);
    assert.equal(result.deltaSpm, 6);
    assert.equal(result.source, 'live');
    assert.equal(result.strokesObserved, 2);
    assert.equal(result.stage, 'obedience');
    assert.equal('ttsAudioBase64' in result, false);

    const state = await sse.next('state', 2);
    assert.equal(state.trials.length, 1);
    assert.deepEqual(state.tally, { obeyed: 1, notObeyed: 0, notSure: 0, total: 1 });
    assert.equal(state.lastResult.callId, 'call-1');
    assert.equal(JSON.stringify(state).includes('QUJD'), false, 'audio is never stored in state');
    assert.equal(s.timers.pendingTimeouts().length, 0);
  } finally {
    sse.close();
    await s.stop();
  }
});

test('audio shout passes a Buffer and mime to translate; data URLs are accepted', async () => {
  const s = await start();
  try {
    const audioBase64 = Buffer.from('fake-audio-bytes').toString('base64');
    const r = await post(s.port, '/api/shout', { audioBase64, mime: 'audio/webm;codecs=opus', targetLang: 'ta-IN' });
    assert.equal(r.status, 200);
    assert.equal(r.json.input, 'audio');
    const sent = s.calls.translate[0];
    assert.ok(Buffer.isBuffer(sent.audio));
    assert.equal(sent.audio.toString(), 'fake-audio-bytes');
    assert.equal(sent.mime, 'audio/webm;codecs=opus');
    assert.equal(sent.sourceLang, 'ml-IN');
    assert.equal('text' in sent, false);
    assert.equal(s.calls.speak[0].targetLang, 'ta-IN');

    const r2 = await post(s.port, '/api/shout', { audioBase64: `data:audio/mp4;base64,${audioBase64}`, targetLang: 'en-IN' });
    assert.equal(r2.status, 200);
    assert.equal(s.calls.translate[1].mime, 'audio/mp4');
    assert.equal(s.calls.translate[1].audio.toString(), 'fake-audio-bytes');
  } finally {
    await s.stop();
  }
});

test('not_sure: no speech, no observation window, result broadcast and trial recorded', async () => {
  const s = await start({ sarvam: { translate: async () => ({ text: 'the weather is nice', source: 'replay', latencyMs: 3 }) } });
  const sse = await openEvents(s.port);
  try {
    const r = await post(s.port, '/api/shout', { text: 'enthokke', targetLang: 'bn-IN' });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'not_sure');
    assert.equal(r.json.meaning, null);
    assert.equal(r.json.translatedText, 'the weather is nice');
    assert.equal(r.json.source, 'replay');
    assert.equal(s.calls.speak.length, 0);
    assert.equal(s.timers.pendingTimeouts().length, 0);
    const result = await sse.next('result');
    assert.equal(result.status, 'not_sure');
    assert.equal(result.stage, 'meaning');
    assert.equal(result.obeyed, null);
    assert.equal(sse.events.some((e) => e.event === 'call'), false);
    const state = await sse.next('state', 2);
    assert.deepEqual(state.tally, { obeyed: 0, notObeyed: 0, notSure: 1, total: 1 });
    assert.equal(s.calls.evaluate.length, 0);
  } finally {
    sse.close();
    await s.stop();
  }
});

test('a meaning with no phrase, or a malformed match, is treated as not_sure', async () => {
  for (const matchMeaning of [() => ({ meaning: 'dance', confidence: 'high' }), () => null, () => ({ meaning: 'stop', confidence: 'none' })]) {
    const s = await start({ matchMeaning });
    try {
      const r = await post(s.port, '/api/shout', { text: 'x', targetLang: 'en-IN' });
      assert.equal(r.json.status, 'not_sure');
      assert.equal(r.json.confidence, 'none');
      assert.equal(s.calls.speak.length, 0);
    } finally {
      await s.stop();
    }
  }
});

test('replay is stated whenever any part was replayed; verdicts map to outcomes', async () => {
  const verdicts = [
    [{ obeyed: false, strokesUntilObeyed: null, deltaSpm: -1, reason: 'no change' }, 'not_obeyed'],
    [{ obeyed: null, strokesUntilObeyed: null, deltaSpm: null, reason: 'too few strokes' }, 'not_sure'],
    ['garbage', 'not_sure'],
  ];
  for (const [verdict, outcome] of verdicts) {
    const s = await start({
      sarvam: { speak: async () => ({ audioBase64: 'QUJD', mime: 'audio/wav', source: 'replay', latencyMs: 1 }) },
      evaluate: () => verdict,
    });
    try {
      const r = await post(s.port, '/api/shout', { text: 'x', targetLang: 'od-IN' });
      assert.equal(r.json.source, 'replay');
      assert.deepEqual(r.json.sources, { translate: 'live', speak: 'replay' });
      s.timers.fireTimeouts();
      const state = s.app.hub.getState();
      assert.equal(state.trials[0].outcome, outcome);
      assert.equal(state.trials[0].source, 'replay');
    } finally {
      await s.stop();
    }
  }
  const thrower = await start({ evaluate: () => { throw new Error('boom'); } });
  try {
    await post(thrower.port, '/api/shout', { text: 'x', targetLang: 'en-IN' });
    thrower.timers.fireTimeouts();
    assert.equal(thrower.app.hub.getState().trials[0].outcome, 'not_sure');
  } finally {
    await thrower.stop();
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
      assert.equal(s.app.hub.getState().trials.length, 0);
    }
    // the in-flight guard is released after a failure
    assert.equal((await post(s2.port, '/api/shout', { text: 'x', targetLang: 'hi-IN' })).status, 502);
  } finally {
    await s1.stop();
    await s2.stop();
  }
});

test('speech failure still delivers the call, marked as having no audio', async () => {
  const s = await start({ sarvam: { speak: async () => { throw new Error('tts down'); } } });
  try {
    const r = await post(s.port, '/api/shout', { text: 'x', targetLang: 'hi-IN' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ttsAvailable, false);
    assert.equal(r.json.ttsAudioBase64, null);
    assert.equal(r.json.meaning, 'speed_up');
    assert.deepEqual(r.json.sources, { translate: 'live', speak: null });
    assert.equal(s.timers.pendingTimeouts().length, 1);
  } finally {
    await s.stop();
  }
});

test('a new call ends the open observation window early; concurrent shouts get 429', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let slow = false;
  const s = await start({
    sarvam: {
      translate: async () => {
        if (slow) await gate;
        return { text: 'faster', source: 'live', latencyMs: 1 };
      },
    },
  });
  try {
    await post(s.port, '/api/shout', { text: 'one', targetLang: 'en-IN' });
    s.clock.t += 3000;
    await post(s.port, '/api/shout', { text: 'two', targetLang: 'en-IN' });
    let state = s.app.hub.getState();
    assert.equal(state.trials.length, 1);
    assert.equal(state.trials[0].callId, 'call-1');
    assert.equal(state.trials[0].superseded, true);
    assert.equal(state.trials[0].windowMs, 3000);
    assert.equal(s.timers.pendingTimeouts().length, 1);
    s.timers.fireTimeouts();
    state = s.app.hub.getState();
    assert.deepEqual(state.trials.map((t) => [t.callId, t.superseded]), [['call-1', true], ['call-2', false]]);

    slow = true;
    const first = post(s.port, '/api/shout', { text: 'three', targetLang: 'en-IN' });
    for (let i = 0; i < 200 && s.calls.match.length < 2; i += 1) await new Promise((r) => setTimeout(r, 2));
    const busy = await post(s.port, '/api/shout', { text: 'four', targetLang: 'en-IN' });
    assert.equal(busy.status, 429);
    assert.equal(busy.json.error.code, 'busy');
    release();
    assert.equal((await first).status, 200);
  } finally {
    release();
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
  assert.match(text, /http:\/\/10\.0\.0\.7:3000\/phone/);
  assert.match(text, /SARVAM_API_KEY set/);
  assert.match(text, /UNVERIFIED/);
  assert.equal(text.includes(FAKE_KEY), false);
  const replay = bannerLines({ ...resolveConfig({ SARVAM_MODE: 'live' }), port: 1, addresses: [] }).join('\n');
  assert.match(replay, /SARVAM_API_KEY is not set/);
  assert.match(replay, /no LAN address/);
});
