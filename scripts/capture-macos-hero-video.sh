#!/bin/bash
# Records the real AppKit editor typing the landing-page Markdown sequence.
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$PWD"
ASSETS="$ROOT/site/assets"
WORK="$(mktemp -d)"
APP="$ROOT/build/mac/MDEditor.app/Contents/MacOS/MDEditor"
RAW="$WORK/macos-native-editor.mov"
OUTPUT="$ASSETS/macos-native-editor.mp4"
POSTER="$ASSETS/macos-native-editor-poster.webp"
LOG="$WORK/app.log"
APP_PID=""

cleanup() {
    if [ -n "$APP_PID" ]; then kill "$APP_PID" >/dev/null 2>&1 || true; fi
    rm -rf "$WORK"
}
trap cleanup EXIT

"$ROOT/scripts/build-macos-app.sh" >/dev/null
"$APP" -ApplePersistenceIgnoreState YES --mde-capture hero-video >"$LOG" 2>&1 &
APP_PID=$!

for _ in $(seq 1 75); do
    grep -q MDE_WINDOW_RECT "$LOG" 2>/dev/null && break
    /bin/sleep 0.2
done
RECT=$(awk '/MDE_WINDOW_RECT/{print $2; exit}' "$LOG")
if [ -z "$RECT" ]; then
    echo "macOS app did not report its capture frame" >&2
    exit 1
fi

# Borderless windows occasionally make `screencapture` stop a little before its
# requested wall time. Record with headroom, then trim the encoded asset precisely.
screencapture -x -v -V20 -R"$RECT" "$RAW" >"$WORK/record.log" 2>&1
[ -s "$RAW" ] || {
    echo "macOS recording is empty; allow Screen Recording for Codex and try again" >&2
    exit 1
}

kill "$APP_PID" >/dev/null 2>&1 || true
wait "$APP_PID" 2>/dev/null || true
APP_PID=""

ffmpeg -nostdin -loglevel error -y -i "$RAW" \
    -t 14 -vf "scale=-2:1080:flags=lanczos,fps=30" \
    -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -an "$OUTPUT"
ffmpeg -nostdin -loglevel error -y -ss 11.5 -i "$OUTPUT" -frames:v 1 \
    -c:v libwebp -quality 90 "$POSTER"
[ -s "$POSTER" ] || { echo "macOS poster is empty" >&2; exit 1; }

echo "wrote $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
echo "wrote $POSTER ($(du -h "$POSTER" | cut -f1))"
