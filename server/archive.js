// The call archive: a capped, searchable list of every heard shout, persisted
// as JSON lines under a git-ignored data/ folder. Audio bytes and API keys are
// never stored here. All file errors are logged and swallowed — archiving must
// never fail a shout.
import fs from 'node:fs';
import path from 'node:path';

export const ARCHIVE_MAX = 500;
export const SOURCES = Object.freeze(['voice_note', 'text', 'mic']);
export const VERDICTS = Object.freeze(['obeyed', 'not_obeyed', 'not_sure']);

const TEXT_MAX = 2000;
const ID_RE = /^e-(\d+)$/;
const clip = (v, n) => (typeof v === 'string' && v !== '' ? v.slice(0, n) : null);

function searchable(e) {
  return [e.text, e.transcript, e.meaning, e.language, e.filename, e.source]
    .filter((s) => typeof s === 'string' && s !== '')
    .join('\n')
    .toLowerCase();
}

/**
 * @param {{file?: string|null, maxEntries?: number, now?: () => number,
 *   log?: (line: string) => void}} options
 *   file is a JSON-lines path (created on demand); null keeps entries in memory only.
 */
export function createArchive({ file = null, maxEntries = ARCHIVE_MAX, now = Date.now, log = () => {} } = {}) {
  const dir = file ? path.dirname(file) : null;
  let entries = [];
  let seq = 0;

  if (file) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e && typeof e === 'object' && typeof e.id === 'string') {
            entries.push(e);
            const m = ID_RE.exec(e.id);
            if (m) seq = Math.max(seq, Number(m[1]));
          }
        } catch {
          log('[archive] skipped a corrupt line while loading');
        }
      }
      entries = entries.slice(-maxEntries);
    } catch (err) {
      if (err.code !== 'ENOENT') log(`[archive] could not load ${path.basename(file)}: ${err.code || err.name}`);
    }
  }

  function writeAll() {
    if (!file) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      log(`[archive] write failed: ${err.code || err.name}`);
    }
  }

  function appendLine(e) {
    if (!file) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(e)}\n`, 'utf8');
    } catch (err) {
      log(`[archive] write failed: ${err.code || err.name}`);
    }
  }

  function add(entry = {}) {
    const stored = {
      id: `e-${++seq}`,
      time: Number.isFinite(entry.time) ? entry.time : now(),
      source: SOURCES.includes(entry.source) ? entry.source : 'text',
      filename: clip(entry.filename, 200),
      language: clip(entry.language, 40),
      text: typeof entry.text === 'string' ? entry.text.slice(0, TEXT_MAX) : '',
      meaning: clip(entry.meaning, 40),
      confidence: clip(entry.confidence, 40),
      verdict: VERDICTS.includes(entry.verdict) ? entry.verdict : null,
      reason: clip(entry.reason, 300),
    };
    entries.push(stored);
    if (entries.length > maxEntries) {
      entries = entries.slice(-maxEntries);
      writeAll();
    } else {
      appendLine(stored);
    }
    return stored;
  }

  function update(id, patch = {}) {
    const e = entries.find((x) => x.id === id);
    if (!e) return null;
    if ('verdict' in patch) e.verdict = VERDICTS.includes(patch.verdict) ? patch.verdict : null;
    if ('reason' in patch) e.reason = clip(patch.reason, 300);
    if ('meaning' in patch) e.meaning = clip(patch.meaning, 40);
    writeAll();
    return e;
  }

  function list({ q = '', limit } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    const matched = needle ? entries.filter((e) => searchable(e).includes(needle)) : entries;
    const out = matched.slice().reverse(); // newest first
    return Number.isInteger(limit) && limit >= 0 ? out.slice(0, limit) : out;
  }

  return {
    add,
    update,
    list,
    get size() { return entries.length; },
    file,
  };
}
