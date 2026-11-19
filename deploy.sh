#!/bin/bash
# Deploys (or redeploys) the watcher under pm2:
# install, build, then start or restart the pm2 process.
set -euo pipefail

cd "$(dirname "$0")"

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 is not installed. Install it with: npm install -g pm2" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo ".env is missing. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm build

pm2 startOrRestart ecosystem.config.cjs --update-env
pm2 save

pm2 status bms-alerts
