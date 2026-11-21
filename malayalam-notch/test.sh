#!/usr/bin/env bash
# Compiles the command rules with a tiny runner and checks them. No screen, no permissions.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${TMPDIR:-/tmp}/malayalam-notch-intent-check"
swiftc -parse-as-library -o "$OUT" "$HERE/Sources/MalayalamIntent.swift" "$HERE/Tests/intent-check.swift"
"$OUT"
