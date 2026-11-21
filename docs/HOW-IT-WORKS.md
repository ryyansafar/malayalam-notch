# How Malayalam Notch works

A plain walk-through of what happens when you use it, and what runs where.

## The three parts

1. **The Mac app** (`malayalam-notch/`, native SwiftUI). One borderless panel sits in the notch. A cursor poll (30 times a second) decides when to open it: only when the pointer is inside the 185 x 37 pt box of the physical notch. Clicking anywhere outside the open island folds it away and the click goes to whatever is underneath.
2. **The local server** (`server/`, Node, no framework). Runs on this Mac. It holds the API keys, validates every request and calls the cloud services. `/api/call` and `/api/agent` answer only the Mac app (loopback, localhost Host header, JSON content type).
3. **The cloud services.** Sarvam AI for speech-to-text and translation (Saaras), text-to-speech (Bulbul), transliteration, and the chat model (sarvam-105b) that turns a sentence into a safe action. smallest.ai is the second voice.

## What happens when you drop a voice note

1. The app sends the audio (base64, up to 30 s) to the local server (`POST /api/shout`).
2. The server runs three Saaras modes **in parallel** on the same audio: Malayalam script, English letters (romanised) and English.
3. The result comes back (about 1.3 s measured) and the notch shows all three lines.
4. If you press play, the English is spoken by Sarvam Bulbul or smallest.ai (0.5 to 0.9 s more).

## What happens when you type or say a command

1. English text goes through local rules first (reminders, timers, volume, brightness, dark mode, find a file, open an app). Malayalam text, or anything the rules miss, goes to the agent.
2. The agent (`POST /api/agent`) sends the sentence (plus the facts you chose to share in the Me tab) to the Sarvam chat model, which can only answer with a reply and actions from a fixed list. The server validates every action.
3. The app maps each action to a local intent and checks its risk tier.
   - Looks and small reversible changes run and are logged.
   - Anything that reaches a person or can lose work (ringing a phone, quitting an app, moving Desktop files) shows a confirm card and waits; no answer in 20 s means no.
4. The pause switch stops commands, reminders and the cloud agent. The Activity tab lists everything done.

## Memory and privacy

Facts you tell it live in a file on this Mac (permissions 0600). Only facts marked shared, capped at 600 characters, go to the cloud model, and the exact text is shown in the Me tab. Translate-on-copy and clipboard history are off until you switch them on; passwords marked secret by password managers are never read.

## How it was built

Product decisions were the builder's. Code was written with AI coding agents (see `AI_USAGE.md`): Devin built the first inbox, archive and the clipboard and file shelf views; a separate AI assistant wrote the rest of the native app; separate AI reviews found real defects (for example, that any web page could have triggered phone calls) which were fixed. Every line of Malayalam on screen comes from Sarvam.
