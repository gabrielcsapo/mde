#!/bin/bash
# Records the real UIKit editor typing the landing-page Markdown sequence.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$PWD"
ASSETS="$ROOT/site/assets"
WORK="$(mktemp -d)"
BUNDLE_ID="dev.mde.editor"
RAW="$WORK/ios-native-editor.mov"
OUTPUT="$ASSETS/ios-native-editor.mp4"
POSTER="$ASSETS/ios-native-editor-poster.webp"
STATUS_BAR_OVERRIDDEN=""

cleanup() {
    if [ -n "$STATUS_BAR_OVERRIDDEN" ]; then
        xcrun simctl status_bar "$DEVICE" clear >/dev/null 2>&1 || true
    fi
    rm -rf "$WORK"
}
trap cleanup EXIT

DEVICE="${MDE_DEVICE:-}"
if [ -z "$DEVICE" ]; then
    DEVICE=$(xcrun simctl list devices available -j | python3 -c 'import json,sys
for runtime, devices in json.load(sys.stdin)["devices"].items():
    if "iOS" not in runtime: continue
    for device in devices:
        if device.get("isAvailable", True) and "iPhone" in device["name"]:
            print(device["udid"]); raise SystemExit')
fi
[ -n "$DEVICE" ] || { echo "no available iPhone simulator" >&2; exit 1; }

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

xcrun simctl ui "$DEVICE" appearance dark
if xcrun simctl status_bar "$DEVICE" override --time "9:41" --dataNetwork wifi \
    --wifiMode active --wifiBars 3 --cellularMode active --cellularBars 4 \
    --batteryState charged --batteryLevel 100 >/dev/null 2>&1; then
    STATUS_BAR_OVERRIDDEN=1
fi

MDE_DEVICE="$DEVICE" "$ROOT/scripts/build-ios-app.sh" >/dev/null
xcrun simctl launch --terminate-running-process "$DEVICE" "$BUNDLE_ID" \
    --mde-capture hero-video >/dev/null
/bin/sleep 0.6

xcrun simctl io "$DEVICE" recordVideo --codec h264 --force "$RAW" \
    >"$WORK/record.log" 2>&1 &
RECORDER=$!
for _ in $(seq 1 30); do
    grep -q "Recording started" "$WORK/record.log" 2>/dev/null && break
    /bin/sleep 0.25
done
if ! grep -q "Recording started" "$WORK/record.log" 2>/dev/null; then
    kill "$RECORDER" 2>/dev/null || true
    echo "simulator recording did not start" >&2
    exit 1
fi

/bin/sleep 14
kill -INT "$RECORDER" 2>/dev/null || true
wait "$RECORDER" 2>/dev/null || true
[ -s "$RAW" ] || { echo "simulator recording is empty" >&2; exit 1; }

ffmpeg -nostdin -loglevel error -y -i "$RAW" \
    -vf "scale=1080:-2:flags=lanczos,fps=30" \
    -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -an "$OUTPUT"
ffmpeg -nostdin -loglevel error -y -ss 11.5 -i "$OUTPUT" -frames:v 1 \
    -c:v libwebp -quality 90 "$POSTER"

echo "wrote $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
echo "wrote $POSTER ($(du -h "$POSTER" | cut -f1))"
