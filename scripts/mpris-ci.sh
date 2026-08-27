#!/usr/bin/env bash
#
# Prove the Linux Now Playing path against real things.
#
# Run under `dbus-run-session`, which gives this script a private session bus:
#
#     dbus-run-session -- scripts/mpris-ci.sh
#
# Starts the D-Bus fixture player, waits for it to claim its bus name, and runs
# the MPRIS tests against it through the real `playerctl` binary.
#
# The last step is the one that matters. Every gated test in that file skips
# itself when there is no player, and a suite that skips itself reports green --
# which is how this kind of verification quietly stops verifying anything. So
# this insists the skip count is zero.
set -euo pipefail

cd "$(dirname "$0")/.."

FIXTURE=packages/adapter-nowplaying/test/fixtures/mpris-player.py
SUITE=packages/adapter-nowplaying/dist/test/mpris.test.js
LOG=$(mktemp)

[ -f "$SUITE" ] || { echo "no build at $SUITE -- run npm run build first"; exit 1; }

python3 "$FIXTURE" >"$LOG" 2>&1 &
FIXTURE_PID=$!
trap 'kill "$FIXTURE_PID" 2>/dev/null || true' EXIT

# The fixture prints "ready" once it owns its name. Waiting for that beats
# sleeping a guessed interval, which is either a flake or a waste.
for _ in $(seq 1 100); do
  grep -q ready "$LOG" 2>/dev/null && break
  kill -0 "$FIXTURE_PID" 2>/dev/null || { echo "fixture exited early:"; cat "$LOG"; exit 1; }
  sleep 0.1
done

if ! grep -q ready "$LOG" 2>/dev/null; then
  echo "fixture never claimed its bus name:"; cat "$LOG"; exit 1
fi

# Checked before our own code runs, so a failure below is about upnext rather
# than about the bus, the fixture, or the runner.
echo "players playerctl can see:"
playerctl -l

UPNEXT_MPRIS_FIXTURE=1 node --test --test-reporter=tap "$SUITE" | tee /dev/stderr | {
  output=$(cat)
  if ! grep -qE '^# skipped 0$' <<<"$output"; then
    echo
    echo "FAIL: tests skipped themselves. With a fixture on the bus every test"
    echo "in this file must run -- a skip here means the gating went wrong and"
    echo "the Linux path is not actually being verified."
    exit 1
  fi
}
