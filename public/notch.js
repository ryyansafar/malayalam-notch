// rowing-call notch island: SSE-driven Dynamic-Island UI.
// Pure decisions live in notch-core.js (also run by node:test); this file owns
// the DOM, the /events stream, audio playback and the native-shell bridge.

import {
  nextPhase, verdictOf, verdictReason, countdown, liveSpm, callOriginBadge,
  watchLine, shouldCollapse, SHOUT_SOURCE, malayalamOf, COLLAPSE_AFTER_MS,
} from './notch-core.js';
import { mimeFromName } from '/shared/audio-mime.js';

const $ = (id) => document.getElementById(id);
const els = {
  island: $('island'), dot: $('dot'), oar: $('oar'), spm: $('spm'),
  originBadge: $('origin-badge'), callLane: $('call-lane'), ringFg: $('ring-fg'),
  callMl: $('call-ml'), callText: $('call-text'), callSpoken: $('call-spoken'),
  callSpm: $('call-spm'), callCount: $('call-count'),
  verdict: $('verdict'), verdictIcon: $('verdict-icon'), verdictWord: $('verdict-word'),
  verdictReason: $('verdict-reason'), idleLine: $('idle-line'),
  err: $('err'), noteStatus: $('note-status'), langs: $('langs'), shout: $('shout'),
  mic: $('mic'), speaker: $('speaker'), replay: $('replay'), replayCoach: $('replay-coach'),
  coachLabel: $('coach-label'), coach: $('coach'), quit: $('quit'),
  watch: $('watch'), archive: $('archive'), dropHint: $('drop-hint'),
};

// Notch geometry from the native shell (?nw=&nh=). Zero width = no notch:
// the gap collapses and the pill stands alone.
const qs = new URLSearchParams(location.search);
const notchW = Number(qs.get('nw')) || 0;
const notchH = Number(qs.get('nh')) || 32;
const root = document.documentElement.style;
root.setProperty('--notch-w', `${Math.max(0, notchW)}px`);
root.setProperty('--notch-h', `${Math.max(24, notchH)}px`);

const NOTE_MAX_BYTES = 5 * 1024 * 1024, NOTE_MAX_SECONDS = 30;
const REC_MAX_MS = 25_000, MAX_AUDIO = 8, MAX_STROKES = 600;
const GRACE_MS = 3000; // keep a call view open this long after its window ends
const LANG_LABEL = { 'en-IN': 'English', 'hi-IN': 'Hindi', 'bn-IN': 'Bengali', 'od-IN': 'Odia', 'ta-IN': 'Tamil' };
const VERDICT_ICON = { ok: '✓', bad: '✕', warn: '?' };
const OUTCOME_LABEL = { obeyed: 'obeyed', not_obeyed: 'not obeyed', not_sure: 'not sure' };
const OUTCOME_CLS = { obeyed: 'ok', not_obeyed: 'bad', not_sure: 'warn' };

const ui = {
  phase: 'idle', strokes: [], clockOffset: 0, phone: null,
  call: null, callUntil: 0, result: null,
  audioByCallId: new Map(), currentCallAudio: null, coachAudio: null,
  ownTextByCallId: new Map(), muted: false, busy: false,
  lastActivity: Date.now(), recording: false, hovered: false, serverUp: false,
  targetLang: 'hi-IN', es: null, watchDirsLine: null,
};

const serverNow = () => Date.now() + ui.clockOffset;
const human = (s) => String(s || '').replace(/_/g, ' ');

// ---------- native-shell bridge ----------
const bridge = (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.notch) || null;
const tell = (msg) => { try { bridge && bridge.postMessage(msg); } catch { /* not in the shell */ } };

let sizeQueued = false;
function reportSize() {
  if (sizeQueued) return;
  sizeQueued = true;
  requestAnimationFrame(() => {
    sizeQueued = false;
    const r = els.island.getBoundingClientRect();
    tell({ type: 'size', w: Math.ceil(r.width), h: Math.ceil(r.height) });
  });
}

// ---------- phases & collapse ----------
function setPhase(phase) {
  ui.phase = phase;
  els.island.classList.toggle('phase-call', phase === 'call');
  els.island.classList.toggle('phase-verdict', phase === 'verdict');
  els.island.classList.toggle('phase-idle', phase === 'idle');
}

