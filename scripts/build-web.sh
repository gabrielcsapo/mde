#!/bin/bash
# Builds the wasm core and drops it next to the web sources.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

echo "==> wasm"
cargo build --release -p mde-wasm --target wasm32-unknown-unknown 2>&1 | tail -1
cp "$ROOT/target/wasm32-unknown-unknown/release/mde_wasm.wasm" "$ROOT/web/mde.wasm"
printf '    %s bytes\n' "$(wc -c < "$ROOT/web/mde.wasm" | tr -d ' ')"
echo "==> $ROOT/web/mde.wasm"
