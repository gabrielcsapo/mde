#!/bin/bash
# Release performance regression gates. Rust and AppKit consume the same corpus and
# the thresholds in benchmarks/budgets.env; their raw reports are retained for CI.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

set -a
# shellcheck source=../benchmarks/budgets.env
source "$ROOT/benchmarks/budgets.env"
set +a

mkdir -p "$ROOT/target/performance"
cargo run --release --example bench -p mde-core -- --check \
    | tee "$ROOT/target/performance/core.txt"
cargo run --release --example bench -p mde-core -- --dump "$ROOT/target/bench-corpus"

"$ROOT/scripts/build-rust.sh" >/dev/null
(
    cd "$ROOT/apple"
    swift package clean
    MDE_BENCH=1 MDE_BENCH_ENFORCE=1 swift test -c release --filter MacRendererBenchmarks
) 2>&1 | tee "$ROOT/target/performance/apple.txt"
