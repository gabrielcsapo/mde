# Performance results — 2026-08-10

Measured on the same Apple-silicon development machine with release builds. Browser
numbers are real headless Chromium runs; native numbers are release AppKit tests. The
budgets leave runner headroom, while these values are the observed baselines.

| Workload | Before | After | Change |
| --- | ---: | ---: | ---: |
| Core representative 100 KB edit | 2.40 ms | 0.071 ms | 34× faster |
| Core representative 1 MB edit | 22.84 ms | 0.342 ms | 67× faster |
| Core representative 5 MB edit | 128.51 ms | 1.907 ms | 67× faster |
| Core adversarial 1 MB edit near start | 38.33 ms p50 | 1.25 ms p50 | 31× faster |
| Core adversarial 1 MB edit in middle | 34.08 ms p50 | 1.08 ms p50 | 32× faster |
| Core sustained 100 KB edits | 3.26 ms p50 | 0.132 ms p50 | 25× faster |
| Core one-span plugin update, 100 KB | 1.532 ms | 0.0006 ms | 2,500× faster |
| Core one-span plugin update, 1 MB | 13.888 ms | 0.0014 ms | 9,700× faster |
| Core one-span plugin update, 5 MB | 99.622 ms | 0.0050 ms | 19,700× faster |
| Core 32 KB Unicode single-paragraph edit | 163 ms | 3.3 ms | 49× faster |
| Browser 100 KB edit | 21.1 ms | 0.7 ms | 30× faster |
| Browser 1 MB edit near end | 192.3 ms p50 | 6.9 ms p50 | 28× faster |
| Browser 1 MB edit near start | 349.7 ms p50 | 10.0 ms p50 | 35× faster |
| Browser sustained 100 KB edits | 19.1 ms p50 | 0.9 ms p50 | 21× faster |
| Browser one-span plugin update, 1 MB | 40.7 ms | 2.5 ms | 16× faster |
| Browser 32 KB Unicode single-paragraph edit | 491 ms | 49.8 ms | 9.9× faster |
| Browser 1 MB DOM elements | 206,332 | 137,734 | 33% fewer |
| Native 1 MB `setMarkdown` | 577.68 ms | 59.79 ms | 9.7× faster |
| Native load through painted first viewport | 590.15 ms | 183.19 ms | 3.2× faster |
| Native positional 1 MB edit | 30–32 ms p50 | 17.65–18.49 ms p50 | 1.6–1.8× faster |
| Native sustained 100 KB edits | 4.39 ms p50 | 1.88 ms p50 | 2.3× faster |
| Native one-span plugin update, 1 MB | 10.20 ms | 3.06 ms | 3.3× faster |

The core now preserves temporal decoration identity inside the reparsed region, emits a
regional patch plus one compact suffix shift, updates payload ownership locally, and
uses a selection interval index. The browser stopped walking every text node merely to
restore a caret and avoids wrapper elements for unstyled source. Apple paints large
documents by TextKit viewport with overscan and decodes disk images to their display
pixel budget; the 640 px fixture becomes at most 200 px when displayed at 100 points on
a 2× screen.

Host layers now re-emit and diff only their own suffix instead of every parsed
decoration. The browser also maintains its sorted decoration index incrementally for
tiny, position-stable plugin patches; bulk layers and text edits keep the lazy rebuild
path. AppKit uses the same bounded incremental-index rule, cutting its full layer update
from 10.20 ms to 3.06 ms. Together these make a cursor-style plugin update scale with
the plugin’s one span rather than the document’s 49,000 parsed decorations.

Two attempted optimizations were removed after isolation runs. Incrementally merging
the renderer index for general text edits did not improve Chromium and slowed native
sustained edits from about 3.0 ms to 5.5 ms. Only the bounded, position-stable plugin
patch path described above remains. Giant Unicode paragraphs exposed a different
quadratic edge: each decoration endpoint rescanned from the beginning of the line while
converting UTF-8 parser offsets to UTF-16 host offsets. Long non-ASCII lines now batch
those conversions into one ordered pass, cutting the 32 KB core edit from about 163 ms
to 3.3 ms. The renderer still has to rebuild one enormous visual line, so the browser
case remains separately tracked rather than hidden inside an average.

