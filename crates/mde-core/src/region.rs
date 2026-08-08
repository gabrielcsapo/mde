//! Finding where a reparse can safely start and stop.
//!
//! Full reparse is correct but costs O(document) per keystroke (DESIGN §2.2). This
//! module bounds the work: if an edit is contained in a region whose parse cannot
//! depend on anything outside it, only that region needs rebuilding.
//!
//! Everything here is deliberately pessimistic. A boundary that is not really safe
//! produces wrong decorations silently, so the rule is proof, not likelihood — and
//! `incremental_matches_full_reparse` in `lib.rs` checks the whole scheme against a
//! full reparse over thousands of random edits.

use crate::registry::{BlockSyntax, Registry};

/// Byte offsets at which a top-level block provably begins.
///
/// Offset 0 is always one. Beyond that, a boundary is the start of a line that
/// - follows a blank line, and
/// - is not inside a fenced code block or a host directive block.
///
/// The blank line is what makes it safe: CommonMark's lazy continuation, setext
/// underlines and list-item continuation all reach *backwards* across non-blank lines
/// only, so a block that starts after a blank line cannot be affected by what precedes
/// it.
pub struct Regions {
    boundaries: Vec<usize>,
}

impl Regions {
    /// `None` means this document contains something that makes region parsing unsound;
    /// the caller must reparse the whole thing.
    pub fn scan(src: &str, reg: &Registry) -> Option<Regions> {
        let markers: Vec<&str> = reg
            .blocks
            .iter()
            .filter_map(|b| match &b.syntax {
                BlockSyntax::Directive { marker, .. } => Some(marker.as_str()),
                _ => None,
            })
            .collect();

        let mut boundaries = vec![0usize];
        let mut offset = 0usize;
        let mut prev_blank = false;
        // The open fence's marker character and run length, if any.
        let mut fence: Option<(u8, usize)> = None;
        let mut directive: Option<&str> = None;

        for line in src.split_inclusive('\n') {
            let trimmed = line.trim_end_matches(['\n', '\r']);
            let indent = trimmed.len() - trimmed.trim_start_matches(' ').len();
            let body = &trimmed[indent..];

            if let Some(marker) = directive {
                if body.trim_end() == marker {
                    directive = None;
                }
                prev_blank = false;
                offset += line.len();
                continue;
            }

            if let Some((ch, len)) = fence {
                // A closing fence is the same character, at least as long, alone.
                let run = body.bytes().take_while(|&b| b == ch).count();
                if run >= len && body[run..].trim().is_empty() {
                    fence = None;
                }
                prev_blank = false;
                offset += line.len();
                continue;
            }

            // A link reference definition can turn `[foo]` anywhere in the document into
            // a link, so no region is independent of it. Rare enough to just refuse.
            if indent < 4 && body.starts_with('[') && body.contains("]:") {
                return None;
            }

            if body.trim().is_empty() {
                prev_blank = true;
                offset += line.len();
                continue;
            }

            // Only at column zero. A blank line does not necessarily close a block:
            // an indented code block absorbs blank lines, and so does a list item's
            // continuation. Both resume with an indented line, so requiring column zero
            // excludes them without having to track open containers.
            if prev_blank && indent == 0 {
                boundaries.push(offset);
            }
            prev_blank = false;

            // An indented code block's contents must not be mistaken for markup.
            if indent < 4 {
                if let Some(m) = markers.iter().find(|m| body.starts_with(**m)) {
                    // `:::name` opens, a bare `:::` closes. A bare marker here is a
                    // stray close; treat it as ordinary text.
                    if body.len() > m.len() {
                        directive = Some(m);
                    }
                } else {
                    let ch = body.as_bytes()[0];
                    if ch == b'`' || ch == b'~' {
                        let run = body.bytes().take_while(|&b| b == ch).count();
                        // A backtick fence's info string may not contain a backtick.
                        if run >= 3 && !(ch == b'`' && body[run..].contains('`')) {
                            fence = Some((ch, run));
                        }
                    }
                }
            }

            offset += line.len();
        }

        // An unterminated fence or directive means the tail of the document is in a
        // state the scan cannot vouch for.
        if fence.is_some() || directive.is_some() {
            return None;
        }
        Some(Regions { boundaries })
    }

