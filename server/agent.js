// The assistant's brain: free-form Malayalam or English in, a short reply plus a list of
// tool calls out. Runs on Sarvam's chat model (sarvam-105b) with reasoning switched off.
// The model never acts by itself: its output is validated against a fixed tool list here,
// and the Mac app performs the actions (open an app, remind, ...). Anything outside the
// list is dropped. No network in tests: pass a fake fetchImpl.

export const AGENT_MODEL = 'sarvam-105b';
export const CHAT_URL = 'https://api.sarvam.ai/v1/chat/completions';
export const MAX_TEXT = 500;

/** Allowed tools and how to validate their arguments. */
export const TOOLS = Object.freeze({
  open_app: { name: 'string' },
  whatsapp: { contact: 'string?', text: 'string?' },
  remind: { text: 'string', minutes: 'number' },
  timer: { seconds: 'number' },
  tidy_desktop: {},
  translate_clipboard: {},
  media: { command: ['playpause', 'next', 'previous'] },
  set_brightness: { percent: 'percent' },
  set_volume: { percent: 'percent' },
  appearance: { mode: ['dark', 'light', 'toggle'] },
});

const SYSTEM = `You are the assistant inside a Mac notch app used by Malayalam speakers. The user speaks or types in Malayalam or English.
Reply ONLY with one JSON object: {"reply": string, "actions": [{"tool": string, "args": object}]}.
"reply" is one short friendly sentence in the SAME language the user used (Malayalam script for Malayalam).
Tools (use only these):
- open_app {name}: open a Mac app, e.g. WhatsApp, Calendar, Notes, Safari.
- whatsapp {contact, text}: open WhatsApp with a message ready. If the user gave the message content, put it in text (translate it to the language of the contact if they ask; otherwise keep it as spoken).
- remind {text, minutes}: remind the user in N minutes (convert hours to minutes).
- timer {seconds}.
- tidy_desktop {}: scan the desktop and propose a tidy-up.
- translate_clipboard {}.
- media {command}: playpause, next or previous.
- set_brightness {percent}: screen brightness 0-100 ("dim to the lowest" = 0, "brightest" = 100).
- set_volume {percent}: speaker volume 0-100 (mute = 0).
- appearance {mode}: dark, light or toggle the macOS appearance.
If the user only asks a question or chats, answer in "reply" and use "actions": []. Never invent facts about contacts or the user. Never claim you did something that is not in "actions".`;

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/** Validate one model-proposed tool call; return a clean { tool, args } or null. */
export function cleanAction(a) {
  if (!a || typeof a !== 'object' || typeof a.tool !== 'string' || !(a.tool in TOOLS)) return null;
  const spec = TOOLS[a.tool];
  const raw = a.args && typeof a.args === 'object' ? a.args : {};
  const args = {};
  for (const [k, kind] of Object.entries(spec)) {
    const v = raw[k];
    if (Array.isArray(kind)) {
      if (!kind.includes(v)) return null;
      args[k] = v;
    } else if (kind === 'percent') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100) return null;
      args[k] = Math.round(n);
    } else if (kind === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 60 * 24 * 14 * 60) return null;
      args[k] = Math.round(n);
    } else if (kind === 'string') {
      const s = clip(v, 300);
      if (!s) return null;
      args[k] = s;
    } else if (kind === 'string?') {
      const s = clip(v, 600);
      if (s) args[k] = s;
    }
  }
  return { tool: a.tool, args };
}

/** Pull the JSON object out of a model reply (it may be wrapped in a code fence or prose). */
export function parseModelJson(text) {
  if (typeof text !== 'string') return null;
  const body = text.replace(/```(?:json)?/gi, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

export function createAgent({ apiKey, fetchImpl = globalThis.fetch, model = AGENT_MODEL, timeoutMs = 25000, log = () => {} } = {}) {
  const key = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : null;

  async function run({ text }) {
    const q = clip(text, MAX_TEXT);
    if (!q) return { ok: false, error: 'empty', reply: '', actions: [] };
    if (!key) return { ok: true, reply: 'The assistant needs a Sarvam key to understand free-form requests.', actions: [], offline: true };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetchImpl(CHAT_URL, {
        method: 'POST',
        headers: { 'api-subscription-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          model, reasoning_effort: null, temperature: 0.1, max_tokens: 500, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: q }],
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`chat ${res.status}`);
      const data = await res.json();
      const parsed = parseModelJson(data?.choices?.[0]?.message?.content);
      if (!parsed) return { ok: true, reply: '', actions: [], latencyMs: Date.now() - t0, note: 'unparseable' };
      const actions = (Array.isArray(parsed.actions) ? parsed.actions : []).map(cleanAction).filter(Boolean).slice(0, 4);
      return { ok: true, reply: clip(parsed.reply, 400), actions, latencyMs: Date.now() - t0 };
    } catch (e) {
      log(`[agent] ${e.name === 'AbortError' ? 'timeout' : e.message}`);
      return { ok: false, error: 'agent_unavailable', reply: '', actions: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  return { run };
}