## UIKit and media hardening — 2026-08-11

The iPhone simulator now runs enforced release workloads instead of relying on AppKit
as a native proxy. Moving UIKit from TextKit 2's paragraph-granular invalidation to the
same incremental TextKit 1 strategy as AppKit reduced the 32 KB pathological edit from
about 12.3 seconds to 80 ms p95. A 100×10 native table fell from 6–8 seconds to about
110 ms after wide tables gained readable minimum column widths, horizontal scrolling,
lightweight linked labels, and a fast plain-cell sizing path.

The media journal now resolves 240 images, 32 videos, and 48 audio views (320 total) on
both Apple hosts. Representative release runs measured roughly 278 ms on UIKit and
502 ms on AppKit to fully project every resource, while subsequent local edits stayed
near 20 ms and 3 ms respectively. Chromium projects the same 320 resources in roughly
48 ms and keeps the resulting edit near 10 ms. React's warm-core 100 KB mount is now
separately gated at about 40–47 ms, and
the browser suite enforces positional p95, sustained p95, and heap usage as well as its
existing median, DOM, and scroll budgets.

## Shared cross-client edit matrix — 2026-08-12

The same Rust-generated 10 KB, 100 KB, 500 KB, and 1 MB documents now run through six
edit shapes at the start, middle, and end of every client. Each case is repeated three
times and followed by a 100-operation alternating insert/delete session. The gate checks
the exact final Markdown as well as latency, so a fast dropped or mis-addressed edit
cannot pass.

| Client | Mixed edit matrix p95 | 100-edit endurance p95 |
| --- | ---: | ---: |
| Rust core | 3.36 ms | 0.05 ms |
| JS / Chromium | 20.6 ms | 0.5 ms |
| React controlled `value` update | 40.6 ms | covered by the JS editor below the adapter |
| AppKit | 23.5 ms | 2.7 ms |
| UIKit / iPhone simulator | 25.9 ms | 2.2 ms |

These are regression baselines, not cross-device product claims. The matrix intentionally
resets each edit case outside the timed interval, while the endurance workload keeps one
live document and exposes cumulative-state regressions.
The same run measured no retained Chromium heap growth, about 19 MiB of iOS footprint
growth, and about 134 MiB on AppKit after cycling four full layout trees; explicit
ceilings now catch unbounded retention alongside latency regressions.

## Rendering and lifecycle pass — 2026-08-12

Seven additional host-level phases were measured and gated:

| Workload | Previous | Current |
| --- | ---: | ---: |
| Browser 1 MB cold load | 218 ms | 114 ms |
| Browser 1 MB DOM elements | 137,734 | 1,057 |
| Browser mixed edit matrix p95 | 51.1 ms | 8.4 ms |
| Browser 64 KB no-newline edit | 78 ms | 7 ms |
| Browser 5 MB edit | 65 ms | 38 ms |
| Browser 5 MB DOM elements | 821,332 | 4,640 |
| AppKit 1 MB edit | 18.7 ms | 8.0 ms |
| AppKit 5 MB edit | 82.0 ms | 29.6 ms |
| React local controlled acknowledgement p95 | implicit in replay | 0.1 ms |
| Warm 100 KB document switch p95 | cold-only | 10–12 ms |
| AppKit warm 100 KB document switch p95 | cold-only | 52 ms |

Resource work is now concurrency-bounded and viewport-prioritized on web and Apple,
with cancellation at the cache and disk-operation layers. Bounded warm projections
speed recent document switching without retaining resource tasks or claiming that one
engine's undo history can be transferred to another document. Both browser and AppKit
warm switching now have latency, active-projection size, and memory-growth gates.

The new 30-cycle lifecycle gate measured 61 ms maximum browser open/edit/scroll work,
67 ms maximum browser frame gap, zero retained editor nodes and no reported heap growth.
The release AppKit loop measured 202 ms maximum work and about 107 MiB resident-memory
growth, below its 256 MiB ceiling. These are energy proxies rather than direct battery
measurements: bounded main-thread stalls, decode concurrency, retained views, and
allocation growth are the controllable costs the library can enforce in CI.
