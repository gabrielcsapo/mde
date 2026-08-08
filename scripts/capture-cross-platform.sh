#!/bin/bash
# Generates the four review images for the single fixture in
# fixtures/cross-platform.md: JS, React, UIKit, and AppKit.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
ASSETS="$ROOT/site/assets"
DEVICE="${MDE_DEVICE:-B67C4805-DF13-4975-8E9C-967C522F683F}"
IOS_BUNDLE="dev.mde.editor"
MAC_APP="$ROOT/build/mac/MDEditor.app/Contents/MacOS/MDEditor"
WORK="$(mktemp -d)"
STATUS_BAR=""

cleanup() {
    [ -z "$STATUS_BAR" ] || xcrun simctl status_bar "$DEVICE" clear >/dev/null 2>&1 || true
    pkill -f "MDEditor.app/Contents/MacOS/MDEditor" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> JS + React"
pnpm run capture:web

echo "==> UIKit"
if ! xcrun simctl list devices -j | grep -q "$DEVICE"; then
    echo "simulator $DEVICE does not exist; set MDE_DEVICE=<udid>" >&2
    exit 1
fi
STATE=$(xcrun simctl list devices -j | python3 -c 'import json,sys
want=sys.argv[1]
for devices in json.load(sys.stdin)["devices"].values():
    for device in devices:
        if device["udid"] == want:
            print(device["state"]); raise SystemExit' "$DEVICE")
if [ "$STATE" != "Booted" ]; then
    xcrun simctl boot "$DEVICE"
    xcrun simctl bootstatus "$DEVICE" -b
fi
MDE_DEVICE="$DEVICE" "$ROOT/scripts/build-ios-app.sh" >"$WORK/ios-build.log" 2>&1
if xcrun simctl status_bar "$DEVICE" override --time "9:41" --dataNetwork wifi \
    --wifiMode active --wifiBars 3 --cellularMode active --cellularBars 4 \
    --batteryState charged --batteryLevel 100 >/dev/null 2>&1; then
    STATUS_BAR=1
fi
xcrun simctl terminate "$DEVICE" "$IOS_BUNDLE" >/dev/null 2>&1 || true
xcrun simctl launch "$DEVICE" "$IOS_BUNDLE" --mde-capture cross-platform >/dev/null
/bin/sleep 3
xcrun simctl io "$DEVICE" screenshot --type=png "$ASSETS/ios-cross-platform.png" >/dev/null

echo "==> AppKit"
"$ROOT/scripts/build-macos-app.sh" >"$WORK/mac-build.log" 2>&1
pkill -f "MDEditor.app/Contents/MacOS/MDEditor" >/dev/null 2>&1 || true
LOG="$WORK/mac.out"
rm -f "$ASSETS/macos-cross-platform.png"
"$MAC_APP" -ApplePersistenceIgnoreState YES --mde-capture cross-platform \
    --mde-output "$ASSETS/macos-cross-platform.png" >"$LOG" 2>&1 &
MAC_PID=$!
for _ in $(seq 1 75); do
    [ -s "$ASSETS/macos-cross-platform.png" ] && break
    /bin/sleep 0.2
done
if [ ! -s "$ASSETS/macos-cross-platform.png" ]; then
    echo "macOS app did not write its capture" >&2
    tail -20 "$LOG" >&2
    exit 1
fi
kill "$MAC_PID" >/dev/null 2>&1 || true

echo "==> verify"
for file in web-js.png web-react.png ios-cross-platform.png macos-cross-platform.png; do
    path="$ASSETS/$file"
    if [ ! -s "$path" ] || [ "$(stat -f%z "$path")" -lt 4096 ]; then
        echo "$file is missing or suspiciously small" >&2
        exit 1
    fi
    echo "    $file ($(du -h "$path" | cut -f1))"
done
