#!/usr/bin/env sh
# Web UI (shared by all platforms) → dist/
set -e
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm ci
npm run build
