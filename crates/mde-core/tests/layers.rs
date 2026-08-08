//! Host decoration layers (DESIGN §5.3).
//!
//! Layers are how a feature that the parser knows nothing about — where the caret is,
//! what a language tagger calls a word — reaches the screen without being built into
//! the core. These tests pin the properties the two showcase extensions depend on.

use mde_core::{Engine, Kind, LayerSpan, Registry, Selection};

fn engine(text: &str) -> Engine {
    let mut e = Engine::new(Registry::empty());
    e.reset(text);
    e
}

fn span(start: u32, end: u32, role: u32) -> LayerSpan {
    LayerSpan { start, end, role, kind: Kind::Style, depth: 0 }
}

#[test]
fn a_layer_adds_decorations_the_parser_never_produced() {
    let mut e = engine("the quick brown fox\n");
    let parsed = e.decorations().len();

    let noun = e.intern_role("pos-noun");
    let patch = e.set_layer("pos", &[span(4, 9, noun), span(16, 19, noun)]);

    assert_eq!(patch.added.len(), 2);
    assert_eq!(e.decorations().len(), parsed + 2);
    assert!(e.decorations().iter().any(|d| d.start == 4 && d.end == 9 && d.role == noun));
}

#[test]
fn layers_paint_after_the_parse_so_they_can_override_it() {
    let mut e = engine("# Heading\n");
    let dim = e.intern_role("dim");
    e.set_layer("focus", &[span(0, 9, dim)]);

    let parsed_max = e.decorations().iter().filter(|d| d.role != dim).map(|d| d.layer).max();
    let layered = e.decorations().iter().find(|d| d.role == dim).unwrap();

    assert_eq!(parsed_max, Some(0), "parsed decorations must stay at layer 0");
    assert!(
        layered.layer > 0,
        "a host layer that cannot outrank the parse cannot dim a styled heading"
    );
}

#[test]
fn later_layers_outrank_earlier_ones() {
    let mut e = engine("body text\n");
    let a = e.intern_role("first");
    let b = e.intern_role("second");
    e.set_layer("under", &[span(0, 4, a)]);
    e.set_layer("over", &[span(0, 4, b)]);

    let under = e.decorations().iter().find(|d| d.role == a).unwrap().layer;
    let over = e.decorations().iter().find(|d| d.role == b).unwrap().layer;
    assert!(over > under, "registration order is paint order");
}

#[test]
fn setting_a_layer_replaces_it_rather_than_appending() {
    let mut e = engine("the quick brown fox\n");
    let role = e.intern_role("mark");
    e.set_layer("l", &[span(0, 3, role), span(4, 9, role)]);
    e.set_layer("l", &[span(10, 15, role)]);

    let mine: Vec<_> = e.decorations().iter().filter(|d| d.role == role).collect();
    assert_eq!(mine.len(), 1);
    assert_eq!((mine[0].start, mine[0].end), (10, 15));
    assert_eq!(e.layer_count(), 1, "the same name must not register twice");
}

#[test]
fn pushing_the_same_spans_twice_is_a_no_op() {
    let mut e = engine("the quick brown fox\n");
    let role = e.intern_role("mark");
    let spans = [span(4, 9, role), span(16, 19, role)];
    e.set_layer("l", &spans);

    // Idempotence matters: a host recomputes on every keystroke and selection change,
    // and a patch that is empty when nothing changed is what stops it repainting.
    assert!(e.set_layer("l", &spans).is_empty());
}

#[test]
fn a_moved_span_is_a_rebuild_not_a_move() {
    let mut e = engine("the quick brown fox\n");
    let role = e.intern_role("focus");
    e.set_layer("l", &[span(0, 3, role)]);
    let patch = e.set_layer("l", &[span(4, 9, role)]);

    // Position is deliberately part of a layer key. A *styling* span that slides has to
    // repaint the range it left behind as well as the one it arrived at, and renderers
    // are free to ignore `moved` (§3.4) — so a move has to present as remove + add.
    assert_eq!(patch.moved.len(), 0, "a layer span must never report as merely moved");
    assert_eq!(patch.removed.len(), 1);
    assert_eq!(patch.added.len(), 1);
}

#[test]
fn clearing_a_layer_removes_its_decorations() {
    let mut e = engine("the quick brown fox\n");
    let role = e.intern_role("mark");
    e.set_layer("l", &[span(4, 9, role)]);
    let patch = e.clear_layer("l");

    assert_eq!(patch.removed.len(), 1);
    assert_eq!(e.layer_count(), 0);
    assert!(!e.decorations().iter().any(|d| d.role == role));
}

#[test]
fn an_empty_layer_is_not_the_same_as_no_layer() {
    let mut e = engine("body\n");
    let role = e.intern_role("mark");
    e.set_layer("l", &[span(0, 4, role)]);
    e.set_layer("l", &[]);
    assert_eq!(e.layer_count(), 1, "an empty layer keeps its paint slot");
    e.clear_layer("l");
    assert_eq!(e.layer_count(), 0);
}

