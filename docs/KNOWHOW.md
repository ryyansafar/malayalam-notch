# Know-how (read this first, it saves tokens)

One product: **Malayalam in the notch**. Drag a WhatsApp voice note (or any audio) toward the MacBook notch, it expands, the Malayalam is transcribed (script + romanised + English, three parallel Saaras modes), shown, and optionally spoken in another language.

## Map of the repo
| Path | What it is |
|---|---|
| `server/index.js` | HTTP server: `POST /api/shout` (text or base64 audio -> 3-way STT -> TTS), `POST /api/speak`, `GET /api/archive`, `GET /events` (SSE), `GET /api/state`, `GET /api/providers` |
| `server/hub.js` | state (langs, phone, lastNote), SSE fan-out, body validation |
| `server/watcher.js` | watches `~/Downloads/malayalam-notch-inbox` (+ `WATCH_DIRS`) for new audio |
| `server/archive.js` | capped text-only archive (`transcript`/`roman`/`text`), JSONL under `data/` |
| `sarvam/client.js` | Sarvam STT (`saaras:v4`, modes transcribe/translit/translate/codemix/verbatim), Mayura text translate, Bulbul TTS; cache/replay in `sarvam/cache/` |
| `smallest/client.js` | smallest.ai TTS (Lightning, optional second voice) |
| `shared/audio-sniff.js`, `audio-mime.js` | magic-byte audio sniffing, duration, lossless Ogg cut |
| `malayalam-notch/Sources/*.swift`, `build.sh` | the native notch app (SwiftUI): `App.swift` panel and cursor poll, `NotchModel.swift` geometry/shape/springs, `NotchRootView.swift` island, `MalayalamView.swift` Voice tab, `Assistant.swift` Assistant tab, `NowPlayingView.swift`, `MalayalamIntent.swift` local command rules |
| `public/dashboard.*` | the desk: drop zone, latest note, archive |
| `public/phone.*` | hold-to-talk phone mic page |
| `docs/devin-tasks/NN-*.md` | the briefs given to Devin sessions (history) |
| `docs/RUNBOOK.md`, `ARCHITECTURE.md`, `DESIGN.md`, `DRAG-FINDINGS.md`, `NOTCH-REFERENCE.md`, `SARVAM-FINDINGS.md`, `DEMO.md` | run, design, findings, demo |

## Commands
- `npm start` (server on :3000, live Sarvam if `.env` has `SARVAM_API_KEY`), `npm test` (all tests, no network), `npm run notch` (build + launch the notch), `npm run ingest -- <file>`, `scripts/notch.sh up|down` (server + notch together).
- Phone over USB: `adb reverse tcp:3000 tcp:3000`, open `http://localhost:3000/phone` (localhost counts as secure, so the mic works).

## Rules that bite
- Keys live only in `.env` (git-ignored). Never print or commit them. Tests never call the network.
- Transcription/translation are **Sarvam cloud**. Never invent Malayalam; show only what the API returns. Language is reported as a code — never claim dialect identification.
- Saaras REST: clips under 30 s, <= 5 MB here. WhatsApp voice notes are Opus-in-Ogg (`.opus`/`.ogg`).
- The window never animates: it jumps to size while the island morphs in CSS (`docs/NOTCH-REFERENCE.md`). The drop target must stay below the top edge — the edge triggers Mission Control (`docs/DRAG-FINDINGS.md`).
- Do not edit the same file from two sessions at once; use a git worktree for parallel work.

## Borrowed UX ideas (ideas only; Boring Notch is GPL-3.0, copy no code)
Hover or drag-toward-notch expands the island; a file shelf/tray; live activity in the collapsed pill; menu bar item for settings; notch size fine-tuning per display; smooth spring morphs (Alcove-style).
