#!/bin/bash
# Runs the watcher in the foreground, without pm2 (Ctrl+C to stop).
#
#   ./run.sh              watch mode, same as the pm2 process
#   ./run.sh --once       a single check, then exit
#   DRY_RUN=1 ./run.sh    print alerts instead of sending them
#
# Every log line and per-check debug details are printed to the terminal.
# Set VERBOSE=0 to turn that off.
set -euo pipefail

cd "$(dirname "$0")"

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if [ "${DRY_RUN:-0}" != "1" ] && command -v pm2 >/dev/null 2>&1 && pm2 pid bms-alerts 2>/dev/null | grep -q '[1-9]'; then
  echo "Warning: bms-alerts is also running under pm2; you will get duplicate alerts." >&2
fi

export VERBOSE="${VERBOSE:-1}"

if [ "${1:-}" = "--once" ]; then
  exec node dist/index.js
fi
exec node dist/index.js --watch
