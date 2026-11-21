# Notch design spec (follow this exactly)

Direction: Cyber Core with Swiss discipline. Dark, quiet, one live accent, Malayalam as the hero text.

## Tokens
| Token | Value | Use |
|---|---|---|
| island | `#000000` | the island (merges with the physical notch) |
| desk | `#0a0a0a` | page/desk background |
| surface | `#141414` | chips, inactive controls |
| line | `#1f1f1f` / `#2a2a28` | hairlines, chip borders |
| olive | `#464a39` / `#6f7a55` | quiet base, borders, labels |
| live | `#b7c48f` | the one bright accent: live states, primary button |
| text | `#f2f2ee` | primary text |
| muted | `#8a8a84` | secondary text; `#6f6f69` for fine print only |

Type: the macOS system font, no web fonts, no downloads (this is what the best notch apps do, e.g. Alcove, which reviewers call the most native-looking: it feels like part of macOS). Stack: `-apple-system, "SF Pro Text", "SF Pro Display", system-ui, sans-serif`, weights 400/500/600/700, tabular numerals (`font-variant-numeric: tabular-nums`) for counts and times. Malayalam: `"Kohinoor Malayalam", "Malayalam Sangam MN", "Noto Sans Malayalam", sans-serif`, 600, line-height 1.5 (never clip conjuncts). Labels: 11-12 px, uppercase, letter-spacing 0.14em.

Native feel (borrowed ideas from Alcove, NotchNook and Boring Notch; no code copied): the island's top edge is flush with the screen edge and its top corners flow into the menu bar with small concave (inverted) curves so it looks grown out of the notch, not stuck on; pure black fill; spring motion in the style of SwiftUI (`response` about 0.4 s, `dampingFraction` about 0.8), width, height and corner radius animate together; icons are simple stroked line glyphs in the style of SF Symbols (no emoji, no filled clip-art); restraint over decoration.

Shape: island bottom corners radius 14 (idle) to 32 (open); chips radius 10; buttons pill radius 22, minimum height 44.

## States (each is a continuous morph, spring easing, only transform/opacity animated)
1. **Idle**: notch-width pill; left a 4-bar waveform glyph in olive, right the count of notes translated today in `live`. Empty-state copy elsewhere: "Drop a WhatsApp voice note."
2. **Drag-over** (opens before the drop): island about 500 x 190 pt, dashed 2 px `#8fa35a` target, soft green edge glow, waveform glyph, "Release to translate", formats ".opus .ogg .m4a .mp3 .wav up to 30 s". The dragged file chip shows filename and "WhatsApp voice note · 12 s".
3. **Received / translating**: filename and duration immediately, then a shimmer on the result area (never a bare spinner), collapsed pill shows a tiny animated glyph plus elapsed seconds.
4. **Result card** (about 580 x 400 pt): top row source badge (WhatsApp / Mic / Text / Drop), language badge, duration and "just now"; Malayalam at 44 px (hero); English below at 22 px; one primary action "Speak in <language>" (live fill, dark text), secondary "Copy"; fine print "Sarvam cloud · language, not dialect"; shelf row of the last 5 chips (draggable out as text).
5. **Recording**: waveform animates with mic level, timer in tabular numerals, collapse timer paused.
6. **Error**: one line saying what happened and the next action; never colour alone.

Rules: one obvious next action per state; minimum 44 pt hit targets; visible keyboard focus; text at 4.5:1 contrast or better; `prefers-reduced-motion` swaps morphs for quick fades; no layout shift during animation.
