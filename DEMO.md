# DEMO: rowing-call trainer

Fill every `[FILL]` before the talk. Never say a number still marked `[FILL]`. What is marked LIVE must actually be live on the day; everything else gets a REPLAY badge on screen.

## 1. Two-minute script

Stage version, three people. J1 = Malayalam speaker (shouts into the laptop mic or types). J2 = rower (phone as oar), ideally someone who does not speak Malayalam. J3 = counts strokes aloud. The laptop shows `/dashboard`; the phone is on `/phone`. If everyone present speaks Malayalam, say so: "Tonight the rower understands Malayalam, so listen to the spoken output and watch the stroke."

**One-judge desk version (60 seconds):** I shout, the judge rows and counts their own strokes. Judge taps TAP TO START on the phone and rows steadily (10 s); I send a "faster" call from the dashboard shout box, typed or recorded (5 s); the phone speaks the meaning, the judge speeds up, the Obedience card shows "Obeyed in N strokes" (15 s); the judge names another command and I send it, or send nonsense to show the amber "not sure" (20 s); I point at the LIVE/REPLAY badge and the UNVERIFIED notice (10 s).

| Time | Who does what | On screen |
|---|---|---|
| 0:00-0:15 | Me: "Boat clubs here run classes so rowers from outside Kerala can follow the captain's Malayalam instructions. This is a drill for that class." | Dashboard: mode badge (LIVE or REPLAY), UNVERIFIED notice, empty evidence table |
| 0:15-0:30 | J2 taps TAP TO START, rows the air steadily. J3 counts aloud. | Stroke rate in spm and sparkline, against J3's count |
| 0:30-0:45 | Me to J1: "Shout 'faster' in Malayalam, your own words." J1 shouts via Record shout (or I send a typed call). | Recording indicator, then the Heard call card: Saaras English text |
| 0:45-1:00 | Phone speaks the meaning in `[FILL: J2's language, one of hi-IN / bn-IN / od-IN / ta-IN / en-IN]`. J2 reacts. | Meaning SPEED UP, confidence, LIVE/REPLAY source badge, latency `[FILL: ms]` |
| 1:00-1:15 | J3 says how many strokes it took. | Obedience verdict "Obeyed in N strokes", rate before and after |
| 1:15-1:35 | J1 shouts anything else: stop, or nonsense. | A second verdict, or amber "Not sure — meaning not recognised" |
| 1:35-1:50 | Me: "Every row says LIVE or REPLAY. The call table says UNVERIFIED: real race calls are not collected yet." | Evidence table rows, UNVERIFIED notice |
| 1:50-2:00 | Me: "No added hardware, only a phone. Two live Sarvam calls per shout in the default path. Next: a club captain's real calls." | Evidence table and tally |

Three rehearsed calls (our own phrasings, not claimed as race calls): `[FILL: faster phrasing]`, `[FILL: stop phrasing]`, `[FILL: slower phrasing]`. Use only phrasings that passed testing.

## 2. REPLAY fallback table

| Step fails | Do this | Say this |
|---|---|---|
| Wi-Fi or network down | Restart with `SARVAM_MODE=replay`; send a recorded typed call from the shout box | "Network is down. These are Sarvam answers recorded earlier, badged REPLAY on every row." |
| Nothing recorded for that input (503 `no_replay_available`) | Use the exact typed text a fixture was recorded with; replay matches the exact input only | "Replay returns only what was recorded for this exact input." |
| Saaras times out or errors (502 `translate_failed`) | Retry once (the client retries once itself), then go replay | "Speech call failed. This is the recorded path." |
| Translation empty or meaning not recognised | Let "Not sure — meaning not recognised" show; J1 repeats once; then send typed text | "It did not find a clear meaning. This is the failure state, on purpose." |
| Wrong meaning spoken | Point at the English text in the Heard call card; do not explain it away | "The translation came back wrong and the matcher followed it. Wrong meanings counted so far: `[FILL: n of n]`." |
| Spoken audio does not play (`ttsAvailable: false`) | Read the on-screen meaning aloud; check `--phrases` fixtures were recorded | "Speech synthesis failed; same content." |
| Motion permission denied or no sensor | Phone shows TAP TO ROW (simulation), badged SIMULATION | "Sensor blocked; taps stand in for strokes and it is labelled as simulation." |
| Stroke count disagrees with J3 | Show the sparkline and count, do not argue | "Detector was off by `[FILL: n]` against the hand count. Measured error: `[FILL]`." |
| A shout is already in flight (429 `busy`) | Wait for the previous verdict, then resend | "One call is judged at a time." |

## 3. Live versus cached

- **Live cloud:** the shout through Saaras `translate` (audio) or Mayura (typed text), plus one Bulbul call for the spoken meaning: two live Sarvam calls per shout in the default path.
- **Live local, no model:** the keyword matcher, the stroke detector, the obedience rule, all SSE updates.
- **Optional and off by default:** smallest.ai Lightning as a second voice (`ttsProvider`), Lightning coach playback of the Malayalam call (`coachPlayback`), and the Pulse second ear (`SECOND_EAR=1`). Each adds live calls only when asked for.
- **Cached:** `[FILL: n]` recorded responses in `sarvam/cache` (14 files at code freeze: 5 translate, 2 Bulbul speak, 6 Lightning speak, 1 Pulse transcribe), recorded `[FILL: when]`. REPLAY returns only the exact recorded input — the same audio bytes or the same typed text — and every replayed row is badged REPLAY.

