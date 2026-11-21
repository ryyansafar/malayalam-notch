// Folder watcher: ingests audio files that appear in watched folders and hands
// them to an injected `ingest` function, which sends them through the same
// shout path as a dropped voice note.
//
// Safety rules (in order):
//   - the default folder ~/Downloads/rowing-call-inbox is created and watched;
//     extra folders come only from WATCH_DIRS (comma-separated, ~ allowed);
//   - files already present at startup are never ingested (no backfill);
//   - non-audio files (magic-byte sniffed) and files over 5 MB are ignored;
//   - each file is ingested once: sha256(first 64 KB) + size is remembered;
//   - source files are only read — never deleted, moved or modified;
//   - a file is read only after its size is stable for `stableMs` (finished writing).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sniffAudio, measureDuration, NOTE_MAX_BYTES } from '../shared/audio-sniff.js';

export const DEFAULT_INBOX_DIR = path.join(os.homedir(), 'Downloads', 'rowing-call-inbox');
const HEAD_BYTES = 64 * 1024;

/** Expands a leading ~ or ~/ to the home directory. */
export function expandHome(raw, home = os.homedir()) {
  const s = String(raw || '').trim();
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(home, s.slice(2));
  return s;
}

// The folder WhatsApp Desktop keeps downloaded media in (layout varies by
// version). Never watched by default; watching it sends every voice note from
// every chat saved there to the transcription service, so adding it earns a warning.
export const WHATSAPP_MEDIA_HINT = 'Library/Group Containers/group.net.whatsapp';

const isWhatsappDir = (dir) => dir.toLowerCase().includes('whatsapp');

/**
 * Resolves the folders to watch from the environment.
 * WATCH_INBOX=0 turns the default inbox folder off; WATCH_DIRS adds extra
 * folders (absolute paths only, ~ allowed).
 * @returns {{ dirs: Array<{dir: string, source: string, create: boolean}>, warnings: string[] }}
 */
export function resolveWatchDirs({ env = process.env, home = os.homedir() } = {}) {
  const inboxOn = !['0', 'false', 'off', 'no'].includes(String(env.WATCH_INBOX ?? '').trim().toLowerCase());
  const warnings = [];
  const dirs = inboxOn
    ? [{ dir: path.join(home, 'Downloads', 'rowing-call-inbox'), source: 'whatsapp_desktop', create: true }]
    : [];
  const seen = new Set(dirs.map((d) => d.dir));
  for (const raw of String(env.WATCH_DIRS || '').split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const dir = expandHome(trimmed, home);
    if (!path.isAbsolute(dir)) {
      warnings.push(`WATCH_DIRS: "${trimmed}" is not an absolute path; skipped`);
      continue;
    }
    const clean = path.resolve(dir);
    if (seen.has(clean)) continue;
    seen.add(clean);
    if (clean.includes(WHATSAPP_MEDIA_HINT) || clean.includes('group.net.whatsapp')) {
      warnings.push(`WATCH_DIRS: ${clean} is inside WhatsApp's media store — every voice note from every chat saved there will be sent to Sarvam cloud speech-to-text`);
    }
    dirs.push({ dir: clean, source: isWhatsappDir(clean) ? 'whatsapp_desktop' : 'watched_folder', create: false });
  }
  return { dirs, warnings };
}

const fileHash = (buf, size) => `${size}:${createHash('sha256').update(buf).digest('hex')}`;
const errorTag = (err) => String((err && (err.code || err.name)) || 'Error');

/**
 * @param {{ dirs: Array<{dir, source, create}>, ingest: (info: object) => Promise<void>|void,
 *   log?: (line: string) => void, timers?: object, debounceMs?: number, stableMs?: number,
 *   stablePolls?: number, maxBytes?: number }} options
 * `ingest` receives { path, filename, source, bytes, mime, format, seconds, exact }.
 */
