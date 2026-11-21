// rowing-call dashboard: 3D hero, shout box, call/obedience cards, provider
// switch, evidence table. /api/* + /events SSE. ES module, no build step.

import { createScene } from './scene.js';

const $ = (id) => document.getElementById(id);
const els = {};
for (const [k, id] of Object.entries({
  modeBadge: 'mode-badge', phoneBadge: 'phone-badge', sseBadge: 'sse-badge',
  qrImg: 'qr-img', qrUrl: 'qr-url', spm: 'spm', spark: 'spark', strokeMeta: 'stroke-meta',
  shoutText: 'shout-text', sendText: 'send-text', rec: 'rec', recUi: 'rec-ui',
  level: 'level', recTime: 'rec-time', shoutStatus: 'shout-status', callText: 'call-text',
  callMeaning: 'call-meaning', callConf: 'call-conf', callSrc: 'call-src', callLat: 'call-lat',
  callExtra: 'call-extra', callMatchedBy: 'call-matchedby', callEars: 'call-ears',
  callTts: 'call-tts', replay: 'replay', replayCoach: 'replay-coach',
  obeyVerdict: 'obey-verdict', obeyDetail: 'obey-detail', tally: 'tally',
  ttsSummary: 'tts-summary', trials: 'trials', providerNote: 'provider-note',
  coachRow: 'coach-row', coach: 'coach',
})) els[k] = $(id);

const SPARK_WINDOW_MS = 60_000, STROKE_STALE_MS = 4_000, PHONE_QUIET_MS = 12_000;
const REC_MAX_MS = 8_000, MAX_STROKES = 600, MAX_AUDIO = 24;
const PROVIDER_LABEL = { sarvam: 'Sarvam', smallest: 'smallest.ai' };

const ui = {
  strokes: [], clockOffset: 0, phone: null,
  audioByCallId: new Map(), currentAudio: null, coachAudio: null,
  trials: [], busy: false,
};

const scene = createScene($('scene'));

const serverNow = () => Date.now() + ui.clockOffset;
const human = (s) => String(s || '').replace(/_/g, ' ');
const esc = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
const label = (p) => PROVIDER_LABEL[p] || p || '—';

function setStatus(text, cls = '') {
  els.shoutStatus.textContent = text;
  els.shoutStatus.className = `status${cls ? ` ${cls}` : ''}`;
}
const setBadge = (el, text, cls) => { el.textContent = text; el.className = `badge ${cls}`; };

// header
const renderMode = (mode) => setBadge(els.modeBadge, mode === 'live' ? 'LIVE' : 'REPLAY',
  mode === 'live' ? 'live' : 'replay');

function renderPhone() {
  const p = ui.phone;
  if (!p || !p.connected) { setBadge(els.phoneBadge, 'phone not connected', 'dim'); return; }
  const quiet = Number.isFinite(p.lastSeenT) && serverNow() - p.lastSeenT > PHONE_QUIET_MS;
  const ago = Number.isFinite(p.lastSeenT)
    ? ` · ${Math.max(0, Math.round((serverNow() - p.lastSeenT) / 1000))}s ago` : '';
  setBadge(els.phoneBadge, `phone ${quiet ? 'quiet' : 'connected'}${p.simulated ? ' (sim)' : ''}${ago}`,
    quiet ? 'bad' : 'live');
}

// providers (voice switch + coach playback)
function renderProviders(info) {
  const prov = (info && info.providers) || {};
  const allowed = new Set((info && info.ttsProviders) || ['sarvam']);
  const notes = [];
  const inputs = [...document.querySelectorAll('input[name="tts"]')];
  for (const input of inputs) {
    const p = prov[input.value] || {};
    input.disabled = !allowed.has(input.value);
    input.closest('label').title = input.disabled
      ? `${label(input.value)} is not available on this server`
      : `${label(input.value)} ${p.configured ? 'configured' : 'not configured'}${p.mode ? ` · ${p.mode}` : ''}`;
    notes.push(`${label(input.value)} ${p.configured ? 'configured' : 'no key'}`);
    if (input.disabled && input.checked) input.checked = false;
  }
  const first = inputs.find((i) => !i.disabled);
  if (first && !inputs.some((i) => i.checked && !i.disabled)) first.checked = true;
  els.providerNote.textContent = info ? notes.join(' · ') : 'providers unknown — Sarvam assumed';
  els.coachRow.hidden = !(info && info.coachPlayback);
}

