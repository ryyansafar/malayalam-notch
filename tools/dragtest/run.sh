#!/usr/bin/env bash
# Closed-loop drag test: restart the notch, drag a real voice-note file toward it, capture frames.
#   tools/dragtest/run.sh [outdir]      needs Accessibility + Screen Recording for the calling app
# Prints the frame paths; look at them (or diff them) to judge what the island did.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:-${TMPDIR:-/tmp}/dragtest-out}"
BIN="${TMPDIR:-/tmp}/dragtest-bin"
SAMPLE="${SAMPLE:-$ROOT/demo-samples/PTT-test-2.opus}"
# Points (not pixels). Defaults suit a 1710x1107 MacBook Air: chip window centre and the drop point
# 90 pt under the notch (never the top edge: that triggers Mission Control).
CHIP_X="${CHIP_X:-710}"; CHIP_Y="${CHIP_Y:-552}"
DROP_X="${DROP_X:-855}"; DROP_Y="${DROP_Y:-90}"
mkdir -p "$BIN" "$OUT"; rm -f "$OUT"/f_*.png

for t in mouse dragsrc trust; do
  [ -x "$BIN/$t" ] && [ "$BIN/$t" -nt "$HERE/$t.swift" ] || swiftc "$HERE/$t.swift" -o "$BIN/$t" || exit 1
done
"$BIN/trust" | grep -q "trusted" && "$BIN/trust" | grep -qv "NOT" || { echo "Accessibility not granted"; exit 2; }

"$ROOT/scripts/notch.sh" restart >/dev/null 2>&1; sleep 2
(nohup "$BIN/dragsrc" "$SAMPLE" >/dev/null 2>&1 &); sleep 1.5

screencapture -x -R0,0,1710,300 "$OUT/f_00_before.png"
("$BIN/mouse" drag "$CHIP_X" "$CHIP_Y" "$DROP_X" "$DROP_Y" 70 1.6 &)
for i in $(seq 1 14); do sleep 0.35; screencapture -x -R0,0,1710,300 "$OUT/f_$(printf %02d "$i").png"; done
sleep 2; screencapture -x -R0,0,1710,300 "$OUT/f_99_after.png"
pkill -f "$BIN/dragsrc"
ls "$OUT"/f_*.png
