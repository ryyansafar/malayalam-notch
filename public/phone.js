// rowing-call phone page: the phone is the oar.
// Streams devicemotion samples into shared/stroke.js, posts batched stroke
// events and a heartbeat, plays + shows each call that arrives over SSE,
// keeps the screen awake and gives visual + haptic feedback per stroke.

const els = {
  simBadge: document.getElementById('sim-badge'),
  connDot: document.getElementById('conn-dot'),
  connText: document.getElementById('conn-text'),
  startScreen: document.getElementById('start-screen'),
  start: document.getElementById('start'),
  startNote: document.getElementById('start-note'),
  rowScreen: document.getElementById('row-screen'),
  notice: document.getElementById('notice'),
  hero: document.getElementById('hero'),
  spm: document.getElementById('spm'),
  count: document.getElementById('count'),
  call: document.getElementById('call'),
  callBadge: document.getElementById('call-badge'),
  callText: document.getElementById('call-text'),
  callSub: document.getElementById('call-sub'),
  hear: document.getElementById('hear'),
  result: document.getElementById('result'),
  resultText: document.getElementById('result-text'),
  resultStrokes: document.getElementById('result-strokes'),
  resultSub: document.getElementById('result-sub'),
  taprow: document.getElementById('taprow'),
  mic: document.getElementById('mic'),
  micLabel: document.getElementById('mic-label'),
  micTime: document.getElementById('mic-time'),
  micNote: document.getElementById('mic-note'),
};

const STROKE_POST_MS = 500;
const HEARTBEAT_MS = 3000;
const MOTION_TIMEOUT_MS = 3000;
const SIM_TAP_WINDOW_MS = 4000;
const MIC_MAX_MS = 25000; // a dictated call may not exceed the 30 s REST limit; keep margin

// navigator.vibrate patterns: call arrives, obeyed, not obeyed, not sure.
const VIBE = {
  call: [45, 60, 45],
  obeyed: [90],
  notObeyed: [150, 80, 150],
  notSure: [45, 50, 45, 50, 45],
};

let detector = null;
let started = false;
let simulated = false;
let motionSeen = false;
let queue = [];
let simCount = 0;
let lastCount = 0;
let simTaps = [];
let wakeLock = null;
const audio = new Audio();
audio.preload = 'auto';

const humanize = (meaning) =>
  typeof meaning === 'string' && meaning ? meaning.replace(/_/g, ' ').toUpperCase() : '';

// iOS Safari has no navigator.vibrate; feature-detect and stay silent there.
function buzz(pattern) {
  if (typeof navigator.vibrate !== 'function') return;
  try { navigator.vibrate(pattern); } catch { /* haptics must never break the page */ }
}

// Restart a one-shot CSS animation by toggling a class and forcing a reflow.
function replayClass(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function setNotice(text) {
  if (text) {
    els.notice.textContent = text;
    els.notice.hidden = false;
  } else {
    els.notice.hidden = true;
  }
}

function setConn(state) {
  // state: 'connected' | 'reconnecting' | 'connecting'
  els.connText.textContent = state;
  els.connDot.className = `conn-dot ${state}`;
}

// Transient network failures are ignored: the next batch carries new events anyway.
function post(url, body) {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}

function emitStroke(ev) {
  const event = {
    type: 'stroke',
    t: Number.isFinite(ev.t) ? ev.t : performance.now(),
    rateSpm: Number.isFinite(ev.rateSpm) ? ev.rateSpm : null,
    count: Number.isInteger(ev.count) ? ev.count : lastCount + 1,
  };
  lastCount = event.count;
  if (simulated) event.simulated = true;
  queue.push(event);
  if (event.rateSpm !== null) els.spm.textContent = String(Math.round(event.rateSpm));
  els.count.textContent = String(event.count);
  replayClass(els.hero, 'stroke'); // oar swing + splash ring, once per stroke
}

function flush() {
  if (queue.length === 0) return;
  const events = queue;
  queue = [];
  post('/api/stroke', { events, sentAt: performance.now(), simulated });
}

function heartbeat() {
  post('/api/phone', { userAgent: navigator.userAgent, simulated });
}

// --- wake lock ------------------------------------------------------------

// Silently does nothing where the Screen Wake Lock API is missing or denied.
async function holdScreen() {
  if (!('wakeLock' in navigator) || typeof navigator.wakeLock.request !== 'function') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    wakeLock = null;
  }
}

