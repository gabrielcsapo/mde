#!/bin/bash
# Builds and installs the reference app on a booted simulator.
#
# There is no Xcode project on purpose: SwiftPM cannot emit an iOS .app bundle, and a
# hand-maintained .pbxproj is worse than assembling the bundle ourselves. swiftc does
# the compile, and the bundle is four files.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

APP_NAME="MDEditor"
BUNDLE_ID="dev.mde.editor"
TARGET="arm64-apple-ios17.0-simulator"
RUST_TARGET="aarch64-apple-ios-sim"
BUILD="$ROOT/build"
APP="$BUILD/$APP_NAME.app"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"

echo "==> rust ($RUST_TARGET)"
cargo build --release -p mde-ffi --target "$RUST_TARGET" 2>&1 | tail -1

echo "==> swift"
rm -rf "$APP" "$BUILD/modules" "$BUILD/obj"
mkdir -p "$APP" "$BUILD/modules" "$BUILD/obj"
MODULES="$BUILD/modules"
OBJ="$BUILD/obj"
INCLUDE="$ROOT/apple/include"

# One real module per source directory, mirroring Package.swift — compiling them into
# a single module instead would make the `import MDECore` lines in the UI layer
# meaningless and let layering violations through unnoticed.
build_module() {
    local name=$1
    shift
    xcrun -sdk iphonesimulator swiftc \
        -target "$TARGET" -sdk "$SDK" -O -wmo \
        -parse-as-library \
        -module-name "$name" \
        -emit-module -emit-module-path "$MODULES/$name.swiftmodule" \
        -c -o "$OBJ/$name.o" \
        -I "$MODULES" \
        -Xcc -fmodule-map-file="$INCLUDE/module.modulemap" -Xcc -I"$INCLUDE" \
        "$@"
}

build_module MDECore     "$ROOT"/apple/Sources/MDECore/*.swift
build_module MDEditorUI  "$ROOT"/apple/Sources/MDEditorUI/*.swift
build_module MDEHost     "$ROOT"/apple/Sources/MDEHost/*.swift
build_module MDEApp      "$ROOT"/apple/Sources/MDEApp/*.swift

xcrun -sdk iphonesimulator swiftc \
    -target "$TARGET" -sdk "$SDK" \
    -L "$ROOT/target/$RUST_TARGET/release" -lmde \
    -o "$APP/$APP_NAME" \
    "$OBJ"/MDECore.o "$OBJ"/MDEditorUI.o "$OBJ"/MDEHost.o "$OBJ"/MDEApp.o

cat > "$APP/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key><string>en</string>
    <key>CFBundleExecutable</key><string>$APP_NAME</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSRequiresIPhoneOS</key><true/>
    <key>MinimumOSVersion</key><string>17.0</string>
    <key>UILaunchScreen</key><dict/>
    <key>UIRequiredDeviceCapabilities</key><array><string>arm64</string></array>
    <!-- Without UIDeviceFamily and CFBundleSupportedPlatforms, simctl cannot classify
         the bundle and rejects it with a misleading "missing WKWatchKitApp" error. -->
    <key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
    <key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
    <key>DTPlatformName</key><string>iphonesimulator</string>
    <key>UISupportedInterfaceOrientations</key>
    <array>
        <string>UIInterfaceOrientationPortrait</string>
        <string>UIInterfaceOrientationLandscapeLeft</string>
        <string>UIInterfaceOrientationLandscapeRight</string>
    </array>
</dict>
</plist>
PLIST

echo "==> install"
# `booted` is ambiguous when a watch or TV simulator is also running, and picking the
# wrong one fails with a confusing device-family error. Resolve an iPhone explicitly.
#
# Set MDE_DEVICE=<udid> to target a specific simulator — worth doing if you use one of
# them yourself, since installing and launching brings the app to the front.
if [ -n "${MDE_DEVICE:-}" ]; then
    DEVICE="$MDE_DEVICE"
else
    DEVICE=$(xcrun simctl list devices booted -j \
        | python3 -c 'import json,sys
d=json.load(sys.stdin)["devices"]
for runtime, devices in d.items():
    if "iOS" not in runtime: continue
    for dev in devices:
        if dev.get("state") == "Booted" and "iPhone" in dev["name"]:
            print(dev["udid"]); raise SystemExit')
    if [ -z "$DEVICE" ]; then
        echo "no booted iPhone simulator; boot one or set MDE_DEVICE=<udid>" >&2
        exit 1
    fi
fi
echo "    device $DEVICE"
xcrun simctl install "$DEVICE" "$APP"
xcrun simctl terminate "$DEVICE" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl launch "$DEVICE" "$BUNDLE_ID"
