# rowing-call: runbook

Needs Node 20 or newer. Run everything from the project root.

## Start the server

```
npm install
cp .env.example .env      # optional; never commit .env
npm start
```

The banner prints the laptop URL (`/dashboard`), the phone URL(s) on the local network and the Sarvam mode. Open `/` on the laptop for the QR code.

Environment (in `.env` or the shell; shell wins):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Listening port. |
| `SARVAM_API_KEY` | empty | Sarvam key. Never printed or logged. |
| `SARVAM_MODE` | auto | `live`, `replay`, or `auto` (live if a key is set, else replay). |
| `CERT_FILE`, `KEY_FILE` | empty | Set both to serve HTTPS. |
| `SMALLEST_API_KEY` | empty | smallest.ai key for the optional second voice, coach playback and second ear. Never printed or logged. Uses the same mode as `SARVAM_MODE`: live with a key, replay from the cache without one. |
| `SECOND_EAR` | 0 | `1` also transcribes each spoken shout with smallest.ai Pulse and compares the two meanings (see below). Off by default. |
| `MODEL_FALLBACK` | 0 | `1` asks the hosted chat model (`sarvam-105b`) for a meaning when the keyword rules find no keyword at all (see below). Uses `SARVAM_API_KEY` and `SARVAM_MODE`. Off by default. |

Without a key and without recorded fixtures the server runs, but every shout answers 503 `no_replay_available`: REPLAY can only return what was recorded for that exact input.

## Record fixtures (needs a key)

Fixtures are real Sarvam answers saved in `sarvam/cache`, so the demo can run offline with a visible REPLAY badge. Record them on good Wi-Fi before the demo.

```
# 1. Every phrase the server speaks, in all five dashboard languages (30 short TTS calls)
SARVAM_API_KEY=... npm run record -- --phrases

# 2. The rehearsal shouts: recorded audio files (max 30 s each) and/or typed text
SARVAM_API_KEY=... npm run record -- --audio shouts/call1.webm --audio shouts/call2.webm
SARVAM_API_KEY=... npm run record -- --text "typed call exactly as it will be typed in the demo"
```

`npm run record -- --help` lists all options. The table printed at the end shows what was recorded live; the exit code is non-zero if anything failed.

Replay matches on the exact input: the same audio bytes, or the same typed text. A new live shout into the microphone can never be replayed, so the offline demo is typed text or the dashboard's replay of an earlier trial. If the key is already in `.env`, load it into the shell first (`set -a; . ./.env; set +a`); the recorder reads the environment only.

Do not put hand-written or synthetic files in `sarvam/cache`. Everything there is shown to an audience as a recorded Sarvam answer.

## WhatsApp voice notes

A WhatsApp voice note can be used as a rowing call — nothing is sent automatically from or to WhatsApp (no bot, no WhatsApp account access; the app only reads files placed in a watched folder or uploaded). Transcription is **Sarvam cloud speech-to-text**: the audio leaves the laptop; it is not local.

**Watched inbox folder (WhatsApp Desktop / WhatsApp Web on the MacBook).** The server creates and watches `~/Downloads/rowing-call-inbox` at startup. In WhatsApp Desktop, right-click a voice note → **Download** or **Save as** → save it into that folder. Within a second or two of the file finishing writing it is posted to the shout path (rower language from `WATCH_LANG`, default `en-IN`) and archived as `whatsapp_desktop`. Files already there at startup are ignored (no backfill); non-audio files and files over 5 MB are ignored; source files are only read, never modified. The startup banner and the dashboard show `watching: <folders>`.

- Extra folders: `WATCH_DIRS="~/voice-notes,/abs/dir" npm start` (comma-separated, `~` allowed, relative paths are skipped with a warning). Extra folders tag notes `watched_folder`, except paths containing `whatsapp`, which tag `whatsapp_desktop`.
- `WATCH_INBOX=0` disables the default folder; `WATCH_DIRS` still applies.
- WhatsApp Desktop also keeps downloaded media under `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/Message/Media/` — the exact layout varies by version, so check yours first. **It is not watched by default**: every voice note from every chat saved there would be sent to Sarvam. Adding it to `WATCH_DIRS` prints a one-line warning at startup.

