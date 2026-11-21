# Malayalam in the notch

**Drag a WhatsApp voice note toward the MacBook notch. The island opens, the Malayalam is transcribed and translated, and the answer can be spoken back in another language.**

Built at Hackathoni (Alappuzha, 21-22 Nov 2026). A native SwiftUI app for the notch (`malayalam-notch/`, written from scratch, no Xcode project needed) plus a Node 20 server (one runtime dependency, a QR code library) that talks to Sarvam and smallest.ai.

## What it is

A Malayalam-first assistant that lives in the notch:

1. Drag an audio file — a WhatsApp `PTT-*.opus` voice note is the hero case — toward the top of the screen. The island expands as the file approaches and glows as a drop target **below** the screen edge (the top edge itself triggers Mission Control; see `docs/DRAG-FINDINGS.md`).
2. The same audio goes through three Sarvam Saaras `saaras:v4` modes **in parallel**: `transcribe` (Malayalam script), `translit` (romanised) and `translate` (English). One failed mode never erases the others.
3. The result card shows all three texts, the detected language code and a **Speak** button that reads the translation aloud in a chosen language (Sarvam Bulbul; smallest.ai Lightning is an optional second voice). Typed Malayalam and the Mac/phone microphones work too.
4. The last five notes sit as chips on the shelf; everything is archived to `data/archive.jsonl` (500 entries, text only — audio bytes are never stored).

Transcription and translation are **Sarvam cloud** services, and the card says so. The API reports a language code — a language, never a dialect claim. Machine translation is not certified translation.

## How to run

```
npm install
cp .env.example .env      # optional; never commit .env
npm test
npm start                 # server on :3000
npm run notch             # builds malayalam-notch/ with swiftc into build/Malayalam Notch.app and launches it
scripts/notch.sh toggle   # start/stop the server and the notch together
```

- `http://localhost:3000/` — landing page (QR to the phone mic page, link to the desk).
- `http://localhost:3000/dashboard` — the desk: voice-note drop zone, latest note, archive with search/export.
- `http://localhost:3000/phone` — hold-to-talk phone microphone (HTTPS or localhost needed for mic access).
- `npm run ingest -- <file>` — send one audio file through the same path from the shell.
- `SARVAM_MODE=replay npm start` — run offline against recorded fixtures in `sarvam/cache` (`npm run record` records more; needs a key).

Voice notes also arrive automatically: the server watches `~/Downloads/malayalam-notch-inbox` (create it or let the server do it, then save a voice note there from WhatsApp Desktop — right-click → Download). `WATCH_DIRS` adds more folders, `WATCH_INBOX=0` turns the default off. Files are only read, never modified, and nothing is sent from or to WhatsApp itself.

## The notch

`malayalam-notch/` is a native macOS app (SwiftUI, built with `malayalam-notch/build.sh`; copy the result to `~/Applications`). It never shows a Dock icon. Sizes come from `NSScreen`, so it fits any notched MacBook and falls back to a floating pill elsewhere.

- **Closed:** exactly the width of the physical notch. Nothing is drawn while idle.
- **Live activity:** when music plays or a note is being processed, the pill grows sideways by `2 x (notch height - 12) + 20` points, with 20x20 artwork on the left wing and a live equaliser on the right, and retracts when it stops.
- **Open (hover, or a file drag approaching):** a 760 x 226 island with a tab bar and one card per feature.
  - **Voice tab:** *Voice* (drop a voice note, hold to speak), *Translation* (Malayalam script, romanised line, English, speak/copy/mute, language and voice-engine choice: Sarvam Bulbul or smallest.ai Lightning) and *Now playing* (Music or Spotify: artwork, title, progress, previous/play/next).
  - **Assistant tab:** a command bar (typed or spoken, English or Malayalam), quick-launch app icons, *Reminders* that speak aloud, a *Desktop* tidy-up with a plan and Undo, and clipboard translate.
- **Voice commands** are understood on this Mac by plain rules (`Sources/MalayalamIntent.swift`): "open Calendar", "message Amma on WhatsApp saying I am late" (WhatsApp opens with the text ready; you press Send), "remind me to call Amma in 10 minutes", "set a timer for 5 minutes", "tidy my desktop", "pause".
- **Window rules:** the window is created once at full size and never resized; only the shape inside morphs, with the open/close spring curves of the best notch apps (`docs/NOTCH-REFERENCE.md`). A cursor poll opens it on hover or when an audio file drag approaches (the screen edge itself triggers Mission Control, so the drop target sits below it, see `docs/DRAG-FINDINGS.md`).
- **Permissions you will be asked for, once:** Microphone (hold to speak), Automation for Music/Spotify (now playing), Files (Desktop), Notifications (reminders).

Right-click the island for Mute / Open desk / Quit.

## Accepted audio

