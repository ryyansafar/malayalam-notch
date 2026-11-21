// rowing-call dashboard: shout box, stroke sparkline, call + obedience cards,
// and the evidence table. Talks to /api/* and subscribes to /events (SSE).
// ES module, zero dependencies, no build step.

const $ = (id) => document.getElementById(id);
const els = {
  modeBadge: $('mode-badge'), phoneBadge: $('phone-badge'), sseBadge: $('sse-badge'),
  qrImg: $('qr-img'), qrUrl: $('qr-url'),
  spm: $('spm'), spark: $('spark'), strokeMeta: $('stroke-meta'),
  lang: $('lang'), shoutText: $('shout-text'), sendText: $('send-text'),
  rec: $('rec'), recUi: $('rec-ui'), level: $('level'), recTime: $('rec-time'),
  shoutStatus: $('shout-status'),
  callText: $('call-text'), callMeaning: $('call-meaning'), callConf: $('call-conf'),
  callSrc: $('call-src'), callLat: $('call-lat'), callExtra: $('call-extra'), replay: $('replay'),
  obeyVerdict: $('obey-verdict'), obeyDetail: $('obey-detail'),
  tally: $('tally'), trials: $('trials'),
};

const SPARK_WINDOW_MS = 60_000;
const STROKE_STALE_MS = 4_000;
const PHONE_QUIET_MS = 12_000;
const REC_MAX_MS = 8_000;
const MAX_STROKES = 600;
const MAX_AUDIO = 24;

const ui = {
  strokes: [],          // { t (server ms), rateSpm, count, simulated }
  clockOffset: 0,       // serverT - Date.now()
  phone: null,
  audioByCallId: new Map(),
  currentAudio: null,   // { b64, mime } for the call card's replay button
  trials: [],
  busy: false,
};

const serverNow = () => Date.now() + ui.clockOffset;
const human = (s) => String(s || '').replace(/_/g, ' ');
const esc = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

function setStatus(text, cls = '') {
  els.shoutStatus.textContent = text;
  els.shoutStatus.className = `status${cls ? ` ${cls}` : ''}`;
}

function setBadge(el, text, cls) {
  el.textContent = text;
  el.className = `badge ${cls}`;
}

// ---------- header ----------

function renderMode(mode) {
  setBadge(els.modeBadge, mode === 'live' ? 'LIVE' : 'REPLAY', mode === 'live' ? 'live' : 'replay');
}

function renderPhone() {
  const p = ui.phone;
  if (!p || !p.connected) {
    setBadge(els.phoneBadge, 'phone not connected', 'dim');
    return;
  }
  const quiet = Number.isFinite(p.lastSeenT) && serverNow() - p.lastSeenT > PHONE_QUIET_MS;
  const ago = Number.isFinite(p.lastSeenT)
    ? ` · ${Math.max(0, Math.round((serverNow() - p.lastSeenT) / 1000))}s ago` : '';
  setBadge(els.phoneBadge,
    `phone ${quiet ? 'quiet' : 'connected'}${p.simulated ? ' (sim)' : ''}${ago}`,
    quiet ? 'bad' : 'live');
}

// ---------- sparkline ----------

function mergeStrokes(events) {
  const byT = new Map(ui.strokes.map((s) => [s.t, s]));
  for (const e of events) {
    if (Number.isFinite(e.t)) byT.set(e.t, { t: e.t, rateSpm: e.rateSpm, count: e.count, simulated: e.simulated });
  }
  ui.strokes = [...byT.values()].sort((a, b) => a.t - b.t).slice(-MAX_STROKES);
}

const ctx = els.spark.getContext('2d');

