// Malayalam in the notch — page controller.
// Drives the island's size via the native "notch" message channel, listens to
// /events (SSE), plays translation audio, renders the result card and shelf.
import {
  nextPhase, phaseLine, cardFields, pushShelf, chipLine, elapsedSeconds,
  shouldCollapse, receivedLine, acceptsAudioName, noteOriginBadge, COLLAPSE_AFTER_MS, PHASES,
} from './notch-core.js';

const PHASES_SET = new Set(PHASES);

const $ = (id) => document.getElementById(id);
const island = $('island');
const params = new URLSearchParams(location.search);
const NOTCH_W = Number(params.get('nw')) || 0;

document.documentElement.style.setProperty('--notch-w', `${NOTCH_W}px`);
if (!NOTCH_W) $('gap').style.display = 'none';

// ---- native channel ----
const native = window.webkit?.messageHandlers?.notch
  ? (msg) => window.webkit.messageHandlers.notch.postMessage(msg)
  : () => {};

// ---- island geometry: report size to the native shell ----
const SIZES = {
  idle:    { w: Math.max(320, NOTCH_W + 120), h: 38 },
  open:    { w: 560, h: 430 },
  drag:    { w: 500, h: 190 }, // dashed target lands at y≈48–176: below the Mission Control edge
};
let open = false;
let w = 0, h = 0;
let shrinkTimer = null;
const root = document.documentElement;
// Fixed-window technique (as in the best notch apps): the native window jumps to the
// needed size instantly, the island morphs inside it. Growing: window first, then the
// morph. Shrinking: morph first, then the window after the spring has settled.
function morphTo(size) {
  if (size.w === w && size.h === h) return;
  const growing = !w || size.h >= h;
  const wasOpen = h > 60;
  w = size.w; h = size.h;
  const isOpen = h > 60;
  clearTimeout(shrinkTimer);
  const apply = () => {
    root.classList.toggle('opening', isOpen);
    root.style.setProperty('--w', `${w}px`);
    root.style.setProperty('--h', `${h}px`);
    root.style.setProperty('--r', isOpen ? '24px' : '14px');   // bottom radius (open 24 / closed 14)
    root.style.setProperty('--tr', isOpen ? '19px' : '6px');   // concave top radius (open 19 / closed 6)
  };
  if (growing) {
    native({ type: 'size', w, h });
    requestAnimationFrame(() => requestAnimationFrame(apply));
  } else {
    apply();
    shrinkTimer = setTimeout(() => native({ type: 'size', w, h }), wasOpen ? 560 : 0);
  }
}

function setOpen(on) {
  if (on === open) return;
  open = on;
  island.classList.toggle('open', on);
  morphTo(on ? SIZES.open : SIZES.idle);
  native({ type: 'hover', on });
}

// ---- state ----
let state = { langs: [], phone: { connected: false }, lastNote: null };
let phase = 'idle';
let shelf = [];
let collapseTimer = null;
let elapsedTimer = null;
let busySince = 0;
let muted = localStorage.getItem('notch-muted') === '1';
let targetLang = localStorage.getItem('notch-lang') || '';
let currentNote = null;
let audio = null;

function renderBar() {
  // Wings are narrow: idle shows the day's count, busy shows elapsed seconds.
  if (phase === 'received' || phase === 'translating') {
    $('count').textContent = `${elapsedSeconds(Date.now(), busySince)}s`;
  } else {
    $('count').textContent = String(todayCount);
  }
  $('bar-line').textContent = '';
}
let todayCount = 0;

let resultAt = 0;
function armCollapse() {
  clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    if (shouldCollapse(Date.now(), resultAt, { focused: document.activeElement === $('typed'), recording: phase === 'recording' })) setPhase('reset');
  }, COLLAPSE_AFTER_MS);
}

