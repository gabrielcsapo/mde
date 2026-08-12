#!/bin/bash
# Measures the 320-resource journaling workload inside the real UIKit renderer.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
BUNDLE_ID="dev.mde.editor"
DEVICE="${MDE_DEVICE:-}"

set -a
# shellcheck source=../benchmarks/budgets.env
source "$ROOT/benchmarks/budgets.env"
set +a

if [ -z "$DEVICE" ]; then
    DEVICE=$(xcrun simctl list devices available -j | python3 -c 'import json,sys
for runtime, devices in json.load(sys.stdin)["devices"].items():
    if "iOS" not in runtime: continue
    for device in devices:
        if device.get("isAvailable", True) and "iPhone" in device["name"]:
            print(device["udid"]); raise SystemExit')
fi
if [ -z "$DEVICE" ]; then
    echo "UIKit performance tests: no available iPhone simulator" >&2
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
RESULT="$CONTAINER/Documents/mde-performance-tests.json"
rm -f "$RESULT"
xcrun simctl launch "$DEVICE" "$BUNDLE_ID" --mde-performance-tests >/dev/null

for _ in $(seq 1 240); do
    [ -s "$RESULT" ] && break
    /bin/sleep 0.5
done
xcrun simctl terminate "$DEVICE" "$BUNDLE_ID" >/dev/null 2>&1 || true

if [ ! -s "$RESULT" ]; then
    echo "UIKit performance tests: app produced no result" >&2
    exit 1
fi

python3 - "$RESULT" <<'PY'
import json, os, sys
with open(sys.argv[1]) as f:
    result = json.load(f)
failed = [name for name, passed in result.get("checks", {}).items() if not passed]
metrics = result.get("metrics", {})
budgets = {
    "standardLoadMs": float(os.environ["MDE_IOS_1MB_LOAD_BUDGET_MS"]),
    "standardFirstPaintMs": float(os.environ["MDE_IOS_1MB_FIRST_PAINT_BUDGET_MS"]),
    "standardEditP95Ms": float(os.environ["MDE_IOS_1MB_EDIT_P95_BUDGET_MS"]),
    "editMatrixP95Ms": float(os.environ["MDE_IOS_EDIT_MATRIX_P95_BUDGET_MS"]),
    "editMatrixEnduranceP95Ms": float(
        os.environ["MDE_IOS_EDIT_MATRIX_ENDURANCE_P95_BUDGET_MS"]
    ),
    "editMatrixMemoryGrowthBytes": float(
        os.environ["MDE_IOS_EDIT_MATRIX_MEMORY_GROWTH_BUDGET_BYTES"]
    ),
    "pathologicalEditP95Ms": float(os.environ["MDE_IOS_GIANT_PARAGRAPH_BUDGET_MS"]),
    "tableReadyMs": float(os.environ["MDE_IOS_TABLE_BUDGET_MS"]),
    "mediaReadyMs": float(os.environ["MDE_IOS_MEDIA_JOURNAL_READY_BUDGET_MS"]),
    "mediaEditMs": float(os.environ["MDE_IOS_MEDIA_JOURNAL_EDIT_BUDGET_MS"]),
    "mediaScrollMs": float(os.environ["MDE_IOS_MEDIA_JOURNAL_SCROLL_BUDGET_MS"]),
}
over = [f"{name} {metrics.get(name, float('inf')):.2f}>{budget:.2f}ms"
        for name, budget in budgets.items() if metrics.get(name, float('inf')) > budget]
if failed or over or not result.get("ok"):
    print("UIKit performance tests failed: " + ", ".join(sorted(failed) + over), file=sys.stderr)
    raise SystemExit(1)
print("UIKit standard: "
      f"1MB load {metrics['standardLoadMs']:.2f} ms, "
      f"first paint {metrics['standardFirstPaintMs']:.2f} ms, "
      f"edit p95 {metrics['standardEditP95Ms']:.2f} ms, "
      f"pathological p95 {metrics['pathologicalEditP95Ms']:.2f} ms, "
      f"table {metrics['tableReadyMs']:.2f} ms")
print("UIKit shared edit matrix: "
      f"p95 {metrics['editMatrixP95Ms']:.2f} ms, "
      f"endurance p95 {metrics['editMatrixEnduranceP95Ms']:.2f} ms, "
      f"footprint growth {metrics['editMatrixMemoryGrowthBytes'] / 1048576:.1f} MiB")
print("UIKit media journal: "
      f"ready {metrics['mediaReadyMs']:.2f} ms, edit {metrics['mediaEditMs']:.2f} ms, "
      f"scroll {metrics['mediaScrollMs']:.2f} ms, "
      f"views {int(metrics['mediaViewCount'])}")
PY
