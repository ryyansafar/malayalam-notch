# rowing-call

**Someone shouts a rowing command in Malayalam. A rower who does not speak Malayalam hears what it means in their own language, and the phone in their hands shows whether the stroke obeyed.**

Built at Hackathoni (Alappuzha, 21-22 Nov 2026) with Devin. ES modules, Node 20 or newer, one runtime dependency (a QR code library).

## What it is

A practice drill for the classes that Alappuzha snake-boat clubs already run for rowers from outside Kerala. It is an induction and classroom tool, not race equipment. It covers six meanings: start, speed up, slow down, hold, ready, stop.

1. A Malayalam speaker shouts a command into the laptop, in their own words (or types it).
2. Sarvam Saaras translates the shout to English text (Sarvam Mayura handles the typed fallback).
3. A deterministic keyword matcher maps the English text to one of the six meanings, or answers "not sure". No model is involved in this step; the same input always gives the same answer.
4. Sarvam Bulbul speaks the meaning to the rower in their language (smallest.ai Lightning is an optional second voice). Built-in languages: English, Hindi, Bengali, Odia, Tamil.
5. The rower holds a phone like an oar. The phone's motion sensor counts strokes, and the server checks whether the stroke rate changed the way the command asked.
6. The dashboard shows the translation, the meaning, the spoken phrase, the verdict ("obeyed in N strokes", "not obeyed" or "not sure"), and an evidence table of every trial.

## Who it is for

More than 200 professional rowers from outside Kerala row for Nehru Trophy clubs, and most clubs arrange special classes so they can follow the leading captain's Malayalam instructions ([Onmanorama, 25 Aug 2025](https://www.onmanorama.com/travel/travel-news/2025/08/25/nehru-trophy-boat-race-special-classes-for-non-malayali-rowers.html)). This tool is for those classes and the people who run them. That one report is the whole evidence of need; no club or rower has been asked.

## How to run

Needs Node 20 or newer, a laptop and a phone on the same network. Full details, troubleshooting and the offline demo path are in [docs/RUNBOOK.md](docs/RUNBOOK.md).

```
npm install
cp .env.example .env      # optional; never commit .env
npm test
npm start
```

- Open `http://localhost:3000/` on the laptop for the landing page (QR to the phone page, link to `/dashboard`).
- Open `http://localhost:3000/dashboard` on the laptop and `/phone` on the phone.
- Phone motion sensors need a secure page. `docs/RUNBOOK.md` gives two ways: a quick HTTPS tunnel, or a self-signed certificate served through `CERT_FILE` and `KEY_FILE`.
- No key or no network: `SARVAM_MODE=replay npm start` plays recorded answers with a REPLAY badge. `npm run record` records fixtures ahead of time (needs a key).
- Demo steps: see [DEMO.md](DEMO.md).

## WhatsApp voice notes

A coach can send the call as a WhatsApp voice note instead of shouting at the laptop mic. **Nothing is sent automatically from or to WhatsApp**: there is no bot and no WhatsApp account access — the app only reads audio files that were placed in a watched folder or dropped on the dashboard. Transcription is Sarvam cloud speech-to-text, so the audio leaves the laptop.

Four ways in, all through the same shout path:

1. **Watched inbox folder (WhatsApp Desktop / WhatsApp Web).** On startup the server creates and watches `~/Downloads/rowing-call-inbox`. In WhatsApp Desktop on the MacBook, right-click a voice note → **Download** (or Save as) → save it there. The file is read once it has finished writing, run through the shout path and archived with source `whatsapp_desktop`. Files already in the folder at startup are never picked up (no backfill), non-audio and over-5 MB files are ignored, and the source file is only ever read — never deleted, moved or modified. `WATCH_DIRS` (comma-separated absolute paths, `~` allowed) adds more folders; `WATCH_INBOX=0` turns the default one off. The dashboard shows a "watching:" line.
   - WhatsApp Desktop keeps downloaded media under `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/Message/Media/` (the exact layout varies by version — check yours). It is **not** watched by default: every voice note from every chat saved there would be sent to Sarvam. If you add it to `WATCH_DIRS`, the server prints a warning at startup.
