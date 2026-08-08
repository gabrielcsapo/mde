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

[ -d "$ROOT/node_modules/.pnpm" ] || pnpm --dir "$ROOT" install --frozen-lockfile

echo "==> @mde/web"
pnpm --dir "$ROOT/web" run build

echo "==> @mde/react"
pnpm --dir "$ROOT/web/react" run build