## 4. Honest claims

Say:

- An induction drill for land classes, not race equipment.
- Six meanings: start, speed up, slow down, hold, ready, stop.
- Onmanorama, 25 Aug 2025: more than 200 professional rowers from outside Kerala, and most clubs arrange special classes. The article names no clubs and no languages.
- Measured so far: `[FILL: n clips, n right, n wrong, whose voice, spoken or shouted, recorded where and how; or "only clean synthetic and typed input"]`. Counts, not percentages.
- Scoring: speed up needs +4 spm over baseline, slow down needs -4 spm; stop, hold and ready all require strokes to fall below 5 spm within 4 s / 2.5 s / 3 s respectively; start needs at least 3 strokes inside the 8 s window. All six meanings are scored, and a phone cannot tell a braking blade from a lifted one — only the absence of strokes is measured. The thresholds are the builder's choices, documented in `shared/calls.js`.

Never claim:

- That these are real race calls. Placeholders, marked UNVERIFIED, until a club supplies them.
- What Aanjukuthi, Valicheduthu and Kuthiyerinju mean. Those three terms are confirmed to exist; the article gives no meanings.
- Any accuracy not measured. No accuracy figure exists in these docs.
- That it works on a boat, in a race, or over chants and whistles. Untested.
- That it teaches or judges rowing technique. It measures stroke rate only.
- That any club or rower has used or asked for it. Nobody has `[FILL: unless someone did at the event]`.
- Which languages the outside rowers actually speak. Sources name states only.
- Speech output in languages outside the five built in (en-IN, hi-IN, bn-IN, od-IN, ta-IN).
- That the spoken phrases are correct; no native speaker has reviewed them.
- That Devin did work it did not do.

## 5. Thirty-second pitch

Plain: "Snake-boat clubs bring in rowers from outside Kerala and run classes so they can follow the captain's Malayalam instructions. Here a Malayalam speaker shouts a command in their own words, the rower hears the meaning in `[FILL: Hindi or English]`, and the phone in their hands measures whether the stroke obeyed. Practice for that class, not race gear."

Track-aware: "Primary: Beyond English. A shouted Malayalam call goes through Sarvam speech translation and is spoken in the rower's language. Beyond the Screen: the phone's motion sensor is the oar and checks the response. Alappuzha Challenge: it serves the clubs' existing classes for outside rowers."

## 6. Differentiation

THUZHAYAN (first prize, Physical AI hackathon, August 2026) is paddle telemetry: sensors per rower, a hub, coaching analysis. It measures how a crew rows. This adds no hardware beyond a phone and coaches no technique; it asks an earlier question: did the newcomer understand the command? A translation app returns a sentence and stops. This maps free speech to six fixed meanings, says "not sure" when no meaning is clear, and measures the physical response. A web search before the event found no tool that translates boat-crew commands; that is a search result, not proof that none exists.

## 7. Hard questions

1. **Useful beyond a few hundred rowers?** Not shown. The claim is only the documented 200+ rowers and their classes.
2. **Why not a phrasebook?** A phrasebook cannot check the body responded. This measures it.
3. **Did Devin build it?** Devin sessions built the stroke detector, the phone page and the dashboard from task briefs in `docs/devin-tasks/`; `[FILL: what the builder did by hand, PR/session list]`.
4. **Accuracy?** `[FILL: n of n calls tested]`. Nothing beyond that.
5. **Are these the real calls?** No. Placeholders, marked UNVERIFIED.
6. **Did you ask a club?** `[FILL: who, when / not yet]`.
7. **Does it work on a boat?** Untested. Built for land classes.
8. **In a race, with drums?** No. Not race equipment.
9. **Isn't this THUZHAYAN?** No. That measures how a crew rows, with paddle sensors. This checks whether a newcomer understood a spoken command; no added hardware.
10. **Why Sarvam, not a fixed word list?** The design bet is that people phrase a command differently and translation to English brings the phrasings together. Evidence so far: `[FILL: n phrasings tried, n matched]`.
11. **What if translation is wrong?** If the English text has no clear keyword, the verdict is "not sure" and nothing is spoken. If the text is wrong but clear, the wrong meaning is spoken; the English text is on screen so the caller can see it. Wrong meanings counted: `[FILL: n of n]`.
12. **Which languages?** Built in: English, Hindi, Bengali, Odia, Tamil. Tested tonight: `[FILL: which, and who checked each]`. The phrases are unreviewed by native speakers.
13. **How is "obeyed" decided?** Stroke-rate change inside an 8 s window (+750 ms grace) against the pre-call baseline, using the thresholds in `shared/calls.js` (+4 / -4 spm, or rate below 5 spm for stop, hold, ready). Builder's choices, tuned on one phone.
14. **What was cached?** `[FILL: which fixtures and when recorded]`. All labelled REPLAY.
15. **Built before the event?** No product code. Written plans and task briefs existed beforehand; `[FILL: any measurements run beforehand]`.
16. **Who asked for this?** Nobody yet. The need is from one news report; `[FILL: anyone spoken to at the event]`.