const checked = (name, dflt) => (document.querySelector(`input[name="${name}"]:checked`) || {}).value || dflt;

// sparkline + live rate
function mergeStrokes(events) {
  const byT = new Map(ui.strokes.map((s) => [s.t, s]));
  for (const e of events) if (Number.isFinite(e.t)) byT.set(e.t, e);
  ui.strokes = [...byT.values()].sort((a, b) => a.t - b.t).slice(-MAX_STROKES);
}

const ctx = els.spark.getContext('2d');

function drawSpark() {
  const c = els.spark;
  const w = c.clientWidth || 1;
  const h = c.clientHeight || 110;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const start = serverNow() - SPARK_WINDOW_MS;
  const pts = ui.strokes.filter((s) => s.t >= start && s.t <= serverNow());
  ctx.strokeStyle = 'rgba(120,124,100,0.35)';
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  ctx.fillStyle = '#a9ab9f';
  ctx.font = '12px system-ui, sans-serif';
  if (pts.length < 2) return ctx.fillText(pts.length ? 'collecting…' : 'no strokes in the last 60 s', 10, h / 2);
  const max = Math.max(40, ...pts.map((p) => p.rateSpm || 0));
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = ((p.t - start) / SPARK_WINDOW_MS) * w;
    const y = h - 4 - ((p.rateSpm || 0) / max) * (h - 10);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#e0a030';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(`${Math.round(max)} spm`, 6, 14);
  ctx.fillText('now', w - 26, h - 6);
}

function tick() {
  const now = serverNow();
  ui.strokes = ui.strokes.filter((s) => now - s.t <= SPARK_WINDOW_MS + 5_000);
  const last = ui.strokes[ui.strokes.length - 1];
  const stale = !last || now - last.t > STROKE_STALE_MS;
  els.spm.textContent = String(stale ? 0 : Math.round(last.rateSpm || 0));
  els.spm.classList.toggle('dim', stale);
  els.strokeMeta.textContent = last
    ? `stroke #${esc(last.count)} · ${Math.round(last.rateSpm || 0)} spm${last.simulated ? ' · simulated' : ''}`
    : 'waiting for the phone';
  renderPhone();
  drawSpark();
}

// call + obedience cards
function stashAudio(call) {
  if (call.ttsAudioBase64 && call.mime && call.callId) {
    ui.audioByCallId.set(call.callId, { b64: call.ttsAudioBase64, mime: call.mime });
    while (ui.audioByCallId.size > MAX_AUDIO) ui.audioByCallId.delete(ui.audioByCallId.keys().next().value);
  }
  els.replay.disabled = !(ui.currentAudio = (call.callId && ui.audioByCallId.get(call.callId)) || null);
}

function onCall(c) {
  if (!c || typeof c !== 'object') return;
  stashAudio(c);
  els.callText.textContent = c.translatedText || '(nothing translated)';
  els.callMeaning.textContent = c.meaning ? human(c.meaning) : 'not recognised';
  els.callConf.textContent = esc(c.confidence);
  setBadge(els.callSrc, c.source === 'live' ? 'LIVE' : 'REPLAY', c.source === 'live' ? 'live' : 'replay');
  setBadge(els.callMatchedBy, c.matchedBy ? human(c.matchedBy) : '—', c.matchedBy === 'model' ? 'replay' : 'dim');
  setBadge(els.callEars, c.ears ? human(c.ears) : '—', c.ears === 'agree' ? 'live' : c.ears === 'disagree' ? 'bad' : 'dim');
  els.callLat.textContent = Number.isFinite(c.latencyMs) ? `${c.latencyMs} ms` : '—';
  els.callTts.textContent = c.tts
    ? `${label(c.tts.provider)} · ${c.tts.latencyMs} ms${c.tts.source === 'live' ? '' : ' (replay)'}`
    : (c.ttsProvider ? label(c.ttsProvider) : '—');
  els.callExtra.textContent = [
    c.spokenText ? `spoken: "${c.spokenText}"` : '',
    c.model && c.model.name ? `model: ${c.model.name}` : '',
  ].filter(Boolean).join(' · ');
  scene.flash(c.meaning);
  if (c.status === 'ok' || c.meaning) {
    const win = Number.isFinite(c.windowMs) ? Math.round(c.windowMs / 1000) : 8;
    setVerdict('none', 'watching strokes…', `judging obedience over a ${win} s window`);
  }
}

