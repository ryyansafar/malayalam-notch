# Stage demo: exact steps (about 4.5 minutes)

Teleprompter with the words to say: open `docs/teleprompter.html` in a browser (works offline).
Every step has a fallback. If something fails, say so calmly and move on: the honest version is stronger.

## Before you go on (10 minutes earlier)

1. Wi-Fi works; try a hotspot as backup. Volume up. Do Not Disturb on. Close other apps and notifications.
2. Server running: `cd rowing-call && npm start` (or `scripts/notch.sh up`). Check `http://localhost:3000/api/providers` shows Sarvam and smallest as live.
3. The notch app is running from `~/Applications` (do not rebuild it now: that resets permissions).
4. Permissions allowed once: Microphone, Full Disk Access, Accessibility, Screen Recording (System Settings, Privacy and Security).
5. Me tab: add FMK (or your friend) under *People you message* with the number. In WhatsApp Desktop, open that chat once so the latest voice note is downloaded.
6. Put on the Desktop: one photo, one PDF, one folder. Have `demo-samples/PTT-test-2.opus` visible in Finder.
7. Pause music. Activity tab: confirm the assistant is not paused. Test hover opens the island.
8. Shake zone: shake the dragged file about 40 to 90 points below the top edge (avoids macOS Mission Control).

## The run (what to do)

| Time | Do | Fallback |
|---|---|---|
| 0:00 | Hover the notch: it opens. | Menu bar icon, Open the notch. |
| 0:25 | Drag `PTT-test-2.opus` onto the island. Three lines appear. Press the speaker. Switch Voice 1 to Voice 2. | Type a Malayalam sentence in Translate what I copy, or replay mode (`SARVAM_MODE=replay npm start`). |
| 1:10 | Tap the mic, say "set a timer for two minutes". Stops by itself. Notch shows a live countdown. | Assistant tab, tap *Set a timer*. |
| 1:30 | Assistant tab: type "remind me tomorrow at six am to call Amma". | Tap *Remind me*. |
| 1:50 | Type "ring my phone in two minutes to test": the confirm card appears. Press Cancel. Open Activity. | Say it, do not confirm. |
| 2:20 | Drag the photo toward the notch, shake twice, drop on Analyze. Read the explanation. | Use the PDF, or the folder. |
| 2:45 | Drag the PDF, shake, drop on Clipboard. The Shelf opens with the file. | Drag straight onto the Shelf tab. |
| 3:10 | Say "open the latest voice message from FMK on WhatsApp". Answer the questions out loud. Approve the card. | Skip this step and say it needs the permissions you showed in the checklist. |
| 4:00 | Assistant tab, tap *See my screen*. | Skip. |
| 4:15 | Close (see the teleprompter). Hand over the laptop: "give me a real voice note". | |

## If you are cut to 90 seconds

Voice note (0:25 block), shake and Analyze (2:20 block), the confirm card (1:50 block), then the close.

## Honest limits to say out loud

- Notes over 30 seconds are cut or refused. Malayalam is not an output language yet.
- The sample voice notes are synthetic speech; real voices are the next test.
- Phone calls need a Sarvam number; reminders are spoken on the Mac.
- WhatsApp features need macOS permissions and a real WhatsApp Desktop.
