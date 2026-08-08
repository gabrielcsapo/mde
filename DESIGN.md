# Markdown Editor — Design

A drop-in markdown editor for iOS, macOS, and web. The document is always a plain
markdown string. There is no rich document model, no serializer, and no lossy
round-trip. The editor is a **text editor with a decoration layer**.

Status: core complete with undo and resource references. All three renderers — iOS,
macOS, web — running against it, each with a reference app.

---

## 1. Principles

1. **The text is the truth.** Every feature is expressible as decorations over a
   markdown string. If a feature requires a side model, it is out of scope.
2. **One brain, three faces.** Parsing, extension semantics, reveal policy, and
   widget identity are decided once, in Rust. Renderers apply, they do not decide.
3. **The system text engine owns input.** Native IME, autocorrect, spellcheck,
   selection handles, and accessibility come from TextKit 2 / the browser. We never
   reimplement a caret.
4. **Correctness first, incrementality later.** Nothing may depend on incremental
   parsing for correctness. It is a profiling-driven optimization behind a fixed
   interface.
5. **Files stay portable.** Every construct degrades to something a stock CommonMark
   renderer displays harmlessly.

---

## 2. Architecture

```
                          keystroke / paste / IME commit
                                       │
                    ┌──────────────────▼──────────────────┐
                    │  PLATFORM INPUT (owns the buffer)   │
                    │  UITextView / NSTextView / CE div   │
                    └──────────────────┬──────────────────┘
                                       │  Edit { range, text }
                                       │  Selection { anchor, head }
                    ┌──────────────────▼──────────────────┐
                    │            RUST CORE                │
                    │  rope mirror → parse → decorate      │
                    │            → key → diff              │
                    └──────────────────┬──────────────────┘
                                       │  Patch { removed[], added[], moved[] }
                    ┌──────────────────▼──────────────────┐
                    │            RENDERER                 │
                    │  TextKit 2 attrs + attachments      │
                    │  DOM attrs + replaced elements      │
                    └─────────────────────────────────────┘
```

The core never mutates text. It is a pure function of `(edit stream, selection,
registry)`. This makes it replayable: any bug reduces to a recorded edit log plus a
registry, which is also the golden-test format.

### 2.1 Why the platform owns the buffer

`NSTextStorage` and the browser's DOM both insist on owning their text. Fighting that
is how editors lose native IME, autocorrect, and selection handles — the exact things
that make webview editors feel wrong on iOS. The core keeps a *mirror* rope updated
from the same edit deltas the platform already applied.

Mirror drift is the one catastrophic failure mode. Mitigation: every edit carries the
resulting document length, and the core asserts agreement. On mismatch it requests a
full resync rather than emitting wrong decorations.

### 2.2 Why full reparse per keystroke

