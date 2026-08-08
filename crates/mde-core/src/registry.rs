//! Extension registry (DESIGN §5).
//!
//! Extensions are declarative data, not code. Nothing host-supplied executes inside
//! the parser: that is what keeps the per-keystroke path fast, identical across
//! platforms, and safe.

use crate::decoration::{Kind, Reveal, RoleId};
use regex_lite::Regex;
#[cfg(feature = "toml-manifest")]
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug)]
#[cfg_attr(feature = "toml-manifest", derive(Deserialize))]
#[cfg_attr(feature = "toml-manifest", serde(tag = "kind", rename_all = "snake_case"))]
pub enum BlockSyntax {
    /// ```` ```info ```` — CommonMark already parses this, so it costs the core
    /// nothing and no outside tool can corrupt it. Preferred form.
    Fence { info: String },
    /// `:::name` … `:::` — lighter visually, needs a custom block scan.
    Directive { marker: String, name: String },
}

#[derive(Debug)]
#[cfg_attr(feature = "toml-manifest", derive(Deserialize))]
#[cfg_attr(feature = "toml-manifest", serde(tag = "kind", rename_all = "snake_case"))]
pub enum InlineSyntax {
    Pattern { regex: String },
    Delimited { open: String, close: String },
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "toml-manifest", derive(Deserialize))]
#[cfg_attr(feature = "toml-manifest", serde(rename_all = "snake_case"))]
pub enum Render {
    Style,
    InlineWidget,
    BlockWidget,
    Hit,
}

impl Render {
    pub fn kind(self) -> Kind {
        match self {
            Render::Style => Kind::Style,
            Render::InlineWidget => Kind::InlineWidget,
            Render::BlockWidget => Kind::BlockWidget,
            Render::Hit => Kind::Hit,
        }
    }
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "toml-manifest", derive(Deserialize))]
#[cfg_attr(feature = "toml-manifest", serde(rename_all = "snake_case"))]
pub enum RevealSpec {
    #[default]
    Never,
    CaretInNode,
    CaretInLine,
    CaretInBlock,
}

impl From<RevealSpec> for Reveal {
    fn from(r: RevealSpec) -> Reveal {
        match r {
            RevealSpec::Never => Reveal::Never,
            RevealSpec::CaretInNode => Reveal::CaretInNode,
            RevealSpec::CaretInLine => Reveal::CaretInLine,
            RevealSpec::CaretInBlock => Reveal::CaretInBlock,
        }
    }
}

#[derive(Debug)]
#[cfg_attr(feature = "toml-manifest", derive(Deserialize))]
pub struct BlockDef {
    pub name: String,
    pub syntax: BlockSyntax,
    pub render: Render,
    #[cfg_attr(feature = "toml-manifest", serde(default))]
    pub reveal: RevealSpec,
}

#[derive(Debug)]
#[cfg_attr(feature = "toml-manifest", derive(Deserialize))]
pub struct InlineDef {
    pub name: String,
    pub syntax: InlineSyntax,
    pub render: Render,
    #[cfg_attr(feature = "toml-manifest", serde(default))]
    pub reveal: RevealSpec,
}

#[derive(Debug, Default)]
#[cfg_attr(feature = "toml-manifest", derive(Deserialize))]
pub struct Manifest {
    #[cfg_attr(feature = "toml-manifest", serde(default, rename = "block"))]
    pub blocks: Vec<BlockDef>,
    #[cfg_attr(feature = "toml-manifest", serde(default, rename = "inline"))]
    pub inlines: Vec<InlineDef>,
}

/// A compiled inline rule. Regexes are compiled once at registry construction, never
/// on the edit path.
pub struct InlineRule {
    pub role: RoleId,
    pub kind: Kind,
    pub reveal: Reveal,
    pub matcher: Matcher,
    /// A byte that must appear somewhere in a run for this rule to match it.
    ///
    /// `regex-lite` has no literal prescan, so a rule like `@[a-zA-Z0-9_-]+` walks every
    /// byte of every text run even when the document contains no `@` at all — measured
    /// at 26x the cost of the markdown parse itself. Checking for the byte first turns
    /// that into one `memchr`-shaped scan.
    pub prefilter: Option<u8>,
}

pub enum Matcher {
    Pattern(Regex),
    Delimited { open: String, close: String },
}

