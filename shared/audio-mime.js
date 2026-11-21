// Mime inference for dropped audio files. Runs in the browser (dashboard drop
// zone) and in Node (tests); no imports.
//
// A WhatsApp voice note saved as .opus is often reported by the browser as
// audio/ogg or with an empty type. When the reported type is missing or is not
// an audio type, the file extension is the better signal. WhatsApp .opus files
// are Opus audio in an Ogg container, so opus maps to audio/ogg;codecs=opus.

export const MIME_BY_EXT = Object.freeze({
  opus: 'audio/ogg;codecs=opus',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  webm: 'audio/webm',
  flac: 'audio/flac',
  amr: 'audio/amr',
});

// Fallback for an audio file with no usable type at all: Ogg is the container
// WhatsApp voice notes use, and the speech API sniffs the real codec anyway.
const FALLBACK_MIME = 'audio/ogg';

/**
 * @param {string} filename original file name, e.g. "PTT-20261121-WA0001.opus"
 * @param {string} [reported] mime the browser reported (file.type / blob.type)
 * @returns {string} an audio/* mime suitable for POST /api/shout
 */
export function mimeFromName(filename, reported) {
  const rep = typeof reported === 'string' ? reported.trim() : '';
  if (/^audio\/[A-Za-z0-9.+-]+/i.test(rep)) return rep;
  const ext = /\.([A-Za-z0-9]+)$/.exec(String(filename || ''));
  const known = ext ? MIME_BY_EXT[ext[1].toLowerCase()] : null;
  return known || FALLBACK_MIME;
}
