#!/usr/bin/env node
// Records rehearsal fixtures into the Sarvam cache so the demo can run offline in REPLAY mode.
//
//   SARVAM_API_KEY=... node sarvam/record-fixtures.js \
//     --text "typed Malayalam sentence" --audio notes/voice1.opus \
//     --speak "hi-IN=phrase in Hindi" --speak "phrase for every --lang" --lang hi-IN,bn-IN
//
// Each --audio records all three Saaras modes (transcribe, translit, translate)
// so the notch card can replay offline.
//
// The key is read from the environment only and is never printed.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSarvamClient, DEFAULT_CACHE_DIR, TTS_LANGS, STT_MODES } from './client.js';

export const USAGE = `Usage: SARVAM_API_KEY=... node sarvam/record-fixtures.js [options]

  --text <text>         typed Malayalam text to translate to English (repeatable)
  --audio <file>        audio file of a voice note, max 30 s; records all three
                        Saaras modes (transcribe, translit, translate) (repeatable)
  --speak <text>        phrase to synthesise in every --lang (repeatable)
  --speak <lang>=<text> phrase to synthesise in one language, e.g. hi-IN=... (repeatable)
  --lang <codes>        comma-separated target languages for --speak (${TTS_LANGS.join(', ')})
  --source <code>       source language of --text and --audio (default ml-IN)
  --speaker <name>      Bulbul v3 speaker (default shubh)
  --cache-dir <dir>     where to write fixtures (default sarvam/cache)
  --help                show this message`;

const MIME_BY_EXT = Object.freeze({
  '.webm': 'audio/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/opus',
  '.flac': 'audio/flac', '.aiff': 'audio/aiff', '.amr': 'audio/amr',
});

const VALUE_FLAGS = Object.freeze(['--text', '--audio', '--speak', '--lang', '--source', '--speaker', '--cache-dir']);

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function parseSpeak(value) {
  const match = /^([a-z]{2,3}-IN)=(.+)$/s.exec(value);
  return match ? { lang: match[1], text: match[2] } : { lang: null, text: value };
}