#[test]
fn layer_spans_are_clamped_to_the_document() {
    let mut e = engine("short\n");
    let role = e.intern_role("mark");
    e.set_layer("l", &[span(0, 9999, role), span(500, 600, role)]);

    let mine: Vec<_> = e.decorations().iter().filter(|d| d.role == role).collect();
    assert_eq!(mine.len(), 1, "a span entirely past the end collapses to nothing");
    assert_eq!(mine[0].end, 6, "a span running past the end is clamped, not dropped");
}

#[test]
fn an_inverted_span_is_normalised_rather_than_trusted() {
    let mut e = engine("the quick brown fox\n");
    let role = e.intern_role("mark");
    e.set_layer("l", &[span(9, 4, role)]);
    let d = e.decorations().iter().find(|d| d.role == role).unwrap();
    assert!(d.start <= d.end);
}

#[test]
fn layers_survive_and_follow_an_edit() {
    let mut e = engine("the quick brown fox\n");
    let role = e.intern_role("mark");
    // "fox" at 16..19
    e.set_layer("l", &[span(16, 19, role)]);

    // Insert before it. The host has not recomputed yet; the span must still sit on the
    // same word rather than drifting left by what was typed.
    e.edit(&[mde_core::Edit { start: 0, end: 0, text: "XY".into() }], None, 0).unwrap();
    let d = e.decorations().iter().find(|d| d.role == role).unwrap();
    assert_eq!((d.start, d.end), (18, 21));
    assert_eq!(&e.text()[18..21], "fox");
}

#[test]
fn a_span_the_edit_landed_inside_is_dropped() {
    let mut e = engine("the quick brown fox\n");
    let role = e.intern_role("mark");
    e.set_layer("l", &[span(4, 9, role)]); // "quick"

    // Typing inside the word makes it a different word; keeping the old span would be
    // a claim about text nobody has looked at.
    e.edit(&[mde_core::Edit { start: 6, end: 6, text: "ZZ".into() }], None, 0).unwrap();
    assert!(!e.decorations().iter().any(|d| d.role == role));
}

#[test]
fn a_span_before_the_edit_does_not_move() {
    let mut e = engine("the quick brown fox\n");
    let role = e.intern_role("mark");
    e.set_layer("l", &[span(0, 3, role)]); // "the"
    e.edit(&[mde_core::Edit { start: 19, end: 19, text: "!".into() }], None, 0).unwrap();

    let d = e.decorations().iter().find(|d| d.role == role).unwrap();
    assert_eq!((d.start, d.end), (0, 3));
}

#[test]
fn reset_drops_layers_because_nothing_can_rebase_them() {
    let mut e = engine("the quick brown fox\n");
    let role = e.intern_role("mark");
    e.set_layer("l", &[span(4, 9, role)]);

    e.reset("an entirely different document\n");
    assert_eq!(e.layer_count(), 0);
    assert!(!e.decorations().iter().any(|d| d.role == role));
}

#[test]
fn layers_are_independent_of_selection_and_reveal() {
    let mut e = engine("hello **world** end\n");
    let role = e.intern_role("mark");
    e.set_layer("l", &[span(0, 5, role)]);

    let before = e.decorations().iter().filter(|d| d.role == role).count();
    e.set_selection(Some(Selection::caret(10)));
    let after = e.decorations().iter().filter(|d| d.role == role).count();

    assert_eq!(before, after, "reveal policy must not touch host layers");
    let d = e.decorations().iter().find(|d| d.role == role).unwrap();
    assert_eq!(d.kind, Kind::Style, "a layer keeps the kind the host asked for");
}

#[test]
fn a_layer_role_survives_a_reparse() {
    let mut e = engine("the quick brown fox\n");
    let role = e.intern_role("pos-noun");
    e.set_layer("l", &[span(16, 19, role)]);
    e.edit(&[mde_core::Edit { start: 19, end: 19, text: " jumps".into() }], None, 0).unwrap();

    // Role ids are interned for the engine's lifetime, so the name still resolves after
    // the parse that has nothing to do with it.
    assert_eq!(e.registry().role_name(role), Some("pos-noun"));
}

#[test]
fn many_spans_do_not_disturb_the_parsed_decorations() {
    let mut e = engine("# Title\n\nSome **bold** text with `code`.\n");
    let parsed: Vec<_> = e.decorations().iter().filter(|d| d.layer == 0).copied().collect();

    let role = e.intern_role("mark");
    let spans: Vec<_> = (0..30)
        .map(|i| span(i, i + 1, role))
        .collect();
    e.set_layer("l", &spans);

    let after: Vec<_> = e.decorations().iter().filter(|d| d.layer == 0).copied().collect();
    assert_eq!(parsed, after, "adding a layer must not perturb what the parse produced");
}