function expand() {
  if (!els.island.classList.contains('expanded')) {
    els.island.classList.add('expanded');
    els.island.classList.remove('idle');
    reportSize();
  }
  ui.lastActivity = Date.now();
}

function collapse() {
  if (!els.island.classList.contains('expanded')) return;
  els.island.classList.remove('expanded');
  els.island.classList.add('idle');
  setPhase('idle');
  reportSize();
}

function tickCollapse() {
  const open = els.island.classList.contains('expanded');
  if (!open) return;
  const callOpen = ui.phase === 'call' && Date.now() < ui.callUntil;
  const focused = els.island.contains(document.activeElement) && document.activeElement !== document.body;
  if (shouldCollapse(Date.now(), ui.lastActivity, { focused, recording: ui.recording, callOpen: callOpen || ui.hovered })) collapse();
}

// ---------- rendering ----------
function renderDot() {
  const on = ui.phone && ui.phone.connected;
  els.dot.classList.toggle('on', Boolean(on) && ui.serverUp);
  els.dot.classList.toggle('offline', !ui.serverUp);
  els.island.classList.toggle('offline', !ui.serverUp);
  els.dot.title = !ui.serverUp ? 'waiting for server' : on ? 'phone connected' : 'phone not connected';
}

function renderSpm() {
  const spm = liveSpm(ui.strokes, serverNow());
  els.spm.textContent = String(spm);
  els.spm.classList.toggle('dim', spm === 0);
  els.callSpm.textContent = String(spm);
  // The oar pulses faster as the rate climbs: 40 spm ≈ one beat per stroke.
  if (spm > 0) {
    els.oar.classList.add('row');
    els.oar.style.setProperty('--oar-ms', `${Math.max(300, Math.round(60_000 / Math.max(1, spm)))}ms`);
  } else els.oar.classList.remove('row');
}

function renderCall(c) {
  const ml = malayalamOf(c) || (c && c.callId ? ui.ownTextByCallId.get(c.callId) : null);
  els.callMl.hidden = !ml;
  els.callMl.textContent = ml || '';
  els.callText.textContent = (c && c.translatedText) || '(nothing translated)';
  els.callSpoken.textContent = c && c.spokenText ? `“${c.spokenText}”` : '';
  const origin = callOriginBadge(c);
  els.originBadge.hidden = !origin;
  els.originBadge.textContent = origin || '';
  els.callLane.hidden = !(c && c.source);
  els.callLane.textContent = c && c.source === 'live' ? 'LIVE' : 'REPLAY';
  els.callLane.className = `badge ${c && c.source === 'live' ? 'live' : 'replay'}`;
}

function renderVerdict(r) {
  const v = verdictOf(r);
  els.verdict.className = `verdict ${v.cls}`;
  els.verdictIcon.textContent = VERDICT_ICON[v.cls];
  els.verdictWord.textContent = v.word;
  els.verdictReason.textContent = verdictReason(r);
}

function renderWatch(state) {
  const line = watchLine(state) || ui.watchDirsLine;
  els.watch.hidden = !line;
  els.watch.textContent = line || '';
}

function renderLangs(langs) {
  const list = Array.isArray(langs) && langs.length ? langs : Object.keys(LANG_LABEL);
  if (!list.includes(ui.targetLang)) ui.targetLang = list.includes('hi-IN') ? 'hi-IN' : list[0];
  els.langs.textContent = '';
  for (const lang of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(lang === ui.targetLang));
    b.classList.toggle('on', lang === ui.targetLang);
    b.textContent = LANG_LABEL[lang] || lang;
    b.addEventListener('click', () => { ui.targetLang = lang; renderLangs(list); });
    els.langs.appendChild(b);
  }
}

function renderArchive(entries) {
  els.archive.textContent = '';
  for (const e of entries.slice(0, 4)) {
    const li = document.createElement('li');
    const src = document.createElement('span');
    src.className = 'badge dim';
    src.textContent = human(e.source) || 'call';
    li.appendChild(src);
    const lang = document.createElement('span');
    lang.className = 'badge dim';
    lang.textContent = e.language || '—';
    li.appendChild(lang);
    const text = document.createElement('span');
    text.className = 'a-text';
    text.textContent = e.text || e.filename || '(no text)';
    li.appendChild(text);
    const verdict = document.createElement('span');
    const cls = e.verdict ? OUTCOME_CLS[e.verdict] || 'warn' : 'pending';
    verdict.className = `a-verdict ${cls}`;
    verdict.textContent = e.verdict ? OUTCOME_LABEL[e.verdict] || human(e.verdict) : 'pending';
    if (e.reason) verdict.title = e.reason;
    li.appendChild(verdict);
    els.archive.appendChild(li);
  }
}