/** Pure argument parser. Throws UsageError on anything it does not understand. */
export function parseArgs(argv) {
  const initial = { help: false, texts: [], audios: [], speaks: [], langs: [], source: 'ml-IN', speaker: undefined, cacheDir: DEFAULT_CACHE_DIR };
  const step = (acc, flag, value) => {
    switch (flag) {
      case '--text': return { ...acc, texts: [...acc.texts, value] };
      case '--audio': return { ...acc, audios: [...acc.audios, value] };
      case '--speak': return { ...acc, speaks: [...acc.speaks, parseSpeak(value)] };
      case '--lang': return { ...acc, langs: [...acc.langs, ...value.split(',').map((s) => s.trim()).filter(Boolean)] };
      case '--source': return { ...acc, source: value };
      case '--speaker': return { ...acc, speaker: value };
      default: return { ...acc, cacheDir: path.resolve(value) };
    }
  };
  let acc = initial;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { ...acc, help: true };
    if (!VALUE_FLAGS.includes(flag)) throw new UsageError(`Unknown argument: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.trim() === '') throw new UsageError(`${flag} needs a value`);
    acc = step(acc, flag, value);
    i += 1;
  }
  const bad = [...acc.langs, ...acc.speaks.map((s) => s.lang).filter(Boolean)].filter((l) => !TTS_LANGS.includes(l));
  if (bad.length > 0) throw new UsageError(`Unsupported target language: ${bad.join(', ')}`);
  if (acc.speaks.some((s) => s.lang === null) && acc.langs.length === 0) {
    throw new UsageError('--speak without a lang= prefix needs --lang');
  }
  if (acc.texts.length + acc.audios.length + acc.speaks.length === 0) {
    throw new UsageError('Nothing to record: give at least one --text, --audio or --speak');
  }
  return acc;
}

// The three Saaras modes the notch card asks for on one audio.
const AUDIO_STT_MODES = Object.freeze(['transcribe', 'translit', 'translate']);

/** Expands parsed options into a flat list of jobs. */
export function planJobs(opts) {
  const texts = opts.texts.map((text) => ({ op: 'translate', label: text, args: { text, sourceLang: opts.source } }));
  const audios = opts.audios.flatMap((file) => AUDIO_STT_MODES
    .filter((mode) => STT_MODES.includes(mode))
    .map((mode) => ({ op: `stt:${mode}`, label: file, file, mode, args: { sourceLang: opts.source, mode } })));
  const speaks = opts.speaks.flatMap((s) => (s.lang ? [s.lang] : opts.langs).map((lang) => ({
    op: 'speak', label: `${lang} ${s.text}`, args: { text: s.text, targetLang: lang, speaker: opts.speaker },
  })));
  return [...texts, ...audios, ...speaks];
}

async function runJob(client, job) {
  try {
    if (job.op === 'speak') {
      const r = await client.speak(job.args);
      const bytes = Buffer.from(r.audioBase64, 'base64').length;
      return { ...job, ok: r.source === 'live', source: r.source, latencyMs: r.latencyMs, result: `${bytes} bytes ${r.mime}` };
    }
    const args = job.file
      ? { ...job.args, audio: await readFile(job.file), mime: MIME_BY_EXT[path.extname(job.file).toLowerCase()] }
      : job.args;
    const r = job.file && typeof client.stt === 'function'
      ? await client.stt(args)
      : await client.translate(args);
    const note = r.passthrough ? ' (passthrough, not cached)' : '';
    return { ...job, ok: r.source === 'live' && !r.passthrough, source: r.source, latencyMs: r.latencyMs, result: `${r.text}${note}` };
  } catch (err) {
    const reason = err.code === 'ENOENT' ? 'file not found' : err.message;
    return { ...job, ok: false, source: 'error', latencyMs: 0, result: reason };
  }
}

function clip(value, width) {
  const flat = String(value).replace(/\s+/g, ' ');
  return (flat.length > width ? `${flat.slice(0, width - 3)}...` : flat).padEnd(width);
}

export function formatTable(rows) {
  const header = `${clip('op', 10)} ${clip('input', 34)} ${clip('source', 7)} ${clip('ms', 6)} result`;
  const lines = rows.map((r) => `${clip(r.op, 10)} ${clip(r.label, 34)} ${clip(r.source, 7)} ${clip(r.latencyMs, 6)} ${clip(r.result, 60).trimEnd()}`);
  return [header, '-'.repeat(header.length + 20), ...lines].join('\n');
}

/**
 * Runs the CLI. Everything external is injectable so tests never touch the network.
 * Returns the process exit code.
 */
export async function main({
  argv, env, createClient = createSarvamClient, fetchImpl,
  out = (line) => process.stdout.write(`${line}\n`),
  err = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  const apiKey = typeof env.SARVAM_API_KEY === 'string' ? env.SARVAM_API_KEY.trim() : '';
  if (apiKey === '') {
    err('SARVAM_API_KEY is not set. Recording needs live calls, so this tool refuses to run without a key.');
    return 1;
  }
  const redact = (line) => String(line).split(apiKey).join('[redacted]');
  const client = createClient({ apiKey, mode: 'live', cacheDir: opts.cacheDir, ...(fetchImpl ? { fetchImpl } : {}) });
  const jobs = planJobs(opts);
  const rows = [];
  for (const job of jobs) {
    rows.push(await runJob(client, job)); // sequential on purpose: stay well inside 60 requests per minute
  }
  const cached = rows.filter((r) => r.ok).length;
  out(redact(formatTable(rows)));
  out(redact(`\n${cached} of ${rows.length} recorded live into ${opts.cacheDir}`));
  return cached === rows.length ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main({ argv: process.argv.slice(2), env: process.env }).then((code) => {
    process.exitCode = code;
  });
}
