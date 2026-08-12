#!/bin/bash
# Opt-in multi-megabyte profile. Kept out of the routine gate because renderer cold
# loads intentionally allocate hundreds of megabytes and are best run on a nightly host.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
set -a
# shellcheck source=../benchmarks/budgets.env
source "$ROOT/benchmarks/budgets.env"
set +a
mkdir -p "$ROOT/target/performance"
cargo run --release --example bench -p mde-core -- --check --extended \
    | tee "$ROOT/target/performance/core-extended.txt"
"$ROOT/scripts/build-web.sh" >/dev/null
pnpm --dir "$ROOT/web" run test:performance:extended 2>&1 \
    | tee "$ROOT/target/performance/web-extended.txt"
pnpm --dir "$ROOT/web" run test:performance:lifecycle 2>&1 \
    | tee "$ROOT/target/performance/web-lifecycle.txt"
if [ "$(uname)" = "Darwin" ]; then
    "$ROOT/scripts/test-ios-performance-extended.sh" 2>&1 \
        | tee "$ROOT/target/performance/ios-extended.txt"
    "$ROOT/scripts/build-rust.sh" >/dev/null
    (
        cd "$ROOT/apple"
        MDE_BENCH=1 MDE_BENCH_MAX_BYTES=6000000 swift test -c release \
            --filter MacRendererBenchmarks/testBenchmarkKeystroke
        MDE_BENCH=1 MDE_BENCH_ENFORCE=1 MDE_BENCH_LIFECYCLE=1 swift test -c release \
            --filter MacRendererBenchmarks/testBenchmarkRepeatedLifecycle
    ) 2>&1 | tee "$ROOT/target/performance/apple-extended.txt"
fi
