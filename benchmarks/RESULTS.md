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
| Browser 100 KB edit | 21.1 ms | 0.7 ms | 30× faster |
| Browser 1 MB edit near end | 192.3 ms p50 | 6.9 ms p50 | 28× faster |
| Browser 1 MB edit near start | 349.7 ms p50 | 10.0 ms p50 | 35× faster |
| Browser sustained 100 KB edits | 19.1 ms p50 | 0.9 ms p50 | 21× faster |
| Browser one-span plugin update, 1 MB | 40.7 ms | 2.5 ms | 16× faster |
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
patch path described above remains. The giant single-paragraph case is also a hard edge:
its core edit is about 163 ms and its browser edit about 491 ms because a safe reparse
and one enormous line rebuild are both necessarily broad. It is tracked by the
adversarial report rather than hidden inside an average.
