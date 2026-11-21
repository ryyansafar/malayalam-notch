You are working in a small Node.js (>= 20, ES modules) web project called rowing-call. Read CONTRACT.md in the current directory first, especially "phone page", the server routes, the SSE events, and "Design direction".

YOUR TASK (only this): create exactly these three files and touch nothing else:
- public/phone.html
- public/phone.js (ES module)
- public/phone.css

What it is: the page a rower opens on their phone (via a QR code on the laptop). The phone is the oar: the rower holds it and rows in the air. The page streams accelerometer data into the stroke detector, reports strokes to the server, and plays and shows the spoken call that arrives from the laptop.

Requirements:
- One large "Tap to start" button (a user gesture is required). On iOS call `DeviceMotionEvent.requestPermission()` if it exists; handle granted, denied and unsupported. Listen to `devicemotion` using `accelerationIncludingGravity` (fall back to `acceleration`), timestamp each sample with `performance.now()`, and feed `{t, ax, ay, az}` into `createStrokeDetector()` imported from `/shared/stroke.js` (another module being written separately; code against the contract in CONTRACT.md; if the file is not present yet, import dynamically inside a try and show a clear "stroke detector not loaded" message).
- Batch stroke events and POST them as JSON to `/api/stroke` about every 500 ms; POST a heartbeat to `/api/phone` every 3 s (include the user agent and whether motion is real or simulated). Use fetch with keepalive and ignore transient failures without crashing.
- Show big, readable live numbers: strokes per minute and stroke count, and a calm connection indicator.
- Subscribe to `/events` (EventSource). On a `call` event (fields in CONTRACT.md: callId, meaning, translatedText, ttsAudioBase64, mime, source): show the meaning in very large type, show LIVE or REPLAY, and play the audio from a base64 data URL (audio playback needs the earlier user gesture; handle autoplay rejection by showing a "Tap to hear" button). On a `result` event show "obeyed in N strokes", "not obeyed" or "not sure" with colour and text (not colour alone).
- If motion permission is denied or `devicemotion` never fires within 3 seconds, show a large honest button "TAP TO ROW (simulation)" that generates a stroke event per tap using the same event shape, and label the page "simulation" everywhere while active.
- Mobile-first, one column, large touch targets, works on mobile Safari and Chrome. Follow the design direction in CONTRACT.md (dark, restrained, Space Grotesk with a system-ui fallback loaded via a normal font stack, no external requests, no emojis, accessible contrast, aria-live regions for the call and result).
- No frameworks, no build step, no external network requests, no inline secrets. Keep each file under 400 lines.

Rules: do not run git commands except `git add` and one `git commit` of your own files at the end with a message starting "feat(phone): ", do not push, do not install packages, do not modify any other file. If you add small pure helper functions, keep them in phone.js. When finished, reply with a short factual summary of what you built and anything you could not verify without a real phone.
