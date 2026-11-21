// Audio sniffing for voice-note intake: magic-byte format detection, duration
// measurement (Ogg granule position, WAV header, bitrate estimate otherwise)
// and a lossless Ogg cut at a page boundary for the "use the first 30 s" offer.
// Pure ES module, no imports: runs in the browser (dashboard drop zone) and in
// Node (share target, folder watcher, tests). Every function takes Uint8Array.

export const SPEECH_MAX_SECONDS = 30; // Sarvam REST speech-to-text limit
export const NOTE_MAX_BYTES = 5 * 1024 * 1024;

export const FORMATS = Object.freeze({
  ogg: { mime: 'audio/ogg', label: 'Ogg/Opus' },
  mp3: { mime: 'audio/mpeg', label: 'MP3' },
  wav: { mime: 'audio/wav', label: 'WAV' },
  m4a: { mime: 'audio/mp4', label: 'M4A/MP4 audio' },
  aac: { mime: 'audio/aac', label: 'AAC' },
  amr: { mime: 'audio/amr', label: 'AMR' },
  webm: { mime: 'audio/webm', label: 'WebM' },
  flac: { mime: 'audio/flac', label: 'FLAC' },
});

// Rough bitrates (bits/second) for the fallback duration estimate. Deliberately
// ordinary compressed-speech rates: the result is always labelled an estimate,
// never presented as measured.
const ESTIMATE_BPS = Object.freeze({
  ogg: 24_000, webm: 32_000, mp3: 64_000, m4a: 64_000, aac: 48_000,
  amr: 12_800, flac: 400_000, wav: 256_000,
});

const EXT_FORMAT = Object.freeze({
  opus: 'ogg', ogg: 'ogg', oga: 'ogg', mp3: 'mp3', wav: 'wav', wave: 'wav',
  m4a: 'm4a', mp4: 'm4a', aac: 'aac', amr: 'amr', webm: 'webm', flac: 'flac',
});

const bytesAt = (buf, off, text) => {
  if (off + text.length > buf.length) return false;
  for (let i = 0; i < text.length; i += 1) if (buf[off + i] !== text.charCodeAt(i)) return false;
  return true;
};

/** Format implied by a file name extension, or null when unknown. */
export function formatFromName(filename) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename || ''));
  return m ? EXT_FORMAT[m[1].toLowerCase()] || null : null;
}

/**
 * Detects the real format from the first bytes, so a mislabelled file is caught.
 * @returns {{format: string, mime: string, label: string} | null} null = not a
 * recognised audio container (a plain "not an audio file" rejection).
 */
export function sniffAudio(buf) {
  if (!(buf instanceof Uint8Array) || buf.length < 4) return null;
  if (bytesAt(buf, 0, 'OggS')) {
    // WhatsApp voice notes are Opus in Ogg; the BOS page starts with OpusHead.
    let mime = 'audio/ogg';
    const head = Math.min(buf.length, 128);
    for (let i = 0; i + 8 <= head; i += 1) {
      if (bytesAt(buf, i, 'OpusHead')) { mime = 'audio/ogg;codecs=opus'; break; }
    }
    return { format: 'ogg', mime, label: 'Ogg/Opus' };
  }
  if (bytesAt(buf, 0, 'RIFF') && bytesAt(buf, 8, 'WAVE')) return { format: 'wav', ...FORMATS.wav };
  if (bytesAt(buf, 0, 'ID3')) return { format: 'mp3', ...FORMATS.mp3 };
  if (bytesAt(buf, 4, 'ftyp')) return { format: 'm4a', ...FORMATS.m4a };
  if (bytesAt(buf, 0, '#!AMR')) return { format: 'amr', ...FORMATS.amr };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { format: 'webm', ...FORMATS.webm };
  if (bytesAt(buf, 0, 'fLaC')) return { format: 'flac', ...FORMATS.flac };
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    const version = (buf[1] >> 3) & 0x03; // 01 is reserved
    const layer = (buf[1] >> 1) & 0x03; // 00 is reserved
    if (version !== 0x01 && layer !== 0x00) return { format: 'mp3', ...FORMATS.mp3 };
    if ((buf[1] & 0xf6) === 0xf0) return { format: 'aac', ...FORMATS.aac }; // ADTS
  }
  return null;
}