pub struct BlockRule {
    pub role: RoleId,
    pub kind: Kind,
    pub reveal: Reveal,
    pub syntax: BlockSyntax,
}

#[derive(Debug)]
pub enum RegistryError {
    Toml(String),
    Binary(&'static str),
    Regex { name: String, msg: String },
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegistryError::Toml(m) => write!(f, "manifest parse error: {m}"),
            RegistryError::Binary(m) => write!(f, "binary manifest is malformed: {m}"),
            RegistryError::Regex { name, msg } => {
                write!(f, "inline `{name}` has an invalid regex: {msg}")
            }
        }
    }
}

impl std::error::Error for RegistryError {}

/// Compact binary encoding of a `Manifest`, for hosts that compile the TOML
/// themselves (see the `toml-manifest` feature). Little-endian throughout:
///
/// ```text
///   [4] magic "MDEM"
///   [4] u32 block_count
///   [4] u32 inline_count
///   block_count  x  { u8 render, u8 reveal, u8 syntax, u8 _pad, str name, str a, str b }
///   inline_count x  { u8 render, u8 reveal, u8 syntax, u8 _pad, str name, str a, str b }
///   str := u32 byte_len, then that many UTF-8 bytes
/// ```
///
/// `syntax` is 0 = fence / pattern, 1 = directive / delimited. For a fence, `a` is the
/// info string and `b` is empty; for a directive, `a` is the marker and `b` the name.
/// For a pattern, `a` is the regex; for a delimiter pair, `a` is open and `b` is close.
pub mod binary {
    pub const MAGIC: [u8; 4] = *b"MDEM";
}

struct Cursor<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn u32(&mut self) -> Result<u32, RegistryError> {
        let end = self.pos.checked_add(4).ok_or(RegistryError::Binary("overflow"))?;
        let slice = self.buf.get(self.pos..end).ok_or(RegistryError::Binary("truncated u32"))?;
        self.pos = end;
        Ok(u32::from_le_bytes(slice.try_into().unwrap()))
    }

    fn u8(&mut self) -> Result<u8, RegistryError> {
        let b = *self.buf.get(self.pos).ok_or(RegistryError::Binary("truncated u8"))?;
        self.pos += 1;
        Ok(b)
    }

    fn string(&mut self) -> Result<String, RegistryError> {
        let len = self.u32()? as usize;
        let end = self.pos.checked_add(len).ok_or(RegistryError::Binary("overflow"))?;
        let slice = self.buf.get(self.pos..end).ok_or(RegistryError::Binary("truncated string"))?;
        self.pos = end;
        std::str::from_utf8(slice)
            .map(str::to_string)
            .map_err(|_| RegistryError::Binary("string is not UTF-8"))
    }
}

/// The first byte every match of `regex` must contain, when that is provable by
/// inspection alone.
///
/// Deliberately timid: anything that is not an unambiguous leading literal returns
/// `None`, which just means the rule keeps its old cost. A wrong answer here would
/// silently drop matches, so the bar is proof, not likelihood.
fn literal_first_byte(regex: &str) -> Option<u8> {
    let bytes = regex.as_bytes();
    let mut i = 0;
    // A leading anchor does not change which bytes can appear.
    if bytes.first() == Some(&b'^') {
        i = 1;
    }
    let first = *bytes.get(i)?;
    // Metacharacters mean the first byte is not fixed. `\` could introduce an escaped
    // literal, but also a class like `\d`, so it is excluded too.
    if b"^$.[](){}*+?|\\".contains(&first) {
        return None;
    }
    // A quantifier right after the first character can make it optional.
    if matches!(bytes.get(i + 1), Some(b'?' | b'*' | b'{')) {
        return None;
    }
    // Multi-byte UTF-8: the leading byte is still required and still unique to it.
    Some(first)
}

fn render_from_u8(v: u8) -> Result<Render, RegistryError> {
    Ok(match v {
        0 => Render::Style,
        1 => Render::InlineWidget,
        2 => Render::BlockWidget,
        3 => Render::Hit,
        _ => return Err(RegistryError::Binary("unknown render")),
    })
}

fn reveal_from_u8(v: u8) -> Result<RevealSpec, RegistryError> {
    Ok(match v {
        0 => RevealSpec::Never,
        1 => RevealSpec::CaretInNode,
        2 => RevealSpec::CaretInLine,
        3 => RevealSpec::CaretInBlock,
        _ => return Err(RegistryError::Binary("unknown reveal")),
    })
}

