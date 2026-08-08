#![cfg(feature = "toml-manifest")]

//! Incremental reparse must be indistinguishable from a full reparse.
//!
//! `Engine::edit` rebuilds only the region an edit could have affected (DESIGN §2.2).
//! That is an optimization with a silent failure mode: a wrong region boundary produces
//! subtly wrong decorations that no unit test would notice. So rather than testing the
//! boundary rules directly, this compares the *whole observable result* — ranges, kinds,
//! roles, reveal, depth, and keys — against an engine that reparsed from scratch, over
//! thousands of edits at every position in a document built to be hostile.
//!
//! A deterministic PRNG is used so a failure is reproducible from the seed alone.

use mde_core::{Edit, Engine, Selection};

const MANIFEST: &str = r#"
    [[block]]
    name   = "callout"
    syntax = { kind = "fence", info = "callout" }
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
"#;

/// Deliberately awkward: every construct that could make a region depend on its
/// neighbours sits next to one that could not.
const CORPUS: &str = "\
# Heading one

A paragraph with **bold**, *italic*, `code`, a [link](https://example.dev) and an
![image](assets/x.png) plus @mention and [[a wikilink]].

> a quote
> > nested deeper

- bullet one
- [ ] a task
- [x] done

```callout warning
A registered fence the host draws.
```

```rust
// an unregistered fence, ``` inside a string is not a close
let s = \"~~~\";
```

:::chart
rows: 3
:::

Setext heading
==============

| Name | Score |
| :--- | ----: |
| Ada  |    10 |

An <kbd>inline HTML</kbd> tag and <https://example.dev>.

    an indented code block
    ``` not a fence

Trailing paragraph with 😀 emoji and 日本語 text.

---
";

/// xorshift64*, so a failing case is reproducible from its seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
}

fn engine() -> Engine {
    Engine::from_toml(MANIFEST).expect("manifest")
}

/// Everything a renderer can observe, rendered as text so a mismatch is readable.
fn snapshot(e: &Engine) -> String {
    let mut out = String::new();
    for d in e.decorations() {
        out.push_str(&format!(
            "{:?} {} {}..{} r{} d{} k{:x} p{:?}\n",
            d.kind,
            d.role,
            d.start,
            d.end,
            d.reveal as u8,
            d.depth,
            d.key,
            e.payload(d.key),
        ));
    }
    out
}

/// First line where two snapshots differ, with a little context. Comparing whole blobs
/// buries the one line that matters under thousands of identical ones.
fn first_difference(a: &str, b: &str) -> String {
    let (mut al, mut bl) = (a.lines(), b.lines());
    let mut n = 0;
    loop {
        match (al.next(), bl.next()) {
            (None, None) => return "identical".into(),
            (x, y) if x == y => n += 1,
            (x, y) => {
                return format!(
                    "line {n}:\n  incremental: {}\n  full reparse: {}",
                    x.unwrap_or("<end>"),
                    y.unwrap_or("<end>")
                )
            }
        }
    }
}

/// Apply one edit incrementally, and the same edit to a fresh engine, and compare.
fn assert_matches(text: &str, start: u32, end: u32, insert: &str, label: &str) {
    let mut incremental = engine();
    incremental.reset(text);
    // A caret makes reveal policy part of what is compared.
    incremental.set_selection(Some(Selection::caret(start)));

    let edit = Edit { start, end, text: insert.to_string() };
    incremental.edit(&[edit], None, 0).expect("edit");

    let mut full = engine();
    full.reset(incremental.text());
    full.set_selection(incremental.selection());

    let (a, b) = (snapshot(&incremental), snapshot(&full));
    assert!(
        a == b,
        "{label}: incremental reparse diverged from a full reparse\n\
         edit: {start}..{end} -> {insert:?}\n{}\n---- document ----\n{}",
        first_difference(&a, &b),
        incremental.text()
    );
}

#[test]
fn inserting_at_every_position_matches_a_full_reparse() {
    let len = CORPUS.encode_utf16().count() as u32;
    for at in 0..=len {
        assert_matches(CORPUS, at, at, "x", &format!("insert at {at}"));
    }
}

