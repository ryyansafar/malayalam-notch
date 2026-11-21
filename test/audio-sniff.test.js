// Magic-byte format sniffing, duration measurement and the lossless Ogg cut.
// All fixtures are tiny synthetic byte headers built here; no network, no files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffAudio, formatFromName, measureDuration, cutOgg, SPEECH_MAX_SECONDS } from '../shared/audio-sniff.js';

// ---------- tiny synthetic audio builders ----------

/** One Ogg page with a given granule position (payload shorter than 255 bytes). */
function oggPage(granule, payload = Buffer.alloc(20, 0x55)) {
  const head = Buffer.alloc(27);
  head.write('OggS', 0, 'latin1');
  head[4] = 0; // stream structure version
  head[5] = 0; // header type flags
  head.writeBigUInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(7, 14); // serial
  head.writeUInt32LE(0, 18); // sequence
  head.writeUInt32LE(0, 22); // crc (not verified by our parser)
  head[26] = 1; // segment count
  return Buffer.concat([head, Buffer.from([payload.length]), payload]);
}

const oggStream = (...granules) => Buffer.concat(granules.map((g) => oggPage(g)));

/** A WhatsApp-style note: an OpusHead BOS page, then pages with granule positions. */
function whatsappNote(...granules) {
  const bosPayload = Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11, 0)]);
  return Buffer.concat([oggPage(0n, bosPayload), ...granules.map((g) => oggPage(g))]);
}

/** A minimal WAV file: `seconds` of PCM at `byteRate` bytes/second. */
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
  fmt.writeUInt16LE(1, 0); // PCM
  fmt.writeUInt16LE(1, 2); // mono
  fmt.writeUInt32LE(8000, 4);
  fmt.writeUInt32LE(byteRate, 8); // byte rate
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const dataHead = Buffer.alloc(8);
  dataHead.write('data', 0, 'latin1');
  dataHead.writeUInt32LE(dataBytes, 4);
  return Buffer.concat([riff, fmtHead, fmt, dataHead, Buffer.alloc(dataBytes, 0x80)]);
}

// ---------- format sniffing ----------

test('sniffAudio: every accepted WhatsApp format is detected from magic bytes', () => {
  const cases = [
    [whatsappNote(48000), 'ogg'],
    [oggStream(48000, 96000), 'ogg'],
    [wav(1), 'wav'],
    [Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x21', 'latin1'), Buffer.alloc(40)]), 'mp3'],
    [Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0]), 'mp3'], // MPEG-1 layer III frame sync
    [Buffer.from([0xff, 0xe3, 0x50, 0x80, 0, 0]), 'mp3'], // MPEG-2.5 sync
    [Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x03, 0x20]), 'aac'], // ADTS
    [Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A \x00\x00\x00\x00', 'latin1')]), 'm4a'],
    [Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom\x00\x00\x00\x00', 'latin1')]), 'm4a'],
    [Buffer.from('#!AMR\n\x3c', 'latin1'), 'amr'],
    [Buffer.from('#!AMR-WB\n\x52', 'latin1'), 'amr'],
    [Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42]), 'webm'],
    [Buffer.from('fLaC\x00\x00\x00\x22', 'latin1'), 'flac'],
  ];
  for (const [buf, format] of cases) {
    const hit = sniffAudio(buf);
    assert.ok(hit, `expected ${format}`);
    assert.equal(hit.format, format, `expected ${format}, got ${hit.format}`);
    assert.match(hit.mime, /^audio\//);
  }
});

test('sniffAudio: OpusHead gives audio/ogg;codecs=opus, plain Ogg gives audio/ogg', () => {
  assert.equal(sniffAudio(whatsappNote(48000)).mime, 'audio/ogg;codecs=opus');
  assert.equal(sniffAudio(oggStream(48000)).mime, 'audio/ogg');
});

test('sniffAudio: non-audio and truncated input are rejected', () => {
  for (const buf of [
    Buffer.from('just some text, not audio at all'),
    Buffer.from('PK\x03\x04zip-archive'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG
    Buffer.alloc(100, 0),
    Buffer.from([0xff]), // too short
    Buffer.alloc(0),
    'not a buffer',
    null,
  ]) {
    assert.equal(sniffAudio(buf), null);
  }
});

test('formatFromName: extension maps to a format for mismatch reporting', () => {
  assert.equal(formatFromName('PTT-20261121-WA0001.opus'), 'ogg');
  assert.equal(formatFromName('clip.M4A'), 'm4a');
  assert.equal(formatFromName('a.amr'), 'amr');
  assert.equal(formatFromName('song.mp3'), 'mp3');
  assert.equal(formatFromName('x.wav'), 'wav');
  assert.equal(formatFromName('x.webm'), 'webm');
  assert.equal(formatFromName('x.txt'), null);
  assert.equal(formatFromName('noext'), null);
});

// ---------- duration ----------

test('measureDuration: Ogg Opus uses the last granule position (48 kHz)', () => {
  const note = whatsappNote(48000 * 10, 48000 * 25); // ends at 25 s
  const d = measureDuration(note, 'ogg');
  assert.equal(d.exact, true);
  assert.ok(Math.abs(d.seconds - 25) < 0.001, `${d.seconds}`);
});

test('measureDuration: WAV uses the header byte rate', () => {
  const d = measureDuration(wav(40), 'wav');
  assert.equal(d.exact, true);
  assert.ok(Math.abs(d.seconds - 40) < 0.01, `${d.seconds}`);
  const short = measureDuration(wav(3.5), 'wav');
  assert.ok(Math.abs(short.seconds - 3.5) < 0.01);
});

test('measureDuration: other formats are an estimate from size, never claimed exact', () => {
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
  const buf = Buffer.concat([mp3, Buffer.alloc(64_000)]);
  const d = measureDuration(buf, 'mp3');
  assert.equal(d.exact, false);
  assert.ok(d.seconds > 0);
});

// ---------- lossless Ogg cut ----------

test('cutOgg: cuts at the last page boundary inside the limit', () => {
  const note = whatsappNote(48000 * 10, 48000 * 20, 48000 * 40); // 40 s total
  const cut = cutOgg(note, SPEECH_MAX_SECONDS);
  assert.ok(cut);
  assert.ok(cut.length < note.length);
  const d = measureDuration(cut, 'ogg');
  assert.equal(d.exact, true);
  assert.ok(d.seconds <= SPEECH_MAX_SECONDS, `${d.seconds} must be <= 30`);
  assert.ok(d.seconds >= 19, `${d.seconds} should keep the 20 s page`);
  assert.equal(sniffAudio(cut).format, 'ogg'); // still a valid Ogg prefix
});

test('cutOgg: returns null when nothing fits the limit, and never on non-ogg', () => {
  const long = whatsappNote(48000 * 60); // first page already past the limit
  assert.equal(cutOgg(long, SPEECH_MAX_SECONDS), null);
  assert.equal(cutOgg(wav(10), SPEECH_MAX_SECONDS), null);
  assert.equal(cutOgg(null, SPEECH_MAX_SECONDS), null);
});

test('cutOgg: a malformed tail is ignored', () => {
  const good = whatsappNote(48000 * 10, 48000 * 20);
  const broken = Buffer.concat([good, Buffer.from('OggSgarbage-not-a-page')]);
  const cut = cutOgg(broken, 30);
  assert.equal(cut.length, good.length); // both valid pages kept, garbage dropped
});