function setVerdict(cls, verdict, detail) {
  els.obeyVerdict.className = `verdict ${cls}`;
  els.obeyVerdict.textContent = verdict;
  els.obeyDetail.textContent = detail || '';
}

function onResult(r) {
  if (!r || typeof r !== 'object') return;
  addTrial(r);
  scene.setResult(r.outcome);
  const n = r.strokesUntilObeyed;
  if (r.outcome === 'obeyed') setVerdict('ok', `Obeyed in ${n === null ? '?' : n} stroke${n === 1 ? '' : 's'}`, detailOf(r));
  else if (r.outcome === 'not_obeyed') setVerdict('bad', 'Not obeyed', detailOf(r));
  else setVerdict('warn', r.status === 'not_sure' ? 'Not sure — meaning not recognised' : 'Not sure', detailOf(r));
}

function detailOf(r) {
  return [
    r.reason,
    Number.isFinite(r.deltaSpm) ? `Δ ${r.deltaSpm > 0 ? '+' : ''}${Math.round(r.deltaSpm)} spm` : '',
    Number.isFinite(r.strokesObserved) ? `${r.strokesObserved} strokes observed` : '',
    r.superseded ? 'window cut short by a newer call' : '',
    r.source ? (r.source === 'live' ? 'live' : 'replay') : '',
  ].filter(Boolean).join(' · ');
}

function playAudio(a) {
  if (a) new Audio(`data:${a.mime};base64,${a.b64}`).play()
    .catch(() => setStatus('Audio playback was blocked by the browser.', 'warn'));
}

// evidence table
const OUTCOME_LABEL = { obeyed: 'obeyed', not_obeyed: 'not obeyed', not_sure: 'not sure' };
const OUTCOME_CLS = { obeyed: 'ok', not_obeyed: 'bad', not_sure: 'warn' };

function cell(tr, text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  tr.appendChild(td);
  return td;
}

function renderTrials() {
  const rows = ui.trials;
  els.trials.textContent = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    cell(tr, 'waiting for the first shout', 'muted').colSpan = 7;
    els.trials.appendChild(tr);
  } else {
    const frag = document.createDocumentFragment();
    for (const t of [...rows].reverse()) {
      const tr = document.createElement('tr');
      const live = t.source === 'live';
      cell(tr, Number.isFinite(t.t) ? new Date(t.t).toLocaleTimeString('en-GB', { hour12: false }) : '—', 'time');
      cell(tr, esc(t.translatedText));
      cell(tr, t.meaning ? human(t.meaning) : '—');
      cell(tr, live ? 'live' : 'replay', live ? 'src-live' : 'src-replay');
      cell(tr, t.tts && t.tts.provider
        ? `${label(t.tts.provider)}${Number.isFinite(t.tts.latencyMs) ? ` · ${t.tts.latencyMs} ms` : ''}`
        : (t.ttsProvider ? label(t.ttsProvider) : '—'));
      cell(tr, Number.isFinite(t.latencyMs) ? `${t.latencyMs} ms` : '—');
      cell(tr, OUTCOME_LABEL[t.outcome] || esc(t.outcome), `outcome ${OUTCOME_CLS[t.outcome] || ''}`);
      frag.appendChild(tr);
    }
    els.trials.appendChild(frag);
  }
  // Tally and the per-provider latency summary are always computed from the
  // rows shown above — never from a claimed figure.
  const c = { obeyed: 0, not_obeyed: 0, not_sure: 0 };
  const sums = {}, sumsTts = {};
  for (const t of rows) {
    if (t.outcome in c) c[t.outcome] += 1;
    const p = t.ttsProvider || (t.tts && t.tts.provider);
    if (!p) continue;
    if (Number.isFinite(t.latencyMs)) {
      (sums[p] = sums[p] || { n: 0, ms: 0 }).n += 1; sums[p].ms += t.latencyMs;
    }
    if (t.tts && Number.isFinite(t.tts.latencyMs)) {
      (sumsTts[p] = sumsTts[p] || { n: 0, ms: 0 }).n += 1; sumsTts[p].ms += t.tts.latencyMs;
    }
  }
  const judged = c.obeyed + c.not_obeyed;
  const pct = judged ? ` · ${Math.round((100 * c.obeyed) / judged)}% of judged` : '';
  els.tally.textContent = rows.length
    ? `${rows.length} trial${rows.length === 1 ? '' : 's'} — obeyed ${c.obeyed} · not obeyed ${c.not_obeyed} · not sure ${c.not_sure}${pct}`
    : 'no trials yet';
  const avg = (o) => Object.entries(o).map(([p, s]) => `${label(p)} ${Math.round(s.ms / s.n)} ms (n=${s.n})`).join(' · ');
  els.ttsSummary.textContent = Object.keys(sums).length
    ? `pipeline avg: ${avg(sums)}${Object.keys(sumsTts).length ? ` — voice avg: ${avg(sumsTts)}` : ''}` : '';
}