Markdown is aggressively non-local. One ``` fence, one list marker, or one link
reference definition can restructure every block below it. Incremental parsers for
markdown are a well-known tarpit.

They are also cheap — but **not for the reason originally written here.** The first
version of this section argued that parsing is ~0.1 ms per 100 KB and that the real
cost is renderer mutation. Measurement said the first half is right and the second half
is backwards:

| at 100 KB, per keystroke | ms | share |
|---|---|---|
| parse | 0.14 | 1% |
| decoration build | 5.8 | 41% |
| FFI + patch marshalling | 2.6 | 18% |
| emit (reveal + UTF-16) | 1.3 | 9% |
| diff | 0.35 | 2% |
| **attribute application in the renderer** | **0.03** | **0.2%** |

Renderer mutation is the cheapest thing in the loop, by two orders of magnitude. The
argument silently equated *parsing* with *reparse + decorate + key + diff + emit +
marshal*, which is 63× larger.

So the design now does three things instead of one, and only the first is what §2.2
originally described:

**1. Reparse only the region an edit could have changed.** `region.rs` finds offsets
where a top-level block provably begins — after a blank line, at column zero, outside
any fence or directive — and `Engine::edit` rebuilds only between the boundaries
enclosing the edit, splicing the result into the existing list in place. Anything the
scan cannot vouch for (an unterminated fence, a link reference definition, a multi-range
edit) falls back to a full reparse. That fallback is not an embarrassment; it is what
makes the optimization safe to have.

Keys are then reassigned over the whole list in document order, which is what makes an
incremental result *byte-identical* to a full reparse rather than merely similar.
`tests/incremental.rs` checks exactly that, over every insert and delete position in a
hostile document, every structural character, and 2000 random edits.

**2. A prefilter before every inline rule.** `regex-lite` has no literal prescan, so
`@[a-zA-Z0-9_-]+` walked every byte of every text run looking for an `@` that was not
there — 3.5 ms on 100 KB of prose with zero matches, 26× the parse itself. One
`memchr`-shaped check first.

**3. A hash built for 64-bit keys.** Decoration keys are already well-mixed hashes, so
running them through SipHash again was pure overhead. `fasthash.rs` is a multiply-xorshift
that costs a few instructions; it cut diffing by ~36% at 1 MB.

Measured, per keystroke, on an M2:

| document | before | after |
|---|---|---|
| 10 KB | 1.3 ms | **0.21 ms** |
| 100 KB | 18.0 ms | **1.99 ms** |
| 500 KB | ~52 ms | **10.3 ms** |
| 1 MB | 137 ms | **22.9 ms** |
| 5 MB | ~3 460 ms | **132 ms** |

500 KB now fits inside a 60 fps frame at the core level, against ~120 KB before.

**What was removed.** An earlier version also limited decoration to a window around the
viewport above 256 KB. Measurement killed it. Because it could not compose with the
incremental splice, turning it on *disabled* the optimization that was actually doing
the work — 13.2 ms against 17.3 ms at 500 KB, 28.2 against 42.0 at 1 MB, 141 against 151
at 5 MB, every one of them worse. It could not help the case it was designed for either:
`set_viewport` necessarily arrives *after* `reset`, so the cold open it was meant to
bound had already happened. It is recorded here because "obvious safety valve, measured,
found to be a pessimisation" is worth more than the code was.

---

## 3. The decoration protocol

A decoration is a range plus one closed-set primitive plus an open-set role.

| primitive | meaning | renderer contract |
|---|---|---|
| `Style` | text attributes | apply the theme's attribute set for `role` |
| `Conceal` | hide syntax | zero-width the range; must not be selectable as text |
| `InlineWidget` | replaced element in a line | participates in line layout, atomic |
| `BlockWidget` | replaced element owning lines | full-width, atomic, own line box |
| `Gutter` | decoration outside the text run | leading margin content, does not shift text |
| `Hit` | tappable region | no layout effect, gesture target only |

Primitives are closed so all three renderers implement a finite contract. Roles are
open strings (`heading.1`, `emphasis.strong`, `mention`) so themes and extensions
extend without protocol changes.

```rust
struct Decoration {
    start: u32,      // UTF-16 code units, see §3.2
    end:   u32,
    kind:  Kind,     // the table above
    role:  RoleId,   // interned
    reveal: Reveal,
    depth: u8,       // role-specific: quote/list nesting, or heading level
    key:   u64,      // stable identity, see §3.3
}
```

### 3.1 Reveal policy

The "show me the `**` while I'm editing this word" behavior lives in the core, not in
renderer code, so it is identical on every platform and tunable per extension.

| `Reveal` | concealed range reopens when |
|---|---|
| `Never` | never (pure decoration) |
| `CaretInNode` | selection intersects the decorated node |
| `CaretInLine` | selection touches any line the node occupies |
| `CaretInBlock` | selection is anywhere in the enclosing block |

Intersection is inclusive at both endpoints: a caret resting immediately before or
after a node reveals it, which is what makes arrowing into `**bold**` feel continuous
rather than stepping through an invisible gap.

Revealing does not delete the decoration — it collapses the hiding primitive
(`Conceal`, `InlineWidget`, `BlockWidget`) to `Style` while keeping the same key and
role, so the theme still dims the markers and the renderer sees one coherent identity
across the transition.

Consequence: **a selection change produces a decoration patch.** `set_selection` is a
first-class core entry point, not a renderer concern.

**Unfocused is a distinct state, not a caret at 0.** The core's selection is
`Option<Selection>`, and renderers pass `None` on blur. Without it, a freshly opened
document has an implicit caret at offset 0 that reveals the first heading's `#` before
the user has touched anything. A resync (`reset`) preserves focus; only an explicit
blur clears it.

