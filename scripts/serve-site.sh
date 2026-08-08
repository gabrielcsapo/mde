#!/usr/bin/env bash
# Runs the marketing site (`site/`) in development.
#
# The site is a Vite + React app and is the one part of this repository allowed to have
# npm dependencies — the editor itself has none, and `web/` is still plain ES modules
# served as-is. This script exists so there is a single obvious way to start the site
# without having to remember that its package lives one directory down.
#
# It builds the wasm first, because the site imports the *real* editor from `web/src`
# and loads `web/mde.wasm`; it does not keep a copy of either, so a stale wasm would
# show up as a stale editor on the page.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v npm > /dev/null || {
    echo "npm is required for the site (the editor itself needs none)" >&2
    exit 1
}

./scripts/build-web.sh

[ -d site/node_modules ] || {
    printf '\033[1m%s\033[0m\n' "==> installing site dependencies"
    npm --prefix site install
}

printf '\033[1m%s\033[0m\n' "==> vite dev server"
exec npm --prefix site run "${1:-dev}"
