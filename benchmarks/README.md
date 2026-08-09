# Performance baselines

The release benchmark suite uses the same generated Markdown corpus in Rust and the
native renderer. `budgets.env` records the observed baseline and the enforced ceiling
for the costs most likely to regress:

- core edit latency at 100 KB, 1 MB, and 5 MB;
- end-to-end AppKit keystroke latency at 100 KB and 1 MB;
- a 100×10 native table projection; and
- indexed lookup among 10,000 resource references.

Run the same command as scheduled CI:

```sh
./scripts/test-performance.sh
```

Reports are written to `target/performance/`. The ceilings include hosted-runner
headroom; they are guards against material or algorithmic regressions, not claims that
every machine has identical latency.
