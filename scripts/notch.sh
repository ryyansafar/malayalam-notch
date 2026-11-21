#!/usr/bin/env bash
# One-command on/off for the notch: starts (or stops) the server and the native Malayalam Notch app.
#   scripts/notch.sh up | down | toggle | status | restart
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${TMPDIR:-/tmp}/malayalam-notch"
PORT="${PORT:-3000}"
APP="$ROOT/malayalam-notch/build/Malayalam Notch.app"
INSTALLED="$HOME/Applications/Malayalam Notch.app"
SERVER_PID="$STATE/server.pid"
mkdir -p "$STATE"

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }
notch_running() { pgrep -f "MalayalamNotch" >/dev/null 2>&1; }

build_notch() {
  if [ ! -d "$APP" ] || [ -n "$(find "$ROOT/malayalam-notch/Sources" -newer "$APP/Contents/MacOS/MalayalamNotch" -name '*.swift' 2>/dev/null | head -1)" ]; then
    echo "building the notch app..."
    "$ROOT/malayalam-notch/build.sh" >/dev/null || { echo "build failed"; exit 1; }
  fi
}

start_server() {
  if port_open; then echo "server: already listening on :$PORT"; return; fi
  (cd "$ROOT" && nohup node server/index.js >"$STATE/server.log" 2>&1 & echo $! >"$SERVER_PID")
  for _ in $(seq 1 30); do port_open && break; sleep 0.2; done
  if port_open; then echo "server: started on :$PORT"; else echo "server: failed to start, see $STATE/server.log"; exit 1; fi
}

start_notch() {
  if notch_running; then echo "notch: already running"; return; fi
  if [ -d "$INSTALLED" ]; then open "$INSTALLED"; else build_notch; open "$APP"; fi
  sleep 1.5
  if notch_running; then echo "notch: running"; else echo "notch: failed to start"; exit 1; fi
}

stop_notch() { if notch_running; then pkill -f "MalayalamNotch" && echo "notch: stopped"; else echo "notch: not running"; fi; }

stop_server() {
  local pid; pid="$( [ -f "$SERVER_PID" ] && cat "$SERVER_PID" || true )"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill "$pid" && echo "server: stopped"; else echo "server: not started by this script (leaving it alone)"; fi
  rm -f "$SERVER_PID"
}

case "${1:-status}" in
  up)      start_server; start_notch ;;
  down)    stop_notch; stop_server ;;
  toggle)  if notch_running; then stop_notch; else start_server; start_notch; fi ;;
  restart) stop_notch; stop_server; sleep 0.5; start_server; start_notch ;;
  status)
    if notch_running; then echo "notch: running"; else echo "notch: off"; fi
    if port_open; then echo "server: listening on :$PORT"; else echo "server: off"; fi ;;
  *) echo "usage: scripts/notch.sh up|down|toggle|restart|status"; exit 2 ;;
esac