pub struct Registry {
    roles: Vec<String>,
    role_ids: HashMap<String, RoleId>,
    pub blocks: Vec<BlockRule>,
    pub inlines: Vec<InlineRule>,
}

/// Built-in roles are interned first so their ids are stable constants that renderers
/// and themes can rely on without a lookup.
pub mod role {
    use crate::decoration::RoleId;
    pub const HEADING: RoleId = 0;
    pub const MARKER: RoleId = 1;
    pub const EMPHASIS: RoleId = 2;
    pub const STRONG: RoleId = 3;
    pub const CODE_INLINE: RoleId = 4;
    pub const CODE_BLOCK: RoleId = 5;
    pub const LINK: RoleId = 6;
    pub const LINK_TEXT: RoleId = 7;
    pub const IMAGE: RoleId = 8;
    pub const QUOTE: RoleId = 9;
    pub const LIST_BULLET: RoleId = 10;
    pub const TASK_CHECKBOX: RoleId = 11;
    pub const RULE: RoleId = 12;
    pub const STRIKETHROUGH: RoleId = 13;
    pub const TABLE: RoleId = 14;
    pub const TABLE_HEADER: RoleId = 15;
    pub const TABLE_DELIMITER: RoleId = 16;
    pub const TABLE_CELL: RoleId = 17;
    pub const HTML: RoleId = 18;
    pub const BUILTIN: &[&str] = &[
        "heading",
        "marker",
        "emphasis",
        "strong",
        "code.inline",
        "code.block",
        "link",
        "link.text",
        "image",
        "quote",
        "list.bullet",
        "task.checkbox",
        "rule",
        "strikethrough",
        "table",
        "table.header",
        "table.delimiter",
        "table.cell",
        "html",
    ];
}

impl Registry {
    pub fn empty() -> Self {
        Registry::from_manifest(Manifest::default()).expect("empty manifest is valid")
    }

    #[cfg(feature = "toml-manifest")]
    pub fn from_toml(src: &str) -> Result<Self, RegistryError> {
        let m: Manifest = toml::from_str(src).map_err(|e| RegistryError::Toml(e.to_string()))?;
        Registry::from_manifest(m)
    }

    /// Decode the compact form documented on [`binary`]. Always available, so web
    /// builds can drop the TOML parser entirely.
    pub fn from_binary(buf: &[u8]) -> Result<Self, RegistryError> {
        if buf.len() < 4 || buf[..4] != binary::MAGIC {
            return Err(RegistryError::Binary("bad magic"));
        }
        let mut c = Cursor { buf, pos: 4 };
        let n_blocks = c.u32()?;
        let n_inlines = c.u32()?;

        let mut m = Manifest::default();
        for _ in 0..n_blocks {
            let (render, reveal, syntax) = (c.u8()?, c.u8()?, c.u8()?);
            c.u8()?; // padding
            let (name, a, b) = (c.string()?, c.string()?, c.string()?);
            m.blocks.push(BlockDef {
                name,
                syntax: match syntax {
                    0 => BlockSyntax::Fence { info: a },
                    1 => BlockSyntax::Directive { marker: a, name: b },
                    _ => return Err(RegistryError::Binary("unknown block syntax")),
                },
                render: render_from_u8(render)?,
                reveal: reveal_from_u8(reveal)?,
            });
        }
        for _ in 0..n_inlines {
            let (render, reveal, syntax) = (c.u8()?, c.u8()?, c.u8()?);
            c.u8()?; // padding
            let (name, a, b) = (c.string()?, c.string()?, c.string()?);
            m.inlines.push(InlineDef {
                name,
                syntax: match syntax {
                    0 => InlineSyntax::Pattern { regex: a },
                    1 => InlineSyntax::Delimited { open: a, close: b },
                    _ => return Err(RegistryError::Binary("unknown inline syntax")),
                },
                render: render_from_u8(render)?,
                reveal: reveal_from_u8(reveal)?,
            });
        }
        Registry::from_manifest(m)
    }

