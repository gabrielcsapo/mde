#!/usr/bin/env bash
# Runs the marketing site (`site/`) in development.
#
# The site is a Vite + React app. This script exists so there is a single obvious way to
# build the web packages and start the docs without remembering which package owns each
# command.
#
# It builds the wasm, framework-free package, and React adapter first; the site consumes
# their package entry points, so a stale artifact would show up as a stale live example.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v npm > /dev/null || {
    echo "npm is required for the site (the editor itself needs none)" >&2
    exit 1
}

[ -d site/node_modules ] || {
    printf '\033[1m%s\033[0m\n' "==> installing site dependencies"
    npm --prefix site install
}

printf '\033[1m%s\033[0m\n' "==> vite dev server"
exec npm --prefix site run "${1:-dev}"
