# AI usage

Built solo at Hackathoni, 21-22 Nov 2026. The repository was created at the event; no product code existed before that. Design notes and research were prepared earlier the same day with AI assistance.

## Devin (Devin CLI sessions)

| Work | What Devin did |
|---|---|
| `public/notch.*`, `notch-app/NotchApp.swift` | Island page (earlier session) and the current card/shelf/drag UI work |
| `public/phone.*` | Wrote and later rebuilt the phone page (now hold-to-talk mic only) |
| `public/dashboard.*` | Wrote the laptop dashboard (now the desk view) |
| `README.md`, `DEMO.md` | Documentation passes |
| `fix(review)` commits | Reviewed other modules and fixed two defects it found (extreme timestamps; a superseded call) |
| `refactor: remove the rowing trainer` | Deleted the earlier rowing-trainer product from code, tests and docs at the builder's direction |

Devin also ran the secret scan, created the repository and pushed it.

## Other modules

`shared/*`, `sarvam/*`, `smallest/*`, `server/*`, their tests, `docs/ARCHITECTURE.md`, `docs/RUNBOOK.md`, `CONTRACT.md`, and the task briefs in `docs/devin-tasks/` were written with a separate AI coding assistant under the builder's direction, from a module contract the builder approved.

## What AI did not do

- It did not make the product decisions; the pivot from the earlier drill idea to "Malayalam in the notch" was the builder's call.
- It did not invent Malayalam: every string shown as Malayalam comes from a Sarvam response.
- Translation, voices and speech run against real services; output is machine translation and is labelled as such.
- Test results (`npm test`) are reported as run.

## Third-party code and services

- No vendored code; the island uses the macOS system font stack (see `docs/VENDOR.md`).
- Boring Notch (GPL-3.0) was read for placement/motion facts only — `docs/NOTCH-REFERENCE.md`; no code copied.
- Sarvam AI (speech-to-text, translation, TTS) and smallest.ai (TTS), called with the builder's own API keys, which are never committed.
