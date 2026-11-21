# What the best open-source notch app does (read from Boring Notch's source, 22 Nov 2026)

Studied only; Boring Notch is GPL-3.0, so no code is copied. These are facts about placement and motion that we match with our own code.

## Window and placement
- One borderless, non-activating panel (utility/HUD style), `isOpaque = false`, `backgroundColor = .clear`, `hasShadow = false`, can become key.
- **The window is created once at the maximum size** (open size 640 x 190 pt plus 20 pt shadow padding) and pinned to the top centre of the notched screen (`x = screen.midX - width/2`, `y = screen.maxY - height`). **It is never resized or animated.** The island shape inside it grows and shrinks. That is why there is no flicker or clipped frame.
- Collapsed, the island is the notch size (width and height from `NSScreen` safe-area and auxiliary areas). Open, it is 640 x 190 pt.

## Shape
- A custom shape with **concave top corners** that flow into the screen edge, plus rounded bottom corners. Closed: top radius 6, bottom radius 14. Open: top radius 19, bottom radius 24. Both radii animate together with the size.
- Pure black fill. When open, a soft black shadow (opacity 0.7, radius 6). Content is inset horizontally by the top radius so it never touches the curved corners.

## Motion (SwiftUI springs)
- Open: `spring(response: 0.42, dampingFraction: 0.8)` (slight overshoot).
- Close: `spring(response: 0.45, dampingFraction: 1.0)` (critically damped, no bounce).
- Gesture-driven/interactive changes: `interactiveSpring(response: 0.38, dampingFraction: 0.8)`.
- Small elements: `spring(response: 0.35, dampingFraction: 0.7)` for drop-target states; content swaps use a blur-replace transition with a bouncy 0.3 s spring.
- Drag-over: the drop target animates with `spring(response: 0.36, dampingFraction: 0.7)` keyed on "drop zone targeted".

## What this means for our notch
1. Stop animating the NSWindow frame. Make the window fixed at 640 x 210 pt at the top centre, transparent, and animate the island inside the web page (CSS) with the spring values above (CSS `linear()` approximations, or a tiny JS spring).
2. Collapsed state: `ignoresMouseEvents = true` except over the notch-sized region and the always-on native drop zone; open or drag-over: accept mouse events.
3. Draw the island with an SVG/CSS clip path that has concave top corners (6 -> 19) and bottom corners (14 -> 24).
4. Idle content must fit the notch wings: a small waveform glyph on the left wing and a short label on the right, never truncated text like "DROP …".
5. Drag approach opens the island (global drag monitor), with the drop target well below the top edge.