**Other ways in.**

- Dashboard **Voice-note inbox** drop zone (click or drop).
- `npm run ingest -- ~/Downloads/PTT-20261121-WA0001.opus [--lang=hi-IN] [--port=3000]` — one file through the same path, against the running server.
- Phone share sheet → installed PWA share target posts to `/share` and shows a small answer page.

**Formats and limits.** Ogg/Opus (`.opus`, `.ogg`, `.oga` — WhatsApp `PTT-*` files), WAV, MP3, M4A/MP4, AAC/ADTS, AMR (`.amr`, `.awb`), WebM and FLAC are detected from the file's own magic bytes; a mislabelled or unsupported file gets a plain rejection. Max **5 MB**; clips over **30 s** are refused (the Sarvam REST limit) — a long Ogg offers a lossless "use the first 30 s" cut at a page boundary, other formats must be shortened first. Audio is never silently truncated.

**Phone microphone.** The phone page has a **HOLD TO CALL** button: hold, dictate the call (max 25 s, timer shown), release to send it as a `phone_mic` shout. The microphone is requested on the first press and used only while held; stroke detection keeps running. Needs HTTPS (see below).

**Archive.** `GET /api/archive` (newest first, `?q=` searches), plus `GET /api/archive.json` and `GET /api/archive.csv` downloads — text only, no audio. Entries keep the source (`voice_note`, `mic`, `phone_mic`, `text`, `whatsapp_share`, `whatsapp_desktop`, `watched_folder`, `ingest`), file name, the language code Sarvam reported (a language, never a dialect claim), translated text, meaning and the verdict once judged. They persist in `data/archive.jsonl` (git-ignored, capped at 500, oldest dropped).

## smallest.ai extras (optional)

Everything here is off unless a request or the environment asks for it; the default demo path is Sarvam only. `GET /api/providers` shows what is configured (booleans and modes, never keys).

- **Second voice.** Add `"ttsProvider": "smallest"` to the `POST /api/shout` body and the rower's phrase is spoken by smallest.ai Lightning v3.1 instead of Bulbul, from the same phrase table. Each trial row records `ttsProvider` and `tts { provider, latencyMs, source }`, which is what a Sarvam versus smallest.ai latency table is built from. Only the provider that spoke is timed; the server does not call both for one shout.
- **Coach playback.** Add `"coachPlayback": true` to a typed shout and the response also carries `coachAudioBase64` (WAV): the typed Malayalam call spoken back with a smallest.ai Malayalam voice (`shibi`). Spoken (audio) shouts skip it, and so does text over 250 characters.
- **Second ear.** With `SECOND_EAR=1` and a smallest.ai key, a spoken shout is sent to Saaras and to smallest.ai Pulse at the same time. The Pulse transcript is translated to English with the Sarvam text path and both English strings go through the same matcher. The trial carries `ears`: `agree` (confidence raised to high), `disagree` (not sure, reason "two ears disagree", nothing is spoken), `single` (only one ear found a meaning, or the second ear failed) or `none`. It costs one extra Pulse call and one extra Sarvam text translation per spoken shout.

```
curl -s localhost:3000/api/providers
curl -s -X POST localhost:3000/api/shout -H 'Content-Type: application/json' \
  -d '{"text":"typed call","targetLang":"hi-IN","ttsProvider":"smallest","coachPlayback":true}'
```

Honest limits: the voices were picked from the live catalog by tag and have not been judged by native speakers. The smallest.ai docs list Malayalam for Pulse streaming but not in the pre-recorded language list; `language=ml` worked in live calls on 21 Nov 2026 and is used on that evidence only. The docs also say model `lightning_v3.1` is retired on 30 Nov 2026 in favour of `lightning_v3.1_pro`; the model name is one constant in `smallest/client.js` and the Malayalam voices must be re-checked before switching. smallest.ai answers are cached next to the Sarvam ones in `sarvam/cache` as `smallest-speak-*` and `smallest-transcribe-*`, and replay the same way.

## Model fallback (optional)

