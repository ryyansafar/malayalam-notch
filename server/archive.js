// The note archive: a capped, searchable list of every translated shout,
// persisted as JSON lines under a git-ignored data/ folder. Audio bytes and
// API keys are never stored here. All file errors are logged and swallowed —
// archiving must never fail a shout.
import fs from 'node:fs';
import path from 'node:path';

export const ARCHIVE_MAX = 500;
// Keep in sync with SHOUT_SOURCES in server/hub.js.
export const SOURCES = Object.freeze([
  'voice_note', 'text', 'mic', 'phone_mic', 'whatsapp_share', 'whatsapp_desktop', 'watched_folder', 'ingest', 'notch_drop',
]);

const TEXT_MAX = 2000;
const ID_RE = /^e-(\d+)$/;
const clip = (v, n) => (typeof v === 'string' && v !== '' ? v.slice(0, n) : null);

function searchable(e) {
  return [e.text, e.transcript, e.roman, e.language, e.filename, e.source]
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

  // One translated note: the English `text`, the Malayalam-script `transcript`
  // and the romanised `roman` line, each only what the API returned.
  function add(entry = {}) {
    const stored = {
      id: `e-${++seq}`,
      time: Number.isFinite(entry.time) ? entry.time : now(),
      source: SOURCES.includes(entry.source) ? entry.source : 'text',
      filename: clip(entry.filename, 200),
      language: clip(entry.language, 40),
      text: typeof entry.text === 'string' ? entry.text.slice(0, TEXT_MAX) : '',
      transcript: clip(entry.transcript, TEXT_MAX),
      roman: clip(entry.roman, TEXT_MAX),
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

  function list({ q = '', limit } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    const matched = needle ? entries.filter((e) => searchable(e).includes(needle)) : entries;
    const out = matched.slice().reverse(); // newest first
    return Number.isInteger(limit) && limit >= 0 ? out.slice(0, limit) : out;
  }

  // Entries since local midnight — the island's "notes translated today" count.
  function countToday(nowT = now()) {
    const dayStart = new Date(nowT);
    dayStart.setHours(0, 0, 0, 0);
    const t0 = dayStart.getTime();
    return entries.filter((e) => Number.isFinite(e.time) && e.time >= t0).length;
  }

  return {
    add,
    list,
    countToday,
    get size() { return entries.length; },
    file,
  };
}

// ---- export -------------------------------------------------------------
// Downloads of the archive. Entries never carry audio, so the export is text
// only. CSV cells are quoted when they contain a comma, a quote or a line
// break; embedded quotes are doubled.

export const CSV_COLUMNS = Object.freeze([
  'id', 'time', 'source', 'filename', 'language', 'transcript', 'roman', 'text',
]);

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function archiveCsv(entries) {
  const head = CSV_COLUMNS.join(',');
  const rows = entries.map((e) => CSV_COLUMNS.map((col) => {
    const v = col === 'time' && Number.isFinite(e.time) ? new Date(e.time).toISOString() : e[col];
    return csvCell(v);
  }).join(','));
  return `${head}\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
}

export function archiveJson(entries) {
  return JSON.stringify({ entries, exportedAt: new Date().toISOString() }, null, 2);
}