// --- audio ---------------------------------------------------------------

// A short silent WAV built at runtime: played inside the start gesture so
// iOS allows later programmatic play on the same element.
function silentWavUrl() {
  const samples = 1600; // 0.1 s at 8 kHz, 16-bit mono
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function primeAudio() {
  const url = silentWavUrl();
  audio.muted = true;
  audio.src = url;
  audio.play()
    .catch(() => {})
    .finally(() => {
      audio.pause();
      audio.muted = false;
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    });
}

function playCall(call) {
  if (typeof call.ttsAudioBase64 !== 'string' || call.ttsAudioBase64 === '') return;
  const mime = typeof call.mime === 'string' && call.mime.startsWith('audio/') ? call.mime : 'audio/wav';
  audio.src = `data:${mime};base64,${call.ttsAudioBase64}`;
  audio.play().catch(() => {
    els.hear.hidden = false; // autoplay blocked: replay inside a gesture
  });
}

// --- server events ---------------------------------------------------------

function onCall(call) {
  if (typeof call.targetLang === 'string' && call.targetLang) lastCallLang = call.targetLang;
  els.hear.hidden = true;
  els.result.className = 'result';
  els.resultText.textContent = '';
  els.resultStrokes.textContent = '';
  els.resultSub.textContent = '';
  els.callText.textContent = call.spokenText || humanize(call.meaning) || '…';
  els.callSub.textContent = typeof call.translatedText === 'string' && call.translatedText
    ? `heard: “${call.translatedText}”`
    : '';
  els.callBadge.hidden = false;
  els.callBadge.textContent = call.source === 'live' ? 'LIVE' : 'REPLAY';
  els.callBadge.className = `badge ${call.source === 'live' ? 'badge-live' : 'badge-replay'}`;
  replayClass(els.call, 'swap');
  buzz(VIBE.call);
  playCall(call);
}

const strokeWord = (n) => `${n} stroke${n === 1 ? '' : 's'}`;

function onResult(res) {
  const meaning = humanize(res.meaning);
  const reason = typeof res.reason === 'string' && res.reason ? res.reason : '';
  const n = Number.isFinite(res.strokesUntilObeyed) ? res.strokesUntilObeyed : null;
  const seen = Number.isFinite(res.strokesObserved) ? res.strokesObserved : null;
  const took = n !== null ? n : seen;
  if (res.outcome === 'obeyed' || res.obeyed === true) {
    els.result.className = 'result is-obeyed';
    els.resultText.textContent = `Obeyed${meaning ? ` — ${meaning}` : ''}`;
    els.resultStrokes.textContent = took === null ? '' : `took ${strokeWord(took)}`;
    buzz(VIBE.obeyed);
  } else if (res.outcome === 'not_obeyed' || res.obeyed === false) {
    els.result.className = 'result is-not-obeyed';
    els.resultText.textContent = `Not obeyed${meaning ? ` — ${meaning}` : ''}`;
    els.resultStrokes.textContent = seen === null ? '' : `${strokeWord(seen)} counted`;
    buzz(VIBE.notObeyed);
  } else {
    els.result.className = 'result is-not-sure';
    els.resultText.textContent = res.status === 'not_sure'
      ? 'Not sure — ask for the call again'
      : `Not sure${meaning ? ` — ${meaning}` : ''}`;
    els.resultStrokes.textContent = seen === null ? '' : `${strokeWord(seen)} counted`;
    buzz(VIBE.notSure);
  }
  els.resultSub.textContent = reason;
  replayClass(els.result, 'swap');
}

function connectEvents() {
  const es = new EventSource('/events');
  es.addEventListener('open', () => setConn('connected'));
  es.addEventListener('error', () => setConn('reconnecting')); // EventSource retries on its own
  es.addEventListener('call', (e) => { try { onCall(JSON.parse(e.data)); } catch { /* ignore bad event */ } });
  es.addEventListener('result', (e) => { try { onResult(JSON.parse(e.data)); } catch { /* ignore bad event */ } });
}

// --- motion -----------------------------------------------------------------

function enableSimulation(reason) {
  if (simulated) return;
  simulated = true;
  document.body.classList.add('sim');
  els.simBadge.hidden = false;
  els.taprow.hidden = false;
  setNotice(reason ? `${reason} Rowing by taps — simulation.` : 'Rowing by taps — simulation.');
}

function pickAccel(e) {
  for (const a of [e.accelerationIncludingGravity, e.acceleration]) {
    if (a && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)) return a;
  }
  return null;
}

