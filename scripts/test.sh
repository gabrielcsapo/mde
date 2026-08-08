#!/bin/bash
# Every suite, one command.
#
# The three layers are built with three different toolchains, and before this existed
# the web suite needed a human to open a page — which is exactly how it grew a test that
# passed when written and failed on re-run. Anything that is not in here will rot.
#
#   ./scripts/test.sh            everything
#   ./scripts/test.sh core       Rust only
#   ./scripts/test.sh apple      Swift only
#   ./scripts/test.sh web        web only
#
# Runs every suite even after one fails, then reports which failed — a single run should
# tell you everything that is broken, not just the first thing.
set -uo pipefail
cd "$(dirname "$0")/.."

WHICH="${1:-all}"
FAILED=()

section() {
    printf '\n\033[1m== %s\033[0m\n' "$1"
}

record() {
    if [ "$1" -ne 0 ]; then
        FAILED+=("$2")
    fi
}

if [ "$WHICH" = all ] || [ "$WHICH" = core ]; then
    section "rust"
    # Release: the bounds suite builds multi-megabyte documents and is minutes slower
    # unoptimised.
    cargo test --release
    record $? "rust tests"

    section "clippy"
    cargo clippy --all-targets -- -D warnings
    record $? "clippy"
fi

if [ "$WHICH" = all ] || [ "$WHICH" = apple ]; then
    section "apple ffi"
    ./scripts/build-rust.sh
    record $? "apple ffi build"

    section "swift"
    # SwiftPM does not notice when a binary-target archive changes in place. Cleaning
    # is required or the tests can silently keep exercising yesterday's Rust core.
    (cd apple && swift package clean && swift test)
    record $? "swift tests"

    section "uikit renderer (simulator)"
    ./scripts/test-ios-renderer.sh
    record $? "uikit renderer tests"
fi

if [ "$WHICH" = all ] || [ "$WHICH" = web ]; then
    section "web (headless chrome)"
    # The wasm the browser loads must be the wasm this tree builds.
    ./scripts/build-web.sh >/dev/null
    record $? "wasm build"
    node scripts/test-web.mjs
    record $? "web tests"
fi

printf '\n'
if [ ${#FAILED[@]} -eq 0 ]; then
    printf '\033[32mall suites passed\033[0m\n'
    exit 0
fi
printf '\033[31mfailed: %s\033[0m\n' "${FAILED[*]}"
exit 1
