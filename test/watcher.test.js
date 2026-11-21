// Folder-watcher tests: a temp directory, real fs.watch events, an injected
// ingest function. Covers backfill skipping, partial writes, non-audio files,
// duplicate suppression, ~ expansion and the over-size limit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWatcher, resolveWatchDirs, expandHome } from '../server/watcher.js';

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rowing-call-watch-'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let dirSeq = 0;
const nextDir = () => {
  const d = path.join(tmp, `watch-${dirSeq++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

// A tiny valid Ogg page (magic bytes are all the sniffer needs).
function oggBytes(tag = 0x55) {
  const head = Buffer.alloc(27);
  head.write('OggS', 0, 'latin1');
  head.writeBigUInt64LE(48000n, 6);
  head[26] = 1;
  return Buffer.concat([head, Buffer.from([8]), Buffer.alloc(8, tag)]);
}

function startWatcher(dir, got, extra = {}) {
  const logs = [];
  const w = createWatcher({
    dirs: [{ dir, source: 'watched_folder', create: false }],
    ingest: async (info) => got.push(info),
    log: (l) => logs.push(l),
    debounceMs: 20, stableMs: 30, stablePolls: 40,
    ...extra,
  });
  return { w, logs };
}

test('a new audio file is ingested once with its folder source label; a duplicate is suppressed', async () => {
  const dir = nextDir();
  const got = [];
  const { w } = startWatcher(dir, got);
  try {
    await w.start();
    fs.writeFileSync(path.join(dir, 'PTT-20261121-WA0001.opus'), oggBytes(1));
    assert.equal(await waitFor(() => got.length === 1), true, 'file was not ingested');
    const info = got[0];
    assert.equal(info.source, 'watched_folder');
    assert.equal(info.filename, 'PTT-20261121-WA0001.opus');
    assert.equal(info.mime, 'audio/ogg');
    assert.equal(info.format, 'ogg');
    assert.ok(Buffer.isBuffer(info.bytes));
    assert.ok(info.bytes.length > 0);
    assert.ok(Number.isFinite(info.seconds));
    assert.equal(info.exact, true);
    // the source file was only read: still there, unchanged
    assert.deepEqual(fs.readFileSync(path.join(dir, info.filename)), oggBytes(1));

    // identical bytes under a different name: same content, ingested once
    fs.writeFileSync(path.join(dir, 'PTT-20261121-WA0002.opus'), oggBytes(1));
    await sleep(400);
    assert.equal(got.length, 1);

    // different bytes: a different file
    fs.writeFileSync(path.join(dir, 'PTT-20261121-WA0003.opus'), oggBytes(2));
    assert.equal(await waitFor(() => got.length === 2), true);
  } finally {
    w.close();
  }
});

test('files already present at startup are never ingested (no backfill)', async () => {
  const dir = nextDir();
  fs.writeFileSync(path.join(dir, 'old.opus'), oggBytes(3));
  const got = [];
  const { w } = startWatcher(dir, got);
  try {
    await w.start();
    await sleep(400);
    assert.equal(got.length, 0);
    // a file that arrives after startup still is
    fs.writeFileSync(path.join(dir, 'new.opus'), oggBytes(4));
    assert.equal(await waitFor(() => got.length === 1), true);
  } finally {
    w.close();
  }
});

test('a partial write waits until the file size is stable, then ingests the whole file', async () => {
  const dir = nextDir();
  const got = [];
  const { w } = startWatcher(dir, got, { debounceMs: 15, stableMs: 50 });
  try {
    await w.start();
    const file = path.join(dir, 'partial.opus');
    const whole = oggBytes(9);
    // appends land inside the stability window, so the poll keeps seeing growth
    fs.writeFileSync(file, whole.subarray(0, 10));
    await sleep(30);
    fs.appendFileSync(file, whole.subarray(10, 20));
    await sleep(30);
    fs.appendFileSync(file, whole.subarray(20));
    assert.equal(await waitFor(() => got.length === 1), true);
    assert.deepEqual(got[0].bytes, whole); // the complete file, not the partial prefix
    assert.equal(got.length, 1); // the three writes produced one ingest
  } finally {
    w.close();
  }
});

test('non-audio files are ignored; files over the byte limit are logged and ignored', async () => {
  const dir = nextDir();
  const got = [];
  const { w, logs } = startWatcher(dir, got, { maxBytes: 1024 });
  try {
    await w.start();
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'definitely not audio');
    fs.writeFileSync(path.join(dir, 'note.opus'), oggBytes(5)); // small audio file
    fs.writeFileSync(path.join(dir, 'big.opus'), Buffer.concat([oggBytes(6), Buffer.alloc(2048)])); // over maxBytes
    await sleep(600);
    assert.equal(got.length, 1); // only the small audio file
    assert.equal(got[0].filename, 'note.opus');
    assert.ok(logs.some((l) => /big\.opus.*MB|limit/i.test(l)), 'over-size warning logged');
  } finally {
    w.close();
  }
});

test('a missing folder is logged and skipped; the default dir is created when asked', async () => {
  const got = [];
  const missing = path.join(tmp, 'does-not-exist');
  const made = path.join(tmp, 'to-be-created');
  const logs = [];
  const w = createWatcher({
    dirs: [
      { dir: missing, source: 'watched_folder', create: false },
      { dir: made, source: 'watched_folder', create: true },
    ],
    ingest: async (i) => got.push(i),
    log: (l) => logs.push(l),
  });
  try {
    assert.equal(await w.start(), 1); // only the created one is watched
    assert.equal(fs.existsSync(made), true);
    assert.ok(logs.some((l) => l.includes('does-not-exist')));
  } finally {
    w.close();
  }
});

// ---------- env resolution ----------

test('resolveWatchDirs: default inbox, WATCH_DIRS parsing, ~ expansion, absolute-only, warnings', () => {
  const home = path.join(tmp, 'home-user');
  const plain = resolveWatchDirs({ env: {}, home });
  assert.deepEqual(plain.dirs, [{ dir: path.join(home, 'Downloads', 'rowing-call-inbox'), source: 'whatsapp_desktop', create: true }]);
  assert.deepEqual(plain.warnings, []);

  const extra = resolveWatchDirs({
    env: { WATCH_DIRS: ` ~/voice-notes , /abs/dir, relative/nope , , ${path.join(home, 'Downloads', 'rowing-call-inbox')} ` },
    home,
  });
  assert.deepEqual(extra.dirs.map((d) => d.dir), [
    path.join(home, 'Downloads', 'rowing-call-inbox'),
    path.join(home, 'voice-notes'),
    '/abs/dir',
  ]);
  assert.deepEqual(extra.dirs.map((d) => d.source), ['whatsapp_desktop', 'watched_folder', 'watched_folder']);
  assert.equal(extra.warnings.length, 1);
  assert.match(extra.warnings[0], /relative\/nope/);

  const wa = resolveWatchDirs({
    env: { WATCH_DIRS: '~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/Message/Media' },
    home,
  });
  assert.equal(wa.dirs[1].source, 'whatsapp_desktop');
  assert.ok(wa.warnings.some((w) => /WhatsApp's media store/.test(w)));

  const off = resolveWatchDirs({ env: { WATCH_INBOX: '0' }, home });
  assert.deepEqual(off.dirs, []);
  const offButExtra = resolveWatchDirs({ env: { WATCH_INBOX: '0', WATCH_DIRS: '/abs/dir' }, home });
  assert.deepEqual(offButExtra.dirs.map((d) => d.dir), ['/abs/dir']);
});

test('expandHome: ~ and ~/ expand, other paths pass through', () => {
  const home = path.join(tmp, 'h');
  assert.equal(expandHome('~', home), home);
  assert.equal(expandHome('~/Downloads', home), path.join(home, 'Downloads'));
  assert.equal(expandHome('/abs/path', home), '/abs/path');
  assert.equal(expandHome('  ~/x  ', home), path.join(home, 'x'));
});
