#![cfg(feature = "toml-manifest")]

//! Where the core breaks, and how.
//!
//! The other suites check that ordinary documents behave. This one checks the edges:
//! documents built to be pathological, input that is not really markdown, and edit
//! patterns no person would produce but a paste, a sync client or a fuzzer will.
//!
//! The bar is not "fast" — several of these are known to be slow, and that is recorded
//! rather than hidden. The bar is: **never panic, never corrupt the document, never
//! emit a decoration that lies about where it is.**

use mde_core::{Edit, Engine, Registry, Selection};

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

fn engine() -> Engine {
    Engine::from_toml(MANIFEST).expect("manifest")
}

/// The invariant every renderer depends on: decorations are inside the document, are
/// not inverted, and arrive in document order.
fn assert_well_formed(e: &Engine, label: &str) {
    let len = e.text().encode_utf16().count() as u32;
    let mut last = 0;
    for d in e.decorations() {
        assert!(d.start <= d.end, "{label}: inverted range {}..{}", d.start, d.end);
        assert!(d.end <= len, "{label}: range {}..{} past end {len}", d.start, d.end);
        assert!(d.start >= last, "{label}: unsorted at {}", d.start);
        last = d.start;
    }
    // Offsets must land on character boundaries, or a renderer slicing by them panics.
    let units: Vec<u16> = e.text().encode_utf16().collect();
    for d in e.decorations() {
        let slice = &units[d.start as usize..d.end as usize];
        assert!(
            String::from_utf16(slice).is_ok(),
            "{label}: decoration {}..{} splits a surrogate pair",
            d.start,
            d.end
        );
    }
}

// MARK: - Pathological documents

#[test]
fn a_document_that_is_one_enormous_line() {
    // No newline anywhere: every region rule keys off line starts, so this is the
    // degenerate case for the incremental path — it can never find a boundary.
    let text = "word ".repeat(40_000);
    let mut e = engine();
    e.reset(&text);
    assert_well_formed(&e, "one line");

    let at = (text.encode_utf16().count() / 2) as u32;
    e.edit(&[Edit { start: at, end: at, text: "**x**".into() }], None, 0).unwrap();
    assert_well_formed(&e, "one line after edit");
}

#[test]
fn deeply_nested_quotes_saturate_depth_rather_than_wrapping() {
    // `depth` is a u8 and nesting is unbounded. 400 levels must clamp at 255; wrapping
    // would report a deeply nested quote as a top-level one and indent it wrongly.
    let text = format!("{}deep\n", "> ".repeat(400));
    let mut e = engine();
    e.reset(&text);
    assert_well_formed(&e, "nested quotes");

    let deepest = e
        .decorations()
        .iter()
        .filter(|d| d.role == mde_core::registry::role::QUOTE)
        .map(|d| d.depth)
        .max()
        .expect("quote gutters");
    assert_eq!(deepest, u8::MAX, "depth should saturate, not wrap");
}

#[test]
fn thousands_of_unclosed_markers() {
    for text in ["*".repeat(20_000), "[".repeat(20_000), "`".repeat(20_000), "#".repeat(5_000)] {
        let mut e = engine();
        e.reset(&text);
        assert_well_formed(&e, "unclosed markers");
    }
}

#[test]
fn an_unterminated_fence_at_the_end_of_a_large_document() {
    // Region scanning refuses this document, so every edit falls back to a full
    // reparse. Correctness must not depend on which path ran.
    let mut text = "para\n\n".repeat(5_000);
    text.push_str("```rust\nnever closed\n");
    let mut e = engine();
    e.reset(&text);

    let at = (text.encode_utf16().count() - 5) as u32;
    e.edit(&[Edit { start: at, end: at, text: "x".into() }], None, 0).unwrap();
    assert_well_formed(&e, "unterminated fence");
}

#[test]
fn a_document_of_nothing_but_extension_syntax() {
    let text = "@a [[b]] ".repeat(20_000);
    let mut e = engine();
    e.reset(&text);
    assert_well_formed(&e, "all extensions");
    assert!(e.decorations().len() > 10_000, "expected a decoration per token");
}

