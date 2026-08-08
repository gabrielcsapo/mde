#!/bin/bash
# Builds and launches the macOS reference app.
#
# Same approach as the iOS script: real modules via swiftc, bundle assembled by hand.
# SwiftPM cannot emit a .app, and a hand-maintained .pbxproj is worse.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

APP_NAME="MDEditor"
BUNDLE_ID="dev.mde.editor.mac"
TARGET="arm64-apple-macos14.0"
RUST_TARGET="aarch64-apple-darwin"
BUILD="$ROOT/build/mac"
APP="$BUILD/$APP_NAME.app"
SDK="$(xcrun --sdk macosx --show-sdk-path)"

echo "==> rust ($RUST_TARGET)"
cargo build --release -p mde-ffi --target "$RUST_TARGET" 2>&1 | tail -1

echo "==> swift"
rm -rf "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$BUILD/modules" "$BUILD/obj"
cp "$ROOT/fixtures/cross-platform.md" "$APP/Contents/Resources/cross-platform.md"
MODULES="$BUILD/modules"
OBJ="$BUILD/obj"
INCLUDE="$ROOT/apple/include"

build_module() {
    local name=$1
    local library=$2
    shift 2
    local extra=()
    [ "$library" = "library" ] && extra+=(-parse-as-library)
    xcrun -sdk macosx swiftc \
        -target "$TARGET" -sdk "$SDK" -O -wmo \
        ${extra[@]+"${extra[@]}"} \
        -module-name "$name" \
        -emit-module -emit-module-path "$MODULES/$name.swiftmodule" \
        -c -o "$OBJ/$name.o" \
        -I "$MODULES" \
        -Xcc -fmodule-map-file="$INCLUDE/module.modulemap" -Xcc -I"$INCLUDE" \
        "$@"
}

build_module MDECore    library "$ROOT"/apple/Sources/MDECore/*.swift
build_module MDEditorUI library "$ROOT"/apple/Sources/MDEditorUI/*.swift
build_module MDEHost    library "$ROOT"/apple/Sources/MDEHost/*.swift
# The app module carries main.swift, so it must NOT be parse-as-library.
build_module MDEAppMac  executable "$ROOT"/apple/Sources/MDEAppMac/*.swift

xcrun -sdk macosx swiftc \
    -target "$TARGET" -sdk "$SDK" \
    -L "$ROOT/target/$RUST_TARGET/release" -lmde \
    -o "$APP/Contents/MacOS/$APP_NAME" \
    "$OBJ"/MDECore.o "$OBJ"/MDEditorUI.o "$OBJ"/MDEHost.o "$OBJ"/MDEAppMac.o

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>$APP_NAME</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

echo "==> $APP"
