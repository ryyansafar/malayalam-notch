// Malayalam in the notch — desk view: voice-note inbox, latest note, archive.
// /api/* + /events SSE. ES module, no build step.
import { sniffAudio, measureDuration, formatFromName, NOTE_MAX_BYTES, SPEECH_MAX_SECONDS } from '/shared/audio-sniff.js';

const $ = (id) => document.getElementById(id);
const els = {};
for (const [k, id] of Object.entries({
  modeBadge: 'mode-badge', phoneBadge: 'phone-badge', sseBadge: 'sse-badge',
  qrImg: 'qr-img', qrUrl: 'qr-url',
  dropzone: 'dropzone', fileInput: 'file-input', inboxStatus: 'inbox-status',
  cutBtn: 'cut-btn', watchLine: 'watch-line',
  lastOrigin: 'last-origin', lastLang: 'last-lang', lastMl: 'last-ml',
  lastRoman: 'last-roman', lastEn: 'last-en', lastStatus: 'last-status',
  speakAgain: 'speak-again', copyEn: 'copy-en',
  shoutText: 'shout-text', sendText: 'send-text', rec: 'rec', recUi: 'rec-ui',
  level: 'level', recTime: 'rec-time', shoutStatus: 'shout-status',
  providerNote: 'provider-note',
  archiveQ: 'archive-q', archiveRows: 'archive-rows', archiveLang: 'archive-lang', archiveSummary: 'archive-summary',
})) els[k] = $(id);

const PROVIDER_LABEL = { sarvam: 'Sarvam', smallest: 'smallest.ai' };
const SOURCE_LABEL = {
  voice_note: 'voice note', mic: 'mic', text: 'text', phone_mic: 'phone mic',
  whatsapp_share: 'share sheet', whatsapp_desktop: 'whatsapp desktop',
  watched_folder: 'watched folder', ingest: 'ingest', notch_drop: 'notch drop',
};
const human = (s) => String(s || '').replace(/_/g, ' ');
const esc = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

const ui = { phone: null, clockOffset: 0, lastNote: null, busy: false };

const setBadge = (el, text, cls) => { el.textContent = text; el.className = `badge ${cls}`; };
const serverNow = () => Date.now() + ui.clockOffset;

// header
const renderMode = (mode) => setBadge(els.modeBadge, mode === 'live' ? 'LIVE' : 'REPLAY', mode === 'live' ? 'live' : 'replay');
function renderPhone() {
  const p = ui.phone;
  if (!p || !p.connected) { setBadge(els.phoneBadge, 'phone not connected', 'dim'); return; }
  const ago = Number.isFinite(p.lastSeenT) ? ` · ${Math.max(0, Math.round((serverNow() - p.lastSeenT) / 1000))}s ago` : '';
  setBadge(els.phoneBadge, `phone connected${ago}`, 'live');
}
setInterval(renderPhone, 2000);

// providers
function renderProviders(info) {
  const prov = info?.providers || {};
  const allowed = new Set(info?.ttsProviders || ['sarvam']);
  const notes = [];
  for (const input of document.querySelectorAll('input[name="tts"]')) {
    const p = prov[input.value] || {};
    input.disabled = !allowed.has(input.value);
    input.closest('label').title = input.disabled
      ? `${PROVIDER_LABEL[input.value]} is not available on this server`
      : `${PROVIDER_LABEL[input.value]} ${p.configured ? 'configured' : 'not configured'}${p.mode ? ` · ${p.mode}` : ''}`;
    notes.push(`${PROVIDER_LABEL[input.value]} ${p.configured ? 'configured' : 'no key'}`);
    if (input.disabled && input.checked) document.querySelector('input[name="tts"]:not(:disabled)')?.click();
  }
  els.providerNote.textContent = notes.join(' · ');
  els.watchLine.hidden = !info?.watchDirs?.length;
  els.watchLine.textContent = info?.watchDirs?.length
    ? `watching ${info.watchDirs.map((d) => d.dir).join(', ')} — new audio files are translated automatically`
    : '';
}

// latest note card
function renderLast(note) {
  if (!note) return;
  ui.lastNote = note;
  els.lastOrigin.textContent = SOURCE_LABEL[note.origin?.source || note.source] || human(note.origin?.source || note.source) || 'note';
  els.lastLang.textContent = note.detectedLanguage || note.language || '—';
  els.lastMl.textContent = note.sourceText || '';
  els.lastRoman.textContent = note.romanText || '';
  els.lastEn.textContent = note.translatedText || note.text || '';
  els.speakAgain.disabled = !(note.translatedText || note.text);
  els.copyEn.disabled = !(note.translatedText || note.text);
  els.lastStatus.textContent = note.failedOps?.length ? `some output missing: ${note.failedOps.join(', ')} failed` : '';
}

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || r.statusText);
  return j;
}