### 3.2 Offset encoding

The core stores UTF-8 and works in byte offsets internally. Both consumers want UTF-16
code units — `NSTextStorage` is UTF-16, and JavaScript strings are UTF-16. Converting
in each renderer would mean two chances to get emoji and CJK wrong.

**All offsets crossing the FFI boundary are UTF-16 code units.** Conversion happens
once, in the core, on the way out.

### 3.3 Widget identity

If a widget's key changes, the renderer tears it down and rebuilds it. An image that
reloads on every keystroke elsewhere in the document is a bug, and a naive
index-based key causes exactly that — inserting a line at the top shifts every index.

```
key = hash(role, source_slice_of_node, disambiguator_among_identical_siblings)
```

Position is deliberately excluded. Typing far away leaves the key untouched, so the
widget survives as a moved-not-rebuilt entry in the patch. Typing *inside* the node's
source changes the key, which correctly rebuilds it.

### 3.4 Patch

```rust
struct Patch {
    removed: Vec<u64>,          // keys
    added:   Vec<Decoration>,
    moved:   Vec<(u64, u32, u32)>,  // key, new start, new end — no rebuild
}
```

---

## 4. Widget and caret semantics

Widgets are atomic. This is the specification all three renderers implement
identically; divergence here is the highest-risk failure mode in the project.

| interaction | required behavior |
|---|---|
| arrow key into a widget | select the widget as a unit; do not enter it |
| arrow again | step past it to the adjacent text position |
| typing while selected | replace the widget's entire source range |
| `Backspace` while selected | delete the source range |
| `Backspace` at the position just after | select the widget; a second press deletes |
| `Enter` while a block widget is selected | insert an empty line after it |
| `Escape` inside a revealed node | collapse to decorated form, caret after the node |
| drag-select across a widget | include its whole source range; never partial |
| find/replace | operates on source text; matches inside widgets reveal them |
| tap on a widget | place the caret in its source, which reveals it for editing |
| tap on a widget that declares itself interactive | the host's view handles it; the host must offer a way back to the source |
| tap on a `Hit` range | deliver to the host's handler, do not move the caret |

A widget's view must not take taps unless its host opts in. This was originally
specified the other way round — "deliver to the `Hit` handler, do not move the caret" —
and it made every widget uneditable: the view swallowed the tap before the text engine
saw it, the caret could never land in the source, so the reveal policy never fired.
A callout, an image, and a mention chip were all dead to the touch. The default has to
be that taps fall through, or the editor's central promise — put the caret in any node
and its syntax comes back — is simply false for widgets.

Concealed ranges are never independently selectable: a selection endpoint landing
inside a concealed range snaps outward to the node boundary. Otherwise the user gets
an invisible caret.

---

## 5. Extensions

Day-one capabilities are custom **block types** and custom **inline tokens**. Both are
declarative data, not code. No extension code runs inside the parser — that is what
keeps the hot path fast, keeps it identical across platforms, and keeps it safe.

(Wasm plugins were considered and rejected: iOS forbids JIT, so it would mean shipping
an interpreter into the per-keystroke path to buy flexibility neither day-one
capability needs.)

```toml
[[block]]
name   = "callout"
syntax = { kind = "fence", info = "callout" }   # ```callout
render = "block_widget"
reveal = "caret_in_block"

[[block]]
name   = "chart"
syntax = { kind = "directive", marker = ":::", name = "chart" }
render = "block_widget"
reveal = "caret_in_block"

[[inline]]
name   = "mention"
syntax = { kind = "pattern", regex = "@[a-zA-Z0-9_-]+" }
render = "inline_widget"
reveal = "caret_in_node"

[[inline]]
name   = "wikilink"
syntax = { kind = "delimited", open = "[[", close = "]]" }
render = "style"
reveal = "caret_in_node"
```

The host ships this manifest plus one widget renderer per platform (DOM on web,
`UIView`/`NSView` on Apple). The core resolves syntax, ranges, capture groups, reveal
state, and identity; the host only draws.

### 5.1 References, not content

A decoration can carry a **payload**: extra text the parser already resolved, which a
renderer would otherwise have to re-derive by re-parsing markdown in three languages.

| construct | payload |
|---|---|
| `![alt](assets/q3.png)` | `assets/q3.png` |
| `[text](docs/spec.pdf)` | `docs/spec.pdf` |
| ` ```callout warning ` | `warning` |
| `:::chart` … `:::` | the block body |
| `[[the roadmap]]` | `the roadmap` |

