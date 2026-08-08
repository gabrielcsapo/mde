#![cfg(feature = "toml-manifest")]

//! Golden-file corpus.
//!
//! Each `tests/corpus/*.md` file is a case; its `.snap` neighbour is the expected
//! decoration set. Because the core is a pure function of
//! `(text, selection, registry)`, a snapshot fully pins observable behavior — which
//! is what the three renderers are written against.
//!
//! Regenerate after an intentional change:
//!
//! ```text
//! UPDATE_GOLDEN=1 cargo test -p mde-core --test golden
//! ```
//!
//! Case file format:
//!
//! ```text
//! +++
//! <optional extension manifest, TOML>
//! +++
//! <markdown; an optional U+2038 CARET ‸ marks the selection and is stripped>
//! ```

use mde_core::{Engine, Kind, Registry, Reveal, Selection};
use std::fs;
use std::path::{Path, PathBuf};

const CARET: char = '\u{2038}';

fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/corpus")
}

fn split_case(raw: &str) -> (Option<String>, String) {
    let Some(rest) = raw.strip_prefix("+++\n") else { return (None, raw.to_string()) };
    match rest.split_once("\n+++\n") {
        Some((manifest, body)) => (Some(manifest.to_string()), body.to_string()),
        None => (None, raw.to_string()),
    }
}

fn render(name: &str, raw: &str) -> String {
    let (manifest, body) = split_case(raw);

    // The caret marker is stripped before parsing; its UTF-16 offset becomes the
    // selection, so reveal behavior is part of the snapshot.
    let caret = body.find(CARET).map(|byte| body[..byte].encode_utf16().count() as u32);
    let text = body.replace(CARET, "");

    let registry = match &manifest {
        Some(m) => Registry::from_toml(m).unwrap_or_else(|e| panic!("{name}: {e}")),
        None => Registry::empty(),
    };

    let mut engine = Engine::new(registry);
    engine.reset(&text);
    if let Some(c) = caret {
        engine.set_selection(Some(Selection::caret(c)));
    }

    let units: Vec<u16> = text.encode_utf16().collect();
    let mut out = String::new();
    out.push_str("# kind        role            range      reveal        source\n");
    for d in engine.decorations() {
        let slice = String::from_utf16_lossy(&units[d.start as usize..d.end as usize]);
        let depth = if d.depth > 0 { format!(" depth={}", d.depth) } else { String::new() };
        out.push_str(&format!(
            "{:<13} {:<15} {:>4}..{:<4} {:<13} {:?}{}\n",
            kind_name(d.kind),
            engine.registry().role_name(d.role).unwrap_or("?"),
            d.start,
            d.end,
            reveal_name(d.reveal),
            slice,
            depth,
        ));
    }
    out
}

fn kind_name(k: Kind) -> &'static str {
    match k {
        Kind::Style => "Style",
        Kind::Conceal => "Conceal",
        Kind::InlineWidget => "InlineWidget",
        Kind::BlockWidget => "BlockWidget",
        Kind::Gutter => "Gutter",
        Kind::Hit => "Hit",
    }
}

fn reveal_name(r: Reveal) -> &'static str {
    match r {
        Reveal::Never => "never",
        Reveal::CaretInNode => "caret_in_node",
        Reveal::CaretInLine => "caret_in_line",
        Reveal::CaretInBlock => "caret_in_block",
    }
}

#[test]
fn corpus_matches_snapshots() {
    let dir = corpus_dir();
    let update = std::env::var("UPDATE_GOLDEN").is_ok();
    let mut cases: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("corpus dir {}: {e}", dir.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "md"))
        .collect();
    cases.sort();
    assert!(!cases.is_empty(), "no corpus cases found in {}", dir.display());

    let mut failures = Vec::new();
    for case in cases {
        let name = case.file_stem().unwrap().to_string_lossy().to_string();
        let raw = fs::read_to_string(&case).unwrap();
        let actual = render(&name, &raw);
        let snap = case.with_extension("snap");

        if update {
            fs::write(&snap, &actual).unwrap();
            continue;
        }
        match fs::read_to_string(&snap) {
            Ok(expected) if expected == actual => {}
            Ok(expected) => failures.push(format!(
                "--- {name} ---\nexpected:\n{expected}\nactual:\n{actual}"
            )),
            Err(_) => failures.push(format!(
                "--- {name} ---\nmissing snapshot; rerun with UPDATE_GOLDEN=1\nactual:\n{actual}"
            )),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Guards the invariant renderers depend on most: nothing outside the document, and
/// no inverted ranges, regardless of input.
#[test]
fn every_case_emits_in_bounds_sorted_ranges() {
    for entry in fs::read_dir(corpus_dir()).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|x| x != "md") {
            continue;
        }
        let raw = fs::read_to_string(&path).unwrap();
        let (manifest, body) = split_case(&raw);
        let text = body.replace(CARET, "");
        let len = text.encode_utf16().count() as u32;
        let registry = manifest.map_or_else(Registry::empty, |m| Registry::from_toml(&m).unwrap());
        let mut e = Engine::new(registry);
        e.reset(&text);

        let mut last = 0;
        for d in e.decorations() {
            assert!(d.start <= d.end, "{:?}: inverted range {d:?}", path);
            assert!(d.end <= len, "{:?}: range past end of document {d:?}", path);
            assert!(d.start >= last, "{:?}: unsorted output at {d:?}", path);
            last = d.start;
        }
    }
}