    /// The region enclosing `[start, end)`: the last boundary at or before `start`, and
    /// the first boundary at or after `end` (or the end of the document).
    pub fn enclosing(&self, start: usize, end: usize, len: usize) -> (usize, usize) {
        let lo = self.at_or_before(start);
        (lo, self.at_or_after(end, len).max(lo))
    }

    /// The last boundary at or before `offset`.
    pub fn at_or_before(&self, offset: usize) -> usize {
        match self.boundaries.partition_point(|&b| b <= offset) {
            0 => 0,
            i => self.boundaries[i - 1],
        }
    }

    /// The first boundary at or after `offset`, or the end of the document.
    pub fn at_or_after(&self, offset: usize, len: usize) -> usize {
        self.boundaries.iter().copied().find(|&b| b >= offset).unwrap_or(len)
    }

    pub fn count(&self) -> usize {
        self.boundaries.len()
    }
}

#[cfg(all(test, feature = "toml-manifest"))]
mod tests {
    use super::*;

    fn regions(src: &str) -> Option<Regions> {
        Regions::scan(src, &Registry::empty())
    }

    #[test]
    fn a_boundary_follows_every_blank_line() {
        let src = "one\n\ntwo\n\nthree";
        let r = regions(src).unwrap();
        assert_eq!(r.boundaries, vec![0, 5, 10]);
    }

    #[test]
    fn a_blank_line_inside_a_fence_is_not_a_boundary() {
        let src = "intro\n\n```\ncode\n\nmore code\n```\n\nafter";
        let r = regions(src).unwrap();
        // Only the paragraph after the fence closes, never the blank line inside it.
        assert_eq!(r.boundaries, vec![0, 7, src.find("after").unwrap()]);
    }

    #[test]
    fn a_tilde_fence_closes_only_on_tildes() {
        let src = "a\n\n~~~\n```\n\nstill code\n~~~\n\nb";
        let r = regions(src).unwrap();
        assert_eq!(r.boundaries, vec![0, 3, src.find('b').unwrap()]);
    }

    #[test]
    fn an_unterminated_fence_refuses_the_whole_document() {
        assert!(regions("a\n\n```\nnever closed\n").is_none());
    }

    #[test]
    fn a_link_reference_definition_refuses_the_whole_document() {
        // It can make `[foo]` a link anywhere, so no region stands alone.
        assert!(regions("[foo]: https://example.dev\n\nsee [foo]\n").is_none());
    }

    #[test]
    fn a_directive_block_is_opaque() {
        let manifest = r#"
            [[block]]
            name   = "chart"
            syntax = { kind = "directive", marker = ":::", name = "chart" }
            render = "block_widget"
        "#;
        let reg = Registry::from_toml(manifest).unwrap();
        let src = "a\n\n:::chart\n\nrows: 2\n:::\n\nb";
        let r = Regions::scan(src, &reg).unwrap();
        assert_eq!(r.boundaries, vec![0, 3, src.find('b').unwrap()]);
    }

    #[test]
    fn enclosing_widens_to_whole_regions() {
        let src = "one\n\ntwo\n\nthree";
        let r = regions(src).unwrap();
        // An edit inside "two" reparses exactly "two\n\n".
        assert_eq!(r.enclosing(6, 7, src.len()), (5, 10));
        // An edit spanning two regions takes both.
        assert_eq!(r.enclosing(6, 11, src.len()), (5, 15));
        // An edit in the last region runs to the end of the document.
        assert_eq!(r.enclosing(11, 12, src.len()), (10, 15));
    }

    #[test]
    fn an_indented_line_after_a_blank_is_not_a_boundary() {
        // An indented code block absorbs the blank line and continues.
        let src = "a\n\n    code one\n\n    code two\n\nb";
        let r = regions(src).unwrap();
        // No boundary at either indented line, only at the paragraph that follows.
        assert_eq!(r.boundaries, vec![0, src.find('b').unwrap()]);
    }

    #[test]
    fn a_list_item_continuation_is_not_a_boundary() {
        let src = "- item\n\n  still the item\n\nafter";
        let r = regions(src).unwrap();
        assert_eq!(r.boundaries, vec![0, src.find("after").unwrap()]);
    }

    #[test]
    fn an_indented_code_block_does_not_open_a_fence() {
        let src = "a\n\n    ```\n    not a fence\n\nb";
        let r = regions(src).unwrap();
        assert_eq!(r.boundaries, vec![0, src.find('b').unwrap()]);
    }
}
