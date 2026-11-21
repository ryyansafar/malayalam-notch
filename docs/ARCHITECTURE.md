# rowing-call: architecture

An induction and classroom drill, not race equipment. A phone is the oar. A shouted Malayalam work call is translated to English (Sarvam Saaras), mapped to one of six meanings by a deterministic keyword matcher, spoken to the rower in their language (Sarvam Bulbul), and the phone's stroke rate shows whether the rower obeyed.

Honest status: this is a pre-event spike. The call table is placeholder (UNVERIFIED), the spoken phrases are not reviewed by native speakers, Saaras on shouted Malayalam is untested, and no accuracy figure has been measured.

## Modules

| File | Role |
|---|---|
| `shared/stroke.js` | Stroke detector from accelerometer samples. Runs on the phone. Built separately. |
| `shared/calls.js` | `MEANINGS`, placeholder `CALLS`, `EXPECTED` thresholds, `matchMeaning(text)`, `noMatchReason(text)` (`empty`, `negation`, `conflict`, `no_match`, or null when matched). Pure, browser and Node. |
| `shared/obedience.js` | `evaluate({ meaning, callT, events, baselineSpm, windowMs })` gives `{ obeyed, strokesUntilObeyed, deltaSpm, reason }`. Pure. |
| `sarvam/client.js` | `createSarvamClient({ apiKey, mode, cacheDir })` with `translate()` and `speak()`. File cache keyed by sha256 of the canonical input. Modes: live, replay, auto. |
| `smallest/client.js` | `createSmallestClient({ apiKey, mode, cacheDir })` with `speak()`, `speakMalayalam()` (Lightning v3.1, WAV) and `transcribe()` (Pulse). Same modes, cache folder and retry rule as the Sarvam client; cache files are prefixed `smallest-speak-` and `smallest-transcribe-`. Optional. |
| `sarvam/classifier.js` | `createMeaningClassifier({ apiKey, mode, cacheDir })` with `classify({ text })` giving `{ meaning or null, confidence: 'model', source, latencyMs, model }`. Hosted chat model `sarvam-105b`, strict JSON schema, 6 s budget, cache files prefixed `classify-`. Optional, off by default. |
| `sarvam/record-fixtures.js` | CLI that records live answers into `sarvam/cache` for offline REPLAY. |
| `server/archive.js` | `createArchive({ file, maxEntries })`: capped, searchable archive of every heard call, persisted as JSON lines under `data/` (git-ignored). Audio bytes and keys are never stored; IO errors are logged and swallowed so archiving can never fail a shout. |
| `server/index.js` | HTTP(S) server: routes, validation, static files, the shout flow. Everything external is injected into `createServer`. |
| `server/hub.js` | SSE hub, immutable session state, the spoken phrase table (`PHRASES`), validation of inbound bodies. |
| `shared/audio-mime.js` | `mimeFromName(filename, reported)`: audio mime from the file extension when the browser reports none (WhatsApp `.opus`). Browser and Node. |
| `server/qr.js` | QR SVG (qrcode-generator), landing page and message page HTML. |
| `server/env.js` | `.env` parser, config validation, startup banner. Never prints values. |
| `public/phone.*`, `public/dashboard.*` | Phone page and laptop dashboard. Built separately. |

Zero runtime dependencies except `qrcode-generator`. Tests use `node:test`.

## Data flow

```
phone (devicemotion) -> shared/stroke.js -> POST /api/stroke (batches, ~500 ms)
                                              |
                                              v
dashboard -> POST /api/shout ----------> server/index.js
   { text | audioBase64, targetLang }      1. sarvam.translate()   audio: Saaras v4 translate mode
                                              (source ml-IN)       typed text: Mayura text translation
                                           2. matchMeaning(english)
                                           3. confidence none -> trial "not_sure", stop here
                                           4. sarvam.speak(PHRASES[meaning][targetLang])   Bulbul v3
                                           5. broadcast `call`, baseline = last stroke rate before the call
                                           6. observe strokes for windowMs (8 s) + 750 ms grace
                                           7. evaluate() -> broadcast `result`, append to trials
                                              |
                         GET /events (SSE) <--+--> phone plays the audio, dashboard shows evidence
```

Optional smallest.ai paths (all off by default; the flow above is unchanged without them):

- `ttsProvider: 'smallest'` in the shout body: step 4 uses `smallest.speak()` with the same phrase table. Every call and trial records `ttsProvider` and `tts { provider, latencyMs, source }` (`tts` is null when speech failed).
- `coachPlayback: true` with typed text: in parallel with the flow, `smallest.speakMalayalam(text)` speaks the coach's own call; the audio is returned only in the HTTP response (`coachAudioBase64`, `coachMime`, `coachSource`, `coachLatencyMs`), never broadcast or stored.
- `SECOND_EAR=1` with audio input: step 1 runs two ears in parallel. Ear one is Saaras translate. Ear two is `smallest.transcribe(audio, 'ml')`, then `sarvam.translate({ text })` (Mayura), then `matchMeaning`. Both meanings set and equal: `ears: 'agree'`, confidence `high`. Both set and different: trial `not_sure`, reason `two ears disagree`. Exactly one set: that one is used, `ears: 'single'`. Neither: the usual `not_sure`, `ears: 'none'`. A failed second ear is logged by error name and counts as unset. `ears` and `secondEar { transcript, translatedText, meaning, source, latencyMs }` appear on call, result and trial rows only when the second ear ran. The hearing stage latency is the slower of the two ears.

Optional model fallback (`MODEL_FALLBACK=1`, default off; the flow above is unchanged without it):