function onMotion(e) {
  const a = pickAccel(e);
  if (!a) return;
  motionSeen = true;
  if (!detector) return;
  let events;
  try {
    events = detector.push({ t: performance.now(), ax: a.x, ay: a.y, az: a.z });
  } catch {
    return; // a bad sample must not stop the stream
  }
  for (const ev of events || []) emitStroke(ev);
}

async function setupMotion() {
  if (typeof DeviceMotionEvent === 'undefined') {
    enableSimulation('Motion sensors are not supported on this device.');
    return;
  }
  try {
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      const answer = await DeviceMotionEvent.requestPermission();
      if (answer !== 'granted') {
        enableSimulation('Motion permission was denied.');
        return;
      }
    }
  } catch {
    enableSimulation('Motion permission was denied.');
    return;
  }
  window.addEventListener('devicemotion', onMotion, true);
  setTimeout(() => {
    if (!motionSeen) {
      window.removeEventListener('devicemotion', onMotion, true);
      enableSimulation('No motion data arrived within 3 seconds.');
    }
  }, MOTION_TIMEOUT_MS);
}

async function loadDetector() {
  try {
    const mod = await import('/shared/stroke.js');
    const d = mod.createStrokeDetector();
    if (!d || typeof d.push !== 'function') throw new TypeError('bad detector');
    detector = d;
    return true;
  } catch {
    detector = null;
    return false;
  }
}

// --- simulated strokes --------------------------------------------------------

function simTap() {
  const t = performance.now();
  simTaps = simTaps.filter((x) => t - x <= SIM_TAP_WINDOW_MS);
  simTaps.push(t);
  simCount += 1;
  let rateSpm = null;
  if (simTaps.length >= 2) {
    const span = simTaps[simTaps.length - 1] - simTaps[0];
    rateSpm = span > 0 ? Math.min(400, Math.round(((simTaps.length - 1) * 60000) / span)) : null;
  }
  emitStroke({ t, rateSpm, count: simCount });
}

// --- coach's microphone ------------------------------------------------------

// The phone doubles as the coach's microphone: a hold dictates a call, which is
// uploaded as a phone_mic shout and arrives back here through the SSE call
// event like any other call. Recording never touches the motion listener, so
// stroke counting keeps running. The mic stream is opened on the first press
// (the browser asks for permission there) and closed on every release, so the
// microphone is only ever open while the button is held.
let micRec = null; // { mr, stream, t0, timer, tick }
let lastCallLang = 'en-IN'; // the language the dashboard last spoke in; a dictated call uses it

const micSupported = () =>
  Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');

const pickMicMime = () => ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
  .find((m) => MediaRecorder.isTypeSupported(m)) || '';

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

let micStarting = false;

