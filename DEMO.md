# DEMO: Malayalam in the notch

Fill every `[FILL]` before the talk. What is marked LIVE must actually be live; anything replayed shows a REPLAY badge.

## 1. Ninety-second script

One laptop, the island live in the notch. Optional: a phone showing `/phone`.

| Time | Who does what | On screen |
|---|---|---|
| 0:00-0:10 | "People send Malayalam as WhatsApp voice notes. This lives in the MacBook notch." | Collapsed island merged with the notch: waveform glyph, today's count |
| 0:10-0:25 | Drag a real `PTT-*.opus` voice note from Finder toward the top of the screen. | Island expands **before the drop**, dashed target below the edge, "Release to translate" |
| 0:25-0:35 | Release on the target. | "Received PTT-test-2.opus", shimmer while translating (never a bare spinner) |
| 0:35-0:50 | Point at the result card. | Malayalam script large (hero), romanised line, English translation, `ml-IN` badge, "Speak in English" |
| 0:50-1:00 | Click **Speak**. "Same three calls ran in parallel on the same audio — script, romanised, English." | Spoken translation in the chosen language; `Sarvam cloud · language, not dialect` fine print |
| 1:00-1:15 | Point at the shelf chips; copy one; drag a chip out into a text field. | Last 5 notes with source badge, language, first line, age |
| 1:15-1:30 | Type `ഇത് ഒരു പരീക്ഷണമാണ്` in the island's field, or hold-to-talk. | Same card path for typed text / mic input |
| 1:30-1:40 | Show `/dashboard` briefly: archive, search, export. | Archive rows: source, language, Malayalam, roman, English — no audio stored |

## 2. Fallback table

| Step fails | Do this | Say this |
|---|---|---|
| Wi-Fi/network down | Restart `SARVAM_MODE=replay`; send a recorded input | "These are Sarvam answers recorded earlier, badged REPLAY." |
| Nothing recorded for that input (503) | Use the exact file/text a fixture was recorded with | "Replay returns only what was recorded for this exact input." |
| A Saaras call fails mid-note | Point at the card: the failed line names itself ("transcription not available") while the other two show | "One mode failed; the card shows the rest and says so — nothing is invented." |
| Drag doesn't open the island | Drop the file on the `/dashboard` inbox instead | "Same pipeline through the desk view." |
| TTS fails (`ttsAvailable: false`) | Read the English line aloud | "Speech synthesis failed; same content." |
| Island won't quit | Right-click → Quit, or `scripts/notch.sh down` | — |

## 3. Live versus cached

- **Live cloud:** three parallel Saaras calls per audio note (transcribe, translit, translate) + one Bulbul speak call. Typed text: one Mayura call + Bulbul.
- **Replay:** `sarvam/cache` fixtures, recorded with `npm run record -- --audio demo-samples/PTT-test-*.opus`.
- The mode badge on the desk and the lane on each note always say which it is.

## 4. Pre-demo checklist

- [ ] `.env` has `SARVAM_API_KEY` (never shown on screen), or fixtures recorded for every planned input.
- [ ] `npm test` green; `npm start` banner shows `LIVE`; `npm run notch` built and running.
- [ ] The drag rig worked once (`tools/dragtest/run.sh`, needs Accessibility) OR rehearsed a real hand drag.
- [ ] `~/Downloads/malayalam-notch-inbox` exists if demoing the watched folder; one voice note ready in WhatsApp Desktop.
- [ ] Archive cleared or pre-seeded: `data/archive.jsonl` holds only demo-safe entries.
- [ ] Demo samples ready: `demo-samples/PTT-test-*.opus` (real Malayalam voice notes).
