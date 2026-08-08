#!/bin/bash
# Showcase assets for the native editors — screenshots and screencasts of the iOS and
# macOS reference apps, written to site/assets/ for the website to read.
#
#   ./scripts/capture.sh            iOS and macOS
#   ./scripts/capture.sh ios        iOS only
#   ./scripts/capture.sh macos      macOS only
#
# Every capture is independent. One failing — a missing permission, a simulator that
# will not boot — is reported and skipped, and manifest.json then lists only what
# actually landed, so the site degrades to whatever exists. The exit status is non-zero
# only if nothing was captured at all.
#
# How the shots are composed: `simctl` cannot inject a touch and `screencapture` cannot
# click, so the apps compose their own shots. Both are launched with
# `--mde-capture <shot>` and set their scroll offset and selection accordingly; see
# `apple/Sources/MDEApp/CaptureMode.swift` and its AppKit twin. Nothing about the
# rendering changes — the shots are of the real editors, doing the real thing.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
ASSETS="$ROOT/site/assets"
WORK="$(mktemp -d)"
STATUS_BAR_OVERRIDDEN=""
trap 'clear_status_bar; rm -rf "$WORK"' EXIT

# The dedicated capture simulator. Deliberately never "booted": that resolves to
# whichever device happens to be running, which has picked a watch before now, and the
# machine this runs on has a simulator its owner is using. Override to retarget.
DEVICE="${MDE_DEVICE:-B67C4805-DF13-4975-8E9C-967C522F683F}"
IOS_BUNDLE="dev.mde.editor"
MAC_APP="$ROOT/build/mac/MDEditor.app/Contents/MacOS/MDEditor"

WHICH="${1:-all}"
case "$WHICH" in
    ios | macos | all) ;;
    *)
        echo "usage: $0 [ios|macos|all]" >&2
        exit 2
        ;;
esac

# Assets that were produced, as `name|file|kind|platform|caption`. manifest.json is
# written from this and nothing else, so it cannot claim an asset that is not there.
LEDGER="$WORK/ledger"
: > "$LEDGER"
PROBLEMS=0