function drawSpark() {
  const c = els.spark;
  const w = c.clientWidth || 1;
  const h = c.clientHeight || 150;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const end = serverNow();
  const start = end - SPARK_WINDOW_MS;
  const pts = ui.strokes.filter((s) => s.t >= start && s.t <= end);

  ctx.strokeStyle = '#2a2c22';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  if (pts.length < 2) {
    ctx.fillStyle = '#a9ab9f';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText(pts.length ? 'collecting…' : 'no strokes in the last 60 s', 10, h / 2);
    return;
  }
  const max = Math.max(40, ...pts.map((p) => p.rateSpm || 0));
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = ((p.t - start) / SPARK_WINDOW_MS) * w;
    const y = h - 4 - ((p.rateSpm || 0) / max) * (h - 10);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#5fd068';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#a9ab9f';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(`${Math.round(max)} spm`, 6, 14);
  ctx.fillText('60 s ago', 6, h - 6);
  ctx.fillText('now', w - 26, h - 6);
}

function renderStrokeMeta(e) {
  const rate = Number.isFinite(e.rateSpm) ? `${Math.round(e.rateSpm)} spm` : '—';
  els.strokeMeta.textContent =
    `stroke #${esc(e.count)} · ${rate}${e.simulated ? ' · simulated' : ''}`;
}

function tick() {
  const now = serverNow();
  ui.strokes = ui.strokes.filter((s) => now - s.t <= SPARK_WINDOW_MS + 5_000);
  const last = ui.strokes[ui.strokes.length - 1];
  const stale = !last || now - last.t > STROKE_STALE_MS;
  els.spm.textContent = stale ? '0' : String(Math.round(last.rateSpm || 0));
  els.spm.classList.toggle('dim', stale);
  renderPhone();
  drawSpark();
}

// ---------- call + obedience cards ----------

function stashAudio(call) {
  if (call.ttsAudioBase64 && call.mime && call.callId) {
    ui.audioByCallId.set(call.callId, { b64: call.ttsAudioBase64, mime: call.mime });
    while (ui.audioByCallId.size > MAX_AUDIO) ui.audioByCallId.delete(ui.audioByCallId.keys().next().value);
  }
  ui.currentAudio = (call.callId && ui.audioByCallId.get(call.callId)) || null;
  els.replay.disabled = !ui.currentAudio;
}

function onCall(c) {
  if (!c || typeof c !== 'object') return;
  stashAudio(c);
  els.callText.textContent = c.translatedText || '(nothing translated)';
  els.callMeaning.textContent = c.meaning ? human(c.meaning) : 'not recognised';
  els.callConf.textContent = esc(c.confidence);
  setBadge(els.callSrc, c.source === 'live' ? 'LIVE' : 'REPLAY', c.source === 'live' ? 'live' : 'replay');
  els.callLat.textContent = Number.isFinite(c.latencyMs) ? `${c.latencyMs} ms` : '—';
  const extra = [];
  if (c.spokenText) extra.push(`spoken: "${c.spokenText}"`);
  if (c.ears) extra.push(`two ears: ${c.ears}`);
  els.callExtra.textContent = extra.join(' · ');
  if (c.status === 'ok' || c.meaning) {
    const win = Number.isFinite(c.windowMs) ? Math.round(c.windowMs / 1000) : 8;
    setVerdict('none', 'watching strokes…', `judging obedience over a ${win} s window`);
  }
}

function setVerdict(cls, verdict, detail) {
  els.obeyVerdict.className = `huge verdict ${cls}`;
  els.obeyVerdict.textContent = verdict;
  els.obeyDetail.textContent = detail || '';
}

function onResult(r) {
  if (!r || typeof r !== 'object') return;
  addTrial(r);
  if (r.outcome === 'obeyed') {
    const n = r.strokesUntilObeyed;
    setVerdict('ok', `Obeyed in ${n === null ? '?' : n} stroke${n === 1 ? '' : 's'}`, detailOf(r));
  } else if (r.outcome === 'not_obeyed') {
    setVerdict('bad', 'Not obeyed', detailOf(r));
  } else {
    setVerdict('warn', r.status === 'not_sure' ? 'Not sure — meaning not recognised' : 'Not sure', detailOf(r));
  }
}

