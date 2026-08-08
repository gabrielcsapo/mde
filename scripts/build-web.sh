#!/bin/bash
# Builds the wasm core, framework-free package, and optional React adapter.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

echo "==> wasm"
cargo build --release -p mde-wasm --target wasm32-unknown-unknown 2>&1 | tail -1
cp "$ROOT/target/wasm32-unknown-unknown/release/mde_wasm.wasm" "$ROOT/web/mde.wasm"
chmod 0644 "$ROOT/web/mde.wasm"
printf '    %s bytes\n' "$(wc -c < "$ROOT/web/mde.wasm" | tr -d ' ')"
echo "==> $ROOT/web/mde.wasm"

ensure_dependencies() {
    local directory="$1"
    [ -d "$directory/node_modules" ] || npm --prefix "$directory" ci
}

echo "==> @mde/web"
ensure_dependencies "$ROOT/web"
npm --prefix "$ROOT/web" run build

echo "==> @mde/react"
ensure_dependencies "$ROOT/web/react"
npm --prefix "$ROOT/web/react" run build