For anything whose content lives outside the document — images, video, documents,
remote assets — **the payload is a reference and nothing else**. Inlining bytes as
base64 would make notes enormous, destroy diffs, and stop every other markdown tool
from reading them; a 26-character path is the whole point of building on markdown.

Turning a reference into something displayable is the host's job, via
`ResourceResolver`:

```swift
func resolve(_ request: ResourceRequest,
             deliver: @escaping (ResourceState) -> Void) -> ResourceState
func reservedSize(_ request: ResourceRequest) -> CGSize
```

Resolution is assumed asynchronous. The resolver returns `.loading`, the editor
reserves `reservedSize` so the document does not jump, and `deliver` later triggers a
repaint of **only the nodes pointing at that reference** — one slow image never
re-lays-out the document.

Results are cached by *reference*, not by decoration key: the key changes whenever the
node's source is edited, but `![a](x.png)` and `![b](x.png)` are the same asset and
should load once.

`ResourceResolver` and `WidgetProvider` are held **strongly**. They are services the
editor owns, not delegates, and hosts naturally write
`editor.resourceResolver = DiskResourceResolver(root: …)` — a weak reference silently
deallocates before the first paint and everything renders as "no resolver". Neither may
retain the editor.

### 5.2 Portability

Every construct degrades under a stock CommonMark renderer:

| construct | seen elsewhere as |
|---|---|
| ` ```callout ` | a code block — visible, harmless, lossless |
| `:::chart` | a paragraph of literal text |
| `@mention`, `[[wikilink]]` | plain text |

Fenced blocks are the preferred form: CommonMark already parses them, so they cost the
core nothing and no outside tool can corrupt them. Directive syntax requires a custom
block scanner and is supported for hosts that want the lighter visual weight.

---

### 5.3 Host decoration layers

The manifest is declarative, and that is its limit: it can only describe things that are
*findable in the text* — a fence with this info string, a pattern that looks like this.
Some features are not like that. Where the caret is, what a language tagger calls a word,
who commented on a range: none of it is in the markdown, and no parser will ever find it.

A **layer** is decoration the host computes and hands over:

```
intern_role(name) -> RoleId          # roles are open strings; invent one at runtime
set_layer(name, [{range, role, kind}])  # replace the layer, get a patch back
clear_layer(name)
```

The spans then flow through the machinery that already exists — identity, diffing,
`moved`, painting, theming — so **no renderer needed new code to draw them**. That is the
test of whether the decoration protocol (§3) was actually a protocol or just an internal
shape: a feature invented years later, in a different language, should reach the screen
through it unchanged.

Three details are load-bearing:

- **Layers paint after the parse.** `Decoration.layer` is `0` for anything derived from
  the markdown and higher for host layers, and the renderers break paint-order ties on
  it. Without that ordering a focus-mode dim cannot dim a heading, because two `Style`
  decorations at the same kind have no defined order. It occupies a byte that used to be
  explicit padding, so the ABI did not change.
- **Layer keys include position, and parsed keys deliberately do not** (§3.3). A widget
  that survives an edit must not be rebuilt; a *styling* span that slides must repaint
  both the range it left and the one it arrived at, and renderers are free to ignore
  `moved`. Keying on position turns a move into a remove plus an add, which is exactly
  the repaint required.
- **Edits rebase layers rather than dropping them.** A span wholly after an edit shifts,
  one before it is untouched, and one the edit landed *inside* is dropped — nothing here
  can know what the host would now say about that text. Without this, highlighting visibly
  slides out of alignment with the words underneath it on every keystroke while the host
  catches up.

Two features ship against this API and are deliberately **not** part of the editor:
typewriter/focus mode (dim everything but the paragraph under the caret) and
parts-of-speech highlighting. Neither required a change to the core, the applier, or the
renderers. They live in `web/extensions/` and `apple/Sources/MDEHost/`, and they supply
their own role styling, because an extension that invents a role should bring its
appearance with it. The Apple build tags words with the system `NLTagger`; the web build
uses a small heuristic tagger, which is meaningfully worse and is labelled as such — the
point being demonstrated is the plumbing, not the linguistics.

## 6. FFI

One C ABI, two consumers.

```c
MdeEngine* mde_engine_new(const uint8_t* manifest_toml, size_t len);
void       mde_engine_free(MdeEngine*);