#[test]
fn adversarial_unicode_survives_round_tripping() {
    let cases = [
        "😀".repeat(5_000),                       // surrogate pairs everywhere
        "a\u{0301}".repeat(5_000),                // combining marks
        "\u{202E}reversed\u{202C} **bold**".into(), // bidi overrides
        "\u{200B}".repeat(5_000),                 // zero-width spaces
        "🏳️‍🌈".repeat(2_000),                      // multi-scalar grapheme clusters
        "\u{FFFC}object replacement **x**".into(), // the attachment character itself
    ];
    for (i, text) in cases.iter().enumerate() {
        let mut e = engine();
        e.reset(text);
        assert_eq!(e.text(), text, "case {i}: document changed");
        assert_well_formed(&e, &format!("unicode case {i}"));
    }
}

#[test]
fn an_empty_document_and_a_document_of_one_newline() {
    for text in ["", "\n", "\n\n\n", " "] {
        let mut e = engine();
        e.reset(text);
        assert_well_formed(&e, "trivial document");
        // Editing at the only valid offset must not panic.
        let len = text.encode_utf16().count() as u32;
        e.edit(&[Edit { start: len, end: len, text: "x".into() }], None, 0).unwrap();
        assert_well_formed(&e, "trivial document after edit");
    }
}

// MARK: - Edit patterns

#[test]
fn an_edit_storm_never_corrupts_the_document() {
    // The mirror is the thing most likely to drift, so it is checked against an
    // independently maintained copy after every single edit.
    let mut e = engine();
    let mut mirror = String::new();
    e.reset("");

    let fragments = ["# h\n\n", "**b** ", "`c` ", "@x ", "[[w]] ", "\n\n", "```\nq\n```\n\n", "- i\n"];
    let mut seed = 0x1234_5678u64;
    for step in 0..3_000 {
        seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        let len16 = mirror.encode_utf16().count();
        let at = ((seed >> 33) as usize % (len16 + 1)) as u32;
        let frag = fragments[(seed >> 20) as usize % fragments.len()];

        // Applying to the mirror in UTF-16 space, exactly as a platform buffer would.
        let units: Vec<u16> = mirror.encode_utf16().collect();
        let head = String::from_utf16(&units[..at as usize]).unwrap_or_default();
        let tail = String::from_utf16(&units[at as usize..]).unwrap_or_default();
        if head.len() + tail.len() != mirror.len() {
            continue; // offset landed inside a surrogate pair; a real host cannot do this
        }
        mirror = format!("{head}{frag}{tail}");

        e.edit(&[Edit { start: at, end: at, text: frag.into() }], None, step).unwrap();
        assert_eq!(e.text(), mirror, "mirror drifted at step {step}");
    }
    assert_well_formed(&e, "edit storm");
}

#[test]
fn deleting_the_entire_document_in_one_edit() {
    let text = "# Title\n\n**bold** and @mention\n\n```callout x\nbody\n```\n";
    let mut e = engine();
    e.reset(text);
    let len = text.encode_utf16().count() as u32;

    e.edit(&[Edit { start: 0, end: len, text: String::new() }], None, 0).unwrap();
    assert_eq!(e.text(), "");
    assert!(e.decorations().is_empty(), "an empty document has no decorations");

    // And back again, in one step.
    assert!(e.undo().is_some());
    assert_eq!(e.text(), text);
    assert_well_formed(&e, "after undoing a full delete");
}

#[test]
fn pasting_a_large_block_into_the_middle() {
    let mut e = engine();
    e.reset("start\n\nend\n");
    let paste = "# Pasted\n\n**bold** @who\n\n".repeat(2_000);
    e.edit(&[Edit { start: 7, end: 7, text: paste.clone() }], None, 0).unwrap();

    assert!(e.text().contains(&paste));
    assert_well_formed(&e, "after a large paste");
    assert!(e.undo().is_some());
    assert_eq!(e.text(), "start\n\nend\n");
}