function addTrial(t) {
  if (t && !ui.trials.some((x) => x.callId && x.callId === t.callId)) ui.trials.push(t);
  renderTrials();
}

// state snapshot
function applyState(s) {
  if (!s || typeof s !== 'object') return;
  if (Number.isFinite(s.serverT)) ui.clockOffset = s.serverT - Date.now();
  if (typeof s.mode === 'string') renderMode(s.mode);
  if (s.phone) { ui.phone = s.phone; renderPhone(); }
  if (Array.isArray(s.recentStrokes)) {
    mergeStrokes(s.recentStrokes);
    const last = s.recentStrokes[s.recentStrokes.length - 1];
    if (last && Number.isFinite(last.rateSpm)) scene.setStrokeRate(last.rateSpm);
  }
  if (Array.isArray(s.trials)) { ui.trials = s.trials.slice(); renderTrials(); }
  if (s.lastCall) onCall(s.lastCall);
  if (s.lastResult) onResult(s.lastResult);
}

// shout
function setBusy(busy) {
  ui.busy = busy;
  els.sendText.disabled = els.shoutText.disabled = busy;
  els.rec.disabled = busy && !rec;
}

async function postShout(payload) {
  if (ui.busy) return;
  setBusy(true);
  setStatus('Shout sent — translating and matching…');
  try {
    const res = await fetch('/api/shout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetLang: checked('lang', 'hi-IN'), ttsProvider: checked('tts', 'sarvam'),
        coachPlayback: payload.text ? els.coach.checked : false, ...payload,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      setStatus(`Shout failed: ${(data && data.error && data.error.message) || `HTTP ${res.status}`}`, 'bad');
      return;
    }
    if (data.coachAudioBase64) {
      ui.coachAudio = { b64: data.coachAudioBase64, mime: data.coachMime || 'audio/wav' };
      els.replayCoach.disabled = false;
      playAudio(ui.coachAudio);
    }
    if (data.status === 'not_sure') {
      setStatus('Not sure, please shout again', 'warn');
      onResult(data);
      return;
    }
    onCall(data); // the SSE 'call' event carries the same record; rendering here is idempotent
    setStatus(`Heard "${data.translatedText || ''}" → ${human(data.meaning)} — judging obedience…`, 'ok');
  } catch {
    setStatus('Shout failed: could not reach the server.', 'bad');
  } finally {
    setBusy(false);
  }
}

function sendText() {
  const text = els.shoutText.value.trim();
  if (!text) return setStatus('Type a shout first, or use Record.', 'warn');
  els.shoutText.value = '';
  postShout({ text });
}

// recording (MediaRecorder)
let rec = null; // { mr, stream, audioCtx, analyser, raf, autoStop, t0 }

