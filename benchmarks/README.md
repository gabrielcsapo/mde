# Performance baselines

The release benchmark suite uses the same generated Markdown corpus in Rust and the
native renderer. `budgets.env` records the observed baseline and the enforced ceiling
for the costs most likely to regress:

- core edit latency at 100 KB, 1 MB, and 5 MB;
- localized core selection/reveal and one-span plugin-layer latency at 1 MB and 5 MB;
- the adversarial 64 KB Unicode no-newline/single-paragraph edit;
- real-browser cold load, positional and sustained edit p95, giant Unicode paragraph,
  typewriter, scroll, virtualized DOM size, JS heap, warm-session switching, React
  warm-core mount, and controlled acknowledgement costs;
- a 320-resource journal with 240 images, 32 videos, and 48 audio attachments in Chromium;
- UIKit 1 MB load/first-paint/edit p95, giant paragraph, 100×10 table, and the same
  320-resource journal in the iPhone simulator;
- end-to-end AppKit keystroke latency at 100 KB and 1 MB;
- end-to-end AppKit one-span plugin-layer latency at 1 MB;
- 1 MB AppKit cold load, viewport paint, and combined load-through-first-paint latency;
- a 100×10 native table projection;
- AppKit positional and sustained edit p95;
- AppKit projection, edit, and scroll costs for the same media-heavy journal; and
- indexed lookup among 10,000 resource references; and
- repeated open/edit/scroll/close lifecycle latency, frame-gap, retained-node, and
  process/heap-growth gates; and
- one shared edit matrix across Rust, JS, React, UIKit, and AppKit: 10 KB, 100 KB,
  500 KB, and 1 MB documents; start/middle/end positions; character insert/delete,
  32-character replacement, emoji/CJK/combining-text commits, structural newline,
  1 KB paste/delete, 8 KB dictation and multiline paste, and a 100-edit
  endurance session. Every host asserts the exact resulting Markdown.
  Browser heap and Apple process-footprint growth are bounded across the run.

Run the same command as scheduled CI:

```sh
./scripts/test-performance.sh
```

Run the opt-in 5 MB Rust, browser, AppKit, iOS Swift/core bridge, and repeated lifecycle
profiles with:

```sh
./scripts/test-performance-extended.sh
```

The iOS leg measures the complete Swift-to-Rust bridge at 5 MB. UIKit first paint stays
covered by the routine enforced 1 MB renderer gate: even a sparse 2 MB full layout can
exceed three minutes in the simulator, so expanding that renderer ceiling remains an
explicit TextKit scalability project rather than a silently relaxed budget.

Reports are written to `target/performance/`. The ceilings include hosted-runner
headroom; they are guards against material or algorithmic regressions, not claims that
every machine has identical latency.

`target/performance/workloads.txt` is the adversarial companion to the representative
core benchmark. It reports p50, p95, maximum latency, and maximum patch amplification
for edits near the start/middle/end, repeated identical nodes, a giant paragraph, an
unterminated fence, Unicode-heavy text, and a sustained 2,000-edit session. The giant
Unicode paragraph is enforced as a core regression gate. Browser and native positional
and sustained p95 values are also enforced by their renderer suites.

`edit-matrix.json` is the cross-client contract. Rust generates the corpus once into
`target/bench-corpus`; browser tests receive those files from the Vitest server, AppKit
reads them directly, and the iOS build embeds the same bytes. React measures controlled
`value` updates separately from the framework-free JS editor. The 5 MB corpus remains an
extended load workload. Browser chunks are source-preserving and virtualized; Apple
retains complete storage with viewport painting. Both therefore measure the shipping
cold-open policy instead of an artificial full presentation tree.

AppKit workloads run in separate test processes. Full-document TextKit measurements
create substantial transient allocator pressure; process isolation prevents one corpus
from changing the timing of the next and makes the gates independent of test order.

The currently committed before/after evidence, including experiments discarded because
they did not help, is in `RESULTS.md`.
