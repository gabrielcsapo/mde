# One document. Four renderers.

CommonMark stays editable: **bold**, *emphasis*, `code`, [links](https://example.dev), and ~~strikethrough~~.

> The same Rust core decorates every platform.

- [x] CommonMark and GFM
- [x] Host-defined custom syntax

| Surface | Nested content | Proof |
| :--- | :---: | ---: |
| **JS** | [Web](https://example.dev/web) + `wasm` | ![chart](chart.png) |
| **React** | *Same editor*, component adapter | `DOM` + ![chart](chart.png) |
| **iOS** | **UIKit** + [TextKit 2](https://developer.apple.com) | ![photo](photo.png) |
| **macOS** | ~~forked~~ **AppKit** | `FFI` |

Ping @gabe about [[the cross-platform roadmap]].

```callout info
Custom syntax is rendered by each host without forking the parser.
```
