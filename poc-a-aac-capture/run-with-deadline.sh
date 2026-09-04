#!/usr/bin/env bash
#
# Launch PoC-A with a kill-switch that lives OUTSIDE the app.
#
# Why this exists: the documented out-of-band escape for a stuck assessment
# session is `ssh <mac> killall PocA`, which needs Remote Login — and Remote
# Login needs admin, which we do not have on this machine (2026-08-26). That
# removes the only exit that had actually been verified.
#
# This is the no-admin substitute. The deadline runs in a plain background
# shell, so it does not care what AAC has done to the GUI: it cannot be
# clicked away, app-switched away from, or starved by a locked screen. It only
# needs the process table.
#
# Layers, innermost first:
#   1. the app's own watchdog ends the session after --session-timeout;
#   2. this script SIGTERMs the app at the deadline, which the app traps and
#      turns into a confirmed teardown;
#   3. this script SIGKILLs it 5s later, leaving the session for the OS to
#      reclaim on process death. Last resort — untested, and the reason layers
#      1 and 2 exist.
#
# Usage:
#   ./run-with-deadline.sh [session-timeout-seconds] [extra app args...]
#
#   ./run-with-deadline.sh 60
#   ./run-with-deadline.sh 10 --simulate-lockdown --auto-begin
#
# Extra arguments are passed straight through to the app, which is how the
# deadline itself gets exercised without locking anything.
#
set -euo pipefail

SESSION_TIMEOUT="${1:-60}"
shift || true
APP_ARGS=("$@")
# The outer deadline has to outlast the inner watchdog, or it fires first and
# we never learn whether the in-app watchdog works — which is the thing the
# first run is meant to measure.
DEADLINE="${POCA_DEADLINE:-$(( SESSION_TIMEOUT + 30 ))}"

# Index.noindex holds the indexer's stub products — same name, same layout, no
# actual binary inside. Matching it launches nothing and the script exits in a
# second looking like a successful run, so exclude it explicitly and then
# confirm the executable is really there.
APP=$(find "$HOME/Library/Developer/Xcode/DerivedData" \
        -maxdepth 6 -path '*/Build/Products/Debug/PocA.app' \
        -not -path '*Index.noindex*' 2>/dev/null | head -1)

if [ -z "$APP" ] || [ ! -x "$APP/Contents/MacOS/PocA" ]; then
  echo "No built PocA.app with a runnable binary. Build it first:" >&2
  echo "  xcodebuild -project PocA/PocA.xcodeproj -scheme PocA -destination 'platform=macOS' build" >&2
  exit 1
fi

echo "app:              $APP"
echo "in-app watchdog:  ${SESSION_TIMEOUT}s"
echo "external SIGTERM: ${DEADLINE}s"
echo "external SIGKILL: $(( DEADLINE + 5 ))s"
echo

"$APP/Contents/MacOS/PocA" --session-timeout "$SESSION_TIMEOUT" ${APP_ARGS[@]+"${APP_ARGS[@]}"} &
APP_PID=$!

(
  sleep "$DEADLINE"
  if kill -0 "$APP_PID" 2>/dev/null; then
    echo "[deadline] ${DEADLINE}s elapsed — SIGTERM to $APP_PID" >&2
    kill -TERM "$APP_PID" 2>/dev/null || true
    sleep 5
    if kill -0 "$APP_PID" 2>/dev/null; then
      echo "[deadline] still alive — SIGKILL to $APP_PID" >&2
      kill -KILL "$APP_PID" 2>/dev/null || true
    fi
  fi
) &
KILLER_PID=$!

wait "$APP_PID" || true
kill "$KILLER_PID" 2>/dev/null || true
echo "PocA exited."