// Edits and selection return a borrowed patch valid until the next call.
const MdePatch* mde_engine_edit(MdeEngine*, const MdeEdit* edits, size_t n);
const MdePatch* mde_engine_set_selection(MdeEngine*, uint32_t anchor, uint32_t head);
const MdePatch* mde_engine_reset(MdeEngine*, const uint8_t* text, size_t len);
```

`MdePatch` exposes `Decoration` as a `#[repr(C)]` array. Swift reads it as
`UnsafeBufferPointer<MdeDecoration>`; wasm reads the same layout out of linear memory.
No JSON, no per-keystroke allocation churn in the host.

Apple ships a static library via a Swift package wrapping an XCFramework. Web ships
`wasm32-unknown-unknown` with a hand-written binding — `wasm-bindgen` is unnecessary
given the flat struct interface.

---

## 7. Renderers

**Apple (built).** `UITextView` on TextKit 2, in `apple/Sources/MDEditorUI`.

| primitive | how it is drawn |
|---|---|
| `Style` | `NSAttributedString` attributes from `Theme` |
| `Conceal` | 0.01pt font + clear colour |
| `InlineWidget` / `BlockWidget` | `NSTextAttachmentViewProvider`, installed by paragraph substitution |
| `Gutter` | the marker character, themed |
| `Hit` | tap-tested against `live` decorations |

Four things this cost that the spec did not anticipate:

**Attachments need a `U+FFFC`, and the storage must stay pure markdown.** Setting
`.attachment` on an ordinary character does nothing — TextKit only draws an attachment
where that character sits. The resolution is `NSTextContentStorageDelegate`, which
lets the *display* string for a paragraph differ from the backing store: the widget's
first character is swapped for the attachment character, one for one. The substitution
is strictly length-preserving; a length change there desynchronises every selection
and edit offset in the view. A multi-line block widget then works for free — the
remaining characters are concealed, and a 0.01pt newline contributes ~0 height, so
only the attachment's own height shows.

**Concealing by shrinking, not by removing.** A hairline font keeps the character
count 1:1 with the source, which is what keeps every offset in the system honest.
Line height is the max over the line, so shrinking a heading's `#` does not shrink the
heading. The cost: concealed characters remain selectable, which is exactly why the
core snaps selection endpoints out of concealed ranges (§4).

**Moves must not repaint.** `NSTextStorage` carries attributes along with characters,
so a decoration that only shifted is already correct on screen. Including `moved` in
the repaint region drags it to the end of the document on every keystroke — O(document)
per character instead of O(paragraph). Only `added`, `removed`, and the edited range
are dirty.

**Two UIKit traps, both silent.** A `UITapGestureRecognizer` added for `Hit` testing
wins gesture arbitration and stops `UITextView`'s own text interaction from ever
firing — the view never becomes first responder and the editor accepts no input at
all. It needs `cancelsTouchesInView = false` *and* a delegate permitting simultaneous
recognition; neither alone is enough. Separately, overriding
`prepare(withInvocationTarget:)` on the replacement undo manager (§9) makes UIKit
invoke text mutations on the undo manager instead of the text view, swallowing every
keystroke. Refusing to *perform* undo is sufficient.

Three things the renderers learned the hard way, all now pinned by tests:

**Dirty ranges are a set, not a bounding box.** Excluding `moved` is only half the rule.
Editing a node changes how many byte-identical siblings precede its twin elsewhere,
which changes that twin's key (§3.3) and puts a removal half a document from the caret.
Unioning the two covered everything between: one keystroke measured at 1844 ms instead
of 0.33 ms. It could fire at any document size.

**A widget view must not take clicks unless its host opts in** (§4), and its wrapper
must be a real box. On the web a plain inline wrapper is one line tall however tall its
content is, so a click in the middle of an image sails past it; and because the source a
widget stands for is concealed to a hairline, the browser then maps that click to
whatever real text is nearest — the line below. The click has to be claimed explicitly
and the caret placed at the start of the source.