// ---------- audio out ----------
function stashAudio(c) {
  if (c && c.ttsAudioBase64 && c.mime && c.callId) {
    ui.audioByCallId.set(c.callId, { b64: c.ttsAudioBase64, mime: c.mime });
    while (ui.audioByCallId.size > MAX_AUDIO) ui.audioByCallId.delete(ui.audioByCallId.keys().next().value);
  }
  ui.currentCallAudio = (c && c.callId && ui.audioByCallId.get(c.callId)) || null;
  els.replay.disabled = !ui.currentCallAudio;
}

function playAudio(a) {
  if (!a) return;
  new Audio(`data:${a.mime};base64,${a.b64}`).play().catch(() => setErr('Audio playback was blocked.', 'warn'));
}

// ---------- shout path ----------
async function sendShout(body) {
  const res = await fetch('/api/shout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok && data && data.ok !== false, status: res.status, data };
}

// Preferred notch source first; when the running server rejects it, retry
// once with the closest canonical source so the call still lands.
async function postShout(payload, kind) {
  const src = SHOUT_SOURCE[kind] || { preferred: null, fallback: null };
  const base = { targetLang: ui.targetLang, ...payload };
  let out = await sendShout(src.preferred ? { ...base, source: src.preferred } : base);
  const code = out.data && out.data.error && out.data.error.code;
  if (!out.ok && code === 'invalid_source' && src.fallback) {
    out = await sendShout({ ...base, source: src.fallback });
  }
  return out;
}

function setErr(text, cls = 'bad') {
  els.err.hidden = !text;
  els.err.textContent = text || '';
  els.err.className = `status ${cls}`;
  if (text) { ui.lastActivity = Date.now(); setTimeout(() => { if (els.err.textContent === text) els.err.hidden = true; }, 8000); }
}

function setNote(text, cls = 'muted') {
  els.noteStatus.hidden = !text;
  els.noteStatus.textContent = text || '';
  els.noteStatus.className = `status ${cls}`;
}

function handleShoutResult(out, typedText) {
  if (!out.ok || !out.data) {
    const msg = (out.data && out.data.error && out.data.error.message) || `HTTP ${out.status || '—'}`;
    setErr(out.status === 0 ? 'Shout failed: could not reach the server.' : `Shout failed: ${msg}`);
    return;
  }
  const data = out.data;
  if (data.coachAudioBase64) {
    ui.coachAudio = { b64: data.coachAudioBase64, mime: data.coachMime || 'audio/wav' };
    els.replayCoach.disabled = false;
    if (!ui.muted) playAudio(ui.coachAudio);
  }
  if (data.status === 'not_sure') { onResult(data); return; }
  if (data.callId && typedText) {
    ui.ownTextByCallId.set(data.callId, typedText);
    while (ui.ownTextByCallId.size > 20) ui.ownTextByCallId.delete(ui.ownTextByCallId.keys().next().value);
  }
  onCall(data); // same record as the SSE call event; idempotent
  loadArchive();
}

async function sendText() {
  const text = els.shout.value.trim();
  if (!text || ui.busy) return;
  els.shout.value = '';
  ui.busy = true;
  setErr('');
  try {
    const out = await postShout({ text, coachPlayback: els.coach.checked || undefined }, 'text');
    handleShoutResult(out, text);
  } catch {
    setErr('Shout failed: could not reach the server.');
  } finally {
    ui.busy = false;
  }
}

// ---------- microphone in ----------
let rec = null;

const pickMime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac']
  .find((m) => MediaRecorder.isTypeSupported(m)) || '';

function micUnavailable(reason) {
  els.mic.hidden = true;
  setNote(`hold-to-talk unavailable: ${reason}`, 'warn');
}

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    return micUnavailable('this build cannot open the microphone');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return micUnavailable('macOS refused the microphone — allow it once under System Settings → Privacy & Security → Microphone');
  }
  const mime = pickMime();
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onstop = () => {
    const blob = new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' });
    finishRecording();
    if (!blob.size) return setErr('Nothing was recorded.', 'warn');
    blob.arrayBuffer().then((buf) => postShout({ audioBase64: toBase64(buf), mime: blob.type }, 'mic')
      .then((out) => handleShoutResult(out, null))
      .catch(() => setErr('Could not send the recording.')));
  };
  rec = { mr, stream, autoStop: setTimeout(stopRecording, REC_MAX_MS) };
  ui.recording = true;
  expand();
  els.mic.classList.add('rec');
  els.mic.textContent = 'recording… tap to send';
  mr.start(250);
}