/** One Ogg page: byte range plus the granule position it ends on. */
function oggPages(buf) {
  const pages = [];
  let off = 0;
  while (off + 27 <= buf.length) {
    if (!bytesAt(buf, off, 'OggS') || buf[off + 4] !== 0) break;
    const granule = buf.slice(off + 6, off + 14);
    let g = 0n;
    for (let i = 7; i >= 0; i -= 1) g = (g << 8n) + BigInt(granule[i]);
    const segs = buf[off + 26];
    const segTable = off + 27;
    if (segTable + segs > buf.length) break;
    let data = 0;
    for (let i = 0; i < segs; i += 1) data += buf[segTable + i];
    const end = segTable + segs + data;
    if (end > buf.length) break;
    pages.push({ start: off, end, granule: g });
    off = end;
  }
  return pages;
}

/** Exact seconds from the last Ogg granule position (Opus is always 48 kHz), or null. */
function oggDuration(buf) {
  const pages = oggPages(buf);
  for (let i = pages.length - 1; i >= 0; i -= 1) {
    if (pages[i].granule !== 0xffff_ffff_ffff_ffffn) return Number(pages[i].granule) / 48000;
  }
  return null;
}

/** Exact seconds from a WAV header, or null on a malformed file. */
function wavDuration(buf) {
  if (buf.length < 12 || !bytesAt(buf, 0, 'RIFF') || !bytesAt(buf, 8, 'WAVE')) return null;
  const u32 = (off) => (off + 4 <= buf.length ? new DataView(buf.buffer, buf.byteOffset + off).getUint32(0, true) : null);
  let byteRate = null;
  let dataBytes = null;
  for (let off = 12; off + 8 <= buf.length;) {
    const size = u32(off + 4);
    if (size === null) return null;
    if (bytesAt(buf, off, 'fmt ')) byteRate = u32(off + 16); // fmt: format(2) channels(2) rate(4) byteRate(4)
    if (bytesAt(buf, off, 'data')) { dataBytes = Math.min(size, buf.length - (off + 8)); break; }
    off += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (!byteRate || dataBytes === null) return null;
  return dataBytes / byteRate;
}

/**
 * How long the clip is. `exact` is true only when the container itself told us
 * (Ogg granule, WAV byte rate); everything else is a bitrate estimate from the
 * file size and must be shown as an estimate.
 * @returns {{seconds: number, exact: boolean} | null}
 */
export function measureDuration(buf, format) {
  if (!(buf instanceof Uint8Array) || buf.length === 0) return null;
  if (format === 'wav') {
    const s = wavDuration(buf);
    return s === null ? null : { seconds: s, exact: true };
  }
  if (format === 'ogg') {
    const s = oggDuration(buf);
    if (s !== null) return { seconds: s, exact: true };
  }
  const bps = ESTIMATE_BPS[format] || 32_000;
  return { seconds: (buf.length * 8) / bps, exact: false };
}

/**
 * Losslessly cuts an Ogg stream at a page boundary: the returned bytes are a
 * valid prefix whose last page ends at or before `seconds` of audio. Returns
 * null when no page boundary fits the limit. Only valid for format 'ogg'.
 */
export function cutOgg(buf, seconds) {
  if (!(buf instanceof Uint8Array)) return null;
  const target = BigInt(Math.max(0, Math.round(seconds * 48000)));
  let cut = 0;
  for (const page of oggPages(buf)) {
    if (page.granule === 0xffff_ffff_ffff_ffffn) continue; // no complete sample ends here
    if (page.granule > 0n && page.granule <= target) cut = page.end;
    else if (page.granule > target) break; // granule positions are monotonic
  }
  return cut > 0 ? buf.slice(0, cut) : null;
}