function detailOf(r) {
  const bits = [];
  if (r.reason) bits.push(r.reason);
  if (Number.isFinite(r.deltaSpm)) bits.push(`Δ ${r.deltaSpm > 0 ? '+' : ''}${Math.round(r.deltaSpm)} spm`);
  if (Number.isFinite(r.strokesObserved)) bits.push(`${r.strokesObserved} strokes observed`);
  if (r.superseded) bits.push('window cut short by a newer call');
  if (r.source) bits.push(r.source === 'live' ? 'live' : 'replay');
  return bits.join(' · ');
}

function playAudio() {
  if (!ui.currentAudio) return;
  const a = new Audio(`data:${ui.currentAudio.mime};base64,${ui.currentAudio.b64}`);
  a.play().catch(() => setStatus('Audio playback was blocked by the browser.', 'warn'));
}

// ---------- evidence table ----------

const OUTCOME_LABEL = { obeyed: 'obeyed', not_obeyed: 'not obeyed', not_sure: 'not sure' };
const OUTCOME_CLS = { obeyed: 'ok', not_obeyed: 'bad', not_sure: 'warn' };

function cell(tr, text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  tr.appendChild(td);
}

function renderTrials() {
  const rows = ui.trials;
  els.trials.textContent = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    cell(tr, 'waiting for the first shout', 'muted').colSpan = 6;
    els.trials.appendChild(tr);
  } else {
    const frag = document.createDocumentFragment();
    for (const t of [...rows].reverse()) {
      const tr = document.createElement('tr');
      cell(tr, Number.isFinite(t.t) ? new Date(t.t).toLocaleTimeString('en-GB', { hour12: false }) : '—', 'time');
      cell(tr, esc(t.translatedText));
      cell(tr, t.meaning ? human(t.meaning) : '—');
      const live = t.source === 'live';
      cell(tr, live ? 'live' : 'replay', live ? 'src-live' : 'src-replay');
      cell(tr, Number.isFinite(t.latencyMs) ? `${t.latencyMs} ms` : '—');
      cell(tr, OUTCOME_LABEL[t.outcome] || esc(t.outcome), `outcome ${OUTCOME_CLS[t.outcome] || ''}`);
      frag.appendChild(tr);
    }
    els.trials.appendChild(frag);
  }
  // Tally is always computed from the rows shown above, never from a claimed figure.
  const c = { obeyed: 0, not_obeyed: 0, not_sure: 0 };
  for (const t of rows) if (t.outcome in c) c[t.outcome] += 1;
  const judged = c.obeyed + c.not_obeyed;
  const pct = judged ? ` · ${Math.round((100 * c.obeyed) / judged)}% of judged` : '';
  els.tally.textContent = rows.length
    ? `${rows.length} trial${rows.length === 1 ? '' : 's'} — obeyed ${c.obeyed} · not obeyed ${c.not_obeyed} · not sure ${c.not_sure}${pct}`
    : 'no trials yet';
}

function addTrial(t) {
  if (!t || ui.trials.some((x) => x.callId && x.callId === t.callId)) { renderTrials(); return; }
  ui.trials.push(t);
  renderTrials();
}

// ---------- state snapshot ----------

function applyState(s) {
  if (!s || typeof s !== 'object') return;
  if (Number.isFinite(s.serverT)) ui.clockOffset = s.serverT - Date.now();
  if (typeof s.mode === 'string') renderMode(s.mode);
  if (s.phone) { ui.phone = s.phone; renderPhone(); }
  if (Array.isArray(s.recentStrokes)) mergeStrokes(s.recentStrokes);
  if (Array.isArray(s.trials)) { ui.trials = s.trials.slice(); renderTrials(); }
  if (s.lastCall) onCall(s.lastCall);
  if (s.lastResult) onResult(s.lastResult);
}

// ---------- shout ----------

