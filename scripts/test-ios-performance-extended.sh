#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
BUNDLE_ID="dev.mde.editor"
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
xcrun simctl boot "$DEVICE" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$DEVICE" -b >/dev/null
MDE_DEVICE="$DEVICE" "$ROOT/scripts/build-ios-app.sh" >/dev/null
xcrun simctl terminate "$DEVICE" "$BUNDLE_ID" >/dev/null 2>&1 || true
CONTAINER=$(xcrun simctl get_app_container "$DEVICE" "$BUNDLE_ID" data)
RESULT="$CONTAINER/Documents/mde-performance-tests.json"
rm -f "$RESULT"
xcrun simctl launch "$DEVICE" "$BUNDLE_ID" --mde-performance-extended >/dev/null
for _ in $(seq 1 360); do [ -s "$RESULT" ] && break; /bin/sleep 0.5; done
xcrun simctl terminate "$DEVICE" "$BUNDLE_ID" >/dev/null 2>&1 || true
[ -s "$RESULT" ] || { echo "iOS 5MB bridge profile produced no result" >&2; exit 1; }
python3 - "$RESULT" <<'PY'
import json, sys
with open(sys.argv[1]) as f: result = json.load(f)
assert result.get("ok"), result
metrics = result["metrics"]
assert metrics["extended5MBBridgeLoadMs"] <= 3000, metrics
assert metrics["extended5MBBridgeEditMs"] <= 250, metrics
assert metrics["extended5MBBridgeMemoryGrowthBytes"] <= 1073741824, metrics
print("iOS 5MB Swift/core bridge:", json.dumps(metrics, sort_keys=True))
PY
