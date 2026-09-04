#!/bin/bash
# Rebuilds both Apple reference apps and refreshes every native hero asset.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$PWD"
ASSETS="$ROOT/site/assets"

for command in xcrun ffmpeg ffprobe node; do
    command -v "$command" >/dev/null 2>&1 || {
        echo "missing required command: $command" >&2
        exit 1
    }
done

echo "==> iPhone · UIKit + TextKit"
"$ROOT/scripts/capture-hero-video.sh"

echo "==> Mac · AppKit + TextKit"
"$ROOT/scripts/capture-macos-hero-video.sh"

validate_video() {
    local file=$1 minimum_width=$2 minimum_height=$3 label=$4
    local dimensions width height codec duration seconds
    [ -s "$file" ] || { echo "$label video is missing: $file" >&2; exit 1; }
    dimensions=$(ffprobe -v error -select_streams v:0 \
        -show_entries stream=width,height -of csv=p=0:s=x "$file")
    codec=$(ffprobe -v error -select_streams v:0 \
        -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "$file")
    duration=$(ffprobe -v error -show_entries format=duration \
        -of default=noprint_wrappers=1:nokey=1 "$file")
    seconds=${duration%%.*}
    IFS=x read -r width height <<<"$dimensions"
    [ "$width" -ge "$minimum_width" ] && [ "$height" -ge "$minimum_height" ] || {
        echo "$label video is $dimensions; expected at least ${minimum_width}x${minimum_height}" >&2
        exit 1
    }
    [ "$codec" = "h264" ] || { echo "$label video uses $codec; expected h264" >&2; exit 1; }
    [ "$seconds" -ge 13 ] && [ "$seconds" -le 15 ] || {
        echo "$label video is ${duration}s; expected about 14s" >&2
        exit 1
    }
    echo "    verified $dimensions · $codec · ${duration}s"
}

validate_video "$ASSETS/ios-native-editor.mp4" 1080 1080 "iPhone"
validate_video "$ASSETS/macos-native-editor.mp4" 1080 1080 "Mac"

for poster in ios-native-editor-poster.webp macos-native-editor-poster.webp; do
    [ -s "$ASSETS/$poster" ] || { echo "poster is missing: $ASSETS/$poster" >&2; exit 1; }
done

echo "==> self-contained report"
node "$ROOT/scripts/build-before-after-report.mjs"

echo "Native hero assets are current."
echo "Run again with: pnpm capture:native-hero"