function setPhase(p, note) {
  phase = PHASES_SET.has(p) ? p : nextPhase(phase, p, note);
  island.classList.toggle('busy', phase === 'translating' || phase === 'received' || phase === 'recording');
  island.classList.remove('dragover');
  clearInterval(elapsedTimer);
  $('status').textContent = '';
  $('shimmer').hidden = true;
  $('err').hidden = true;

  if (phase === 'idle') {
    $('card').hidden = true;
    $('v-idle').hidden = false;
    $('controls').hidden = false;
    setOpen(openHover);
  } else if (phase === 'received' || phase === 'translating') {
    busySince = Date.now();
    setOpen(true);
    $('v-idle').hidden = true;
    $('card').hidden = true;
    $('controls').hidden = true;
    $('status').innerHTML = phase === 'received'
      ? receivedLine(note || {}) : `${phaseLine(phase)} <span class="elapsed">0 s</span>`;
    if (phase === 'translating') $('shimmer').hidden = false;
    elapsedTimer = setInterval(() => {
      renderBar();
      const el = $('status').querySelector('.elapsed');
      if (el) el.textContent = `${elapsedSeconds(Date.now(), busySince)} s`;
    }, 500);
  } else if (phase === 'result') {
    setOpen(true);
    $('v-idle').hidden = true;
    $('card').hidden = false;
    $('controls').hidden = false;
    renderCard(note);
    resultAt = Date.now();
    armCollapse();
  } else if (phase === 'error') {
    setOpen(true);
    $('v-idle').hidden = false;
    $('controls').hidden = false;
    resultAt = Date.now();
    armCollapse();
  }
  renderBar();
}

function renderCard(note) {
  const f = cardFields(note);
  if (!f) { $('card').hidden = true; return; }
  const b = noteOriginBadge(note);
  $('origin-badge').hidden = !b;
  $('origin-badge').textContent = b || '';
  $('lang-badge').hidden = !f.detectedLanguage;
  $('lang-badge').textContent = f.detectedLanguage || '';
  $('lang-badge').classList.add('lang');
  $('meta').textContent = 'just now';
  $('ml').textContent = f.malayalamFailed ? 'transcription not available' : (f.malayalam || '');
  $('ml').hidden = !f.malayalam && !f.malayalamFailed;
  $('roman').textContent = f.romanFailed ? 'romanisation not available' : (f.roman || '');
  $('roman').hidden = !f.roman && !f.romanFailed;
  $('en').textContent = f.englishFailed ? 'translation not available' : (f.english || '');
  $('en').hidden = !f.english && !f.englishFailed;
  const speakBtn = $('speak');
  speakBtn.textContent = `Speak in ${langName(note.targetLang || targetLang || 'en-IN')}`;
  speakBtn.disabled = !f.english;
  currentNote = note;
}

// ---- shelf ----
function renderShelf() {
  const ul = $('shelf');
  ul.textContent = '';
  for (const n of shelf) {
    const li = document.createElement('li');
    li.className = 'chip-row';
    li.draggable = true;
    const src = document.createElement('span'); src.className = 'src'; src.textContent = n.origin || 'note';
    const txt = document.createElement('span'); txt.className = 'txt'; txt.textContent = chipLine(n);
    const lang = document.createElement('span'); lang.className = 'lang'; lang.textContent = n.language || '';
    const ago = document.createElement('span'); ago.className = 'ago'; ago.textContent = relTime(n.t);
    const speakB = document.createElement('button'); speakB.type = 'button'; speakB.textContent = 'speak'; speakB.title = 'Speak this translation again';
    speakB.addEventListener('click', (e) => { e.stopPropagation(); speakEntry(n); });
    const copyB = document.createElement('button'); copyB.type = 'button'; copyB.textContent = 'copy'; copyB.title = 'Copy translation';
    copyB.addEventListener('click', (e) => { e.stopPropagation(); navigator.clipboard?.writeText(n.firstLine || ''); });
    li.append(src, txt, lang, ago, speakB, copyB);
    li.addEventListener('dragstart', (e) => {
      li.classList.add('dragging');
      e.dataTransfer.setData('text/plain', n.firstLine || '');
      e.dataTransfer.effectAllowed = 'copy';
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('click', () => {
      currentNote = { translatedText: n.firstLine, sourceText: n.sourceText, romanText: n.romanText, detectedLanguage: n.language, origin: n.origin, targetLang: n.targetLang };
      setPhase('result', currentNote);
    });
    ul.append(li);
  }
}
function relTime(t) {
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

// ---- audio ----
function playNote(note) {
  if (muted || !note?.ttsAudioBase64) return;
  audio?.pause();
  audio = new Audio(`data:${note.mime || 'audio/wav'};base64,${note.ttsAudioBase64}`);
  audio.play().catch(() => {});
}
async function speakEntry(entry) {
  const text = entry.firstLine || entry.translatedText;
  if (!text) return;
  const r = await post('/api/speak', { text, targetLang: targetLang || 'en-IN' });
  if (r?.ttsAudioBase64 && !muted) {
    new Audio(`data:${r.mime || 'audio/wav'};base64,${r.ttsAudioBase64}`).play().catch(() => {});
  }
}

// ---- server ----
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j?.error?.message || r.statusText); e.code = j?.error?.code; throw e; }
  return j;
}

