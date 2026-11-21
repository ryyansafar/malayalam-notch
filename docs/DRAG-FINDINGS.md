# Drag-to-notch findings (measured on the builder's MacBook Air, macOS 27)

Test rig: `tools/dragtest/` (mouse.swift posts real CGEvent mouse events and needs the Accessibility permission; dragsrc.swift is a floating window holding a draggable file chip that puts a real file URL on the drag pasteboard). Build with `swiftc`.

## Result with the first notch build
- A real file drag moved to the notch: the island did not react at all (no native drop zone, no expand).
- A drag that reaches the very top screen edge (y near 0) triggers macOS Mission Control (the Spaces strip drops down). So the drop target must NEVER require the cursor to touch the top edge.

## Requirements this implies
1. Start opening the island while the drag is still approaching: when a file drag is in progress (NSEvent global monitor for `.leftMouseDragged` plus a drag-pasteboard check for audio file types) and the cursor is within about 120 pt of the notch horizontally and about 160 pt of the top, expand.
2. Expanded, the drop target must sit well below the edge (its dashed target area between about y = 50 and y = 170 pt), so dropping at y = 60 to 120 works and Mission Control never triggers.
3. Keep the always-on small native NSDraggingDestination over the notch as a second path.
4. Acceptance test: drag the chip from a point about 400 pt away, move along a curve to (notch centre x, y = 90), hold 1 s, release; the island must expand before release, show the drop glow, and on release start the "received" state. Run it with `tools/dragtest` and capture frames with `screencapture -x`.
