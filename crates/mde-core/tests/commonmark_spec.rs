//! Renderer-contract fixtures selected from the CommonMark 0.31.2 specification.
//!
//! `pulldown-cmark` runs the complete upstream parsing suite. These cases cover the
//! extra responsibility owned here: turning tricky legal parses into precise,
//! in-bounds decorations that all hosts can project without reparsing Markdown.

use mde_core::registry::role;
use mde_core::{Engine, Kind, Registry};
use pulldown_cmark::{html, Options, Parser};
use serde::Deserialize;

#[derive(Deserialize)]
struct SpecExample {
    markdown: String,
    html: String,
    example: u32,
    section: String,
}

/// CommonMark defines the HTML semantics; serializers may omit needless escaping of
/// quotes in text nodes and whitespace between block tags. Normalize only those two
/// presentation differences before comparing the complete corpus.
fn normalize_html(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut index = 0;
    let mut in_tag = false;
    while index < value.len() {
        if !in_tag && value[index..].starts_with("&quot;") {
            normalized.push('"');
            index += "&quot;".len();
            continue;
        }
        let ch = value[index..].chars().next().expect("valid character boundary");
        if ch == '<' {
            in_tag = true;
        }
        normalized.push(ch);
        if ch == '>' {
            in_tag = false;
        }
        index += ch.len_utf8();
    }
    normalized.replace(">\n<", "><")
}

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

#[test]
fn complete_commonmark_0_31_2_corpus_matches_and_projects_safely() {
    let examples: Vec<SpecExample> = serde_json::from_str(include_str!("commonmark/spec.json"))
        .expect("vendored CommonMark corpus should be valid JSON");
    assert_eq!(examples.len(), 652, "unexpected CommonMark 0.31.2 corpus size");

    let mut html_failures = Vec::new();
    let mut projection_failures = Vec::new();
    for example in examples {
        let mut actual = String::new();
        html::push_html(&mut actual, Parser::new_ext(&example.markdown, Options::empty()));
        if normalize_html(&actual) != normalize_html(&example.html) {
            html_failures.push(format!(
                "#{} {} expected={:?} actual={:?}",
                example.example, example.section, example.html, actual
            ));
        }

        // The product parser enables documented extensions in addition to CommonMark,
        // so its HTML can intentionally differ for extension-looking input. What every
        // official example must still guarantee is a platform-safe renderer contract.
        let parsed = engine(&example.markdown);
        let units: Vec<u16> = example.markdown.encode_utf16().collect();
        let mut previous = 0;
        for decoration in parsed.decorations() {
            let valid = decoration.start <= decoration.end
                && decoration.end as usize <= units.len()
                && decoration.start >= previous
                && String::from_utf16(
                    &units[decoration.start as usize..decoration.end as usize],
                )
                .is_ok();
            if !valid {
                projection_failures.push(format!(
                    "#{} {}: {:?}",
                    example.example, example.section, decoration
                ));
                break;
            }
            previous = decoration.start;
        }
        if parsed.text() != example.markdown {
            projection_failures.push(format!(
                "#{} {}: source changed",
                example.example, example.section
            ));
        }
    }

    assert!(
        html_failures.is_empty(),
        "base parser diverged from official HTML semantics in {} examples: {}",
        html_failures.len(),
        html_failures.join(", ")
    );
    assert!(
        projection_failures.is_empty(),
        "renderer contract failed in {} examples: {}",
        projection_failures.len(),
        projection_failures.join(", ")
    );
}
