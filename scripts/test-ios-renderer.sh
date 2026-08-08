#!/bin/bash
# Runs the UIKit renderer assertions inside an iPhone simulator. The app writes one
# JSON result into its Documents directory; this script treats every false check as a
# test failure and prints the exact failing renderer capabilities.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
BUNDLE_ID="dev.mde.editor"
DEVICE="${MDE_DEVICE:-B67C4805-DF13-4975-8E9C-967C522F683F}"

if ! xcrun simctl list devices -j | grep -q "$DEVICE"; then
    echo "UIKit renderer tests: simulator $DEVICE does not exist; set MDE_DEVICE=<udid>" >&2
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

MDE_DEVICE="$DEVICE" "$ROOT/scripts/build-ios-app.sh" >/dev/null
xcrun simctl terminate "$DEVICE" "$BUNDLE_ID" >/dev/null 2>&1 || true
CONTAINER=$(xcrun simctl get_app_container "$DEVICE" "$BUNDLE_ID" data)
RESULT="$CONTAINER/Documents/mde-renderer-tests.json"
rm -f "$RESULT"
xcrun simctl launch "$DEVICE" "$BUNDLE_ID" --mde-renderer-tests >/dev/null

for _ in $(seq 1 60); do
    [ -s "$RESULT" ] && break
    /bin/sleep 0.25
done
xcrun simctl terminate "$DEVICE" "$BUNDLE_ID" >/dev/null 2>&1 || true

if [ ! -s "$RESULT" ]; then
    echo "UIKit renderer tests: app produced no result" >&2
    exit 1
fi

python3 - "$RESULT" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    result = json.load(f)
failed = [name for name, passed in result.get("checks", {}).items() if not passed]
if failed or not result.get("ok"):
    print("UIKit renderer tests failed: " + ", ".join(sorted(failed)), file=sys.stderr)
    raise SystemExit(1)
print("UIKit renderer tests passed (" + ", ".join(sorted(result["checks"])) + ")")
PY