function setStatus(t, cls = '') { els.shoutStatus.textContent = t; els.shoutStatus.className = `status${cls ? ` ${cls}` : ''}`; }

async function shout(body) {
  if (ui.busy) { setStatus('one translation at a time — try again in a moment'); return; }
  ui.busy = true;
  setStatus('translating…');
  try {
    const targetLang = document.querySelector('input[name="lang"]:checked')?.value || 'en-IN';
    const ttsProvider = document.querySelector('input[name="tts"]:checked')?.value || 'sarvam';
    const note = await post('/api/shout', { targetLang, ttsProvider, ...body });
    renderLast(note);
    playNote(note);
    setStatus('done');
    loadArchive();
  } catch (e) {
    setStatus(`couldn't translate — ${e.message}`);
  } finally { ui.busy = false; }
}

let audio = null;
function playNote(note) {
  if (!note?.ttsAudioBase64) return;
  audio?.pause();
  audio = new Audio(`data:${note.ttsAudioMime || 'audio/wav'};base64,${note.ttsAudioBase64}`);
  audio.play().catch(() => {});
}

els.sendText.addEventListener('click', () => {
  const t = els.shoutText.value.trim();
  if (!t) return;
  shout({ text: t, source: 'text' });
  els.shoutText.value = '';
});
els.shoutText.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.sendText.click(); });

els.speakAgain.addEventListener('click', async () => {
  const text = ui.lastNote?.translatedText || ui.lastNote?.text;
  if (!text) return;
  els.lastStatus.textContent = 'speaking…';
  try {
    const targetLang = document.querySelector('input[name="lang"]:checked')?.value || 'en-IN';
    const ttsProvider = document.querySelector('input[name="tts"]:checked')?.value || 'sarvam';
    const r = await post('/api/speak', { text, targetLang, ttsProvider });
    playNote(r);
    els.lastStatus.textContent = '';
  } catch (e) { els.lastStatus.textContent = `speak failed — ${e.message}`; }
});
els.copyEn.addEventListener('click', () => {
  navigator.clipboard?.writeText(ui.lastNote?.translatedText || ui.lastNote?.text || '');
});

// hold to talk
let rec = null, recChunks = [], recTimer = null, levelTimer = null, levelCtx = null, recStartT = 0;
const REC_MAX_MS = 25000;
async function startRec() {
  if (rec?.state === 'recording') return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4';
    rec = new MediaRecorder(stream, { mimeType });
    recChunks = [];
    rec.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      levelCtx?.close?.(); levelCtx = null;
      els.recUi.hidden = true;
      const blob = new Blob(recChunks, { type: rec.mimeType });
      const buf = await blob.arrayBuffer();
      let bin = ''; const u8 = new Uint8Array(buf);
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      shout({ audioBase64: btoa(bin), mime: blob.type, source: 'mic' });
    };
    try {
      levelCtx = new AudioContext();
      const src = levelCtx.createMediaStreamSource(stream);
      const analyser = levelCtx.createAnalyser(); analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      levelTimer = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        const peak = Math.max(...data.map((v) => Math.abs(v - 128))) / 128;
        els.level.style.width = `${Math.min(100, peak * 140)}%`;
      }, 80);
    } catch { /* meter is cosmetic */ }
    rec.start();
    recStartT = performance.now();
    els.rec.setAttribute('aria-pressed', 'true');
    els.rec.textContent = 'Listening…';
    els.recUi.hidden = false;
    recTimer = setInterval(() => { els.recTime.textContent = `${((performance.now() - recStartT) / 1000).toFixed(1)} s`; }, 100);
    setTimeout(stopRec, REC_MAX_MS);
  } catch { setStatus('no microphone — check browser permissions'); }
}
function stopRec() {
  clearInterval(recTimer);
  if (rec?.state === 'recording') rec.stop();
  els.rec.setAttribute('aria-pressed', 'false');
  els.rec.textContent = 'Hold to talk';
}
els.rec.addEventListener('pointerdown', startRec);
addEventListener('pointerup', stopRec);

