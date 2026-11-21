// npm run ingest -- <file> [--lang=hi-IN] [--port=3000]
// Sends one audio file through the shout path of a running server, exactly like
// a voice note dropped on the dashboard: magic-byte sniff, 5 MB and 30 s
// limits, then POST /api/shout. The server must already be running.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LANGS } from './hub.js';
import { sniffAudio, measureDuration, NOTE_MAX_BYTES, SPEECH_MAX_SECONDS } from '../shared/audio-sniff.js';

const USAGE = `usage: npm run ingest -- <audio file> [--lang=<${LANGS.join('|')}>] [--port=<n>]
Sends one audio file (WhatsApp voice note, mp3, wav, m4a, aac, amr, webm) to the
running rowing-call server through the voice-note path.`;

function parseArgs(argv) {
  const args = { lang: 'en-IN', port: Number(process.env.PORT || 3000), file: null };
  for (const arg of argv) {
    if (arg.startsWith('--lang=')) args.lang = arg.slice(7);
    else if (arg.startsWith('--port=')) args.port = Number(arg.slice(7));
    else if (!arg.startsWith('--')) args.file = arg;
  }
  return args;
}

export async function main(argv = process.argv.slice(2), { fetchImpl = globalThis.fetch, say = (l) => process.stdout.write(`${l}\n`), fail = (l) => process.stderr.write(`${l}\n`) } = {}) {
  const args = parseArgs(argv);
  if (!args.file) {
    fail(USAGE);
    return 2;
  }
  if (!LANGS.includes(args.lang)) {
    fail(`--lang must be one of: ${LANGS.join(', ')}`);
    return 2;
  }
  const file = path.resolve(args.file);
  let bytes;
  try {
    bytes = await fs.promises.readFile(file);
  } catch (err) {
    fail(`cannot read ${args.file}: ${err.code || err.name}`);
    return 2;
  }
  const filename = path.basename(file);
  if (bytes.length === 0) {
    fail(`${filename}: the file is empty`);
    return 2;
  }
  if (bytes.length > NOTE_MAX_BYTES) {
    fail(`${filename} is ${(bytes.length / 1e6).toFixed(1)} MB; the limit is ${NOTE_MAX_BYTES / 1e6} MB`);
    return 2;
  }
  const sniffed = sniffAudio(bytes);
  if (!sniffed) {
    fail(`${filename}: not a recognised audio file (Ogg/Opus, MP3, WAV, M4A, AAC, AMR or WebM)`);
    return 2;
  }
  const dur = measureDuration(bytes, sniffed.format);
  if (dur && dur.seconds > SPEECH_MAX_SECONDS) {
    const how = dur.exact ? 'is' : 'is about';
    fail(`${filename} ${how} ${Math.round(dur.seconds)} s; Sarvam speech-to-text accepts clips up to ${SPEECH_MAX_SECONDS} s. Save a shorter note.`);
    return 2;
  }
  const url = `http://127.0.0.1:${args.port}/api/shout`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audioBase64: bytes.toString('base64'), mime: sniffed.mime,
        filename, source: 'ingest', targetLang: args.lang,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    fail(`could not reach the server at ${url} (${err.name === 'TimeoutError' ? 'timed out' : err.code || err.name}). Is it running? npm start`);
    return 1;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok === false) {
    fail(`shout failed: ${(data && data.error && data.error.message) || `HTTP ${res.status}`}`);
    return 1;
  }
  say(`${filename}: heard "${data.translatedText || ''}"${data.meaning ? ` -> ${data.meaning}` : ' (not sure)'}${data.status === 'not_sure' ? ' [not sure]' : ''}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
