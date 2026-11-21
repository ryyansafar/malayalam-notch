# AI usage

Built solo at Hackathoni, 21-22 Nov 2026. The repository was created at the event (about 21:30 IST on 21 Nov); no product code existed before that. Design notes and research were prepared earlier the same day with AI assistance.

## Devin (Devin CLI sessions, commits authored as Devin, builder as co-author)

| Files | What Devin did |
|---|---|
| `shared/stroke.js`, `test/stroke.test.js` | Wrote the stroke detector and its tests |
| `public/phone.*` | Wrote and later polished the phone page |
| `public/dashboard.*`, `public/scene.js` | Wrote the laptop dashboard and the 3D snake-boat scene |
| `README.md`, `DEMO.md` | Wrote the README and demo script from the project docs |
| `fix(review)` commits | Reviewed the other modules and fixed two defects it found (extreme stroke timestamps, a superseded call with no observation) |

Devin also ran the secret scan, created the repository and pushed it.

## Other modules (not Devin)

These were written with a separate AI coding assistant under the builder's direction, from a module contract (`CONTRACT.md`) the builder approved. Devin did not write them; it reviewed them and committed them unchanged, so they are authored by the builder in git.

`shared/calls.js`, `shared/obedience.js`, `sarvam/*`, `smallest/*`, `server/*`, their tests, `docs/ARCHITECTURE.md`, `docs/RUNBOOK.md`, `CONTRACT.md`, and the task briefs in `docs/devin-tasks/`.

## What AI did not do

- It did not collect real rowing calls. The call table holds placeholders (see `shared/calls.js`).
- The translation, voice and stroke detection run against real services and a real phone, but the system is a classroom drill, not race equipment.
- Test results (274 passing) are from `npm test`.

## Third-party code and services

- three.js r160 (MIT), vendored in `public/vendor/` (see `docs/VENDOR.md`).
- Sarvam AI (speech translation and speech output) and smallest.ai (speech output), called with the builder's own API keys, which are never committed.