const pickMime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac']
  .find((m) => MediaRecorder.isTypeSupported(m)) || '';

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    return setStatus('Recording needs localhost or HTTPS — type a shout instead.', 'warn');
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {
    return setStatus('Microphone permission denied — type a shout instead.', 'warn');
  }
  const mime = pickMime();
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onstop = () => {
    const blob = new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' });
    finishRecording();
    if (!blob.size) return setStatus('Nothing was recorded.', 'warn');
    blob.arrayBuffer().then((buf) => postShout({ audioBase64: toBase64(buf), mime: blob.type }));
  };
  rec = { mr, stream, audioCtx: null, analyser: null, raf: 0, autoStop: 0, t0: performance.now() };
  try { // level meter is optional
    const AC = window.AudioContext || window.webkitAudioContext;
    rec.audioCtx = new AC();
    rec.analyser = rec.audioCtx.createAnalyser();
    rec.analyser.fftSize = 256;
    rec.audioCtx.createMediaStreamSource(stream).connect(rec.analyser);
  } catch { /* no meter */ }
  mr.start(250);
  els.rec.setAttribute('aria-pressed', 'true');
  els.rec.textContent = 'Stop & send';
  els.recUi.hidden = false;
  rec.autoStop = setTimeout(stopRecording, REC_MAX_MS);
  rec.raf = requestAnimationFrame(levelLoop);
}

function stopRecording() { if (rec && rec.mr.state !== 'inactive') rec.mr.stop(); } // onstop -> finishRecording

function finishRecording() {
  if (!rec) return;
  clearTimeout(rec.autoStop);
  cancelAnimationFrame(rec.raf);
  for (const track of rec.stream.getTracks()) track.stop();
  if (rec.audioCtx) rec.audioCtx.close().catch(() => {});
  rec = null;
  els.rec.setAttribute('aria-pressed', 'false');
  els.rec.textContent = 'Record shout';
  els.recUi.hidden = true;
  els.level.style.width = '0';
}

function levelLoop() {
  if (!rec) return;
  if (rec.analyser) {
    const buf = new Uint8Array(rec.analyser.fftSize);
    rec.analyser.getByteTimeDomainData(buf);
    const rms = Math.sqrt(buf.reduce((s, v) => s + (v - 128) * (v - 128), 0) / buf.length) / 128;
    els.level.style.width = `${Math.min(100, Math.round(rms * 250))}%`;
  }
  els.recTime.textContent = `${((performance.now() - rec.t0) / 1000).toFixed(1)} s / 8 s max`;
  rec.raf = requestAnimationFrame(levelLoop);
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

// SSE
let es = null;

function connect() {
  if (es) es.close();
  es = new EventSource('/events');
  es.onopen = () => setBadge(els.sseBadge, 'events live', 'live');
  es.onerror = () => {
    setBadge(els.sseBadge, 'events reconnecting', 'bad');
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 2000);
  };
  const dispatch = { state: applyState, stroke: onStroke, call: onCall, result: onResult,
    phone: (p) => { ui.phone = p; renderPhone(); } };
  for (const [name, fn] of Object.entries(dispatch)) {
    es.addEventListener(name, (e) => { try { fn(JSON.parse(e.data)); } catch { /* malformed event: ignore */ } });
  }
}

function onStroke(e) {
  if (!e || !Number.isFinite(e.t)) return;
  mergeStrokes([e]);
  if (Number.isFinite(e.rateSpm)) scene.setStrokeRate(e.rateSpm);
}

// init
const phoneUrl = `${location.origin}/phone`;
els.qrImg.src = `/qr.svg?url=${encodeURIComponent(phoneUrl)}`;
els.qrUrl.textContent = phoneUrl;
els.qrUrl.href = '/phone';

els.sendText.addEventListener('click', sendText);
els.shoutText.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });
els.rec.addEventListener('click', () => (rec ? stopRecording() : startRecording()));
els.replay.addEventListener('click', () => playAudio(ui.currentAudio));
els.replayCoach.addEventListener('click', () => playAudio(ui.coachAudio));

fetch('/api/state').then((r) => (r.ok ? r.json() : null)).then(applyState).catch(() => {});
fetch('/api/providers').then((r) => (r.ok ? r.json() : null)).then(renderProviders).catch(() => renderProviders(null));
connect();
setInterval(tick, 500);
tick();
