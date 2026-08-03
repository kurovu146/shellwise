#!/bin/bash
# Record assets/demo.gif in an isolated environment.
#
# The daemon socket lives at /tmp/shellwise-<uid>.sock and ignores HOME and
# XDG_DATA_HOME, so a recording made while the real daemon is up would show the
# real history. This stops it, runs a daemon pointed at the demo database, and
# restores the real one afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO=/tmp/shellwise-demo

cd "$ROOT"
bash scripts/demo-setup.sh "$DEMO" >/dev/null

echo "[demo] stopping the real daemon"
shellwise daemon stop >/dev/null 2>&1 || true
sleep 0.5

echo "[demo] starting a daemon on the demo database"
HOME="$DEMO/home" XDG_DATA_HOME="$DEMO/data" shellwise daemon start >/dev/null 2>&1
sleep 1

cleanup() {
  echo "[demo] restoring the real daemon"
  shellwise daemon stop >/dev/null 2>&1 || true
  sleep 0.5
  shellwise daemon start >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[demo] recording"
vhs scripts/demo.tape

echo "[demo] done: assets/demo.gif"
