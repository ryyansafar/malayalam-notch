You are working in a small Node.js (>= 20, ES modules) web project called rowing-call. Read CONTRACT.md in the current directory first, especially "dashboard page", the server routes and SSE events, and "Design direction".

YOUR TASK (only this): create exactly these three files and touch nothing else:
- public/dashboard.html
- public/dashboard.js (ES module)
- public/dashboard.css

What it is: the control screen on the laptop at a demo. A Malayali judge shouts a call; the laptop translates it; a second person holds the phone like an oar; the dashboard shows everything, including the evidence.

Requirements:
- Header: project name, a LIVE/REPLAY badge for the Sarvam mode (from `/api/state`), phone connection status (from `phone` events and heartbeats), and a QR code image from `/qr.svg?url=<encoded phone URL>` for opening `/phone` on a phone (derive the phone URL from `location.origin + '/phone'`).
- A live stroke-rate sparkline on a `<canvas>` (last 60 seconds, from `stroke` events), with the current strokes per minute in large type.
- A shout panel: a target-language selector (Hindi hi-IN, Bengali bn-IN, Odia od-IN, Tamil ta-IN, English en-IN), a text box for a typed shout (fallback), and a record button using `MediaRecorder` (hold or toggle to record up to 8 seconds, show a level meter or clear recording state) that POSTs `{ audioBase64, mime, targetLang }` to `/api/shout`; typed shouts POST `{ text, targetLang }`. Show a clear pending state, handle `status: 'not_sure'` with the message "Not sure, please shout again", and handle HTTP errors without crashing.
- A call card that shows, per call: the translated English text, the matched meaning and confidence, LIVE or REPLAY, latency in ms, and a replay button for the spoken audio.
- An obedience card: "obeyed in N strokes", "not obeyed" or "not sure" (use text plus colour, never colour alone; green, red, amber per CONTRACT.md).
- An evidence table of all trials from `/api/state` (time, translated text, meaning, source, latency, outcome) with a running tally (obeyed / not obeyed / not sure out of total). Never show an accuracy percentage unless it is computed from the table on screen.
- A visible notice: "Call table is placeholder: real race calls not yet collected (UNVERIFIED)".
- Subscribe to `/events` (EventSource: state, stroke, call, result, phone) and reconnect automatically.
- Large type, generous spacing, dark restrained design per CONTRACT.md, Space Grotesk with a system-ui fallback via a normal font stack, no external requests, no frameworks, no build step, no emojis, accessible (aria-live for results, labels on controls, keyboard operable). Keep each file under 450 lines.

Rules: do not run git commands except `git add` and one `git commit` of your own files at the end with a message starting "feat(dashboard): ", do not push, do not install packages, do not modify any other file. When finished, reply with a short factual summary of what you built and anything you could not verify without the server running.