**A widget view may size itself by frame, not only by Auto Layout.** Measuring only with
`systemLayoutSizeFitting` reports zero for such a view, which clamped a resolved image
to one point and rendered it as an invisible gap. Related: substitution can run before
the text container has a width, so resolution must wait for a real one — and asking for
a *size* has to start the load, or a resource skipped for want of a width is never
requested again.

**macOS (built).** `NSTextView`, also TextKit 2.

Everything that decides *what a decoration means* — reveal resolution, paint ordering,
conceal, widget substitution, the `moved`-does-not-repaint rule, hit testing — lives in
`DecorationApplier`, which has no UIKit or AppKit in it and is shared verbatim. The two
`MarkdownTextView`s are thin hosts holding only what genuinely differs: first-responder
handling, gesture vs. `mouseDown`, and the inert undo manager. UIKit/AppKit type
divergence is absorbed by aliases in `Platform.swift`.

This split is the guard against the failure mode named in §4: three renderers quietly
disagreeing about atomic selection or reveal. They cannot disagree about code they
share.

**Web (built).** Our own layer over `contenteditable` — not a framework. The browser
supplies IME, spellcheck, accessibility, and touch selection; we supply span
application and replaced elements, exactly as on TextKit 2. CodeMirror 6 was rejected:
it is a framework *above* the browser's text engine with its own decoration and
transaction model, so building against it and TextKit 2 would translate our protocol
into two foreign vocabularies and let the semantics of §4 drift apart.

The host rests on one invariant: **the DOM's text, excluding `data-mde-ignore`
subtrees, is exactly the markdown source.** Widget views are marked ignored so a chip
reading "@gabe" cannot smuggle its label into the document, and everything else —
recovering the edit, mapping selection to offsets — falls out of a single tree walk.

| primitive | how it is drawn |
|---|---|
| `Style` | a class per role on a run |
| `Conceal` | `font-size: 0.01px` — the same hairline trick as Apple, so the character count stays 1:1 |
| `InlineWidget` / `BlockWidget` | host view marked `data-mde-ignore`, alongside the concealed source |
| `Gutter` | the marker character, themed |
| `Hit` | hit-tested against `live` on click |

Four things worth naming:

**The edit is recovered by diffing, not reported.** By the time `input` fires the
browser has already mutated the DOM, and it does not describe what it did in a form
that holds across IME, autocorrect, paste and drag. A common-prefix/suffix diff against
the mirror recovers the replacement uniformly from all of them — and must not cut a
surrogate pair in half.

**`contenteditable="plaintext-only"` is what keeps the DOM honest.** Plain
`contenteditable` invents `<div>`s and `<br>`s on Enter; `plaintext-only` inserts a real
newline character, which is what the document actually contains. Lines are then spans in
a `white-space: pre-wrap` container, so a line can be re-rendered without touching its
neighbours.

**A line owns its trailing newline, and a concealed line must collapse itself.**
Appending the `\n` outside the line's decorated range leaves it unconcealed, so a block
widget spanning three lines renders as one widget plus two blank lines. Treating the
newline as an ordinary character of the line lets a block widget conceal it like any
other.

That is necessary but not sufficient, and the earlier claim here — that "a hairline
newline has no height" — was simply wrong. Concealing shrinks *glyphs*; the line box
they sit in is sized by the containing block's strut, which no amount of shrinking the
content can get under. Three separate things were each contributing a full 27px band:
the continuation lines themselves, the anonymous line box generated by an inline
concealed run sitting after the block-level widget view, and the empty inline fragments
a block box creates when it splits an inline `.mde-line`. So the container carries no
leading at all (`line-height: 0`), each `.mde-line` restores it, a fully concealed line
zeroes it again, the line that draws a widget becomes a block itself, and the concealed
source inside a widget is a zero-height block. A test asserts the continuation lines
measure exactly zero and that the drawn line is no taller than the view it draws.

**Conceal must beat role styling explicitly.** A concealed `##` is also a heading;
`.mde-conceal` and `.mde-h2` are both single-class selectors, so without `!important`
the heading's font-size silently wins on source order and the markers never collapse.
There is a test pinned to exactly this.

---

## 8. Testing