async function sendShout(body) {
  setPhase('received', { filename: body.filename });
  setPhase('translating');
  try {
    const note = await post('/api/shout', { targetLang: targetLang || 'en-IN', ...body });
    setPhase('result', note);
    shelf = pushShelf(shelf, note);
    renderShelf();
    playNote(note);
  } catch (e) {
    $('err').textContent = `Couldn't translate — ${e.message}. Try again.`;
    $('err').hidden = false;
    setPhase('error');
  }
}

// ---- SSE ----
const es = new EventSource('/events');
es.addEventListener('state', (e) => {
  state = JSON.parse(e.data);
  todayCount = state.lastNote ? todayCount : todayCount; // count comes from archive below
  renderLangs();
  renderBar();
});
es.addEventListener('received', () => { if (phase === 'idle') setPhase('received'); });
es.addEventListener('note', (e) => {
  const note = JSON.parse(e.data);
  setPhase('result', note);
  shelf = pushShelf(shelf, note);
  renderShelf();
  playNote(note);
});
es.addEventListener('error', () => { if (phase === 'idle') $('bar-line').textContent = 'waiting for server'; });

async function refreshCount() {
  try {
    const r = await fetch('/api/archive.json');
    const j = await r.json();
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    todayCount = j.entries.filter((e) => new Date(e.time) >= midnight).length;
    if (!shelf.length) {
      shelf = j.entries.slice(0, 5).map((e) => ({
        noteId: e.id, t: new Date(e.time).getTime(), origin: e.source,
        language: e.language, firstLine: (e.text || '').split('\n')[0],
        sourceText: e.transcript, romanText: e.roman,
      }));
      renderShelf();
    }
  } catch { /* server starting */ }
  renderBar();
}
refreshCount();

// ---- language chips ----
const LANG_NAME = { 'en-IN': 'English', 'hi-IN': 'Hindi', 'bn-IN': 'Bengali', 'od-IN': 'Odia', 'ta-IN': 'Tamil' };
const langName = (code) => LANG_NAME[code] || code;
function renderLangs() {
  const box = $('langs');
  box.textContent = '';
  const codes = state.langs.map((l) => (typeof l === 'string' ? l : l.code));
  if (!codes.length) return;
  if (!codes.includes(targetLang)) targetLang = codes[0];
  for (const code of codes) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(code === targetLang));
    b.textContent = langName(code);
    b.addEventListener('click', () => {
      targetLang = code;
      localStorage.setItem('notch-lang', code);
      renderLangs();
      if (currentNote) renderCard(currentNote);
    });
    box.append(b);
  }
}

// ---- interactions ----
let openHover = false;
island.addEventListener('mouseenter', () => { openHover = true; if (phase === 'idle' || phase === 'result') setOpen(true); });
island.addEventListener('mouseleave', () => { openHover = false; if (phase === 'idle' && !document.querySelector('.chip-row.dragging')) setPhase('idle'); });

// drag a voice note onto the island (inside the page; the native shell also
// has an always-on drop zone that posts directly and emits "note" via SSE)
island.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (![...e.dataTransfer.types].includes('Files')) return;
  island.classList.add('dragover');
  setOpen(true);
  morphTo(SIZES.drag, { r: 32 });
});
island.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
island.addEventListener('dragleave', (e) => {
  if (e.relatedTarget && island.contains(e.relatedTarget)) return;
  island.classList.remove('dragover');
  if (phase === 'idle') morphTo(SIZES.open, { r: 32 });
});
island.addEventListener('drop', async (e) => {
  e.preventDefault();
  island.classList.remove('dragover');
  const file = [...(e.dataTransfer?.files || [])].find((f) => acceptsAudioName(f.name));
  if (!file) { $('err').textContent = 'That file is not audio — drop .opus, .ogg, .m4a, .mp3 or .wav.'; $('err').hidden = false; setPhase('error'); return; }
  const buf = await file.arrayBuffer();
  sendShout({
    audioBase64: btoa(String.fromCharCode(...new Uint8Array(buf))),
    mime: file.type || 'audio/ogg',
    filename: file.name,
    source: 'notch_drop',
  });
});

// typed Malayalam
$('typed').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.value.trim()) return;
  sendShout({ text: e.target.value.trim(), source: 'text' });
  e.target.value = '';
});
$('typed').addEventListener('focus', () => { openHover = true; setOpen(true); });

