#!/bin/bash
# Cross-compiles mde-ffi for every Apple slice we need and packages them as an
# XCFramework so SwiftPM links the right one automatically.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="$ROOT/apple/MDECore.xcframework"

TARGETS=(aarch64-apple-darwin aarch64-apple-ios aarch64-apple-ios-sim)
for t in "${TARGETS[@]}"; do
    echo "==> $t"
    cargo build --release -p mde-ffi --target "$t"
done

rm -rf "$OUT"
xcodebuild -create-xcframework \
    -library "$ROOT/target/aarch64-apple-darwin/release/libmde.a"   -headers "$ROOT/apple/include" \
    -library "$ROOT/target/aarch64-apple-ios/release/libmde.a"      -headers "$ROOT/apple/include" \
    -library "$ROOT/target/aarch64-apple-ios-sim/release/libmde.a"  -headers "$ROOT/apple/include" \
    -output "$OUT" >/dev/null
echo "==> $OUT"