export function createWatcher({
  dirs = [], ingest, log = () => {}, timers = globalThis,
  debounceMs = 150, stableMs = 400, stablePolls = 8, maxBytes = NOTE_MAX_BYTES,
} = {}) {
  if (typeof ingest !== 'function') throw new TypeError('createWatcher needs an ingest function');
  const watchers = [];
  const debounced = new Map(); // file -> pending debounce timer
  const active = new Set(); // files with a stability check in flight
  const seen = new Set(); // "size:hash" of files already ingested or ignored
  let closed = false;

  const later = (fn, ms) => timers.setTimeout(fn, ms);

  // Wait until the file size stops changing, then process it.
  async function whenStable(file, dirSpec, lastSize, left) {
    if (closed) {
      active.delete(file);
      return;
    }
    if (left <= 0) {
      log(`[watch] ${path.basename(file)} never stopped growing; skipped`);
      active.delete(file);
      return;
    }
    let st;
    try {
      st = await fs.promises.stat(file);
    } catch {
      active.delete(file);
      return; // gone before it was readable
    }
    if (!st.isFile()) {
      active.delete(file);
      return;
    }
    if (st.size > maxBytes) {
      log(`[watch] ${path.basename(file)} is ${(st.size / 1e6).toFixed(1)} MB; the limit is ${Math.round(maxBytes / 1e6)} MB — ignored`);
      active.delete(file);
      return;
    }
    if (st.size === 0 || st.size !== lastSize) {
      later(() => { whenStable(file, dirSpec, st.size, left - 1).catch((err) => log(`[watch] ${errorTag(err)}`)); }, stableMs);
      return;
    }
    await ingestIfAudio(file, st.size, dirSpec);
    active.delete(file);
  }

  async function ingestIfAudio(file, size, dirSpec) {
    const filename = path.basename(file);
    let head;
    try {
      head = Buffer.alloc(Math.min(HEAD_BYTES, size));
      const fh = await fs.promises.open(file, 'r');
      try {
        await fh.read(head, 0, head.length, 0);
      } finally {
        await fh.close();
      }
    } catch {
      return;
    }
    const sniffed = sniffAudio(head);
    const key = fileHash(head, size);
    if (seen.has(key)) return; // same bytes already ingested (or already ignored)
    if (!sniffed) {
      seen.add(key); // not an audio file: ignore, and do not read it again
      return;
    }
    let bytes;
    try {
      bytes = await fs.promises.readFile(file);
    } catch {
      return;
    }
    if (bytes.length !== size) return; // it changed while we read it; the next event picks it up
    seen.add(key);
    const dur = measureDuration(bytes, sniffed.format);
    try {
      await ingest({
        path: file, filename, source: dirSpec.source, bytes,
        mime: sniffed.mime, format: sniffed.format,
        seconds: dur ? dur.seconds : null, exact: dur ? dur.exact : false,
      });
    } catch (err) {
      log(`[watch] ingest of ${filename} failed: ${errorTag(err)}`);
    }
  }

  function onEvent(dirSpec, filename) {
    if (closed || typeof filename !== 'string' || filename === '') return;
    if (filename.startsWith('.') || filename.endsWith('.tmp') || filename.endsWith('.crdownload')) return;
    const file = path.join(dirSpec.dir, filename);
    if (dirSpec.existing.has(filename)) return; // present at startup: no backfill
    if (active.has(file)) return; // a stability check is already running for it
    timers.clearTimeout(debounced.get(file));
    debounced.set(file, later(() => {
      debounced.delete(file);
      if (closed || active.has(file)) return;
      active.add(file);
      whenStable(file, dirSpec, null, stablePolls).catch((err) => log(`[watch] ${errorTag(err)}`));
    }, debounceMs));
  }

  async function start() {
    for (const dirSpec of dirs) {
      try {
        if (dirSpec.create) fs.mkdirSync(dirSpec.dir, { recursive: true });
        dirSpec.existing = new Set(fs.readdirSync(dirSpec.dir));
      } catch (err) {
        log(`[watch] cannot watch ${dirSpec.dir}: ${errorTag(err)}`);
        continue;
      }
      try {
        const w = fs.watch(dirSpec.dir, { persistent: false }, (_event, filename) => onEvent(dirSpec, filename));
        w.on('error', (err) => log(`[watch] ${dirSpec.dir}: ${errorTag(err)}`));
        watchers.push(w);
      } catch (err) {
        log(`[watch] cannot watch ${dirSpec.dir}: ${errorTag(err)}`);
      }
    }
    return watchers.length;
  }

  function close() {
    closed = true;
    for (const t of debounced.values()) timers.clearTimeout(t);
    debounced.clear();
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    watchers.length = 0;
  }

  return { start, close, get watching() { return watchers.length; }, get seenCount() { return seen.size; } };
}
