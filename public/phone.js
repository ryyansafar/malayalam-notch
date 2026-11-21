// Malayalam in the notch — phone mic page.
// Hold the button, speak Malayalam, release: the note is posted to the Mac
// and the result appears in the notch. Heartbeats mark this phone connected.
const $ = (id) => document.getElementById(id);
const hold = $('hold');
const status = $('status');
const err = $('err');
const conn = $('conn'), connText = $('conn-text');

const MAX_MS = 25000;

function setConn(on) {
  conn.classList.toggle('on', on);
  conn.classList.toggle('off', !on);
  connText.textContent = on ? 'connected' : 'offline';
}
function showErr(msg) { err.textContent = msg; err.hidden = false; setTimeout(() => { err.hidden = true; }, 5000); }

// heartbeat: the notch shows this phone as connected
async function beat() {
  try {
    const r = await fetch('/api/phone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userAgent: navigator.userAgent }) });
    setConn(r.ok);
  } catch { setConn(false); }
}
beat();
setInterval(beat, 3000);

const es = new EventSource('/events');
es.addEventListener('open', () => setConn(true));
es.addEventListener('error', () => setConn(false));
es.addEventListener('note', (e) => {
  const n = JSON.parse(e.data);
  if (n.origin?.source !== 'phone_mic' && n.source !== 'phone_mic') return;
  $('last').hidden = false;
  $('last-ml').textContent = n.sourceText || '';
  $('last-roman').textContent = n.romanText || '';
  $('last-en').textContent = n.translatedText || '';
  status.textContent = 'shown in the notch';
});

let rec = null, chunks = [], timer = null;
async function start() {
  if (rec?.state === 'recording') return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4';
    rec = new MediaRecorder(stream, { mimeType });
    chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType });
      if (blob.size < 200) { status.textContent = 'too short — hold a little longer'; return; }
      status.textContent = 'translating…';
      const buf = await blob.arrayBuffer();
      let bin = ''; const u8 = new Uint8Array(buf);
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      try {
        const r = await fetch('/api/shout', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioBase64: btoa(bin), mime: blob.type, source: 'phone_mic', targetLang: 'en-IN' }),
        });
        const j = await r.json();
        if (!r.ok) { showErr(j?.error?.message || 'translation failed'); status.textContent = ''; return; }
        status.textContent = 'shown in the notch';
      } catch { showErr('could not reach the Mac — same Wi-Fi?'); status.textContent = ''; }
    };
    rec.start();
    hold.classList.add('recording');
    hold.textContent = 'LISTENING…';
    status.textContent = 'release to send';
    timer = setTimeout(stop, MAX_MS);
  } catch {
    showErr('no microphone — allow mic access for this page in browser settings');
  }
}
function stop() {
  clearTimeout(timer);
  if (rec?.state === 'recording') rec.stop();
  hold.classList.remove('recording');
  hold.textContent = 'HOLD TO TALK';
}
hold.addEventListener('pointerdown', start);
addEventListener('pointerup', stop);
hold.addEventListener('pointercancel', stop);
hold.addEventListener('contextmenu', (e) => e.preventDefault());