function setBusy(busy) {
  ui.busy = busy;
  els.sendText.disabled = busy;
  els.shoutText.disabled = busy;
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
      body: JSON.stringify({ targetLang: els.lang.value, ...payload }),
    });
    let data = null;
    try { data = await res.json(); } catch { /* keep null */ }
    if (!res.ok || !data || data.ok === false) {
      const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${res.status}`;
      setStatus(`Shout failed: ${msg}`, 'bad');
      return;
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
  if (!text) { setStatus('Type a shout first, or use Record.', 'warn'); return; }
  els.shoutText.value = '';
  postShout({ text });
}

// ---------- recording (MediaRecorder) ----------

let rec = null; // { mr, stream, audioCtx, analyser, raf, autoStop, t0 }

function pickMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    setStatus('Recording needs localhost or HTTPS — type a shout instead.', 'warn');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setStatus('Microphone permission denied — type a shout instead.', 'warn');
    return;
  }
  const mime = pickMime();
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  mr.onstop = () => {
    const blob = new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' });
    finishRecording();
    if (!blob.size) { setStatus('Nothing was recorded.', 'warn'); return; }
    blob.arrayBuffer().then((buf) => postShout({ audioBase64: toBase64(buf), mime: blob.type }));
  };
  rec = { mr, stream, audioCtx: null, analyser: null, raf: 0, autoStop: 0, t0: performance.now() };
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    rec.audioCtx = new AC();
    const src = rec.audioCtx.createMediaStreamSource(stream);
    rec.analyser = rec.audioCtx.createAnalyser();
    rec.analyser.fftSize = 256;
    src.connect(rec.analyser);
  } catch { /* level meter is optional */ }
  mr.start(250);
  els.rec.setAttribute('aria-pressed', 'true');
  els.rec.textContent = 'Stop & send';
  els.recUi.hidden = false;
  rec.autoStop = setTimeout(stopRecording, REC_MAX_MS);
  rec.raf = requestAnimationFrame(levelLoop);
}

function stopRecording() {
  if (rec && rec.mr.state !== 'inactive') rec.mr.stop(); // onstop -> finishRecording
}

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
    let sum = 0;
    for (const v of buf) sum += (v - 128) * (v - 128);
    const rms = Math.sqrt(sum / buf.length) / 128;
    els.level.style.width = `${Math.min(100, Math.round(rms * 250))}%`;
  }
  els.recTime.textContent = `${((performance.now() - rec.t0) / 1000).toFixed(1)} s / 8 s max`;
  rec.raf = requestAnimationFrame(levelLoop);
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

// ---------- SSE ----------

let es = null;

function connect() {
  if (es) es.close();
  es = new EventSource('/events');
  es.onopen = () => setBadge(els.sseBadge, 'events live', 'live');
  es.onerror = () => {
    setBadge(els.sseBadge, 'events reconnecting', 'bad');
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 2000);
  };
  const dispatch = { state: applyState, phone: (p) => { ui.phone = p; renderPhone(); },
    stroke: onStroke, call: onCall, result: onResult };
  for (const [name, fn] of Object.entries(dispatch)) {
    es.addEventListener(name, (e) => {
      try { fn(JSON.parse(e.data)); } catch { /* malformed event: ignore */ }
    });
  }
}

function onStroke(e) {
  if (!e || !Number.isFinite(e.t)) return;
  mergeStrokes([e]);
  renderStrokeMeta(e);
}

// ---------- init ----------

const phoneUrl = `${location.origin}/phone`;
els.qrImg.src = `/qr.svg?url=${encodeURIComponent(phoneUrl)}`;
els.qrUrl.textContent = phoneUrl;
els.qrUrl.href = '/phone';

els.sendText.addEventListener('click', sendText);
els.shoutText.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });
els.rec.addEventListener('click', () => { if (rec) stopRecording(); else startRecording(); });
els.replay.addEventListener('click', playAudio);

fetch('/api/state').then((r) => (r.ok ? r.json() : null)).then(applyState).catch(() => {});
connect();
setInterval(tick, 500);
tick();
