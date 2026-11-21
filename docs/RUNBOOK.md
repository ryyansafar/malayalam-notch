# Malayalam in the notch: runbook

Needs Node 20 or newer (plus Xcode CLT `swiftc` for the notch shell). Run everything from the project root.

## Start the server

```
npm install
cp .env.example .env      # optional; never commit .env
npm start
```

The banner prints the laptop URL (`/dashboard`), the phone URL(s) on the local network and the Sarvam mode. Open `/` on the laptop for the QR code to the phone mic page.

Environment (in `.env` or the shell; shell wins):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Listening port. |
| `SARVAM_API_KEY` | empty | Sarvam key. Never printed or logged. |
| `SARVAM_MODE` | auto | `live`, `replay`, or `auto` (live if a key is set, else replay). |
| `CERT_FILE`, `KEY_FILE` | empty | Set both to serve HTTPS. |
| `SMALLEST_API_KEY` | empty | smallest.ai key for the optional second voice. Never printed or logged. Follows `SARVAM_MODE`. |
| `WATCH_INBOX` | 1 | `0` turns off the default watched folder. |
| `WATCH_DIRS` | empty | Extra watched folders (comma-separated absolute paths, `~` allowed). |
| `WATCH_LANG` | en-IN | Target language for watched-folder notes. |

Without a key and without recorded fixtures the server runs, but every shout answers 503 `no_replay_available`: REPLAY can only return what was recorded for that exact input.

## The notch

```
npm start        # server must be running
npm run notch    # builds notch-app/NotchApp.swift and launches the island
scripts/notch.sh up|down|status   # both together
```

The island merges with the notch: waveform glyph left, today's count right. Hover to open; drag a file toward the top and it expands early with a dashed target **below** the screen edge — the edge itself triggers Mission Control, so the target deliberately sits around y 50–170 (`docs/DRAG-FINDINGS.md`). Drop a voice note, hold-to-talk, or type Malayalam. Right-click: Quit / Mute / Open desk. Cmd-Q while hovering also quits.

Mic capture needs a one-time macOS permission (System Settings → Privacy & Security → Microphone). The page is served at `/notch.html` (there is no bare `/notch` route).

## WhatsApp voice notes — four ways in

1. **Watched inbox folder.** On startup the server creates and watches `~/Downloads/malayalam-notch-inbox`. In WhatsApp Desktop, right-click a voice note → **Download** → save it there. The file is read once its size stops changing, run through the shout path and archived as `whatsapp_desktop`. No backfill, non-audio and over-5 MB files ignored, sources only ever read. `WATCH_DIRS` adds folders; `WATCH_INBOX=0` disables the default. WhatsApp's own media store (`~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/Message/Media/`) is **not** watched by default — adding it prints a warning.
2. **Desk drop zone** (`/dashboard`) — drop or click to choose.
3. **`npm run ingest -- <file>`** — one file to the running server (`--lang=hi-IN`, `--port`).
4. **Phone share sheet** — the installed phone page is a PWA share target posting to `/share`.

Formats are checked by magic bytes: Ogg/Opus (WhatsApp `PTT-*.opus`), WAV, MP3, M4A/MP4, AAC/ADTS, AMR, WebM, FLAC. Limits: 5 MB and 30 s (the Saaras REST limit). A longer Ogg offers a lossless "first 30 s" cut at a page boundary; other formats just say so. Audio is never silently truncated and never archived.

## Record fixtures (needs a key)

`npm run record -- --audio <file>` records the three Saaras modes for that audio into `sarvam/cache`, so the demo can run offline with a REPLAY badge. `--text` records a typed-text translation, `--speak` the spoken output. Replay matches the exact input only. Do not hand-write files into `sarvam/cache` — everything there is presented as a recorded answer.

## Phone page

`/phone` is one big HOLD TO TALK button: records while held (25 s max), posts the clip as a `phone_mic` shout; the result lands in the notch and the archive. Mic access needs HTTPS on a real network — a tunnel (`tailscale funnel`, `cloudflared`, `ngrok`) or self-signed `CERT_FILE`/`KEY_FILE` — or `adb reverse` over USB, where localhost counts as secure.

## Troubleshooting

- **Island never appears:** `pgrep -f notch-app/build/notch`; rebuild with `npm run notch`. On a notch-less Mac it floats 8 pt below the top.
- **Drag does nothing:** confirm the file extension is in the accepted list; the island opens only within ~160 pt of the top and ~120 pt of the notch. The drag rig (`tools/dragtest`) needs Accessibility permission for its synthetic events — the real drag itself does not.
- **`no_replay_available`:** you are in replay mode without a fixture for that exact input — record one or set `SARVAM_MODE=live` with a key.
- **`speech_too_long` / `file_too_large`:** clip exceeded 30 s or 5 MB.
- **Phone mic silent:** the page needs HTTPS or localhost; check the browser's mic permission.