// hold to talk (Mac mic)
let rec = null, recChunks = [], recTimer = null;
async function startRec() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    rec = new MediaRecorder(stream);
    recChunks = [];
    rec.ondataavailable = (e) => recChunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recChunks, { type: rec.mimeType });
      const buf = await blob.arrayBuffer();
      sendShout({ audioBase64: btoa(String.fromCharCode(...new Uint8Array(buf))), mime: blob.type || 'audio/webm', source: 'mic' });
    };
    rec.start();
    phase = 'recording';
    island.classList.add('busy');
    busySince = Date.now();
    $('status').innerHTML = 'Recording <span class="elapsed">0 s</span>';
    setOpen(true);
    recTimer = setInterval(() => renderBar(), 500);
    setTimeout(() => { if (rec?.state === 'recording') rec.stop(); }, 25000);
  } catch {
    $('err').textContent = 'No microphone — check macOS permissions for this app.';
    $('err').hidden = false;
    setPhase('error');
  }
}
function stopRec() {
  if (rec?.state === 'recording') { rec.stop(); }
  clearInterval(recTimer);
}
$('mic').addEventListener('pointerdown', startRec);
addEventListener('pointerup', stopRec);
$('mic').addEventListener('keydown', (e) => { if (e.key === ' ' && rec?.state !== 'recording') startRec(); });
$('mic').addEventListener('keyup', (e) => { if (e.key === ' ') stopRec(); });

$('speak').addEventListener('click', () => { if (currentNote) playNote(currentNote.ttsAudioBase64 ? currentNote : currentNote); });
$('copy').addEventListener('click', () => { if (currentNote?.translatedText) navigator.clipboard?.writeText(currentNote.translatedText); });
$('mute').addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('notch-muted', muted ? '1' : '0');
  $('mute').textContent = muted ? 'muted' : 'sound on';
  $('mute').setAttribute('aria-pressed', String(muted));
  if (muted) audio?.pause();
});
$('mute').textContent = muted ? 'muted' : 'sound on';
$('mute').setAttribute('aria-pressed', String(muted));

// right-click menu: Quit / Mute / Open desk
island.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showMenu(e.clientX, e.clientY);
});
let menu = null;
function showMenu(x, y) {
  hideMenu();
  menu = document.createElement('div');
  menu.id = 'ctxmenu';
  menu.style.cssText = `position:fixed;left:${x}px;top:${y + 8}px;z-index:9;background:#141414;border:1px solid #2a2a28;border-radius:10px;padding:4px;font:13px -apple-system,sans-serif;`;
  const items = [
    ['Open desk', () => { window.open('/dashboard.html'); }],
    [muted ? 'Unmute' : 'Mute', () => $('mute').click()],
    ['Quit', () => native({ type: 'quit' })],
  ];
  for (const [label, fn] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'display:block;width:140px;text-align:left;background:none;border:none;color:#f2f2ee;padding:8px 10px;border-radius:6px;cursor:pointer;font:inherit;';
    b.onmouseenter = () => { b.style.background = '#2a2a28'; };
    b.onmouseleave = () => { b.style.background = 'none'; };
    b.onclick = () => { hideMenu(); fn(); };
    menu.append(b);
  }
  document.body.append(menu);
}
function hideMenu() { menu?.remove(); menu = null; }
addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target)) hideMenu(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideMenu(); if (phase === 'result') setPhase('idle'); } });

// native shell messages: drag state, early drop notice, native errors
addEventListener('notch-native', (e) => {
  const d = e.detail || {};
  if (d.type === 'drag') {
    island.classList.toggle('dragover', !!d.on);
    if (d.on) { setOpen(true); morphTo(SIZES.drag, { r: 32 }); $('drop-file').textContent = d.filename || ''; }
    else if (phase === 'idle') morphTo(openHover ? SIZES.open : SIZES.idle, { r: openHover ? 32 : 14 });
  } else if (d.type === 'nativeDrop') {
    setPhase('received', { filename: d.filename });
    setPhase('translating'); // the result arrives over SSE as a "note"
  } else if (d.type === 'nativeError') {
    $('err').textContent = `${d.message}. Try again.`;
    $('err').hidden = false;
    setPhase('error');
  } else if (d.type === 'hoverNear') {
    openHover = !!d.on;
    if (phase === 'idle' || phase === 'result') setOpen(openHover);
  }
});

// boot: collapsed pill
morphTo(SIZES.idle);
$('bar').removeAttribute('aria-hidden');