    /// Encode a manifest into the binary form. Used by tests and by host-side tooling
    /// that compiles TOML ahead of time.
    pub fn encode_binary(m: &Manifest) -> Vec<u8> {
        fn put_str(out: &mut Vec<u8>, s: &str) {
            out.extend_from_slice(&(s.len() as u32).to_le_bytes());
            out.extend_from_slice(s.as_bytes());
        }
        let mut out = Vec::new();
        out.extend_from_slice(&binary::MAGIC);
        out.extend_from_slice(&(m.blocks.len() as u32).to_le_bytes());
        out.extend_from_slice(&(m.inlines.len() as u32).to_le_bytes());
        for b in &m.blocks {
            let (syntax, a, x) = match &b.syntax {
                BlockSyntax::Fence { info } => (0u8, info.as_str(), ""),
                BlockSyntax::Directive { marker, name } => (1u8, marker.as_str(), name.as_str()),
            };
            out.extend_from_slice(&[b.render as u8, b.reveal as u8, syntax, 0]);
            put_str(&mut out, &b.name);
            put_str(&mut out, a);
            put_str(&mut out, x);
        }
        for i in &m.inlines {
            let (syntax, a, x) = match &i.syntax {
                InlineSyntax::Pattern { regex } => (0u8, regex.as_str(), ""),
                InlineSyntax::Delimited { open, close } => (1u8, open.as_str(), close.as_str()),
            };
            out.extend_from_slice(&[i.render as u8, i.reveal as u8, syntax, 0]);
            put_str(&mut out, &i.name);
            put_str(&mut out, a);
            put_str(&mut out, x);
        }
        out
    }

    pub fn from_manifest(m: Manifest) -> Result<Self, RegistryError> {
        let mut r = Registry {
            roles: Vec::new(),
            role_ids: HashMap::new(),
            blocks: Vec::new(),
            inlines: Vec::new(),
        };
        for name in role::BUILTIN {
            r.intern(name);
        }
        debug_assert_eq!(r.roles.len(), role::BUILTIN.len());

        for b in m.blocks {
            let role = r.intern(&b.name);
            r.blocks.push(BlockRule {
                role,
                kind: b.render.kind(),
                reveal: b.reveal.into(),
                syntax: b.syntax,
            });
        }
        for i in m.inlines {
            let role = r.intern(&i.name);
            let matcher = match &i.syntax {
                InlineSyntax::Pattern { regex } => Matcher::Pattern(Regex::new(regex).map_err(
                    |e| RegistryError::Regex { name: i.name.clone(), msg: e.to_string() },
                )?),
                InlineSyntax::Delimited { open, close } => {
                    Matcher::Delimited { open: open.clone(), close: close.clone() }
                }
            };
            let prefilter = match &i.syntax {
                InlineSyntax::Pattern { regex } => literal_first_byte(regex),
                InlineSyntax::Delimited { open, .. } => open.as_bytes().first().copied(),
            };
            r.inlines.push(InlineRule {
                role,
                kind: i.render.kind(),
                reveal: i.reveal.into(),
                matcher,
                prefilter,
            });
        }
        Ok(r)
    }

    pub(crate) fn intern(&mut self, name: &str) -> RoleId {
        if let Some(&id) = self.role_ids.get(name) {
            return id;
        }
        let id = self.roles.len() as RoleId;
        self.roles.push(name.to_string());
        self.role_ids.insert(name.to_string(), id);
        id
    }

    pub fn role_name(&self, id: RoleId) -> Option<&str> {
        self.roles.get(id as usize).map(|s| s.as_str())
    }

    pub fn role_count(&self) -> usize {
        self.roles.len()
    }

    /// The block rule matching a fence info string, if any.
    pub fn block_for_fence(&self, info: &str) -> Option<&BlockRule> {
        let word = info.split_whitespace().next().unwrap_or("");
        self.blocks.iter().find(|b| match &b.syntax {
            BlockSyntax::Fence { info } => info == word,
            _ => false,
        })
    }
}

#[cfg(all(test, feature = "toml-manifest"))]
mod tests {
    use super::*;

    const MANIFEST: &str = r#"
        [[block]]
        name   = "callout"
        syntax = { kind = "fence", info = "callout" }
        render = "block_widget"
        reveal = "caret_in_block"

        [[inline]]
        name   = "mention"
        syntax = { kind = "pattern", regex = "@[a-zA-Z0-9_-]+" }
        render = "inline_widget"
        reveal = "caret_in_node"
    "#;

