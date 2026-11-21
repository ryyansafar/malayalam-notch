#!/usr/bin/env bash
# Builds "Malayalam Notch.app" with swiftc (no Xcode project): ./build.sh [outdir]  (default ./build)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/build}"
APP="$OUT/Malayalam Notch.app"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS"
swiftc -O -parse-as-library -target arm64-apple-macos14.0 \
  -framework SwiftUI -framework AppKit -framework AVFoundation -framework UniformTypeIdentifiers \
  "$HERE"/Sources/*.swift -o "$APP/Contents/MacOS/MalayalamNotch"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
[ -f "$HERE/AppIcon.icns" ] && { mkdir -p "$APP/Contents/Resources"; cp "$HERE/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"; }
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "$APP"