Off unless `MODEL_FALLBACK=1`. With it off, requests, responses and events are exactly as before.

The keyword rules always run first and always win. The model (`sarvam-105b` on `/v2/chat/completions`, reasoning off, temperature 0, JSON schema with the six meanings plus `none`) is asked only when the rules report `no_match`: no keyword of any meaning in the translated text. It is never asked when the text contains a negation ("do not stop"), keywords of two meanings ("stop, go faster"), no words, or when the two ears disagree; those stay "not sure". This is checked twice, in the server and again inside `sarvam/classifier.js` before any network call.

A model answer is accepted only if it is exactly `{"meaning": "<one of the seven labels>"}`. Anything else, an HTTP error, or no answer within 6 s becomes "not sure"; it never fails the shout. On a call or trial row: `matchedBy` is `rules`, `model` or null (not sure), `confidence` is `model` for a model decision (never `high` or `low`), and `model { meaning, name, latencyMs, source, error }` is present whenever the model was asked. `latencyMs` of the call includes the model time. `GET /api/providers` shows `modelFallback: true` when it is active.

Model answers are cached in `sarvam/cache` as `classify-*` and replay like the others; in REPLAY mode a phrase that was never recorded is simply "not sure".

Honest limits, from one live run of 10 English phrases on 21 Nov 2026 (not an accuracy figure): the model turned phrases such as "Pull with all your strength" and "Put your backs into it" into `speed_up` and refused "What time is it", but it also answered `ready` for "Everyone together now" and for "Oars up", which a coach could mean differently. A model decision is a guess shown as `confidence: model`; treat it as weaker than a rule match. Latency in that run was 0.3 to 1.6 s per phrase. The dashboard page is built separately and may not yet show `matchedBy`.

## MacBook notch (macOS only)

With the server running:

```
npm run notch
```

This compiles `notch-app/NotchApp.swift` with `swiftc` (no Xcode project, no extra dependencies; the build output lands in `git`-ignored `notch-app/build/`) and launches a borderless panel over the notch that loads `http://localhost:3000/notch.html` (port from `PORT`). It needs a notched MacBook to look right — the notch size is measured from `NSScreen.safeAreaInsets` at launch — and falls back to a floating pill at the top centre on other Macs.

- **Collapsed:** phone dot + pulsing oar on the left of the camera, live spm on the right. Grey dot = no phone, green = connected, pulsing amber = waiting for the server (the page and the shell both retry every 2 s).
- **Expanded:** hover, or any incoming call/verdict, grows the island (collapses after 6 s of quiet; focus and recording hold it open). It shows the call two lines + countdown ring + live spm, then the OBEYED / NOT OBEYED / NOT SURE badge with its reason, plus the latest archive entries.
- **Voice out:** the call's TTS audio plays through the Mac speakers; **sound on** mutes, **replay call** / **replay coach** repeat it.
- **Voice in:** **hold to talk** records up to 25 s with the Mac mic and sends it as a call. The first use needs a one-time click in System Settings → Privacy & Security → Microphone; if capture cannot work the button hides and says why.
- **Voice notes:** dropping an audio file (`.opus`, `.ogg`, `.m4a`, `.mp3`, `.wav`, ≤ 5 MB, ≤ 30 s) onto the island sends it through the same path as the dashboard drop zone.
- **Text:** the field takes English or Malayalam (macOS Malayalam keyboard, IME composition safe); Enter sends. Language chips mirror `/api/state.langs`.
- **Quit:** the island's **quit** button, or Cmd-Q while hovering it.

Honest status: on a 15-inch MacBook Air (M2, macOS 27) the build, notch placement, call expansion, the verdict and the timed collapse were verified with `screencapture`; microphone capture, audio output and Cmd-Q are implemented but were not exercised end-to-end here. `watchDirs` from `GET /api/providers` is shown when the watcher reports it; there is no `/api/state` watch line yet (TODO: revisit when the watcher session lands it).

## Phone over HTTPS

Phone motion sensors (and the iOS permission prompt) need a secure page. Two ways.

### A. cloudflared quick tunnel (easiest, needs internet)

