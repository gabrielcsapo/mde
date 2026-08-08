//! Parse -> decoration build.
//!
//! Full reparse per keystroke (DESIGN §2.2). The output is a position-sorted list of
//! `Built` entries carrying enough context (node range, enclosing block range) for
//! `reveal` to be resolved later against the selection, without reparsing.

use crate::decoration::{node_key, Kind, Reveal, RoleId};
use crate::registry::{role, BlockSyntax, Matcher, Registry};
use crate::text::Text;
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use std::collections::HashMap;

/// A decoration before selection is applied. All offsets are UTF-8 bytes; conversion
/// to UTF-16 happens once, at emit (DESIGN §3.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Built {
    pub start: usize,
    pub end: usize,
    pub node: (usize, usize),
    pub block: (usize, usize),
    pub kind: Kind,
    pub role: RoleId,
    pub reveal: Reveal,
    pub depth: u8,
    pub key: u64,
    /// Extra text the parser already knew and the renderer would otherwise have to
    /// re-derive: an image or link destination, a fence info string, the inside of a
    /// delimited token. Renderers must never re-parse markdown to find these — that is
    /// duplicated, divergent work in three languages.
    pub payload: Option<String>,
}

pub fn options() -> Options {
    Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_TABLES
}

struct Builder<'a> {
    src: &'a str,
    reg: &'a Registry,
    out: Vec<Built>,
    block_stack: Vec<(usize, usize)>,
    quote_depth: u8,
    /// Byte ranges owned by a custom directive block; pulldown sees these as
    /// paragraphs, so its decorations inside them are discarded.
    directives: Vec<(usize, usize)>,
}

impl<'a> Builder<'a> {
    /// The enclosing block, or the node itself when there is none.
    ///
    /// Falling back to the whole document — as this used to — is quietly disastrous:
    /// `reveal = "caret_in_block"` then fires from anywhere in the file, and the
    /// incremental splice cannot tell which side of a region such a decoration belongs
    /// to, so it drops it. A block-less decoration is its own block.
    fn block(&self, node: (usize, usize)) -> (usize, usize) {
        self.block_stack.last().copied().unwrap_or(node)
    }

    fn push(
        &mut self,
        start: usize,
        end: usize,
        node: (usize, usize),
        kind: Kind,
        role: RoleId,
        reveal: Reveal,
    ) {
        self.push_with(start, end, node, kind, role, reveal, None);
    }

    #[allow(clippy::too_many_arguments)]
    fn push_with(
        &mut self,
        start: usize,
        end: usize,
        node: (usize, usize),
        kind: Kind,
        role: RoleId,
        reveal: Reveal,
        payload: Option<String>,
    ) {
        if start >= end {
            return;
        }
        let block = self.block(node);
        self.out.push(Built {
            start,
            end,
            node,
            block,
            kind,
            role,
            reveal,
            depth: self.quote_depth,
            // Assigned by `assign_keys` once the list is in document order. Doing it
            // here would make a key depend on the order the builder happened to emit
            // in, which differs between a full parse and a region reparse.
            key: 0,
            payload,
        });
    }