    #[test]
    fn parses_the_design_doc_manifest() {
        let r = Registry::from_toml(MANIFEST).unwrap();
        assert_eq!(r.blocks.len(), 1);
        assert_eq!(r.inlines.len(), 1);
        assert_eq!(r.blocks[0].kind, Kind::BlockWidget);
        assert_eq!(r.blocks[0].reveal, Reveal::CaretInBlock);
        assert_eq!(r.role_name(r.inlines[0].role), Some("mention"));
    }

    #[test]
    fn builtin_role_ids_are_stable() {
        let r = Registry::from_toml(MANIFEST).unwrap();
        assert_eq!(r.role_name(role::HEADING), Some("heading"));
        assert_eq!(r.role_name(role::TASK_CHECKBOX), Some("task.checkbox"));
        assert_eq!(r.role_name(role::TABLE), Some("table"));
        assert_eq!(r.role_name(role::TABLE_HEADER), Some("table.header"));
        assert_eq!(r.role_name(role::TABLE_DELIMITER), Some("table.delimiter"));
        assert_eq!(r.role_name(role::TABLE_CELL), Some("table.cell"));
        assert_eq!(r.role_name(role::HTML), Some("html"));
        assert_eq!(r.role_count(), role::BUILTIN.len() + 2);
        // Extension roles are interned after the built-ins, never before.
        assert!(r.blocks[0].role >= role::BUILTIN.len() as RoleId);
    }

    #[test]
    fn fence_info_matches_first_word_only() {
        let r = Registry::from_toml(MANIFEST).unwrap();
        assert!(r.block_for_fence("callout").is_some());
        assert!(r.block_for_fence("callout warning").is_some());
        assert!(r.block_for_fence("rust").is_none());
    }

    #[test]
    fn binary_manifest_round_trips_the_toml_form() {
        let from_toml = Registry::from_toml(MANIFEST).unwrap();
        let manifest: Manifest = toml::from_str(MANIFEST).unwrap();
        let encoded = Registry::encode_binary(&manifest);
        let from_bin = Registry::from_binary(&encoded).unwrap();

        assert_eq!(from_bin.blocks.len(), from_toml.blocks.len());
        assert_eq!(from_bin.inlines.len(), from_toml.inlines.len());
        assert_eq!(from_bin.role_count(), from_toml.role_count());
        for id in 0..from_toml.role_count() as RoleId {
            assert_eq!(from_bin.role_name(id), from_toml.role_name(id));
        }
        assert_eq!(from_bin.blocks[0].kind, from_toml.blocks[0].kind);
        assert_eq!(from_bin.blocks[0].reveal, from_toml.blocks[0].reveal);
        assert!(from_bin.block_for_fence("callout").is_some());
    }

    #[test]
    fn a_truncated_binary_manifest_is_an_error_not_a_panic() {
        let manifest: Manifest = toml::from_str(MANIFEST).unwrap();
        let encoded = Registry::encode_binary(&manifest);
        for cut in [0, 3, 8, 20, encoded.len() - 1] {
            assert!(Registry::from_binary(&encoded[..cut]).is_err(), "len {cut} should fail");
        }
        assert!(matches!(
            Registry::from_binary(b"XXXX\0\0\0\0"),
            Err(RegistryError::Binary("bad magic"))
        ));
    }

    #[test]
    fn prefilters_are_extracted_only_when_provable() {
        assert_eq!(literal_first_byte("@[a-z]+"), Some(b'@'));
        assert_eq!(literal_first_byte("^#tag"), Some(b'#'));
        // A quantifier can make the first character optional.
        assert_eq!(literal_first_byte("a?bc"), None);
        assert_eq!(literal_first_byte("a*bc"), None);
        // Anything that is not plainly a literal is refused rather than guessed at.
        assert_eq!(literal_first_byte("[abc]+"), None);
        assert_eq!(literal_first_byte("\\d+"), None);
        assert_eq!(literal_first_byte("(foo|bar)"), None);
        assert_eq!(literal_first_byte(""), None);
    }

    #[test]
    fn a_rules_prefilter_is_a_byte_every_match_must_contain() {
        let r = Registry::from_toml(MANIFEST).unwrap();
        assert_eq!(r.inlines[0].prefilter, Some(b'@'));
    }

    #[test]
    fn bad_regex_is_a_construction_error_not_a_panic() {
        let bad = r#"
            [[inline]]
            name   = "oops"
            syntax = { kind = "pattern", regex = "([" }
            render = "style"
        "#;
        assert!(matches!(Registry::from_toml(bad), Err(RegistryError::Regex { .. })));
    }
}