async function startMic() {
  if (micRec || micStarting) return;
  if (!micSupported()) {
    setNotice('Recording is not supported on this phone (it needs HTTPS and MediaRecorder). Use the laptop dashboard instead.');
    return;
  }
  micStarting = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    micStarting = false;
    setNotice(err && err.name === 'NotFoundError'
      ? 'No microphone was found on this phone.'
      : 'Microphone permission was denied — the coach can use the laptop dashboard instead.');
    return;
  }
  const mime = pickMicMime();
  let mr;
  try {
    mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch {
    micStarting = false;
    for (const track of stream.getTracks()) track.stop();
    setNotice('This browser cannot record audio. Use the laptop dashboard instead.');
    return;
  }
  micStarting = false;
  const chunks = [];
  let errored = false;
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onerror = () => {
    errored = true; // onstop still fires after an error; it must not send
    finishMic();
    setNotice('Recording stopped unexpectedly. Hold the button to try again.');
  };
  mr.onstop = () => {
    const blob = new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' });
    finishMic();
    if (!errored) sendMic(blob);
  };
  micRec = { mr, stream, t0: performance.now(), timer: 0, tick: 0 };
  mr.start(250);
  els.mic.setAttribute('aria-pressed', 'true');
  els.mic.classList.add('is-rec');
  els.micLabel.textContent = 'RECORDING';
  els.micTime.hidden = false;
  micRec.timer = setTimeout(stopMic, MIC_MAX_MS);
  micRec.tick = setInterval(() => {
    if (micRec) els.micTime.textContent = `${((performance.now() - micRec.t0) / 1000).toFixed(1)} s / ${Math.round(MIC_MAX_MS / 1000)} s`;
  }, 200);
  setNotice('Recording — release to send the call.');
}

function stopMic() {
  if (!micRec) return;
  try {
    if (micRec.mr.state !== 'inactive') micRec.mr.stop(); // onstop -> finishMic -> sendMic
  } catch {
    finishMic();
  }
}

function finishMic() {
  if (!micRec) return;
  clearTimeout(micRec.timer);
  clearInterval(micRec.tick);
  for (const track of micRec.stream.getTracks()) track.stop();
  micRec = null;
  els.mic.setAttribute('aria-pressed', 'false');
  els.mic.classList.remove('is-rec');
  els.micLabel.textContent = 'HOLD TO CALL';
  els.micTime.hidden = true;
}

async function sendMic(blob) {
  if (!blob.size) return setNotice('Nothing was recorded.');
  setNotice('Sending the call…');
  try {
    const res = await fetch('/api/shout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audioBase64: toBase64(await blob.arrayBuffer()), mime: blob.type,
        source: 'phone_mic', targetLang: lastCallLang,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      setNotice(`Call not sent: ${(data && data.error && data.error.message) || `HTTP ${res.status}`}`);
      return;
    }
    setNotice(data.translatedText ? `Heard “${data.translatedText}”.` : 'Call sent.');
  } catch {
    setNotice('Call not sent: could not reach the server.');
  }
}

// --- start --------------------------------------------------------------------

function enterRowScreen() {
  els.startScreen.hidden = true;
  els.rowScreen.hidden = false;
  holdScreen();
  heartbeat();
  setInterval(heartbeat, HEARTBEAT_MS);
  setInterval(flush, STROKE_POST_MS);
  document.addEventListener('visibilitychange', () => {
    flush();
    // The lock is released when the tab hides; re-acquire it on return.
    if (document.visibilityState === 'visible') holdScreen();
  });
  window.addEventListener('pagehide', flush);
}

async function start() {
  if (started) return;
  started = true;
  els.start.disabled = true;
  els.startNote.textContent = 'starting…';
  primeAudio();
  const ok = await loadDetector();
  await setupMotion();
  if (!ok) enableSimulation('Stroke detector not loaded — motion cannot be measured.');
  enterRowScreen();
}

els.start.addEventListener('click', () => {
  start().catch(() => {
    enableSimulation('Startup failed.');
    enterRowScreen();
  });
});
els.taprow.addEventListener('click', simTap);
// Hold-to-record: press starts, release/cancel stops and sends.
els.mic.addEventListener('pointerdown', (e) => { e.preventDefault(); startMic().catch(() => setNotice('Could not start recording.')); });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) els.mic.addEventListener(ev, stopMic);
els.mic.addEventListener('keydown', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startMic().catch(() => {}); }
});
els.mic.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') stopMic(); });
els.mic.addEventListener('contextmenu', (e) => e.preventDefault());
els.hear.addEventListener('click', () => {
  audio.play().then(() => { els.hear.hidden = true; }).catch(() => {});
});

connectEvents();