    /// `:::name` … `:::` blocks. CommonMark has no directive syntax, so this runs as a
    /// line scan before the parser and its ranges mask pulldown's output.
    fn scan_directives(&mut self) {
        let rules: Vec<(usize, String, String)> = self
            .reg
            .blocks
            .iter()
            .enumerate()
            .filter_map(|(i, b)| match &b.syntax {
                BlockSyntax::Directive { marker, name } => {
                    Some((i, marker.clone(), name.clone()))
                }
                _ => None,
            })
            .collect();
        if rules.is_empty() {
            return;
        }

        let mut open: Option<(usize, usize, String)> = None; // start, rule idx, marker
        let mut off = 0usize;
        for line in self.src.split_inclusive('\n') {
            let trimmed = line.trim_end_matches(['\n', '\r']);
            match &open {
                None => {
                    for (i, marker, name) in &rules {
                        if let Some(rest) = trimmed.strip_prefix(marker.as_str()) {
                            if rest.trim() == name {
                                open = Some((off, *i, marker.clone()));
                                break;
                            }
                        }
                    }
                }
                Some((start, i, marker)) => {
                    if trimmed.trim_end() == marker.as_str() {
                        let (start, i) = (*start, *i);
                        let marker_owned = marker.clone();
                        let end = off + trimmed.len();
                        let rule = &self.reg.blocks[i];
                        let (role, kind, reveal) = (rule.role, rule.kind, rule.reveal);
                        self.directives.push((start, end));
                        // A directive block *is* its own block. Without this it
                        // inherited the whole-document fallback, so `caret_in_block`
                        // revealed it from anywhere in the file.
                        self.block_stack.push((start, end));
                        let body = self.src[start..end]
                            .split_inclusive('\n')
                            .skip(1)
                            .filter(|l| l.trim_end() != marker_owned)
                            .collect::<String>()
                            .trim()
                            .to_string();
                        self.push_with(start, end, (start, end), kind, role, reveal, Some(body));
                        self.block_stack.pop();
                        open = None;
                    }
                }
            }
            off += line.len();
        }
    }

    /// Custom inline tokens, scanned inside literal text runs only — never inside
    /// code spans, URLs, or fenced blocks.
    ///
    /// `block` is captured when the run is seen, not when it is scanned: by scan time
    /// the block stack has unwound, and taking the block from there gave every custom
    /// inline token the whole document as its enclosing block — which made
    /// `reveal = "caret_in_block"` fire from anywhere in the file.
    fn scan_inlines(&mut self, range: std::ops::Range<usize>, block: (usize, usize)) {
        let slice = &self.src[range.clone()];
        let base = range.start;
        // Payload travels in the tuple rather than a parallel vector: the two would
        // only stay aligned if every delimited rule happened to be declared after every
        // pattern rule.
        let mut found: Vec<(usize, usize, RoleId, Kind, Reveal, Option<String>)> = Vec::new();
        for rule in &self.reg.inlines {
            // Skip the rule entirely when the run cannot contain a match. This is the
            // single biggest cost in `build` on ordinary prose, because a regex with no
            // literal prescan walks every byte looking for a `@` that is not there.
            if let Some(byte) = rule.prefilter {
                if !slice.as_bytes().contains(&byte) {
                    continue;
                }
            }
            match &rule.matcher {
                Matcher::Pattern(re) => {
                    for m in re.find_iter(slice) {
                        found.push((
                            base + m.start(),
                            base + m.end(),
                            rule.role,
                            rule.kind,
                            rule.reveal,
                            None,
                        ));
                    }
                }
                Matcher::Delimited { open, close } => {
                    let mut cursor = 0usize;
                    while let Some(o) = slice[cursor..].find(open.as_str()) {
                        let o = cursor + o;
                        let after = o + open.len();
                        let Some(c) = slice[after..].find(close.as_str()) else { break };
                        let end = after + c + close.len();
                        // `[[the roadmap]]` hands the host "the roadmap".
                        let payload = slice[after..after + c].to_string();
                        found.push((
                            base + o,
                            base + end,
                            rule.role,
                            rule.kind,
                            rule.reveal,
                            Some(payload),
                        ));
                        cursor = end;
                    }
                }
            }
        }
        // Deterministic order regardless of rule declaration order.
        found.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
        self.block_stack.push(block);
        for (s, e, role, kind, reveal, payload) in found {
            self.push_with(s, e, (s, e), kind, role, reveal, payload);
        }
        self.block_stack.pop();
    }
}

