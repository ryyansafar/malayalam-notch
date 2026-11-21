# Malayalam in the notch: architecture

One product: a Malayalam-first assistant in the MacBook notch. A voice note (or typed Malayalam, or a mic clip) is heard by three parallel Sarvam Saaras modes — `transcribe` (Malayalam script), `translit` (romanised), `translate` (English) — shown on the result card, and optionally spoken in another language (Bulbul; smallest.ai Lightning optional).

## Modules

| File | Role |
|---|---|
| `shared/audio-sniff.js` | `sniffAudio(buf)` (magic bytes → `{ format, mime, label }`), `formatFromName`, `measureDuration` (Ogg granule + WAV header exact, size estimate otherwise), `cutOgg` (lossless first-N-seconds at a page boundary). Browser and Node. |
| `shared/audio-mime.js` | `mimeFromName(filename, reported)` — extension mime when the browser reports none. |
| `sarvam/client.js` | `createSarvamClient({ apiKey, mode, cacheDir })`: `stt({ audio, mime, sourceLang, mode })` for all five Saaras modes, `translate({ text, targetLang })` (Mayura), `speak({ text, targetLang })` (Bulbul v3). File cache keyed by sha256 of canonical inputs, per-mode keys. Modes: live, replay, auto. |
| `smallest/client.js` | `createSmallestClient(...)`: `speak()` (Lightning v3.1, WAV), `speakMalayalam()`. Same mode/cache/retry rule; cache files prefixed `smallest-speak-`. Optional. |
| `sarvam/record-fixtures.js` | CLI recording live answers into `sarvam/cache`; `--audio` records all three STT modes per file. |
| `server/hub.js` | SSE hub, frozen session state (`langs`, `phone`, `lastNote`), body validation (`validateShout`, `validatePhone`). |
| `server/archive.js` | `createArchive({ file, maxEntries=500 })`: JSONL archive of `{ id, time, source, filename, language, transcript, roman, text }`. No audio, no keys; IO errors logged and swallowed. `archiveCsv`/`archiveJson` exports. |
| `server/watcher.js` | `createWatcher({ dirs, ingest })`: `fs.watch` + size-stability + sha256 dedupe → `ingest`. Never backfills, never modifies sources. `resolveWatchDirs` builds the list (default `~/Downloads/malayalam-notch-inbox`, extras `WATCH_DIRS`, off `WATCH_INBOX=0`). |
| `server/ingest.js` | `npm run ingest -- <file>` CLI: sniff + limits → `POST /api/shout`. |
| `server/index.js` | HTTP(S) server: routes, validation, static files, the shout flow. Everything external is injected into `createServer`. |
| `server/qr.js`, `server/env.js` | QR SVG + landing/message pages; `.env` parser + startup banner (never prints values). |
| `public/notch.*` | The island page: `notch-core.js` holds pure phase/card/shelf logic (Node-testable), `notch.js` the DOM/SSE/native wiring, `notch.css` the shape + spring morphs. |
| `public/dashboard.*` | The desk: voice-note inbox, latest note, archive table. |
| `public/phone.*` | Hold-to-talk mic page + PWA share target (`/share`). |
| `notch-app/NotchApp.swift` | Borderless non-activating NSPanel + transparent WKWebView; always-on NSDraggingDestination over the notch; global `.leftMouseDragged` monitor + drag-pasteboard check for early expand; URLSession post for native drops. |

Zero runtime dependencies except `qrcode-generator`. Tests use `node:test`.

## Data flow

```
notch drop / watched folder / share sheet / ingest / mics / typed text
              |
              v
     POST /api/shout  (one shout at a time -> 429 busy)
        audio input:
          Promise.all on the SAME buffer+mime:
            stt(mode='transcribe') -> sourceText    (Malayalam script)
            stt(mode='translit')   -> romanText     (romanised)
            stt(mode='translate')  -> translatedText (English)
          failed modes recorded in failedOps; all three failing -> 502
        text input:  Mayura translate; the typed text is kept as sourceText
        -> speak(spokenText, targetLang)  Bulbul or Lightning (ttsProvider)
        -> archive.add({ transcript, roman, text }); hub 'received' + 'note'
              |
   GET /events (SSE: state, received, note, phone) -> island, desk, phone
```

`POST /api/speak` re-speaks stored text (the shelf's "speak" chips and the desk's "Speak again"). `POST /api/phone` is the phone heartbeat. `GET /api/state` gives `langs`, `phone`, `lastNote`, `notesToday`, `serverT`. `GET /api/providers` reports booleans and modes only. `GET /api/archive`, `/api/archive.json`, `/api/archive.csv` serve the archive. `POST /share` (+ `/share/cut`) is the PWA share target.

## The island contract

Page → native channel `webkit.messageHandlers.notch`: `{type:'size',w,h}` (window jumps, never animates), `{type:'hover',on}` (key-without-activating), `{type:'quit'}`. Native → page: a `notch-native` CustomEvent with `{type:'drag',on}`, `{type:'nativeDrop',filename}`, `{type:'nativeError',message}`, `{type:'hoverNear',on}`.

Phases (`public/notch-core.js`): `idle`, `received`, `translating`, `result`, `recording`, `error` — each with a plain-words line; the card shows only API-returned text and names failed modes; the shelf keeps the last five notes (`pushShelf`, capped, no audio); `shouldCollapse` collapses after `COLLAPSE_AFTER_MS` unless recording/busy/focused/dragging.

Design is specified in `docs/DESIGN.md`; window/animation technique in `docs/NOTCH-REFERENCE.md`; approach-region + drop-target geometry in `docs/DRAG-FINDINGS.md`; Saaras modes in `docs/SARVAM-FINDINGS.md`.