function stopRecording() { if (rec && rec.mr.state !== 'inactive') rec.mr.stop(); }

function finishRecording() {
  if (!rec) return;
  clearTimeout(rec.autoStop);
  for (const track of rec.stream.getTracks()) track.stop();
  rec = null;
  ui.recording = false;
  ui.lastActivity = Date.now();
  els.mic.classList.remove('rec');
  els.mic.textContent = 'hold to talk';
}

// ---------- voice-note drop ----------
function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const done = (sec) => { URL.revokeObjectURL(url); resolve(sec); };
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', () => done(Number.isFinite(audio.duration) ? audio.duration : null));
    audio.addEventListener('error', () => done(null));
    audio.src = url;
    setTimeout(() => done(null), 4000);
  });
}

async function sendNote(file) {
  if (file.size > NOTE_MAX_BYTES) return setErr(`"${file.name}" is ${(file.size / 1e6).toFixed(1)} MB — the limit is 5 MB.`);
  setNote(`Checking "${file.name}"…`);
  const seconds = await probeDuration(file);
  if (seconds !== null && seconds > NOTE_MAX_SECONDS) {
    return setErr(`"${file.name}" is about ${Math.round(seconds)} s — speech-to-text accepts clips up to 30 s.`);
  }
  try {
    const buf = await file.arrayBuffer();
    setNote(`Sending "${file.name}"…`);
    const out = await postShout({ audioBase64: toBase64(buf), mime: mimeFromName(file.name, file.type), filename: file.name }, 'drop');
    handleShoutResult(out, null);
    setNote(`"${file.name}" sent as a voice note.`, 'ok');
  } catch {
    setErr(`Could not read "${file.name}".`);
  }
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

// ---------- archive ----------
async function loadArchive() {
  const res = await fetch('/api/archive').catch(() => null);
  const data = res && res.ok ? await res.json().catch(() => null) : null;
  if (data && data.ok && Array.isArray(data.entries)) renderArchive(data.entries);
}

// ---------- events ----------
function onCall(c) {
  if (!c || typeof c !== 'object' || c.status !== 'ok' || !c.meaning) return;
  ui.call = c;
  ui.result = null;
  ui.callUntil = Date.now() + (Number.isFinite(c.windowMs) ? c.windowMs : 8000) + GRACE_MS;
  stashAudio(c);
  renderCall(c);
  setPhase('call');
  expand();
  if (!ui.muted && ui.currentCallAudio) playAudio(ui.currentCallAudio);
}

function onResult(r) {
  if (!r || typeof r !== 'object') return;
  ui.result = r;
  ui.call = null;
  ui.callUntil = 0;
  renderVerdict(r);
  setPhase('verdict');
  expand();
  ui.lastActivity = Date.now();
  loadArchive();
}

function applyState(s) {
  if (!s || typeof s !== 'object') return;
  if (Number.isFinite(s.serverT)) ui.clockOffset = s.serverT - Date.now();
  if (s.phone) { ui.phone = s.phone; renderDot(); }
  if (Array.isArray(s.recentStrokes)) mergeStrokes(s.recentStrokes);
  if (s.langs) renderLangs(s.langs);
  renderWatch(s);
  // A page that opened after a call/result still shows what it missed.
  if (s.lastCall && (!ui.call || s.lastCall.callId !== ui.call.callId) && !ui.result) {
    const age = serverNow() - (s.lastCall.t || 0);
    if (age < (s.lastCall.windowMs || 8000) + GRACE_MS) {
      ui.call = s.lastCall; ui.callUntil = Date.now() + (s.lastCall.windowMs || 8000) + GRACE_MS - age;
      stashAudio(s.lastCall); renderCall(s.lastCall); setPhase('call'); expand();
    }
  }
  if (s.lastResult && !ui.result) { ui.result = s.lastResult; renderVerdict(s.lastResult); }
}

function mergeStrokes(events) {
  const byT = new Map(ui.strokes.map((s) => [s.t, s]));
  for (const e of events) if (Number.isFinite(e.t)) byT.set(e.t, e);
  ui.strokes = [...byT.values()].sort((a, b) => a.t - b.t).slice(-MAX_STROKES);
}

function connect() {
  if (ui.es) ui.es.close();
  ui.es = new EventSource('/events');
  ui.es.onopen = () => { ui.serverUp = true; renderDot(); };
  ui.es.onerror = () => {
    ui.serverUp = false; renderDot();
    if (ui.es.readyState === EventSource.CLOSED) setTimeout(connect, 2000);
  };
  const dispatch = {
    state: applyState,
    stroke: (e) => { if (e && Number.isFinite(e.t)) mergeStrokes([e]); },
    call: onCall,
    result: onResult,
    phone: (p) => { ui.phone = p; renderDot(); },
  };
  for (const [name, fn] of Object.entries(dispatch)) {
    ui.es.addEventListener(name, (e) => { try { fn(JSON.parse(e.data)); } catch { /* malformed event: ignore */ } });
  }
}

// ---------- countdown ring + clock ----------
const RING_LEN = 100;
function tick() {
  renderSpm();
  renderDot();
  if (ui.phase === 'call' && ui.call) {
    const left = countdown(serverNow(), ui.call.t, ui.call.windowMs || 8000);
    els.ringFg.style.strokeDashoffset = String(RING_LEN * (1 - left));
    els.callCount.textContent = (left * (ui.call.windowMs || 8000) / 1000).toFixed(1);
  }
  tickCollapse();
}

// ---------- providers (coach playback + watched folders) ----------
fetch('/api/providers').then((r) => (r.ok ? r.json() : null)).then((info) => {
  if (!info) return;
  els.coachLabel.hidden = !info.coachPlayback;
  // The voice-note folder watcher reports its folders here when it is enabled.
  if (Array.isArray(info.watchDirs) && info.watchDirs.length) {
    const dirs = info.watchDirs.map((d) => String(d).replace(/^\/Users\/[^/]+/, '~'));
    ui.watchDirsLine = `watching ${dirs.join(', ')}`;
    renderWatch(null);
  }
}).catch(() => {});

// ---------- wiring ----------
els.island.addEventListener('mouseenter', () => { ui.hovered = true; tell({ type: 'hover', on: true }); expand(); });
els.island.addEventListener('mouseleave', () => { ui.hovered = false; ui.lastActivity = Date.now(); tell({ type: 'hover', on: false }); });
els.island.addEventListener('focusin', () => { ui.lastActivity = Date.now(); });
els.island.addEventListener('focusout', () => { ui.lastActivity = Date.now(); });
els.island.addEventListener('pointerdown', () => { ui.lastActivity = Date.now(); }, true);

els.shout.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendText(); }
});
els.mic.addEventListener('pointerdown', (e) => { if (!rec) { e.preventDefault(); startRecording(); } });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  els.mic.addEventListener(ev, () => { if (rec) stopRecording(); });
}
els.mic.addEventListener('keydown', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
    e.preventDefault();
    if (rec) stopRecording(); else startRecording();
  }
});
els.speaker.addEventListener('click', () => {
  ui.muted = !ui.muted;
  els.speaker.textContent = ui.muted ? 'muted' : 'sound on';
  els.speaker.setAttribute('aria-pressed', String(!ui.muted));
});
els.replay.addEventListener('click', () => playAudio(ui.currentCallAudio));
els.replayCoach.addEventListener('click', () => playAudio(ui.coachAudio));
els.quit.addEventListener('click', () => { tell({ type: 'quit' }); window.close(); });

for (const ev of ['dragenter', 'dragover']) {
  els.island.addEventListener(ev, (e) => { e.preventDefault(); expand(); els.island.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  els.island.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || !els.island.contains(e.relatedTarget)) els.island.classList.remove('over'); });
}
els.island.addEventListener('drop', (e) => {
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) sendNote(file);
});
for (const ev of ['dragover', 'drop']) window.addEventListener(ev, (e) => e.preventDefault());

// ---------- init ----------
fetch('/api/state').then((r) => (r.ok ? r.json() : null)).then((s) => {
  ui.serverUp = Boolean(s);
  applyState(s);
  renderDot();
  reportSize();
}).catch(() => { ui.serverUp = false; renderDot(); });
renderLangs(null);
loadArchive();
connect();
setInterval(tick, 250);
tick();
reportSize();