/// Byte offsets of the link text inside `[text](dest)`, bracket-depth aware.
///
/// A backslash escapes the next byte, so `[a \] b](x)` keeps its literal `]` instead
/// of ending the link text early. Backslashes are ASCII and can never appear inside a
/// UTF-8 continuation byte, so byte-wise scanning is safe here.
fn link_text_range(src: &str) -> Option<(usize, usize)> {
    let bytes = src.as_bytes();
    if bytes.first() != Some(&b'[') {
        return None;
    }
    let mut depth = 0i32;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 1, // skip the escaped byte
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some((1, i));
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Length of the run of `c` at the start of `s`.
fn run_len(s: &str, c: char) -> usize {
    s.chars().take_while(|&x| x == c).count()
}

pub fn build(text: &Text, reg: &Registry) -> Vec<Built> {
    let src = text.as_str();
    let mut b = Builder {
        src,
        reg,
        out: Vec::new(),
        block_stack: Vec::new(),
        quote_depth: 0,
        directives: Vec::new(),
    };
    b.scan_directives();

    let mut pending_inline_scans: Vec<(std::ops::Range<usize>, (usize, usize))> = Vec::new();

    for (ev, r) in Parser::new_ext(src, options()).into_offset_iter() {
        match ev {
            Event::Start(Tag::Heading { level, .. }) => {
                b.block_stack.push((r.start, r.end));
                let line_end = text.line_range(r.start).1;
                b.push(r.start, line_end, (r.start, line_end), Kind::Style, role::HEADING, Reveal::Never);
                // ATX only: a setext heading has no leading marker to conceal.
                let hashes = run_len(&src[r.start..], '#');
                if hashes > 0 && hashes == level as usize {
                    let mut m = r.start + hashes;
                    if src[m..].starts_with(' ') {
                        m += 1;
                    }
                    b.push(
                        r.start,
                        m,
                        (r.start, line_end),
                        Kind::Conceal,
                        role::MARKER,
                        Reveal::CaretInLine,
                    );
                }
            }
            Event::End(TagEnd::Heading(_)) => {
                b.block_stack.pop();
            }

            Event::Start(Tag::Paragraph) => b.block_stack.push((r.start, r.end)),
            Event::End(TagEnd::Paragraph) => {
                b.block_stack.pop();
            }

            Event::Start(Tag::BlockQuote(_)) => {
                b.quote_depth = b.quote_depth.saturating_add(1);
                b.block_stack.push((r.start, r.end));
                let depth = b.quote_depth;
                let mut off = r.start;
                for line in src[r.start..r.end].split_inclusive('\n') {
                    let marker = line.find('>').map(|i| off + i);
                    if let Some(m) = marker {
                        b.push(m, m + 1, (r.start, r.end), Kind::Gutter, role::QUOTE, Reveal::Never);
                        if let Some(last) = b.out.last_mut() {
                            last.depth = depth;
                        }
                    }
                    off += line.len();
                }
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                b.quote_depth = b.quote_depth.saturating_sub(1);
                b.block_stack.pop();
            }

            Event::Start(Tag::Item) => {
                b.block_stack.push((r.start, r.end));
                let line = &src[r.start..text.line_range(r.start).1];
                let marker_len = line.len() - line.trim_start().len()
                    + line.trim_start().split(' ').next().unwrap_or("").len();
                b.push(
                    r.start,
                    r.start + marker_len,
                    (r.start, r.end),
                    Kind::Gutter,
                    role::LIST_BULLET,
                    Reveal::Never,
                );
            }
            Event::End(TagEnd::Item) => {
                b.block_stack.pop();
            }

            Event::TaskListMarker(_) => {
                b.push(r.start, r.end, (r.start, r.end), Kind::Hit, role::TASK_CHECKBOX, Reveal::Never);
            }

            Event::Start(Tag::Emphasis) => {
                let n = run_len(&src[r.start..], src[r.start..].chars().next().unwrap_or('*'));
                delimited(&mut b, r.clone(), n.min(1), role::EMPHASIS);
            }
            Event::Start(Tag::Strong) => delimited(&mut b, r.clone(), 2, role::STRONG),
            Event::Start(Tag::Strikethrough) => {
                delimited(&mut b, r.clone(), 2, role::STRIKETHROUGH)
            }

            Event::Code(_) => {
                let ticks = run_len(&src[r.start..], '`');
                b.push(r.start, r.end, (r.start, r.end), Kind::Style, role::CODE_INLINE, Reveal::Never);
                b.push(r.start, r.start + ticks, (r.start, r.end), Kind::Conceal, role::MARKER, Reveal::CaretInNode);
                b.push(r.end - ticks, r.end, (r.start, r.end), Kind::Conceal, role::MARKER, Reveal::CaretInNode);
            }

            Event::Start(Tag::Link { ref dest_url, .. }) => {
                b.block_stack.push((r.start, r.end));
                if let Some((ts, te)) = link_text_range(&src[r.start..r.end]) {
                    let node = (r.start, r.end);
                    b.push_with(
                        r.start + ts,
                        r.start + te,
                        node,
                        Kind::Style,
                        role::LINK_TEXT,
                        Reveal::Never,
                        Some(dest_url.to_string()),
                    );
                    b.push(r.start, r.start + ts, node, Kind::Conceal, role::MARKER, Reveal::CaretInNode);
                    b.push(r.start + te, r.end, node, Kind::Conceal, role::LINK, Reveal::CaretInNode);
                }
            }
            Event::End(TagEnd::Link) => {
                b.block_stack.pop();
            }

            Event::Start(Tag::Image { dest_url, .. }) => {
                // The destination is a *reference*, never inlined content. Resolving it
                // to bytes is the host's business (DESIGN §5.2).
                b.push_with(
                    r.start,
                    r.end,
                    (r.start, r.end),
                    Kind::InlineWidget,
                    role::IMAGE,
                    Reveal::CaretInNode,
                    Some(dest_url.to_string()),
                );
            }

            Event::Start(Tag::CodeBlock(kind)) => {
                b.block_stack.push((r.start, r.end));
                let info = match &kind {
                    CodeBlockKind::Fenced(s) => s.to_string(),
                    CodeBlockKind::Indented => String::new(),
                };
                match reg.block_for_fence(&info) {
                    Some(rule) => {
                        let (role_id, k, rev) = (rule.role, rule.kind, rule.reveal);
                        // Everything after the fence name, so `\`\`\`callout warning`
                        // hands the host "warning" without re-parsing the fence.
                        let arg = info.split_whitespace().skip(1).collect::<Vec<_>>().join(" ");
                        b.push_with(r.start, r.end, (r.start, r.end), k, role_id, rev, Some(arg));
                    }
                    None => {
                        b.push(r.start, r.end, (r.start, r.end), Kind::Style, role::CODE_BLOCK, Reveal::Never);
                    }
                }
            }
            Event::End(TagEnd::CodeBlock) => {
                b.block_stack.pop();
            }

            Event::Rule => {
                b.push(r.start, r.end, (r.start, r.end), Kind::Style, role::RULE, Reveal::Never);
            }

            Event::Text(_) => pending_inline_scans.push((r.clone(), b.block((r.start, r.end)))),

            _ => {}
        }
    }

    // pulldown splits literal text into several `Text` events around characters it
    // considered as markup and then rejected — `[[wiki]]` arrives as four runs. Merge
    // touching runs first so a custom delimiter is never scanned across a seam that
    // exists only as a parser artifact.
    pending_inline_scans.sort_by_key(|(r, _)| (r.start, r.end));
    let mut merged: Vec<(std::ops::Range<usize>, (usize, usize))> =
        Vec::with_capacity(pending_inline_scans.len());
    for (r, block) in pending_inline_scans {
        match merged.last_mut() {
            // Only merge runs from the same block, or the merged run would inherit one
            // block's range while covering another's text.
            Some((last, last_block)) if last.end >= r.start && *last_block == block => {
                last.end = last.end.max(r.end)
            }
            _ => merged.push((r, block)),
        }
    }
    for (r, block) in merged {
        b.scan_inlines(r, block);
    }

    // Directive blocks are discovered by a forward line scan, so they are already
    // sorted and non-overlapping — which lets the mask be a binary search instead of a
    // scan. At 5 MB the linear version was 69% of the whole build.
    let directives = b.directives.clone();
    debug_assert!(directives.windows(2).all(|w| w[0].1 <= w[1].0));
    let mut out = b.out;
    out.retain(|d| {
        let idx = directives.partition_point(|&(s, _)| s <= d.start);
        if idx == 0 {
            return true;
        }
        let (s, e) = directives[idx - 1];
        // The directive's own widget decoration covers the block exactly; everything
        // strictly inside it is pulldown's view of text the host is replacing.
        !(d.end <= e && !(d.start == s && d.end == e))
    });
    out.sort_by_key(|d| (d.start, std::cmp::Reverse(d.end), d.kind as u8));
    assign_keys(&mut out, src);
    out
}

/// Build decorations for `src`, reporting offsets shifted by `base`.
///
/// Keys are left unassigned: the caller splices the result into the full list and runs
/// `assign_keys` over the whole thing, which is what makes a region reparse produce
/// exactly the keys a full reparse would.
pub fn build_region(src: &str, reg: &Registry, base: usize) -> Vec<Built> {
    let region = Text::new(src);
    let mut out = build(&region, reg);
    for d in &mut out {
        d.start += base;
        d.end += base;
        d.node = (d.node.0 + base, d.node.1 + base);
        d.block = (d.block.0 + base, d.block.1 + base);
    }
    out
}

/// Give every decoration its stable identity (DESIGN §3.3).
///
/// Position is excluded from the hash so typing far away does not rebuild a widget;
/// `nth` disambiguates byte-identical siblings and is counted in document order, which
/// makes the result independent of how the list was assembled.
pub fn assign_keys(out: &mut [Built], src: &str) {
    let mut seen: HashMap<(u8, RoleId, &str), u32> = HashMap::new();
    for d in out.iter_mut() {
        let source = &src[d.node.0.min(src.len())..d.node.1.min(src.len())];
        let counter = seen.entry((d.kind as u8, d.role, source)).or_insert(0);
        let nth = *counter;
        *counter += 1;
        d.key = node_key(d.kind, d.role, source, nth);
    }
}

fn delimited(b: &mut Builder, r: std::ops::Range<usize>, n: usize, role_id: RoleId) {
    let node = (r.start, r.end);
    if r.end - r.start < n * 2 {
        return;
    }
    b.push(r.start + n, r.end - n, node, Kind::Style, role_id, Reveal::Never);
    b.push(r.start, r.start + n, node, Kind::Conceal, role::MARKER, Reveal::CaretInNode);
    b.push(r.end - n, r.end, node, Kind::Conceal, role::MARKER, Reveal::CaretInNode);
}

#[cfg(all(test, feature = "toml-manifest"))]
mod tests {
    use super::*;

    fn built(src: &str, manifest: Option<&str>) -> (Text, Vec<Built>) {
        let t = Text::new(src);
        let reg = match manifest {
            Some(m) => Registry::from_toml(m).unwrap(),
            None => Registry::empty(),
        };
        let d = build(&t, &reg);
        (t, d)
    }

    fn find(d: &[Built], kind: Kind, role: RoleId) -> Vec<&Built> {
        d.iter().filter(|x| x.kind == kind && x.role == role).collect()
    }

    #[test]
    fn strong_styles_inner_and_conceals_both_markers() {
        let (t, d) = built("a **bold** b", None);
        let style = find(&d, Kind::Style, role::STRONG);
        assert_eq!(style.len(), 1);
        assert_eq!(&t.as_str()[style[0].start..style[0].end], "bold");
        let conceals = find(&d, Kind::Conceal, role::MARKER);
        assert_eq!(conceals.len(), 2);
        assert!(conceals.iter().all(|c| &t.as_str()[c.start..c.end] == "**"));
        assert!(conceals.iter().all(|c| c.reveal == Reveal::CaretInNode));
    }

    #[test]
    fn heading_conceals_hashes_and_reveals_by_line() {
        let (t, d) = built("## Title\n\nbody", None);
        let h = find(&d, Kind::Style, role::HEADING);
        assert_eq!(&t.as_str()[h[0].start..h[0].end], "## Title");
        let m = find(&d, Kind::Conceal, role::MARKER);
        assert_eq!(&t.as_str()[m[0].start..m[0].end], "## ");
        assert_eq!(m[0].reveal, Reveal::CaretInLine);
    }

    #[test]
    fn setext_heading_has_no_marker_to_conceal() {
        let (_, d) = built("Title\n=====\n", None);
        assert_eq!(find(&d, Kind::Style, role::HEADING).len(), 1);
        assert_eq!(find(&d, Kind::Conceal, role::MARKER).len(), 0);
    }

    #[test]
    fn link_splits_into_text_and_two_concealed_halves() {
        let (t, d) = built("see [the docs](https://x.dev) ok", None);
        let txt = find(&d, Kind::Style, role::LINK_TEXT);
        assert_eq!(&t.as_str()[txt[0].start..txt[0].end], "the docs");
        let tail = find(&d, Kind::Conceal, role::LINK);
        assert_eq!(&t.as_str()[tail[0].start..tail[0].end], "](https://x.dev)");
    }

    #[test]
    fn escaped_brackets_do_not_end_the_link_text_early() {
        let (t, d) = built(r"a [x \] y](https://e.dev) b", None);
        let txt = find(&d, Kind::Style, role::LINK_TEXT);
        assert_eq!(txt.len(), 1);
        assert_eq!(&t.as_str()[txt[0].start..txt[0].end], r"x \] y");
        let tail = find(&d, Kind::Conceal, role::LINK);
        assert_eq!(&t.as_str()[tail[0].start..tail[0].end], "](https://e.dev)");
    }

    #[test]
    fn nested_brackets_in_link_text_are_balanced() {
        let (t, d) = built("[an ![img](i.png) inside](https://e.dev)", None);
        let txt = find(&d, Kind::Style, role::LINK_TEXT);
        assert_eq!(&t.as_str()[txt[0].start..txt[0].end], "an ![img](i.png) inside");
    }

    #[test]
    fn image_is_an_inline_widget_over_its_whole_source() {
        let (t, d) = built("![alt](a.png)", None);
        let w = find(&d, Kind::InlineWidget, role::IMAGE);
        assert_eq!(w.len(), 1);
        assert_eq!(&t.as_str()[w[0].start..w[0].end], "![alt](a.png)");
    }

    #[test]
    fn task_marker_is_a_hit_target() {
        let (t, d) = built("- [ ] todo\n", None);
        let h = find(&d, Kind::Hit, role::TASK_CHECKBOX);
        assert_eq!(h.len(), 1);
        assert_eq!(&t.as_str()[h[0].start..h[0].end], "[ ]");
    }

    #[test]
    fn nested_quotes_carry_depth() {
        let (_, d) = built("> a\n>\n> > b\n", None);
        let q = find(&d, Kind::Gutter, role::QUOTE);
        assert!(q.iter().any(|x| x.depth == 1));
        assert!(q.iter().any(|x| x.depth == 2));
    }

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

    #[test]
    fn registered_fence_becomes_a_block_widget() {
        let (_, d) = built("```callout warning\nhi\n```\n", Some(MANIFEST));
        assert!(d.iter().any(|x| x.kind == Kind::BlockWidget));
        // ...and an unregistered one stays styled source.
        let (_, d2) = built("```rust\nfn main() {}\n```\n", Some(MANIFEST));
        assert!(d2.iter().all(|x| x.kind != Kind::BlockWidget));
        assert_eq!(find(&d2, Kind::Style, role::CODE_BLOCK).len(), 1);
    }

    #[test]
    fn directive_block_is_recognised_and_masks_inner_decorations() {
        let (t, d) = built(":::chart\n**not bold in here**\n:::\n", Some(MANIFEST));
        let w: Vec<_> = d.iter().filter(|x| x.kind == Kind::BlockWidget).collect();
        assert_eq!(w.len(), 1);
        assert!(t.as_str()[w[0].start..w[0].end].starts_with(":::chart"));
        assert_eq!(find(&d, Kind::Style, role::STRONG).len(), 0);
    }

    #[test]
    fn custom_inline_tokens_match_in_text_runs() {
        let (t, d) = built("ping @gabe and see [[some note]]", Some(MANIFEST));
        let widgets: Vec<_> = d.iter().filter(|x| x.kind == Kind::InlineWidget).collect();
        assert_eq!(widgets.len(), 1);
        assert_eq!(&t.as_str()[widgets[0].start..widgets[0].end], "@gabe");
        assert!(d.iter().any(|x| &t.as_str()[x.start..x.end] == "[[some note]]"));
    }

    #[test]
    fn a_directive_block_is_its_own_block() {
        let (t, d) = built("intro\n\n:::chart\nrows: 2\n:::\n\nafter", Some(MANIFEST));
        let w = d.iter().find(|x| x.kind == Kind::BlockWidget).unwrap();
        let block = &t.as_str()[w.block.0..w.block.1];
        assert!(block.starts_with(":::chart"), "block was {block:?}");
        assert!(!block.contains("intro"), "block swallowed the document");
    }

    #[test]
    fn a_custom_inline_token_belongs_to_its_own_paragraph() {
        // Regression guard: these used to inherit the whole document as their block, so
        // `reveal = "caret_in_block"` triggered from anywhere in the file.
        let (t, d) = built("first para\n\nping @gabe here\n\nlast para", Some(MANIFEST));
        let mention = d.iter().find(|x| x.kind == Kind::InlineWidget).unwrap();
        let block = &t.as_str()[mention.block.0..mention.block.1];
        assert!(block.contains("ping @gabe here"), "block was {block:?}");
        assert!(!block.contains("first para"), "block swallowed the document");
    }

    #[test]
    fn custom_inline_tokens_do_not_match_inside_code_spans() {
        let (_, d) = built("`@gabe`", Some(MANIFEST));
        assert!(d.iter().all(|x| x.kind != Kind::InlineWidget));
    }

    fn payload_of(d: &[Built], role: RoleId) -> Option<String> {
        d.iter().find(|x| x.role == role).and_then(|x| x.payload.clone())
    }

    #[test]
    fn an_image_carries_its_destination_not_its_content() {
        let (_, d) = built("![alt](assets/diagram.png)", None);
        assert_eq!(payload_of(&d, role::IMAGE).as_deref(), Some("assets/diagram.png"));
    }

    #[test]
    fn a_link_carries_its_destination() {
        let (_, d) = built("see [docs](https://example.dev/a?b=1)", None);
        assert_eq!(
            payload_of(&d, role::LINK_TEXT).as_deref(),
            Some("https://example.dev/a?b=1")
        );
    }

    #[test]
    fn a_registered_fence_carries_its_argument() {
        let (_, d) = built("```callout warning\nhi\n```\n", Some(MANIFEST));
        let w = d.iter().find(|x| x.kind == Kind::BlockWidget).unwrap();
        assert_eq!(w.payload.as_deref(), Some("warning"));
    }

    #[test]
    fn a_directive_block_carries_its_body() {
        let (_, d) = built(":::chart\nbars: 3\n:::\n", Some(MANIFEST));
        let w = d.iter().find(|x| x.kind == Kind::BlockWidget).unwrap();
        assert_eq!(w.payload.as_deref(), Some("bars: 3"));
    }

    #[test]
    fn a_delimited_token_carries_its_inner_text() {
        let (_, d) = built("see [[the roadmap]] please", Some(MANIFEST));
        let w = d.iter().find(|x| x.payload.is_some()).unwrap();
        assert_eq!(w.payload.as_deref(), Some("the roadmap"));
    }

    /// Payloads must not depend on the order rules were declared in.
    #[test]
    fn delimited_payloads_survive_a_pattern_rule_declared_first() {
        let (t, d) = built("@gabe and [[a note]] and @sam", Some(MANIFEST));
        let wiki: Vec<_> = d.iter().filter(|x| x.payload.is_some()).collect();
        assert_eq!(wiki.len(), 1);
        assert_eq!(wiki[0].payload.as_deref(), Some("a note"));
        assert_eq!(&t.as_str()[wiki[0].start..wiki[0].end], "[[a note]]");
    }

    #[test]
    fn output_is_position_sorted() {
        let (_, d) = built("# H\n\n**a** and *b* and `c`\n", Some(MANIFEST));
        assert!(d.windows(2).all(|w| w[0].start <= w[1].start));
    }
}
