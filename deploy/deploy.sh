#!/usr/bin/env bash
# Deploys the main branch of pinillasync on server1. Run as pinilla:  ~/pinillasync/deploy/deploy.sh
# Pulls main into /opt/pinillasync, installs dependencies, runs the tests and
# restarts the service. Stops at the first failure.
set -euo pipefail

APP=/opt/pinillasync
REPO=${PINILLASYNC_REPO:-https://github.com/Pinilla/pinillasync.git}
export PATH=/opt/node/bin:$PATH

if [ ! -d "$APP/.git" ]; then
  sudo mkdir -p "$APP"
  sudo chown "$USER:$USER" "$APP"
  git clone "$REPO" "$APP"
fi

cd "$APP"
git fetch origin main
git checkout --detach origin/main
echo "Deploying $(git log -1 --format='%h %s')"

npm ci
npm test

sudo systemctl restart pinillasync
sleep 2
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3200/healthz)
if [ "$code" != "200" ]; then
  echo "The app didn't answer after the restart (HTTP $code). Check: journalctl -u pinillasync -n 50" >&2
  exit 1
fi
echo "Deployed. https://sync.pinillaweb.org"