2. **Dashboard drop zone.** Drop the file onto the **Voice-note inbox** panel (or click to choose).
3. **`npm run ingest -- <file>`** — sends one file to the running server, exactly like a drop (`--lang=hi-IN` picks the rower's language, `--port` the server port).
4. **Phone share sheet.** The phone page is an installed-PWA share target: sharing a voice note to it posts the file to `/share` and answers with a small page.

Accepted formats (checked by the file's own magic bytes, not the name or the browser's mime guess): Ogg/Opus (WhatsApp `PTT-*.opus`, `.ogg`, `.oga`), WAV, MP3 (ID3 or frame sync), M4A/MP4 (`ftyp`), AAC/ADTS, AMR (`.amr`, `.awb`), WebM and FLAC. Anything else gets a plain "not a recognised audio file" message.

Limits are enforced honestly: **5 MB** max, and **30 s** max (the Sarvam REST speech-to-text limit). Duration is measured exactly for Ogg (last granule position) and WAV (header) and estimated from size otherwise. A longer Ogg note offers a **"use the first 30 s"** button — a lossless cut at an Ogg page boundary, nothing re-encoded; longer notes in other formats just say so. Audio is never silently truncated.

Every heard call — voice note, microphone, phone mic or typed — is kept in the **Call archive** panel: searchable by translation, meaning or language, filterable per language code (the code Sarvam reported — a language, never a dialect claim), with a summary strip (notes today, languages seen, obeyed / not obeyed / not sure), a **copy** button per entry, and **Export JSON / CSV** downloads. Audio bytes are never stored. The archive persists between restarts in `data/archive.jsonl` (git-ignored, capped at 500 entries). "Replay as call" re-sends the stored English text through the shout path; it does not replay the audio.

## Phone microphone

The rower's phone is also the coach's microphone: a big **HOLD TO CALL** button on the phone page records while it is held (MediaRecorder, `audio/webm;codecs=opus` with fallbacks, 25 s max with a live timer) and uploads the clip as a `phone_mic` shout. The microphone is asked for on the first press and only ever open while the button is held; denied permission, missing hardware and missing APIs each get a clear message. Recording never interrupts stroke detection — the rower can keep rowing while the coach dictates. HTTPS is required (use a tunnel or the self-signed route in the runbook).

## MacBook notch (macOS only)

The whole drill also lives in the MacBook notch, like a Dynamic Island.

```
npm start        # the server must be running
npm run notch    # builds notch-app/NotchApp.swift with swiftc and launches it
```

A borderless panel is parked over the notch (a floating pill on Macs without one; the size always comes from `NSScreen`, never hard-coded). Collapsed, the island merges with the notch: a phone-connected dot and a pulsing oar on the left, the live stroke rate on the right. Hovering, a call, or a verdict grows it; 6 s of quiet shrinks it. Expanded, it shows the call (English meaning, the spoken target-language line, a countdown ring for the 8 s window), plays the call through the Mac speakers (mute/replay buttons), and takes input itself: a text field that accepts the macOS Malayalam keyboard, a hold-to-talk mic button (25 s max), and a drop target for WhatsApp voice notes. Language chips and the latest archive entries are there too, so the demo runs without opening the dashboard.

Quit with the island's **quit** button or Cmd-Q while hovering. The mic needs a one-time macOS permission (System Settings → Privacy & Security → Microphone); the button hides itself if capture cannot work.

Verified on a 15-inch MacBook Air (M2, macOS 27): build, placement over the notch, expand on call, the verdict badge and archive row, and the 6 s collapse — all confirmed with screen captures. Microphone capture, Cmd-Q and audio playback paths are wired (embedded `Info.plist`, the WKWebView permission delegate, autoplay allowed) but were not exercised end-to-end on this machine. The page is served at `/notch.html` (the bare `/notch` route does not exist).

## Environment variables

Names and defaults only; `.env` is git-ignored and values are never printed or logged.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Listening port. |
| `SARVAM_API_KEY` | empty | Sarvam key for Saaras, Mayura and Bulbul. |
| `SARVAM_MODE` | auto | `live`, `replay`, or `auto` (live if a key is set, else replay). |
| `CERT_FILE`, `KEY_FILE` | empty | Set both to serve HTTPS locally. |
| `SMALLEST_API_KEY` | empty | smallest.ai key for the optional second voice (Lightning), coach playback and second ear (Pulse). Follows `SARVAM_MODE`. |
| `SECOND_EAR` | 0 | `1` also transcribes each spoken shout with smallest.ai Pulse and compares the two meanings. Off by default. |
| `WATCH_INBOX` | 1 | `0` turns off the default voice-note inbox folder `~/Downloads/rowing-call-inbox`. |
| `WATCH_DIRS` | empty | Comma-separated extra folders to watch for voice notes (absolute paths, `~` allowed). |
| `WATCH_LANG` | en-IN | Rower language used for shouts ingested from watched folders. |

## Architecture

```
phone (motion sensor) -> shared/stroke.js -> POST /api/stroke (batches)
                                                |
dashboard -> POST /api/shout (text or audio)    v
                                        server/index.js
                                          1. translate (Saaras; Mayura for typed text)
                                          2. matchMeaning -> one of six meanings, or "not sure"
                                          3. speak the phrase in targetLang (Bulbul, or Lightning)
                                          4. broadcast the call over SSE; phone plays the audio
                                          5. watch stroke events for 8 s, evaluate obedience
                                          6. broadcast the result, append to the trial table
```

Only the translation and speech steps touch a network. The keyword matcher, stroke detector and obedience rule are pure local code with no model and no I/O. The second ear (off by default) transcribes the shout with Pulse in parallel and compares meanings before speaking. All state lives in memory; a restart clears the evidence table. Full module contracts, routes and SSE event shapes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### APIs used

| API | Model | What it does here | Live calls per shout |
|---|---|---|---|
| Sarvam speech translation | Saaras `saaras:v4`, `translate` mode | Malayalam shout to English text | 1 (audio input) |
| Sarvam text translation | Mayura | Typed Malayalam call to English, and the second-ear transcript | 1 (typed input; 1 extra when the second ear runs) |
| Sarvam text to speech | Bulbul v3 | Speaks the meaning in the rower's language | 1 |
| smallest.ai text to speech | Lightning v3.1 | Optional: second voice, or Malayalam coach playback | 0 by default |
| smallest.ai transcription | Pulse | Optional: second ear for spoken shouts | 0 by default |

## Project structure

```
shared/    stroke.js, calls.js, obedience.js, audio-sniff.js, audio-mime.js  pure modules, run in browser and Node
sarvam/    client.js, record-fixtures.js, cache/  Sarvam client and recorded REPLAY fixtures
smallest/  client.js                            optional smallest.ai client
server/    index.js, hub.js, qr.js, env.js        server, SSE hub + state, QR, .env loading
           archive.js, watcher.js, ingest.js      call archive, folder watcher, ingest CLI
public/    phone.*, dashboard.*, notch.*, vendor/   the pages (vendored files in docs/VENDOR.md)
notch-app/ NotchApp.swift, Info.plist               macOS notch shell; build output is git-ignored
test/      node:test suites, no network, no keys
docs/      ARCHITECTURE.md, RUNBOOK.md, VENDOR.md, devin-tasks/
```

## Honest limits

- **Not race equipment.** An induction and classroom drill. Nobody should carry a phone as an oar in a boat.
- **The call table is UNVERIFIED.** Real race calls have not been collected; the six rows are English placeholder phrases and are marked that way in the app. Only three real terms are confirmed to exist (Aanjukuthi, Valicheduthu, Kuthiyerinju; Onmanorama, 25 Aug 2025) and their meanings are unconfirmed, so they are listed but never used for matching.
- **Shouted Malayalam is untested.** The speech models have been exercised on clean synthetic and typed input, not on a real shouted call from a boat shed. No accuracy figure is claimed.
- **No speech confidence score.** "Not sure" comes from the keyword matcher, not from the speech model. If the translation is wrong but reads as a clear command, the wrong meaning is spoken; the English text is always shown so the caller can catch it.
- **Stroke detection is untested on real rowing.** It is air-rowing with a phone; it measures stroke rate only and judges no technique. The obedience thresholds (for example +4 spm for speed up) are documented choices in `shared/calls.js`, tuned on one phone.
- **Spoken phrases unreviewed.** The six meanings are spoken from a phrase table written at the event; no native speaker of Hindi, Bengali, Odia or Tamil has reviewed them.
- **LIVE and REPLAY.** Every call and trial is badged. REPLAY means a recorded answer to that exact input from an earlier live call.
- **Tap-to-row** appears when motion sensing is unavailable and is labelled SIMULATION.

## Tracks

- **Primary: Beyond English.** Remove the Malayalam speech and nothing works; the product is the translation of a spoken command for someone who does not know the language.
- **The Alappuzha Challenge.** A reported local need: rowers from outside Kerala in the Nehru Trophy boat clubs learning the captain's words.
- **Beyond the Screen.** The input is a shout and a body movement; the phone's motion sensor decides the result.

## How Devin was used

Devin sessions built the modules listed in `CONTRACT.md` (stroke detector, phone page, dashboard) from task briefs prepared before the event, kept in `docs/devin-tasks/`. The builder reviewed the output and did the phone and microphone testing by hand. No product code existed before kickoff; the planning notes and task briefs did.

## What is next

- Collect and verify the real race calls with a boat club.
- Measure recognition on shouts recorded in a real practice session.
- Have the spoken phrase table reviewed by native speakers.

## Socials and Support

Built by Ryyan Safar.

- Portfolio: https://ryyansafar.site
- GitHub: https://github.com/ryyansafar
- Buy Me a Coffee: https://buymeacoffee.com/ryyansafar
- PayPal: https://www.paypal.com/paypalme/ryyansafar
- Razorpay: https://razorpay.me/@ryyansafar