info() { printf '\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
problem() {
    printf '\033[33m!!  %s\033[0m\n' "$*" >&2
    PROBLEMS=$((PROBLEMS + 1))
}

# Record an asset only once the file is really on disk and is not a zero-byte stub —
# screencapture leaves those behind when it is denied.
keep() {
    local name=$1 file=$2 kind=$3 platform=$4 caption=$5
    local path="$ASSETS/$file"
    if [ ! -s "$path" ]; then
        problem "$file was not produced"
        return 1
    fi
    if [ "$(stat -f%z "$path")" -lt 4096 ]; then
        problem "$file is suspiciously small ($(stat -f%z "$path") bytes) — discarding"
        rm -f "$path"
        return 1
    fi
    printf '%s|%s|%s|%s|%s\n' "$name" "$file" "$kind" "$platform" "$caption" >> "$LEDGER"
    note "$file ($(du -h "$path" | cut -f1))"
}

# Re-encode to a small web-friendly mp4. Both encoders are optional; without either the
# recording is still usable, just larger, so this never fails the capture.
transcode() {
    local src=$1 dst=$2
    rm -f "$dst"
    if command -v ffmpeg > /dev/null 2>&1; then
        ffmpeg -nostdin -loglevel error -y -i "$src" \
            -vf "scale=-2:1000" -c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p \
            -movflags +faststart -an "$dst" > /dev/null 2>&1 && return 0
    fi
    if command -v avconvert > /dev/null 2>&1; then
        avconvert --quiet --preset PresetHighestQuality \
            --source "$src" --output "$dst" > /dev/null 2>&1 && return 0
    fi
    problem "no ffmpeg or avconvert — shipping $(basename "$dst") unre-encoded"
    cp "$src" "$dst"
}

# ---------------------------------------------------------------------------- iOS

capture_ios() {
    info "iOS"
    # Clear the shots this run owns before taking any. Otherwise a step that fails
    # leaves the previous run's file in place, `keep` sees a perfectly good PNG, and
    # the manifest advertises a stale asset as a fresh one.
    rm -f "$ASSETS"/ios-inline-rendering.png "$ASSETS"/ios-reveal.png \
        "$ASSETS"/ios-widgets.png "$ASSETS"/ios-references.png "$ASSETS"/ios-demo.mp4

    if ! xcrun simctl list devices -j | grep -q "$DEVICE"; then
        problem "simulator $DEVICE does not exist — set MDE_DEVICE=<udid>"
        return 1
    fi
    note "device $DEVICE"

    local state
    state=$(xcrun simctl list devices -j \
        | python3 -c 'import json,sys
want = sys.argv[1]
for devices in json.load(sys.stdin)["devices"].values():
    for dev in devices:
        if dev["udid"] == want:
            print(dev["state"]); raise SystemExit' "$DEVICE")
    if [ "$state" != "Booted" ]; then
        note "booting"
        xcrun simctl boot "$DEVICE" || {
            problem "could not boot $DEVICE"
            return 1
        }
        /bin/sleep 8
    fi

    if ! MDE_DEVICE="$DEVICE" "$ROOT/scripts/build-ios-app.sh" > "$WORK/ios-build.log" 2>&1; then
        problem "iOS build failed — see below"
        tail -20 "$WORK/ios-build.log" >&2
        return 1
    fi

    # A settled status bar, so re-running does not change the clock in every image.
    # Cleared again on the way out — it is a property of the *shot*, not of the device,
    # and leaving it set silently changes what the simulator shows for everything else
    # the user does with it afterwards.
    if xcrun simctl status_bar "$DEVICE" override \
        --time "9:41" \
        --dataNetwork wifi --wifiMode active --wifiBars 3 \
        --cellularMode active --cellularBars 4 \
        --batteryState discharging --batteryLevel 100 > /dev/null 2>&1
    then
        STATUS_BAR_OVERRIDDEN=1
    else
        note "status bar override unavailable; using the simulator's own"
    fi

    shot() {
        local mode=$1 file=$2
        xcrun simctl terminate "$DEVICE" "$IOS_BUNDLE" > /dev/null 2>&1
        if ! xcrun simctl launch "$DEVICE" "$IOS_BUNDLE" --mde-capture "$mode" > /dev/null 2>&1; then
            problem "could not launch the iOS app for '$mode'"
            return 1
        fi
        # 1.2s of that is the app waiting for the references to resolve before it
        # scrolls; the rest is layout and the animation settling.
        /bin/sleep 3
        rm -f "$ASSETS/$file"
        xcrun simctl io "$DEVICE" screenshot --type=png "$ASSETS/$file" > /dev/null 2>&1
    }

    shot inline ios-inline-rendering.png
    keep "Inline rendering" ios-inline-rendering.png image ios \
        "A heading, bold and italic, inline code, a link and strikethrough — rendered in place, with the markdown still the document."

    shot reveal ios-reveal.png
    keep "Syntax reveal" ios-reveal.png image ios \
        "The caret inside the bold node brings its ** delimiters back. Nothing is hidden from you; nothing was converted into a separate model."

    shot widgets ios-widgets.png
    keep "Host widgets" ios-widgets.png image ios \
        "The @gabe mention chip and the callout block are drawn by the host app, from a declarative manifest the core never executes."

    shot references ios-references.png
    keep "Resolved references" ios-references.png image ios \
        "The document holds a 26-character path, never the bytes. The host resolves the chart and the spec.pdf chip off disk."

    capture_ios_video
}

# Puts the simulator's status bar back the way it was found. Hung off the exit trap
# rather than the end of the happy path: a run that dies half way through must not leave
# the device pinned at 9:41 for everything the user does with it afterwards.
clear_status_bar() {
    [ -n "${STATUS_BAR_OVERRIDDEN:-}" ] || return 0
    STATUS_BAR_OVERRIDDEN=""
    xcrun simctl status_bar "$DEVICE" clear > /dev/null 2>&1 || true
}

capture_ios_video() {
    local raw="$WORK/ios-demo.mov"
    rm -f "$raw"

    # App first, recorder second: the app holds the document still for four seconds
    # before it starts moving, so the recording opens on the rendered document rather
    # than on the home screen and an app-launch animation.
    xcrun simctl terminate "$DEVICE" "$IOS_BUNDLE" > /dev/null 2>&1
    if ! xcrun simctl launch "$DEVICE" "$IOS_BUNDLE" --mde-capture demo > /dev/null 2>&1; then
        problem "could not launch the iOS app for the screencast"
        return 1
    fi

    xcrun simctl io "$DEVICE" recordVideo --codec h264 --force "$raw" \
        > "$WORK/ios-record.log" 2>&1 &
    local recorder=$!
    # simctl writes "Recording started" once the first frame is through.
    local waited=0
    while ! grep -q "Recording started" "$WORK/ios-record.log" 2> /dev/null; do
        /bin/sleep 1
        waited=$((waited + 1))
        if [ $waited -gt 15 ]; then
            problem "iOS screen recording never started"
            kill "$recorder" 2> /dev/null
            return 1
        fi
    done

    # The tour begins 4s after launch and lands on the references around 11.7s.
    /bin/sleep 11
    kill -INT "$recorder" 2> /dev/null
    wait "$recorder" 2> /dev/null

    if [ ! -s "$raw" ]; then
        problem "iOS screen recording produced nothing"
        return 1
    fi
    transcode "$raw" "$ASSETS/ios-demo.mp4"
    keep "iOS walkthrough" ios-demo.mp4 video ios \
        "Caret in, syntax back, caret out — then down through the host widgets to the resolved references."
}

# -------------------------------------------------------------------------- macOS

MAC_ID=""
MAC_RECT=""

mac_quit() {
    pkill -f "MDEditor.app/Contents/MacOS/MDEditor" > /dev/null 2>&1
    /bin/sleep 1
    # Signalling a GUI app counts as a crash, and after a couple of those AppKit opens
    # a modal "reopen its windows?" alert on the next launch — from inside
    # `applicationDidFinishLaunching`, so the app hangs before it has a window and
    # every capture after it silently fails. Forget that we were ever here.
    rm -rf "$HOME/Library/Saved Application State/dev.mde.editor.mac.savedState"
}

# Launches the app for one shot and reads back where its window is, into MAC_ID and
# MAC_RECT. The app puts its CGWindowID and its screen rect on stdout because neither
# is reachable from the shell: the system python has no Quartz bindings and System
# Events needs Accessibility. Assigned to globals rather than echoed — a `$(...)` here
# would be a subshell and the rect would not survive it.
mac_launch() {
    local mode=$1 settle=${2:-2}
    MAC_ID=""
    MAC_RECT=""
    mac_quit
    local log="$WORK/mac-$mode.out"
    rm -f "$log"
    # -ApplePersistenceIgnoreState is belt to `mac_quit`'s braces: it stops AppKit
    # restoring or asking about window state at all.
    "$MAC_APP" -ApplePersistenceIgnoreState YES --mde-capture "$mode" > "$log" 2>&1 &
    # Otherwise the shell announces "Terminated" for every app `mac_quit` kills.
    disown %% 2> /dev/null

    # Wait for the window rather than guessing at a launch time: a cold start pays for
    # dyld and for the first parse, and a fixed sleep that is long enough on a warm run
    # silently loses the window on a cold one.
    local waited=0
    while ! grep -q MDE_WINDOW_RECT "$log" 2> /dev/null; do
        /bin/sleep 0.2
        waited=$((waited + 1))
        if [ "$waited" -gt 75 ]; then return 1; fi
    done
    MAC_ID=$(awk '/MDE_WINDOW_ID/{print $2}' "$log")
    MAC_RECT=$(awk '/MDE_WINDOW_RECT/{print $2}' "$log")
    /bin/sleep "$settle"
}

capture_macos() {
    info "macOS"
    # Same reason as the iOS side: a failed step must not leave a stale asset behind
    # for `keep` to mistake for this run's work.
    rm -f "$ASSETS"/macos-editor.png "$ASSETS"/macos-widgets.png "$ASSETS"/macos-demo.mp4

    if ! "$ROOT/scripts/build-macos-app.sh" > "$WORK/mac-build.log" 2>&1; then
        problem "macOS build failed — see below"
        tail -20 "$WORK/mac-build.log" >&2
        return 1
    fi

    mac_shot() {
        local mode=$1 file=$2
        mac_launch "$mode"
        if [ -z "$MAC_ID" ]; then
            problem "the macOS app did not report a window for '$mode' (did it launch?)"
            return 1
        fi
        rm -f "$ASSETS/$file"
        # -o drops the window shadow, which would otherwise bake a soft grey border
        # into a transparent-less PNG.
        screencapture -x -o -l"$MAC_ID" -t png "$ASSETS/$file" > /dev/null 2>&1
        if [ ! -s "$ASSETS/$file" ]; then
            problem "screencapture wrote nothing. Grant Screen Recording to your" \
                "terminal in System Settings > Privacy & Security > Screen & System" \
                "Audio Recording, then re-run."
            return 1
        fi
    }

    mac_shot editor macos-editor.png
    keep "macOS editor" macos-editor.png image macos \
        "The same document in the AppKit host — one Swift package, two renderers, the same decoration logic underneath."

    mac_shot widgets macos-widgets.png
    keep "macOS widgets and references" macos-widgets.png image macos \
        "The mention chip, the callout block, the resolved chart and the spec.pdf chip, all drawn natively by the host."

    capture_macos_video
}

capture_macos_video() {
    # App first, recorder second, same as iOS: `screencapture -v` takes a screen rect
    # rather than a window, so the window has to exist — and be on top — before there
    # is anything safe to point it at. The app holds the document still for three
    # seconds and raises its window to the floating level, so nothing of yours can end
    # up inside the rect.
    # Start recording the moment the window is up: the tour itself does not begin
    # until three seconds after launch, which is the lead-in.
    mac_launch demo 0
    if [ -z "$MAC_RECT" ]; then
        problem "the macOS app did not report a window rect — skipping the screencast"
        return 1
    fi

    local raw="$WORK/macos-demo.mov"
    rm -f "$raw"
    screencapture -x -v -V9 -R"$MAC_RECT" "$raw" > "$WORK/mac-record.log" 2>&1
    mac_quit

    if [ ! -s "$raw" ]; then
        problem "screencapture recorded nothing. Grant Screen Recording to your" \
            "terminal in System Settings > Privacy & Security > Screen & System" \
            "Audio Recording, then re-run."
        return 1
    fi
    transcode "$raw" "$ASSETS/macos-demo.mp4"
    keep "macOS walkthrough" macos-demo.mp4 video macos \
        "The reveal and the scroll on the desktop, driven by the same core as the phone."
}

# ----------------------------------------------------------------------- manifest

# `capture.sh ios` must not erase the macOS half of the manifest. Anything the previous
# run recorded for a platform this run is not touching is carried across, but only if
# the file is still on disk — the manifest never claims an asset that is not there.
carry_over() {
    [ -f "$ASSETS/manifest.json" ] || return 0
    python3 - "$ASSETS" "$WHICH" >> "$LEDGER" <<'PY'
import json, os, sys

assets, which = sys.argv[1], sys.argv[2]
skip = {"ios": {"ios"}, "macos": {"macos"}, "all": {"ios", "macos"}}[which]

try:
    with open(os.path.join(assets, "manifest.json")) as f:
        manifest = json.load(f)
except (OSError, ValueError):
    raise SystemExit

for asset in manifest.get("assets", []):
    if asset.get("platform") in skip:
        continue
    if not os.path.exists(os.path.join(assets, asset.get("file", ""))):
        continue
    print("|".join(asset.get(key, "") for key in
                   ("name", "file", "kind", "platform", "caption")))
PY
}

write_manifest() {
    # The ledger arrives as a path, not on stdin: `python3 -` is already reading the
    # program from there.
    python3 - "$ASSETS/manifest.json" "$LEDGER" <<'PY'
import json, sys

# A fixed order, so the file does not churn with whatever ran first.
ORDER = [
    "ios-inline-rendering.png",
    "ios-reveal.png",
    "ios-widgets.png",
    "ios-references.png",
    "ios-demo.mp4",
    "macos-editor.png",
    "macos-widgets.png",
    "macos-demo.mp4",
]

assets = []
with open(sys.argv[2]) as ledger:
    lines = ledger.read().splitlines()

for line in lines:
    if not line:
        continue
    name, file, kind, platform, caption = line.split("|", 4)
    assets.append({
        "name": name,
        "file": file,
        "kind": kind,
        "platform": platform,
        "caption": caption,
    })

assets.sort(key=lambda a: ORDER.index(a["file"]) if a["file"] in ORDER else len(ORDER))

with open(sys.argv[1], "w") as out:
    json.dump({"assets": assets}, out, indent=2, ensure_ascii=False)
    out.write("\n")
PY
}

# --------------------------------------------------------------------------- run

mkdir -p "$ASSETS"
carry_over

if [ "$WHICH" = all ] || [ "$WHICH" = ios ]; then
    capture_ios
fi
if [ "$WHICH" = all ] || [ "$WHICH" = macos ]; then
    capture_macos
fi

info "manifest"
write_manifest
COUNT=$(wc -l < "$LEDGER" | tr -d ' ')
note "$ASSETS/manifest.json — $COUNT asset(s)"

printf '\n'
if [ "$COUNT" -eq 0 ]; then
    printf '\033[31mnothing was captured\033[0m\n'
    exit 1
fi
if [ "$PROBLEMS" -gt 0 ]; then
    printf '\033[33mcaptured %s asset(s), %s problem(s) above\033[0m\n' "$COUNT" "$PROBLEMS"
    exit 0
fi
printf '\033[32mcaptured %s asset(s)\033[0m\n' "$COUNT"