- Between steps 2 and 3. If `matchMeaning` found nothing and `noMatchReason(english)` is exactly `no_match`, the server calls `classifier.classify({ text })`. `negation`, `conflict`, `empty`, an unknown reason, and `ears: 'disagree'` never reach the model; with the second ear on, its English text must not be negated or conflicting either. The classifier repeats the same check itself before any request.
- The model only chooses among the six meanings or `none` (JSON schema enum, validated again on our side, and again when read from the cache). `none`, an invalid answer, an error or a timeout (6 s in the classifier, 6.5 s hard stop in the server) continues to step 3 as "not sure".
- With the flag on, call, result and trial rows carry `matchedBy` (`rules`, `model`, or null for not sure) and `model` (null if not asked, else `{ meaning, name, latencyMs, source, error }`); a model decision has `confidence: 'model'` and `matchedKeyword: null`; `sources.model` is added when the model was asked; `latencyMs` includes the model time; the call is LIVE only if the model answer was live too. With the flag off none of these fields exist.

Environment: `SMALLEST_API_KEY` (optional; the smallest.ai client follows `SARVAM_MODE`), `SECOND_EAR` (`1` to enable, default off) and `MODEL_FALLBACK` (`1` to enable, default off; uses `SARVAM_API_KEY`).

Clocks: phone stroke timestamps are on the phone clock. The server re-anchors each batch so that `sentAt` (or the newest event) equals server "now"; `t` in every broadcast stroke is server time and `phoneT` keeps the original.

Sarvam modes: `live` always calls the API and caches each success. `replay` reads only the cache and fails with `NoReplayAvailable` when the exact input was never recorded. `auto` is live when a key is present, else replay. On 429, 5xx, timeout or 402 the client retries once (not for 402) and then falls back to the cache if it can. A call is labelled LIVE only if every part of it was live.

## Routes

| Route | Purpose |
|---|---|
| `GET /` | Landing page: QR to `/phone`, link to `/dashboard`, LIVE or REPLAY badge. |
| `GET /phone`, `GET /dashboard` | `public/phone.html`, `public/dashboard.html` (a plain "not built yet" page if missing). |
| `GET /public/*`, `GET /shared/*`, `GET /<file.ext>` | Static files. Known extensions only, no dotfiles, no traversal, symlinks must stay inside the folder. |
| `GET /qr.svg?url=` | QR code as SVG for an absolute http(s) URL of at most 512 characters. |
| `GET /events` | Server-sent events (below). |
| `GET /api/state` | Current public state as JSON. |
| `POST /api/phone` | Phone hello and heartbeat: `{ userAgent?, simulated? }`. |
| `POST /api/stroke` | `{ events: [{ type: 'stroke', t, rateSpm, count }], sentAt? }`, at most 200 per batch. |
| `POST /api/shout` | `{ text, targetLang }` or `{ audioBase64, mime?, targetLang }`. `targetLang` is one of `en-IN, hi-IN, bn-IN, od-IN, ta-IN`. Optional: `ttsProvider` (`sarvam` default, or `smallest`) and `coachPlayback` (boolean); bad values get a 400. Optional `source` (`voice_note`, `text`, `mic`; defaults to `mic` for audio and `text` for text) and `filename` (a file name, no path separators, at most 200 characters) are used only for the archive entry. |
| `GET /api/archive` | `{ ok, entries }` newest first; `?q=` searches the translation, meaning, filename and language. Persisted in `data/archive.jsonl`, capped at 500 entries. An entry is written when a call is heard (`verdict: null`) and updated when the trial is judged. |
| `GET /api/providers` | `{ providers: { sarvam: { configured, mode }, smallest: { configured, mode } }, ttsProviders, defaultTtsProvider, coachPlayback, secondEar }`, plus `modelFallback: true` only when the model fallback is active. Booleans and mode names only, never keys. |

Errors are JSON `{ ok: false, error: { code, message } }`: 400 validation, 404, 405, 413 (body over 8 MB), 429 (a shout is already in flight), 502 (Sarvam call failed), 503 (`no_replay_available`, or QR unavailable). No stack traces leave the process.

## SSE events

| Event | Payload |
|---|---|
| `state` | Full public state: `mode`, `phone`, `stroke`, `recentStrokes`, `lastCall`, `lastResult`, `trials`, `tally { obeyed, notObeyed, notSure, total }`, `langs`, `callsVerified: false`, `phrasesReviewed: false`, `serverT`. Sent on connect and after every result. |
| `phone` | `{ connected, lastSeenT, userAgent, simulated }`. Disconnects after 10 s without a heartbeat or stroke. |
| `stroke` | `{ type: 'stroke', t, phoneT, rateSpm, count, simulated }`. |
| `call` | `{ callId, t, meaning, translatedText, confidence, matchedKeyword, spokenText, targetLang, ttsAudioBase64, mime, ttsAvailable, source, sources { translate, speak }, latencyMs, baselineSpm, windowMs, status: 'ok', ttsProvider, tts { provider, latencyMs, source } }`, plus `ears` and `secondEar` when the second ear ran. Audio is sent here once and never stored in state. |
| `result` | The trial row: the call fields without audio, plus `obeyed` (true, false or null), `strokesUntilObeyed`, `deltaSpm`, `reason`, `outcome` (`obeyed`, `not_obeyed`, `not_sure`), `status` (`judged` or `not_sure`), `stage`, `strokesObserved`, `superseded`. A shout whose meaning was not recognised produces a `result` with `status: 'not_sure'` and no `call`. |

## State and limits

State lives in memory only and is rebuilt as a new frozen object on every change. It keeps the last 600 strokes and 500 trials; a restart clears the evidence table. One shout is processed at a time, and a new call ends an open observation window early (that trial is marked `superseded`).
