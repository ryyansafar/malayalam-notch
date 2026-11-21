# Know-how (read this first, it saves tokens)

One product: **Malayalam in the MacBook notch**. Drag a WhatsApp voice note (or any audio) toward the notch, it expands, and the Malayalam is transcribed, translated, shown and optionally spoken in another language. A rowing-call trainer (phone as oar) is kept as a secondary "Row" mode.

## Map of the repo
| Path | What it is |
|---|---|
| `server/index.js` | HTTP server: `POST /api/shout` (text or base64 audio -> translate -> TTS), `GET /api/archive`, `GET /events` (SSE), `GET /api/state`, `GET /api/providers` |
| `server/hub.js` | state, strokes, SSE fan-out |
| `server/watcher.js` | watches `~/Downloads/rowing-call-inbox` (+ `WATCH_DIRS`) for new audio |
| `sarvam/client.js` | Sarvam speech-to-text/translate (`saaras:v4`), TTS (`bulbul:v3`), cache/replay in `sarvam/cache/` |
| `smallest/client.js` | smallest.ai TTS (and optional second-ear transcribe) |
| `shared/calls.js`, `obedience.js`, `stroke.js`, `audio-sniff.js` | rowing mode logic, stroke detector, audio format sniffing |
| `public/notch.*`, `notch-app/NotchApp.swift` | the notch island page and the native macOS launcher |
| `public/dashboard.*`, `public/phone.*`, `public/scene.js` | laptop dashboard (3D boat), phone page (oar, mic) |
| `docs/devin-tasks/NN-*.md` | the briefs given to Devin sessions (what was asked, in order) |
| `docs/RUNBOOK.md`, `ARCHITECTURE.md`, `DEMO.md` | run, design, demo script |

## Commands
- `npm start` (server on :3000, live Sarvam if `.env` has `SARVAM_API_KEY`), `npm test` (all tests, no network), `npm run notch` (build + launch the notch), `npm run ingest -- <file>`.
- Phone over USB: `adb reverse tcp:3000 tcp:3000`, open `http://localhost:3000/phone` (localhost counts as secure, so sensors and mic work).

## Rules that bite
- Keys live only in `.env` (git-ignored). Never print or commit them. Tests never call the network.
- Translation is **Sarvam cloud** (not local). Real Malayalam rowing calls are NOT collected: the call table is unverified placeholders; never invent Malayalam phrases.
- Language is reported by the API as a code; never claim dialect identification.
- Saaras REST: clips under 30 s, <= 5 MB here. WhatsApp voice notes are Opus-in-Ogg (`.opus`/`.ogg`).
- Authorship: Devin-written commits are authored `devin-ai-integration[bot]` (builder is co-author); other modules are authored by the builder. Credit is recorded in `AI_USAGE.md`. Do not credit Devin for what it did not write.
- Do not edit the same file from two sessions at once; use a git worktree for parallel work.

## Borrowed UX ideas (ideas only; Boring Notch is GPL-3.0, copy no code)
Hover or drag-toward-notch expands the island; a file shelf/tray; live activity in the collapsed pill; swipe/gesture controls; menu bar item for settings; notch size fine-tuning per display; smooth spring morphs (Alcove-style).
