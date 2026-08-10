#!/bin/bash
# Generates a feature-focused comparison matrix across JS, React, UIKit, and AppKit.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
ASSETS="$ROOT/site/assets"
DEVICE="${MDE_DEVICE:-}"
IOS_BUNDLE="dev.mde.editor"
MAC_APP="$ROOT/build/mac/MDEditor.app/Contents/MacOS/MDEditor"
WORK="$(mktemp -d)"
STATUS_BAR=""
SCENARIOS=$(node -e "const m=require('./fixtures/captures/manifest.json'); console.log(m.scenarios.map(s=>s.id).join(' '))")

if [ -z "$DEVICE" ]; then
    DEVICE=$(xcrun simctl list devices available -j | python3 -c 'import json,sys
for runtime, devices in json.load(sys.stdin)["devices"].items():
    if "iOS" not in runtime: continue
    for device in devices:
        if device.get("isAvailable", True) and "iPhone" in device["name"]:
            print(device["udid"]); raise SystemExit')
fi
if [ -z "$DEVICE" ]; then
    echo "no available iPhone simulator; install an iOS runtime or set MDE_DEVICE=<udid>" >&2
    exit 1
fi

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
for scenario in $SCENARIOS; do
    # The build helper launches the app once after installing it. Terminate atomically
    # with each scenario launch so that a still-starting copy cannot retain the previous
    # process arguments and silently give every output file the same document.
    xcrun simctl launch --terminate-running-process "$DEVICE" "$IOS_BUNDLE" \
        --mde-capture "matrix-$scenario" >/dev/null
    /bin/sleep 2.5
    xcrun simctl io "$DEVICE" screenshot --type=png \
        "$ASSETS/capture-$scenario-ios.png" >/dev/null
done

cp "$ASSETS/capture-core-ios.png" "$ASSETS/ios-cross-platform.png"

echo "==> AppKit"
"$ROOT/scripts/build-macos-app.sh" >"$WORK/mac-build.log" 2>&1
pkill -f "MDEditor.app/Contents/MacOS/MDEditor" >/dev/null 2>&1 || true
for scenario in $SCENARIOS; do
    LOG="$WORK/mac-$scenario.out"
    output="$ASSETS/capture-$scenario-macos.png"
    rm -f "$output"
    "$MAC_APP" -ApplePersistenceIgnoreState YES --mde-capture "matrix-$scenario" \
        --mde-output "$output" >"$LOG" 2>&1 &
    MAC_PID=$!
    for _ in $(seq 1 75); do
        [ -s "$output" ] && break
        /bin/sleep 0.2
    done
    if [ ! -s "$output" ]; then
        echo "macOS app did not write $scenario capture" >&2
        tail -20 "$LOG" >&2
        exit 1
    fi
    kill "$MAC_PID" >/dev/null 2>&1 || true
done
cp "$ASSETS/capture-core-macos.png" "$ASSETS/macos-cross-platform.png"

echo "==> verify"
for scenario in $SCENARIOS; do
    for platform in js react ios macos; do
        file="capture-$scenario-$platform.png"
        path="$ASSETS/$file"
        if [ ! -s "$path" ] || [ "$(stat -f%z "$path")" -lt 4096 ]; then
            echo "$file is missing or suspiciously small" >&2
            exit 1
        fi
        echo "    $file ($(du -h "$path" | cut -f1))"
    done
done

# A non-empty PNG is not sufficient evidence: a launch-race once produced four copies
# of the same valid screenshot. Every scenario must result in distinct pixels on each
# renderer surface.
for platform in js react ios macos; do
    hash_count=$(for scenario in $SCENARIOS; do
        shasum "$ASSETS/capture-$scenario-$platform.png" | cut -d' ' -f1
    done | sort -u | wc -l | tr -d ' ')
    scenario_count=$(printf '%s\n' $SCENARIOS | wc -l | tr -d ' ')
    if [ "$hash_count" -ne "$scenario_count" ]; then
        echo "$platform captures contain duplicate scenario pixels" >&2
        exit 1
    fi
done
