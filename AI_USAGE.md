# AI usage

Built solo at Hackathoni, 21-22 Nov 2026. The repository was created at the event; no product code existed before that. Design notes and research were prepared earlier the same day with AI assistance.

## Devin (Devin CLI sessions; commits authored as Devin, builder as co-author)

| Work | What Devin did |
|---|---|
| `server/archive.js`, voice-note drop and archive | Built the capped text-only archive and the upload path |
| `server/watcher.js`, `shared/audio-sniff.js`, `shared/audio-mime.js`, `public/phone.*` | WhatsApp audio-format support (magic-byte sniffing, duration, lossless Ogg cut), the watched inbox folder, the hold-to-talk phone mic |
| `server/*`, `sarvam/*` changes in the translate path | Three parallel Saaras modes (script, romanised, English) behind `POST /api/shout`, and the removal of the earlier rowing-trainer product |
| `public/dashboard.*` | The desk view (drop zone, latest note, archive) |
| `README.md`, `DEMO.md`, docs passes | Documentation |
| `fix(review)` commits | Reviewed other modules and fixed two defects it found |

Devin also ran the secret scan, created the repository and pushed it. Devin also wrote a first web-based notch island (`public/notch.*` with a small Swift shell). It was **replaced** by the native app below and is no longer in the repository.

## Other work (not Devin)

Written with a separate AI coding assistant under the builder's direction:

- `malayalam-notch/` — the native SwiftUI notch app, written from scratch: panel and cursor poll, notch geometry and shape, the Voice and Assistant tabs, Now Playing, reminders, desktop tidy-up, the local command rules.
- `sarvam/*`, `smallest/*`, `server/*` (original modules), `shared/*` (original modules), their tests, `docs/*` (architecture, design spec, findings, reference), `CONTRACT.md`, `scripts/`, `tools/dragtest/` (test rig), and the briefs in `docs/devin-tasks/`.

## What AI did not do

- It did not make the product decisions; the pivot to "Malayalam in the notch" and the assistant scope were the builder's calls.
- It did not invent Malayalam: every string shown as Malayalam comes from a Sarvam response. The demo voice notes in `demo-samples/` are synthetic (Sarvam TTS), which proves the pipeline, not accuracy on real voices.
- Translation, voices and speech run against real services; output is machine translation and is labelled as such.
- Test results (`npm test`) are reported as run.

## Third-party code and services

- No vendored code. The app uses the macOS system font and system frameworks only.
- Boring Notch (GPL-3.0) was **studied** for placement and motion facts (sizes, corner radii, spring parameters), recorded in `docs/NOTCH-REFERENCE.md`. **No code from it is in this repository**; the notch app is original.
- Sarvam AI (speech-to-text, translation, TTS) and smallest.ai (TTS), called with the builder's own API keys, which are never committed.
