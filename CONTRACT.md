# malayalam-notch: module contract (all agents must follow; files are owned, do not edit files you do not own)

Built at Hackathoni (repo created at the event, 21 Nov 2026). ES modules, Node >= 20, zero runtime dependencies except `qrcode-generator` (server QR). Tests use `node:test` (`npm test` runs `node --test test/`). Never print or log secrets. Never commit `.env`. No emojis in code or UI text.

## What it is
A Malayalam-first assistant in the MacBook notch. Drag a WhatsApp voice note (or any audio) toward the notch: it expands early, and three parallel Sarvam Saaras `saaras:v4` calls on the same audio produce the Malayalam script (`transcribe`), romanised (`translit`) and English (`translate`) for the result card; Bulbul (or smallest.ai Lightning) can speak the translation in a chosen language. Everything is archived as text — never audio, never keys. The UI and docs must say "Sarvam cloud", report the API's language code (language, never dialect), and never fabricate Malayalam.

## Layout and owners
- shared/audio-sniff.js, audio-mime.js    owner: agent D       pure audio detection/duration/cut
- sarvam/client.js, record-fixtures.js    owner: agent C       Sarvam REST client + fixture recorder
- smallest/client.js                      owner: agent C       smallest.ai TTS (optional)
- server/index.js, hub.js, qr.js, env.js  owner: agent A       http(s) server, SSE hub, routes
- server/archive.js, watcher.js, ingest.js owner: agent D      archive, watcher, ingest CLI
- public/notch.*, notch-core.js           owner: notch session  island page + pure state logic
- public/dashboard.*, public/phone.*      owner: agent B       desk view + phone mic page
- notch-app/*                             owner: notch session  native shell
- test/<module>.test.js                   owner: whoever owns the module
- README.md, docs/*                       owner: integrator (last phase)

## Interfaces

### sarvam/client.js
- `createSarvamClient({ apiKey, mode='auto', cacheDir, fetchImpl, log })` → `{ stt, translate, speak, mode }`.
- `stt({ audio: Buffer|Uint8Array, mime, sourceLang='ml-IN', mode })` → `{ text, language, source, latencyMs }`. `mode` is one of `transcribe`, `translit`, `translate`, `codemix`, `verbatim` (`STT_MODES`); cache key includes the mode. Multipart POST `/speech-to-text`, `model=saaras:v4`.
- `translate({ text, sourceLang='ml-IN', targetLang })` → `{ text, language, source, latencyMs }` (Mayura).
- `speak({ text, targetLang })` → `{ audioBase64, mime, source, latencyMs }` (Bulbul v3 WAV).

### server/hub.js
- `initialState`, `withPhone`, `withNote` (strips audio), `publicState`, `formatSse`, `createHub` (state, SSE clients, broadcast).
- `LANGS` = en-IN, hi-IN, bn-IN, od-IN, ta-IN. `SHOUT_SOURCES` = voice_note, text, mic, phone_mic, whatsapp_share, whatsapp_desktop, watched_folder, ingest, notch_drop (keep in sync with `archive.js` `SOURCES`).
- `validateShout(body, cfg)`: `{ text }` xor `{ audioBase64, mime }`, `targetLang` required, `source`/`filename` validated, `mode` accepted-and-ignored; throws `HttpError`-style errors with precise `code`s.

### server/archive.js
- `createArchive({ file, maxEntries=500, now })` → `{ add, list({q}), size, countToday }`. Entry fields only: `id, time, source, filename, language, transcript, roman, text`. Unknown fields dropped, audio never stored, IO failures logged not thrown. `archiveCsv(entries)`, `archiveJson(entries)` for downloads.

### server/index.js (routes)
- `GET /` landing, `GET /qr.svg`, `GET /api/state`, `GET /api/providers` (booleans + modes only), `GET /api/archive[.json|.csv]` (`?q=` search), `GET /events` (SSE: `state`, `received`, `note`, `phone`), `GET /phone`, `GET /dashboard`.
- `POST /api/phone` heartbeat. `POST /api/shout` the flow above — SSE `received` then `note`. `POST /api/speak { text, targetLang, ttsProvider }` re-speaks. `POST /share`, `POST /share/cut` share-target.
- The note shape: `noteId, t, status, input, origin, filename, targetLang, sourceText, romanText, translatedText, detectedLanguage, spokenText, spokenLang, ttsAudioBase64, mime, ttsAvailable, ttsProvider, tts, sources, failedOps, latencyMs, source`.

### shared/audio-sniff.js / audio-mime.js
- `sniffAudio(buf)` → `{ format, mime, label } | null`; `formatFromName(name)`; `measureDuration(buf, format)` → `{ seconds, exact } | null`; `cutOgg(buf, seconds)`; `mimeFromName(filename, reported)`. `NOTE_MAX_BYTES` = 5 MB, `SPEECH_MAX_SECONDS` = 30.

### public/notch-core.js (pure, browser and Node)
- `PHASES`, `COLLAPSE_AFTER_MS`, `SHELF_MAX`, `AUDIO_EXTENSIONS`, `SHOUT_SOURCE`; `nextPhase`, `phaseLine`, `cardFields`, `noteOriginBadge`, `pushShelf`, `chipLine`, `elapsedSeconds`, `shouldCollapse`, `receivedLine`, `acceptsAudioName`. No DOM, no I/O.

### notch-app/NotchApp.swift
- Non-activating NSPanel above the menu-bar level hosting a transparent WKWebView on `/notch.html`. Message channel `notch` for `size`/`hover`/`quit`; `notch-native` CustomEvent inbound. Always-on `DropZone` (NSDraggingDestination, `.fileURL`, audio only) over the notch; grows to cover the page's dashed target (y ≈ 50–170) while a drag is in the approach region (~160 pt top / ~120 pt horizontal); URLSession post to `/api/shout` on drop. The window never animates — it jumps while the island morphs in CSS.

## Rules
- One shout at a time: in-flight requests answer 429 `busy`.
- All three STT modes run concurrently on the same buffer+mime; per-mode failures go to `failedOps` and never blank the other fields.
- Audio bytes, key material and absolute paths never enter state, SSE, the archive or logs.
- `docs/DESIGN.md` governs the island's look; follow it exactly.
