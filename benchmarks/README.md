# Performance baselines

The release benchmark suite uses the same generated Markdown corpus in Rust and the
native renderer. `budgets.env` records the observed baseline and the enforced ceiling
for the costs most likely to regress:

- core edit latency at 100 KB, 1 MB, and 5 MB;
- localized core selection/reveal and one-span plugin-layer latency at 1 MB and 5 MB;
- the adversarial 32 KB Unicode single-paragraph edit;
- real-browser cold load, local edit, giant Unicode paragraph, typewriter, scroll, and DOM-size costs;
- end-to-end AppKit keystroke latency at 100 KB and 1 MB;
- end-to-end AppKit one-span plugin-layer latency at 1 MB;
- 1 MB AppKit cold load, viewport paint, and combined load-through-first-paint latency;
- a 100×10 native table projection; and
- indexed lookup among 10,000 resource references.

Run the same command as scheduled CI:

```sh
./scripts/test-performance.sh
```

Reports are written to `target/performance/`. The ceilings include hosted-runner
headroom; they are guards against material or algorithmic regressions, not claims that
every machine has identical latency.

`target/performance/workloads.txt` is the adversarial companion to the representative
core benchmark. It reports p50, p95, maximum latency, and maximum patch amplification
for edits near the start/middle/end, repeated identical nodes, a giant paragraph, an
unterminated fence, Unicode-heavy text, and a sustained 2,000-edit session. These are
The giant Unicode paragraph is also enforced as a regression gate; the other workloads
remain reports so optimizations can be compared against recorded baselines rather than
invented targets.

The currently committed before/after evidence, including experiments discarded because
they did not help, is in `RESULTS.md`.