#[test]
fn deleting_at_every_position_matches_a_full_reparse() {
    let len = CORPUS.encode_utf16().count() as u32;
    for at in 0..len {
        assert_matches(CORPUS, at, at + 1, "", &format!("delete at {at}"));
    }
}

/// The characters most able to restructure a document from a single keystroke.
#[test]
fn inserting_structural_characters_matches_a_full_reparse() {
    let len = CORPUS.encode_utf16().count() as u32;
    for insert in ["\n", "\n\n", "`", "```", "~~~", "#", ">", "-", "*", ":::", "[", "]", "\\"] {
        for at in (0..=len).step_by(7) {
            assert_matches(CORPUS, at, at, insert, &format!("insert {insert:?} at {at}"));
        }
    }
}

/// A link reference definition makes every region depend on it, so the scan must refuse
/// to work incrementally at all rather than produce a plausible wrong answer.
#[test]
fn a_link_reference_definition_still_matches() {
    let text = "[foo]: https://example.dev\n\nsee [foo] and [[wiki]]\n\nmore text\n";
    let len = text.encode_utf16().count() as u32;
    for at in 0..=len {
        assert_matches(text, at, at, "x", &format!("refdef insert at {at}"));
    }
}

/// Successive edits, so divergence has somewhere to accumulate rather than being reset
/// by a fresh document each time.
#[test]
fn a_long_random_edit_session_never_diverges() {
    let mut rng = Rng(0x5EED_1234_ABCD_0001);
    let inserts = ["a", " ", "\n", "\n\n", "**", "`", "```\n", ":::", "@bob", "[[x]]", "😀", "日"];

    let mut e = engine();
    e.reset(CORPUS);

    for step in 0..2_000 {
        let len = e.text().encode_utf16().count() as u32;
        let start = rng.below(len as usize + 1) as u32;

        let (end, insert) = if rng.next().is_multiple_of(3) {
            // A deletion, sometimes of a whole run.
            let span = rng.below(12) as u32;
            (start.saturating_add(span).min(len), String::new())
        } else {
            (start, inserts[rng.below(inserts.len())].to_string())
        };

        e.set_selection(Some(Selection::caret(start)));
        // Offsets that land inside a surrogate pair are clamped by the core, so an edit
        // it rejects is simply skipped rather than treated as a failure.
        if e.edit(&[Edit { start, end, text: insert.clone() }], None, step).is_err() {
            continue;
        }

        let mut full = engine();
        full.reset(e.text());
        full.set_selection(e.selection());
        let (a, b) = (snapshot(&e), snapshot(&full));
        assert!(
            a == b,
            "diverged at step {step} (edit {start}..{end} -> {insert:?})\n{}\n\
             ---- document ----\n{}",
            first_difference(&a, &b),
            e.text()
        );
    }
}

/// Undo and redo route through the same rebuild, so they get the same guarantee.
#[test]
fn undo_and_redo_match_a_full_reparse() {
    let mut e = engine();
    e.reset(CORPUS);

    let at = CORPUS.find("```callout").unwrap() as u32;
    e.set_selection(Some(Selection::caret(at)));
    e.edit(&[Edit { start: at, end: at, text: "```\n\n".into() }], None, 0).unwrap();
    e.edit(&[Edit { start: at, end: at, text: "more ".into() }], None, 9_000).unwrap();

    for _ in 0..2 {
        e.undo().expect("undo");
        let mut full = engine();
        full.reset(e.text());
        full.set_selection(e.selection());
        let (a, b) = (snapshot(&e), snapshot(&full));
        assert!(a == b, "undo diverged\n{}", first_difference(&a, &b));
    }
    for _ in 0..2 {
        e.redo().expect("redo");
        let mut full = engine();
        full.reset(e.text());
        full.set_selection(e.selection());
        let (a, b) = (snapshot(&e), snapshot(&full));
        assert!(a == b, "redo diverged\n{}", first_difference(&a, &b));
    }
}
