#!/usr/bin/env bash
# Copy the dashboard app into ./app (gitignored here) and deploy this directory.
#   APP_DIR=../../apps/dashboard HEXCLAVE_PROJECT_ID=... ./deploy.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="${APP_DIR:?APP_DIR=<path to the dashboard app>}"
rsync -a --delete --exclude node_modules --exclude dist --exclude .output --exclude .tanstack "$app/" "$here/app/"
[[ -f "$here/.dockerignore" ]] || cp "$here/dockerignore" "$here/.dockerignore"
cd "$here"
npx -y "@hexclave/cli@${HEXCLAVE_CLI_VERSION:-1.0.130}" deploy --cloud-project-id "${HEXCLAVE_PROJECT_ID:?}"
