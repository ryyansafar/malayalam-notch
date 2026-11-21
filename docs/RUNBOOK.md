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
