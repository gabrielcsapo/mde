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
cargo run --release --example workloads -p mde-core -- --check \
    | tee "$ROOT/target/performance/workloads.txt"
cargo run --release --example bench -p mde-core -- --dump "$ROOT/target/bench-corpus"

"$ROOT/scripts/build-web.sh" >/dev/null
rm -f "$ROOT/target/performance/web-metrics.json"
pnpm --dir "$ROOT/web" run test:performance 2>&1 \
    | tee "$ROOT/target/performance/web.txt"
if [ -s "$ROOT/target/performance/web-metrics.json" ]; then
    cat "$ROOT/target/performance/web-metrics.json" \
        | tee -a "$ROOT/target/performance/web.txt"
    echo | tee -a "$ROOT/target/performance/web.txt"
fi

"$ROOT/scripts/test-ios-performance.sh" 2>&1 \
    | tee "$ROOT/target/performance/ios.txt"

"$ROOT/scripts/build-rust.sh" >/dev/null
(
    cd "$ROOT/apple"
    swift package clean
    # Full-document TextKit workloads intentionally allocate heavily. XCTest otherwise
    # runs the whole class in one process, making later metrics price allocator pressure
    # from earlier corpora (a 1 ms plugin update has been observed as 22 seconds). Each
    # gate gets a fresh process so test order cannot manufacture a regression.
    for benchmark in \
        testBenchmarkColdLoad \
        testBenchmarkCoreOnlyGiantUnicodeParagraph \
        testBenchmarkGiantUnicodeParagraph \
        testBenchmarkKeystroke \
        testBenchmarkLargeTableProjection \
        testBenchmarkPluginLayerUpdate \
        testBenchmarkPositionAndTailLatency \
        testBenchmarkRepaintScopeAndDirtyRange \
        testBenchmarkResourceReferenceLookup
    do
        MDE_BENCH=1 MDE_BENCH_ENFORCE=1 swift test -c release \
            --filter "MacRendererBenchmarks/$benchmark"
    done
    MDE_BENCH=1 MDE_BENCH_ENFORCE=1 swift test -c release --filter MacMediaRendererBenchmarks
) 2>&1 | tee "$ROOT/target/performance/apple.txt"
