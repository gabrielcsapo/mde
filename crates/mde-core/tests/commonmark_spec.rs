//! Renderer-contract fixtures selected from the CommonMark 0.31.2 specification.
//!
//! `pulldown-cmark` runs the complete upstream parsing suite. These cases cover the
//! extra responsibility owned here: turning tricky legal parses into precise,
//! in-bounds decorations that all hosts can project without reparsing Markdown.

use mde_core::registry::role;
use mde_core::{Engine, Kind, Registry};

fn engine(source: &str) -> Engine {
    let mut engine = Engine::new(Registry::empty());
    engine.reset(source);
    engine
}

#[test]
fn tabs_and_indentation_from_the_spec_keep_structural_ranges_narrow() {
    let heading = engine("  #\tFoo\n");
    let marker = heading
        .decorations()
        .iter()
        .find(|item| item.kind == Kind::Conceal && item.role == role::MARKER)
        .expect("indented ATX marker");
    assert_eq!(&heading.text().encode_utf16().collect::<Vec<_>>()[marker.start as usize..marker.end as usize],
               &"  #\t".encode_utf16().collect::<Vec<_>>());

    let list = engine("3.\titem\n");
    let bullet = list
        .decorations()
        .iter()
        .find(|item| item.kind == Kind::Gutter && item.role == role::LIST_BULLET)
        .expect("ordered-list marker");
    assert_eq!((bullet.start, bullet.end), (0, 2));
}

#[test]
fn escaped_constructs_remain_literal_instead_of_gaining_false_roles() {
    let source = "\\*not emphasized*\n\\<br/> not a tag\n\\[not a link](/foo)\n";
    let parsed = engine(source);
    assert!(parsed.decorations().iter().all(|item| {
        !matches!(item.role, role::EMPHASIS | role::HTML | role::LINK_TEXT)
    }));
}

#[test]
fn nested_inline_constructs_stay_inside_their_commonmark_nodes() {
    let source = "[a *nested* label](https://example.dev) and ***both***\n";
    let parsed = engine(source);
    for item in parsed.decorations() {
        assert!(item.start <= item.end, "inverted decoration {item:?}");
        assert!(item.end <= source.encode_utf16().count() as u32, "out of bounds {item:?}");
    }
    assert!(parsed.decorations().iter().any(|item| item.role == role::LINK_TEXT));
    assert!(parsed.decorations().iter().any(|item| item.role == role::EMPHASIS));
    assert!(parsed.decorations().iter().any(|item| item.role == role::STRONG));
}

#[test]
fn lazy_block_quote_continuations_do_not_invent_gutters() {
    let parsed = engine("> first\nlazy a > b\n");
    assert_eq!(
        parsed
            .decorations()
            .iter()
            .filter(|item| item.kind == Kind::Gutter && item.role == role::QUOTE)
            .count(),
        1
    );
}