/// History is bounded, and this is what that bound *means* in practice: the oldest
/// revisions are dropped, so undo stops at the state the document had 500 edits ago
/// rather than at the empty document. Unbounded history on a long editing session is a
/// slow memory leak, so the bound is deliberate — but it should be stated, not
/// discovered.
#[test]
fn undo_stops_at_the_history_limit_rather_than_growing_without_bound() {
    const EDITS: u64 = 1_000;
    let mut e = engine();
    e.reset("");

    let mut after_each = Vec::new();
    // Far apart in time so nothing coalesces: one revision per edit.
    for i in 0..EDITS {
        let at = e.text().encode_utf16().count() as u32;
        e.edit(&[Edit { start: at, end: at, text: format!("line {i}\n\n") }], None, i * 10_000)
            .unwrap();
        after_each.push(e.text().to_string());
    }

    let mut steps = 0;
    while e.undo().is_some() {
        steps += 1;
        assert!(steps <= EDITS, "history grew past its limit");
    }
    assert_eq!(steps, 500, "the limit in history.rs");
    // Undoing 500 of 1000 edits lands on the document as it was after edit 499.
    assert_eq!(e.text(), after_each[(EDITS as usize - 1) - steps as usize]);
    assert_well_formed(&e, "unwound to the history limit");

    // And redo climbs all the way back.
    while e.redo().is_some() {}
    assert_eq!(e.text(), *after_each.last().unwrap());
}

#[test]
fn out_of_bounds_and_overlapping_edits_are_refused_not_applied() {
    let mut e = engine();
    e.reset("hello");

    assert!(e.edit(&[Edit { start: 99, end: 99, text: "x".into() }], None, 0).is_err());
    assert_eq!(e.text(), "hello", "a rejected edit must not mutate");

    assert!(e
        .edit(
            &[
                Edit { start: 0, end: 3, text: "a".into() },
                Edit { start: 2, end: 5, text: "b".into() },
            ],
            None,
            0
        )
        .is_err());
    assert_eq!(e.text(), "hello");
    assert!(!e.can_undo(), "a refused edit must not enter the history");
}

// MARK: - Selection

#[test]
fn selection_at_every_offset_of_a_hostile_document() {
    let text = "😀**bold**日本\n\n```callout x\nbody\n```\n\n@who [[link]]\n";
    let mut e = engine();
    e.reset(text);
    for at in 0..=text.encode_utf16().count() as u32 {
        e.set_selection(Some(Selection::caret(at)));
        assert_well_formed(&e, &format!("caret at {at}"));
    }
}




// MARK: - Registry

#[test]
fn a_manifest_with_many_rules_still_produces_correct_decorations() {
    let mut manifest = String::new();
    for i in 0..200 {
        manifest.push_str(&format!(
            "[[inline]]\nname = \"tag{i}\"\nsyntax = {{ kind = \"pattern\", regex = \"#t{i}\\\\b\" }}\nrender = \"style\"\n\n"
        ));
    }
    let mut e = Engine::from_toml(&manifest).expect("200 rules");
    e.reset("text #t7 and #t199 and #t0 here");
    assert_well_formed(&e, "many rules");
    assert!(e.decorations().len() >= 3, "each declared tag should match");
}

#[test]
fn a_rule_that_can_match_empty_does_not_hang() {
    // `a*` matches the empty string; a naive scan loop would never advance.
    let manifest = "[[inline]]\nname = \"x\"\nsyntax = { kind = \"pattern\", regex = \"a*\" }\nrender = \"style\"\n";
    let mut e = Engine::from_toml(manifest).expect("manifest");
    e.reset("bbb aaa bbb");
    assert_well_formed(&e, "empty-matching rule");
}

#[test]
fn a_delimiter_pair_that_is_the_same_string() {
    let manifest = "[[inline]]\nname = \"x\"\nsyntax = { kind = \"delimited\", open = \"%%\", close = \"%%\" }\nrender = \"style\"\n";
    let mut e = Engine::from_toml(manifest).expect("manifest");
    e.reset("%%one%% and %%two%% and %%unclosed");
    assert_well_formed(&e, "same-string delimiters");
}

#[test]
fn an_empty_registry_still_decorates_builtin_markdown() {
    let mut e = Engine::new(Registry::empty());
    e.reset("# h\n\n**b** *i* `c` [l](u) ![i](u)\n\n> q\n\n- [ ] t\n\n---\n");
    assert_well_formed(&e, "empty registry");
    assert!(!e.decorations().is_empty());
}
