# rowing-call: module contract (all agents must follow; files are owned, do not edit files you do not own)

Built at Hackathoni (repo created at the event, 21 Nov 2026, ~21:30 IST). ES modules, Node >= 20, zero runtime dependencies except `qrcode-generator` (server QR). Tests use `node:test` (`npm test` runs `node --test test/`). Never print or log secrets. Never commit. No emojis in code or UI text.

## What it is
A phone is the oar. A Malayali shouts a work call. One live Saaras `translate` call turns the shout into English text, a deterministic matcher maps it to one of six meanings, Bulbul speaks the meaning to the (non-Malayali) rower in their language, and the phone's stroke detector measures whether the rower obeyed (stroke rate change). Dashboard on the laptop shows everything, including evidence. Honest framing: an induction and classroom drill, not race equipment. Real race calls are NOT yet collected: the calls table holds placeholders marked UNVERIFIED. Only three real terms are verified to exist (Aanjukuthi, Valicheduthu, Kuthiyerinju; Onmanorama, 25 Aug 2025) and their meanings are unconfirmed; do not invent others.

## Layout and owners
- shared/stroke.js            owner: Devin session 1   stroke detector from accelerometer samples (run by the builder)
- shared/calls.js             owner: agent D       six meanings, call table, matchMeaning()
- shared/obedience.js         owner: agent D       evaluate obedience from stroke events
- sarvam/client.js            owner: agent C       Sarvam REST client with cache/replay
- sarvam/record-fixtures.js   owner: agent C       records rehearsal fixtures into sarvam/cache
- server/index.js, server/hub.js, server/qr.js   owner: agent A   http(s) server, SSE hub, routes
- public/phone.html, public/phone.js, public/phone.css      owner: Devin session 2   phone page (run by the builder)
- public/dashboard.html, public/dashboard.js, public/dashboard.css   owner: Devin session 3   laptop dashboard (run by the builder)
- test/<module>.test.js       owner: whoever owns the module
- README.md, docs/*           owner: integrator (last phase)

## Interfaces
### shared/stroke.js (browser and Node, no imports)
- `export function createStrokeDetector(opts?)` returns `{ push(sample), reset() }`.
  - sample: `{ t: number /* ms, monotonic */, ax: number, ay: number, az: number }` (m/s^2, may include gravity) ; optional gyro `gx,gy,gz`.
  - `push` returns an array of stroke events `{ type: 'stroke', t, rateSpm, count }` (usually empty). `rateSpm` is strokes per minute from the last 2-4 intervals; `count` is cumulative.
  - opts: `{ minSpm=10, maxSpm=90, smoothingHz=3, minPeakGapMs, adaptive=true }`.
- `export function detectStrokes(samples, opts?)` batch version returning all events.
- Must handle uneven sampling (jitter), 20-60 Hz, constant gravity offset, no-motion (zero strokes), and a phone held at different orientations (use acceleration magnitude or a dominant-axis rule).

### shared/calls.js
- `export const MEANINGS = ['start','speed_up','slow_down','hold','ready','stop']`.
- `export const CALLS` : array of `{ id, meaning, malayalam, transliteration, english, verified: false, source }`; all placeholders `verified: false`.
- `export function matchMeaning(text)` -> `{ meaning: string|null, confidence: 'high'|'low'|'none', matchedKeyword?: string }`; deterministic keyword rules over English text (lowercased), handles synonyms (faster, speed up, pick up the pace, harder -> speed_up; slower, ease, easy -> slow_down; stop, finish, easy oar? -> stop only if unambiguous; hold, hold water; ready, attention, get set; go, start, begin, row). Returns meaning null with confidence 'none' when ambiguous (the dashboard shows "not sure, ask again").
- `export const EXPECTED` : per meaning, what stroke-rate change counts as obeyed, e.g. `{ speed_up: { deltaSpmMin: +4 }, slow_down: { deltaSpmMax: -4 }, stop: { rateBelowSpm: 5, withinMs }, hold: { ... }, ready: { ... }, start: { ... } }`.

### shared/obedience.js
- `export function evaluate({ meaning, callT, events, baselineSpm, windowMs = 8000 })` -> `{ obeyed: true|false|null, strokesUntilObeyed: number|null, deltaSpm: number|null, reason: string }`. `events` are stroke events from the hub; use only those after `callT`. null = not enough strokes to judge ("not sure").
- Pure, no I/O. Document every threshold.

### sarvam/client.js
- `export function createSarvamClient({ apiKey, mode='auto', cacheDir, fetchImpl=fetch, log })`.
  - `translate({ audio /* Buffer */, mime, text /* alternative for typed fallback */, sourceLang='ml-IN' })` -> `{ text, languageProbability?, source: 'live'|'replay', latencyMs }` ; uses Saaras v4 `translate` mode (documented in /private/tmp/claude-501/-Users-rybosafar-devin-hacks/4bd9d671-8cf4-4b89-8517-84c0f28c5a76/scratchpad/loop/sarvam_facts.md and raw docs in the sibling raw/ folder: follow the exact endpoint, header `api-subscription-key`, field names, 30 s REST limit).
  - `speak({ text, targetLang /* e.g. 'hi-IN' */, speaker? })` -> `{ audioBase64, mime, source, latencyMs }` ; Bulbul v3 REST (2,500 char limit).
  - `mode`: 'live' always calls the API; 'replay' reads only from cache and throws a clear error `NoReplayAvailable` if missing; 'auto' = live if apiKey else replay. Every live success is written to cache (key = sha256 of canonical input). Never log the key. Handle 429/timeout with one retry then fall back to replay if available.
- `sarvam/record-fixtures.js`: CLI that records the rehearsal calls (typed text and/or provided audio files) into sarvam/cache so the demo can run offline with a visible REPLAY badge.

### server (http(s), zero-dep except qrcode-generator)
- Env: PORT (3000), SARVAM_API_KEY, SARVAM_MODE, CERT_FILE/KEY_FILE (https when both set). Load `.env` manually (tiny parser), never print values.
- Routes: `GET /` landing (QR to /phone, link to /dashboard, LIVE/REPLAY badge); `GET /phone`, `GET /dashboard`; static `/public/*` and `/shared/*` (with correct JS MIME, no directory traversal); `GET /qr.svg?url=` ; `GET /events` (SSE: events `state`, `stroke`, `call`, `result`, `phone`); `GET /api/state`; `POST /api/phone` (phone hello/heartbeat); `POST /api/stroke` (batched stroke events from phone); `POST /api/shout` (JSON `{ audioBase64?, mime?, text?, targetLang }`).
- `/api/shout` flow: translate -> matchMeaning -> if confidence none respond `{ status:'not_sure' }` and broadcast; else speak(meaning in targetLang using a small phrase table in server) -> broadcast `call` {callId, t, meaning, translatedText, ttsAudioBase64, mime, source, latencyMs} -> record baseline rate -> observe stroke events for windowMs -> evaluate -> broadcast `result` and append to an in-memory trial table (served in state for the evidence table).
- Validation: body size limit 8 MB, JSON schema checks, clear 4xx errors, no stack traces to clients. Keep state immutable (new objects on update).

### phone page
Single tap-to-start button (user gesture) requests `DeviceMotionEvent.requestPermission()` on iOS. Streams samples into `createStrokeDetector` imported from `/shared/stroke.js`, POSTs batched stroke events and a heartbeat. Shows live rate, count. Subscribes to `/events`; when a `call` arrives, plays the TTS audio and shows the meaning big. If motion permission is denied or unavailable: a large honest "TAP TO ROW" fallback labelled as simulation. Works on mobile Safari and Chrome.

### dashboard page
QR + connection status; live stroke-rate sparkline (canvas); a shout box (typed text and a record button via MediaRecorder -> base64) ; a target-language selector (Hindi hi-IN, Bengali bn-IN, Odia od-IN, Tamil ta-IN, English en-IN); shows translation, meaning, confidence, spoken meaning, obedience result ("obeyed in N strokes" or "not obeyed" or "not sure"); evidence table of all trials with hit counts; LIVE/REPLAY badge per call; a "REPLAY demo" button that plays a cached trial. A clear UNVERIFIED notice that the call table is placeholder.

## Design direction
Dark, restrained, type-forward: background #0a0a0a, text near-white, accent olive #464A39 with one signal colour for obeyed (green) / not obeyed (red) / not sure (amber). Fonts: Space Grotesk (system-ui fallback). Large type, generous spacing, no decorative clutter. Mobile-first for the phone page.

## Honesty rules (docs and UI)
This is a pre-event spike. Real race calls are not yet collected (placeholders, UNVERIFIED). Saaras behaviour on shouted Malayalam is untested. Never claim accuracy figures not measured. State REPLAY vs LIVE on every result.