The core is a pure function of `(text, selection, registry)`, so a snapshot pins
observable behavior completely. `tests/corpus/*.md` holds cases; each `.snap`
neighbour is the expected decoration set, rendered with source slices inline so a diff
is readable. A case may carry an inline extension manifest and a `‸` marker for the
caret, which is stripped before parsing — so reveal behavior is snapshotted too.

```bash
UPDATE_GOLDEN=1 cargo test -p mde-core --test golden
```

This corpus is the contract the three renderers are written against. When a renderer
disagrees with a snapshot, the renderer is wrong.

Above it sit two Swift suites, both run by `swift test` from `apple/`:

- **`MDECoreTests`** drives the FFI wrapper against a `MirrorBuffer` standing in for
  `NSTextStorage`, so mirror drift is caught here rather than as a corrupted document
  on device.
- **`MDEditorUITests`** drives the real AppKit `NSTextView` in an offscreen window and
  asserts on what it renders — heading larger than body, `**` collapsed to a hairline,
  only the caret's own node revealed, substitution length-preserving, undo restoring
  storage *and* decorations. Since the applier is shared, these pin iOS too.

The web suite is `web/test/index.html`. It runs in a real browser on purpose: every
hard bug in that layer — contenteditable behaviour, selection restore, CSS precedence
on concealed runs, hit-testing a widget — only exists in a real engine, so a DOM shim
would pass while the editor was broken.

**All three suites run from one command**, `./scripts/test.sh`, which drives the web
tests through headless Chrome over the DevTools protocol (`scripts/test-web.mjs`, no npm
dependencies — Node serves the files itself so caching cannot hand the browser a stale
module). This is not a convenience. While the web suite needed a human to open a page it
grew a test that passed when written and failed on re-run, because it depended on the
window's size; nothing that is not in `test.sh` will stay honest.

## 9. Undo

**The core owns the history.** The platform undo manager sees keystrokes, not
structure: undoing a bold-toggle would come back as two unrelated character deletions,
and `UITextView`'s manager cannot be taught otherwise. Owning the log puts grouping
next to the code that knows what a markdown edit *was*, and makes it identical on all
three platforms. Renderers install an inert undo manager (see §7 for the trap there).

`Text::apply` returns the inverse of every batch it applies, so a revision is just
`(redo edits, undo edits, selection before, selection after)`. **The flow inverts on
undo**: edits normally travel platform → core, but an undo travels core → platform,
which applies the returned edits to its own buffer *without* reporting them back.

Two gestures coalesce into one undo step, because only two are unambiguous: a forward
typing run and a backspace run, both within 700 ms and both positionally adjacent. A
newline ends a run — a paragraph break is where a person expects undo to stop. Anything
else starts a new revision, and `boundary()` forces one explicitly so a formatting
command never merges into surrounding typing.

A resync (`reset`) clears the history. After a desync the recorded offsets describe a
document that never existed on the platform side; replaying them would corrupt the
buffer.

**A timeline, not just two buttons.** Undo and redo are the one-step view of a history
that can be listed and navigated:

```
revisions()        -> [{index, at_ms, inserted, removed, kind, at}]
history_position() -> how many revisions are applied
jump_to(n)         -> land anywhere in the timeline
```

Three decisions are worth stating:

- **Undone revisions stay in the list.** They are not deleted when you step back, only
  un-applied. A history you can browse has to show the branch you stepped back from, or
  there is nothing to step forward *to*. An edit made from a rewound point still discards
  that branch, exactly as it does for redo.
- **`jump_to` returns one edit, not a chain of them.** Each step's edits are expressed in
  the coordinates of the document as it was at that step, so replaying fifty of them
  requires the host to reconstruct every intermediate state in exactly the right order —
  and any host that gets it subtly wrong desyncs silently. Diffing the start and end text
  instead yields a single replacement that is correct however the host applies it, and
  collapses a fifty-revision jump into one splice. The diff is UTF-16 and never splits a
  surrogate pair.
- **The summary is deliberately coarse** — counts of inserted and removed code units, and
  which side was non-empty. The core knows which characters moved, not what the person
  meant; a label that guesses at intent ("renamed the heading") is worse than one that
  states what happened.

## 10. Open questions