```
npm start                                   # terminal 1
cloudflared tunnel --url http://localhost:3000   # terminal 2
```

cloudflared prints an `https://<random-words>.trycloudflare.com` address. Open that address on the laptop: the landing page QR then points at the https tunnel URL, so the phone can scan it. The address changes on every run and anyone who has it can reach the server while the tunnel is up, so stop the tunnel after the demo.

### B. Self-signed certificate (works offline, same Wi-Fi)

```
mkdir -p certs
LAN_IP=$(ipconfig getifaddr en0)            # macOS; on Linux: hostname -I | cut -d' ' -f1
openssl req -x509 -newkey rsa:2048 -nodes -days 7 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=rowing-call" \
  -addext "subjectAltName=IP:${LAN_IP},DNS:localhost"
CERT_FILE=certs/cert.pem KEY_FILE=certs/key.pem npm start
```

`certs/` is ignored by git. On the phone, open `https://<LAN_IP>:3000/phone` and accept the certificate warning once (Safari: Show Details, then visit this website; Chrome: Advanced, then proceed). Do the same on the laptop for the dashboard. If the laptop's IP changes, make a new certificate.

## Run the tests

```
npm test
```

All tests use `node:test`, fake timers and injected fakes; none touch the network or need a key. `shared/stroke.js` and the two pages have their own owners and are not covered here unless their tests are present in `test/`.

## Troubleshooting

- **Every shout returns 503 `no_replay_available`.** REPLAY mode and nothing recorded for that exact input. Set `SARVAM_API_KEY` (and `SARVAM_MODE=auto` or `live`), or record fixtures.
- **The call arrives but there is no sound.** The translation worked but speech failed or was not recorded (`ttsAvailable: false`). Run `npm run record -- --phrases`. On the phone, audio also needs the earlier tap on the start button.
- **502 `translate_failed`.** Sarvam rejected the request or the network failed after one retry. Check the key, credits and connectivity; the server log shows only the error name.
- **Badge says REPLAY although a key is set.** Check `SARVAM_MODE` is not `replay`, and that `.env` is in the project root. A live call that fell back to the cache after a 429 or timeout is also labelled REPLAY, on purpose.
- **Phone shows "simulation" or never asks for motion permission.** The page is on plain HTTP, or permission was denied. Use HTTPS (above); on iOS, close the tab and reopen to be asked again.
- **Phone cannot open the page.** Phone and laptop must be on the same network, and the venue Wi-Fi may block device-to-device traffic. Use a phone hotspot or the cloudflared tunnel.
- **QR points at `localhost` or the wrong address.** Open the landing page through the address the phone should use (the LAN IP or the tunnel URL); the banner lists the LAN addresses.
- **QR image is broken (503 `qr_unavailable`).** Run `npm install`, or type the phone URL shown next to the QR.
- **`/phone` or `/dashboard` says "Page not built yet".** `public/phone.html` or `public/dashboard.html` is missing.
- **"not sure" on every trial.** Speed up and slow down need a rowing baseline (a stroke in the 8 s before the call, at 10 spm or more) and at least 3 strokes after the call. Start rowing before shouting.
- **400 `tts_provider_unavailable` or `coach_playback_unavailable`.** The server was started without the smallest.ai client. With `npm start` the client always exists; without `SMALLEST_API_KEY` it only replays cached answers, so the call arrives without sound (`ttsAvailable: false`) unless that exact phrase was recorded.
- **`ears` is always `single`.** The second ear failed (the log shows `second ear failed` and an error name) or one side found no meaning. Check `SMALLEST_API_KEY` and `/api/providers`.
- **Model fallback is on but a phrase is still "not sure".** Expected when the text is negated or conflicting, when the model answered `none`, or when it failed; the trial row's `model.error` holds a short code (`timeout`, `http_429`, `invalid_output`, `no_replay`, `ModelTimeout`).
- **429 `busy`.** One shout is processed at a time; wait for the previous one to return.
- **`EADDRINUSE` at start.** Another process holds the port; set `PORT` to a free one.
- **Evidence table is empty after a restart.** Trials are kept in memory only.