Checked by magic bytes, not the file name: Ogg/Opus (WhatsApp `.opus`/`.ogg`), WAV, MP3, M4A/MP4, AAC/ADTS, AMR, WebM, FLAC. Max 5 MB and 30 s (the Saaras REST limit); a longer Ogg note can be losslessly cut to the first 30 s.

## Environment variables

Names and defaults only; `.env` is git-ignored and values are never printed or logged.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Listening port. |
| `SARVAM_API_KEY` | empty | Sarvam key for Saaras, Mayura and Bulbul. |
| `SARVAM_MODE` | auto | `live`, `replay`, or `auto` (live if a key is set). |
| `CERT_FILE`, `KEY_FILE` | empty | Set both to serve HTTPS locally. |
| `SMALLEST_API_KEY` | empty | smallest.ai key for the optional second voice. Follows `SARVAM_MODE`. |
| `WATCH_INBOX` | 1 | `0` turns off the default inbox folder. |
| `WATCH_DIRS` | empty | Extra watched folders (comma-separated absolute paths). |
| `WATCH_LANG` | en-IN | Target language for watched-folder notes. |

## Architecture

```
a voice note (notch drop, watched folder, share sheet, ingest, mics, typed text)
              |
              v
      server/index.js  POST /api/shout
        1. three parallel Saaras calls on the same audio:
           transcribe (ml script) + translit (romanised) + translate (English)
           typed text: Mayura translation instead
        2. speak the translation in targetLang (Bulbul, or Lightning)
        3. archive text fields; broadcast `note` over SSE
              |
   GET /events (SSE) ----> notch island, desk, phone page
```

`GET /api/state`, `/api/providers`, `/api/archive[.json|.csv]`, `POST /api/speak`, `POST /api/phone`, `POST /share` (+ `/share/cut`) round out the surface. All providers are injected for tests; `npm test` runs `node:test` with no network. Full contracts: `docs/ARCHITECTURE.md`, run instructions: `docs/RUNBOOK.md`, demo script: `DEMO.md`.

| API | Model | Role | Calls per audio note |
|---|---|---|---|
| Sarvam speech-to-text | Saaras `saaras:v4` | transcribe + translit + translate modes | 3 (parallel) |
| Sarvam text translation | Mayura | typed text | 1 (typed input only) |
| Sarvam TTS | Bulbul v3 | speaks the translation | 1 |
| smallest.ai TTS | Lightning v3.1 | optional second voice | 0 by default |

## Project structure

```
shared/    audio-sniff.js, audio-mime.js        pure modules, run in browser and Node
sarvam/    client.js, record-fixtures.js, cache/  Sarvam client and recorded REPLAY fixtures
smallest/  client.js                            optional smallest.ai client
server/    index.js, hub.js, qr.js, env.js        server, SSE hub + state, QR, .env loading
           archive.js, watcher.js, ingest.js      archive, folder watcher, ingest CLI
public/    dashboard.*, phone.*                   the desk and the phone mic page
malayalam-notch/ Sources/*.swift, Info.plist, build.sh   the native notch app
tools/dragtest/                                   closed-loop real-drag acceptance rig
test/      node:test suites, no network, no keys
docs/      DESIGN.md, DRAG-FINDINGS.md, SARVAM-FINDINGS.md, NOTCH-REFERENCE.md, ARCHITECTURE.md, RUNBOOK.md, KNOWHOW.md, devin-tasks/
```

## Honest limits

- **Cloud, not local.** Transcription, translation and voices are Sarvam calls; the audio leaves the Mac. The UI and docs say so.
- **Machine translation.** It is shown for convenience and labelled as such; it is not a certified translation.
- **Language, not dialect.** The API reports a language code (usually `ml-IN`); we report exactly that and never invent dialect claims.
- **Partial results.** If one of the three speech modes fails, the card shows the others and names the missing one — nothing is fabricated.
- **LIVE and REPLAY.** Every note is badged by lane. REPLAY means a recorded answer to that exact input from an earlier live call.
- **Real drags need Accessibility permission** for the automated test rig (`tools/dragtest`); the drag itself works without it — only the synthetic test events do.

## Tracks

- **Primary: Beyond English.** The product is a spoken Malayalam note becoming text and speech someone else can use; remove the Malayalam speech and nothing works.
- **The Alappuzha Challenge.** Voice notes are how people actually send Malayalam; the notch is where a Mac user already looks.
- **Beyond the Screen.** The whole product lives in the notch — no window to find, nothing to manage, drag and done.

## Socials and Support

Built by Ryyan Safar.

- Portfolio: https://ryyansafar.site
- GitHub: https://github.com/ryyansafar
- Buy Me a Coffee: https://buymeacoffee.com/ryyansafar
- PayPal: https://www.paypal.com/paypalme/ryyansafar
- Razorpay: https://razorpay.me/@ryyansafar