- A document with no newlines at all (a minified paste) has no region boundaries, so
  every keystroke in it is a full reparse. There is no smaller unit to fall back to, and
  real prose always has them; accepted rather than fixed.
- `contenteditable="plaintext-only"` is well supported in Chrome and Safari but only
  landed in Firefox recently; a fallback that intercepts `beforeinput` would be needed
  for older Firefox.
- The web host re-renders whole lines, so the same minified-paste case degrades to
  O(line) per keystroke there.
- Soft-wrap interaction with `Gutter` depth on deeply nested quotes is unspecified.
  Gutters are currently drawn as the themed marker character rather than true margin
  content.
- `swiftc -O` crashes on `super.init(usingTextLayoutManager:)` (Swift 6.3, SIL
  CopyPropagation). Worked around by assembling the TextKit 2 stack by hand; worth
  reporting upstream.

### Closed

- ~~Host-drawn widget views rebuild on every re-layout.~~ They are now cached by
  decoration key in `DecorationApplier` and `DomApplier`. This is safe *because* keys are
  stable across edits (§3.3): a key changes exactly when its node's own source changes,
  so the cache invalidates itself and there is no staleness rule to get wrong. Bounded at
  256 views, evicting entries that are no longer live first.
- ~~`reservedSize` is a guess, so a wrong guess shifts the document once.~~ Resolved
  sizes are now measured and kept (`resourceSizes` on every host). A host that persists
  them and seeds them on open turns "shifts once per launch" into "shifts once per asset,
  ever". The guess is still the fallback for a reference nobody has seen.

## 11. Sequencing

1. ~~Rust core: rope, parse, decorate, key, diff, golden-file corpus~~ — done
2. ~~Undo/redo owned by the core~~ — done (§9)
3. ~~iOS renderer on TextKit 2~~ — done (§7)
4. ~~Reference app shell~~ — done, running in the simulator
5. ~~Resource references with async resolution~~ — done (§5.1)
6. ~~macOS renderer sharing the Swift package~~ — done (§7)
7. ~~Web renderer over `contenteditable`~~ — done (§7)
8. ~~Performance: incremental reparse, prefilter, fast hashing~~ — done (§2.2)
9. Commands / toolbar API beyond the reference apps' bold + undo
10. Multi-document session model

---

## Tooling

`scripts/capture.sh` produces the showcase assets in `site/assets/` — screenshots and
short screencasts of the two native reference apps.

    ./scripts/capture.sh            iOS and macOS
    ./scripts/capture.sh ios        iOS only
    ./scripts/capture.sh macos      macOS only

It writes `ios-inline-rendering.png`, `ios-reveal.png`, `ios-widgets.png`,
`ios-references.png`, `ios-demo.mp4`, `macos-editor.png`, `macos-widgets.png`,
`macos-demo.mp4`, and a `manifest.json` describing them. Only assets that were actually
produced are listed, so a site reading the manifest degrades to whatever exists. A
failing step is reported and skipped rather than aborting the run; the exit status is
non-zero only if nothing was captured.

**Nothing drives the apps from outside.** `simctl` can screenshot and record a
simulator but cannot inject a touch into one, and `screencapture` cannot click. The
apps therefore compose their own shots: both are launched with `--mde-capture <shot>`
and set their scroll offset and selection to match (`MDEApp/CaptureMode.swift`,
`MDEAppMac/CaptureModeMac.swift`). Rendering is untouched — the offset and the caret
are the only things a hand doing this would have moved either. The macOS app also
prints its `CGWindowID` and screen rect on stdout, because neither is reachable from
the shell: the system python has no Quartz bindings and System Events needs
Accessibility.

Two things are worth knowing before a run:

- The iOS half targets a **dedicated simulator**, never `booted` — that resolves to
  whichever device happens to be running, and has picked a watch before now. Override
  with `MDE_DEVICE=<udid>`.
- The macOS screencast records a screen *rect*, since `screencapture` has no
  window-video mode. The still shots photograph the window itself and do not care what
  is in front of it, but the screencast does, so the app parks its window in the
  top-left corner for that one shot to stay clear of centre-screen system alerts.
  Anything modal that still lands on top of it will be in the recording. It also needs
  Screen Recording permission for whatever terminal runs it; without it the script says
  so and carries on with the rest.