// voice-note inbox
const fmtBytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
async function sendFile(file) {
  els.inboxStatus.textContent = `reading ${file.name}…`;
  const buf = await file.arrayBuffer();
  if (buf.byteLength > NOTE_MAX_BYTES) { els.inboxStatus.textContent = `${file.name} is ${fmtBytes(buf.byteLength)} — over the 5 MB limit.`; return; }
  const sniffed = sniffAudio(buf);
  if (!sniffed) { els.inboxStatus.textContent = `${file.name} is not a recognised audio file.`; return; }
  const dur = measureDuration(buf, sniffed.format);
  const secs = dur?.seconds ?? null;
  if (secs !== null && secs > SPEECH_MAX_SECONDS) { els.inboxStatus.textContent = `${file.name} is ${Math.round(secs)} s — longer than the 30 s speech-to-text limit.`; return; }
  let bin = ''; const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  els.inboxStatus.textContent = `translating ${file.name}${secs ? ` · ${Math.round(secs)} s` : ''}…`;
  await shout({ audioBase64: btoa(bin), mime: sniffed.mime, filename: file.name, source: 'voice_note' });
}
els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); } });
els.fileInput.addEventListener('change', () => { const f = els.fileInput.files[0]; if (f) sendFile(f); els.fileInput.value = ''; });
for (const ev of ['dragenter', 'dragover']) els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.remove('over'); });
els.dropzone.addEventListener('drop', (e) => { const f = [...(e.dataTransfer?.files || [])][0]; if (f) sendFile(f); });

// archive
function renderArchive(entries) {
  els.archiveRows.textContent = '';
  if (!entries.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="8" class="muted">no notes yet</td>';
    els.archiveRows.append(tr);
    return;
  }
  for (const e of entries) {
    const tr = document.createElement('tr');
    const cells = [
      new Date(e.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      SOURCE_LABEL[e.source] || human(e.source), e.filename || '—', e.language || '—',
      e.transcript || '—', e.roman || '—', e.text || '—',
    ];
    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.append(td); }
    const td = document.createElement('td');
    td.className = 'row-actions';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'mini'; copy.textContent = 'copy';
    copy.addEventListener('click', () => navigator.clipboard?.writeText(e.text || ''));
    const speak = document.createElement('button'); speak.type = 'button'; speak.className = 'mini'; speak.textContent = 'speak';
    speak.addEventListener('click', async () => {
      try {
        const r = await post('/api/speak', { text: e.text, targetLang: document.querySelector('input[name="lang"]:checked')?.value || 'en-IN' });
        playNote(r);
      } catch { /* status lives in the card */ }
    });
    td.append(copy, speak);
    tr.append(td);
    els.archiveRows.append(tr);
  }
  els.archiveSummary.textContent = `${entries.length} note${entries.length === 1 ? '' : 's'}`;
}

async function loadArchive() {
  const q = els.archiveQ.value.trim();
  const lang = els.archiveLang.value;
  const r = await fetch(`/api/archive${q ? `?q=${encodeURIComponent(q)}` : ''}`).catch(() => null);
  if (!r?.ok) return;
  const { entries } = await r.json();
  const filtered = lang ? entries.filter((e) => e.language === lang) : entries;
  renderArchive(filtered);
  if (!els.archiveLang.dataset.filled) {
    els.archiveLang.dataset.filled = '1';
    for (const l of [...new Set(entries.map((e) => e.language).filter(Boolean))]) {
      const o = document.createElement('option'); o.value = l; o.textContent = l;
      els.archiveLang.append(o);
    }
  }
}
let qTimer = null;
els.archiveQ.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(loadArchive, 200); });
els.archiveLang.addEventListener('change', loadArchive);

// SSE
let es = null;
function connect() {
  es = new EventSource('/events');
  es.addEventListener('open', () => setBadge(els.sseBadge, 'events live', 'live'));
  es.addEventListener('state', (e) => {
    const s = JSON.parse(e.data);
    ui.clockOffset = (s.serverT || Date.now()) - Date.now();
    ui.phone = s.phone;
    renderMode(s.mode);
    renderPhone();
    if (s.lastNote) renderLast(s.lastNote);
  });
  es.addEventListener('phone', (e) => { ui.phone = JSON.parse(e.data); renderPhone(); });
  es.addEventListener('note', (e) => { renderLast(JSON.parse(e.data)); loadArchive(); });
  es.addEventListener('error', () => {
    setBadge(els.sseBadge, 'events reconnecting', 'dim');
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 2000);
  });
}
connect();

// boot
fetch('/api/state').then((r) => (r.ok ? r.json() : null)).then((s) => {
  if (!s) return;
  ui.clockOffset = (s.serverT || Date.now()) - Date.now();
  ui.phone = s.phone; renderMode(s.mode); renderPhone();
  if (s.lastNote) renderLast(s.lastNote);
}).catch(() => {});
fetch('/api/providers').then((r) => (r.ok ? r.json() : null)).then(renderProviders).catch(() => renderProviders(null));
fetch('/qr.svg').then((r) => (r.ok ? r.text() : null)).then((svg) => {
  if (svg) els.qrImg.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  els.qrUrl.href = '/phone';
  els.qrUrl.textContent = `${location.origin.replace(/^https?/, location.protocol === 'https:' ? 'https' : 'http')}/phone`;
}).catch(() => { document.querySelector('.qr').hidden = true; });
loadArchive();
