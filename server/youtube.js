// "Watch a video for me": find a YouTube video (by link or by search words), read its captions and
// summarise them. We cannot watch video: the summary comes from the caption text (or, when the video has
// no captions, from its title and description, and we say so). No dependencies, no key.

const UA = 'Mozilla/5.0 (Macintosh) Safari/605';
const ID_RE = /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/i;

export function videoIdFromUrl(text) {
  const m = typeof text === 'string' ? text.match(ID_RE) : null;
  return m ? m[1] : null;
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Parse the caption JSON3 body into plain text. */
export function captionText(json) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const parts = [];
  for (const e of events) for (const s of e.segs || []) if (typeof s.utf8 === 'string') parts.push(s.utf8);
  return decodeEntities(parts.join('').replace(/\s+/g, ' ').trim());
}

/** Pull ytInitialPlayerResponse out of a watch page. */
export function playerResponse(html) {
  const i = html.indexOf('ytInitialPlayerResponse');
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let p = start; p < html.length; p++) {
    const c = html[p];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { try { return JSON.parse(html.slice(start, p + 1)); } catch { return null; } }
  }
  return null;
}

export function createYoutube({ fetchImpl = globalThis.fetch, summarize, log = () => {}, timeoutMs = 15000 } = {}) {
  async function get(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' }, signal: ctl.signal });
      if (!res.ok) throw new Error(`http ${res.status}`);
      return await res.text();
    } finally { clearTimeout(t); }
  }

  async function findId(query) {
    const direct = videoIdFromUrl(query);
    if (direct) return direct;
    const html = await get(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`);
    const m = html.match(/"videoRenderer":\{"videoId":"([\w-]{11})"/) || html.match(/"videoId":"([\w-]{11})"/);
    return m ? m[1] : null;
  }

  async function summarizeVideo(query) {
    const q = typeof query === 'string' ? query.trim().slice(0, 300) : '';
    if (!q) return { ok: false, error: 'empty' };
    try {
      const id = await findId(q);
      if (!id) return { ok: false, error: 'not_found' };
      const page = await get(`https://www.youtube.com/watch?v=${id}&hl=en`);
      const pr = playerResponse(page);
      const title = String(pr?.videoDetails?.title || '').slice(0, 200);
      const description = String(pr?.videoDetails?.shortDescription || '').slice(0, 1200);
      const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const track = tracks.find((t) => /^en/.test(t.languageCode)) || tracks[0];
      let transcript = '';
      if (track?.baseUrl) {
        try { transcript = captionText(JSON.parse(await get(`${track.baseUrl}&fmt=json3`))); } catch (e) { log(`[youtube] captions: ${e.message}`); }
      }
      const url = `https://www.youtube.com/watch?v=${id}`;
      const material = transcript ? transcript.slice(0, 7000) : `${title}. ${description}`.trim();
      if (!material || material.length < 20) return { ok: false, error: 'no_text', url, title };
      const summary = typeof summarize === 'function' ? await summarize(material, title) : '';
      if (!summary) return { ok: false, error: 'summary_failed', url, title };
      return { ok: true, id, url, title, summary, source: transcript ? 'captions' : 'description' };
    } catch (e) {
      log(`[youtube] ${e.message}`);
      return { ok: false, error: 'unavailable' };
    }
  }

  return { summarize: summarizeVideo };
}
