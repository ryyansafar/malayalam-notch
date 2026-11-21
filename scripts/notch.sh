#!/usr/bin/env bash
# One-command on/off for the notch: starts (or stops) the server and the native notch app.
#   scripts/notch.sh up | down | toggle | status | restart
# State lives in /tmp/malayalam-notch (pid files, logs). Safe to run repeatedly.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${TMPDIR:-/tmp}/malayalam-notch"
PORT="${PORT:-3000}"
BIN="$ROOT/notch-app/build/notch"
SERVER_PID="$STATE/server.pid"
NOTCH_PID="$STATE/notch.pid"
mkdir -p "$STATE"

is_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
read_pid() { [ -f "$1" ] && cat "$1" || true; }
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }
notch_running() { pgrep -f "notch-app/build/notch" >/dev/null 2>&1; }

build_notch() {
  mkdir -p "$ROOT/notch-app/build"
  if [ ! -x "$BIN" ] || [ "$ROOT/notch-app/NotchApp.swift" -nt "$BIN" ]; then
    echo "building the notch app..."
    swiftc -O -framework AppKit -framework WebKit \
      -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$ROOT/notch-app/Info.plist" \
      "$ROOT/notch-app/NotchApp.swift" -o "$BIN" || { echo "build failed"; exit 1; }
  fi
}

start_server() {
  if port_open; then echo "server: already listening on :$PORT"; return; fi
  (cd "$ROOT" && nohup node server/index.js >"$STATE/server.log" 2>&1 & echo $! >"$SERVER_PID")
  for _ in $(seq 1 30); do port_open && break; sleep 0.2; done
  if port_open; then echo "server: started on :$PORT (log: $STATE/server.log)"; else echo "server: failed to start, see $STATE/server.log"; exit 1; fi
}

start_notch() {
  if notch_running; then echo "notch: already running"; return; fi
  build_notch
  (cd "$ROOT" && PORT="$PORT" nohup "$BIN" >"$STATE/notch.log" 2>&1 & echo $! >"$NOTCH_PID")
  sleep 0.5
  if notch_running; then echo "notch: running"; else echo "notch: failed to start, see $STATE/notch.log"; exit 1; fi
}

stop_notch() {
  if notch_running; then pkill -f "notch-app/build/notch" && echo "notch: stopped"; else echo "notch: not running"; fi
  rm -f "$NOTCH_PID"
}

stop_server() {
  local pid; pid="$(read_pid "$SERVER_PID")"
  if is_alive "$pid"; then kill "$pid" && echo "server: stopped"; else echo "server: not started by this script (leaving it alone)"; fi
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
