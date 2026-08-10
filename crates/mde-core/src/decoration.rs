//! The decoration protocol (DESIGN §3).
//!
//! Primitives are a closed set so all three renderers implement a finite contract.
//! Roles are open strings so themes and extensions extend without protocol changes.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    /// Apply the theme's attribute set for `role`.
    Style = 0,
    /// Zero-width the range. Must not be independently selectable.
    Conceal = 1,
    /// Replaced element participating in line layout. Atomic.
    InlineWidget = 2,
    /// Replaced element owning whole lines. Atomic.
    BlockWidget = 3,
    /// Leading decoration outside the text run; does not shift text.
    Gutter = 4,
    /// Gesture target with no layout effect.
    Hit = 5,
}

/// When a concealed range reopens (DESIGN §3.1). A selection change therefore
/// produces a decoration patch — `set_selection` is a core entry point.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Reveal {
    #[default]
    Never = 0,
    CaretInNode = 1,
    CaretInLine = 2,
    CaretInBlock = 3,
}

/// Interned role id. The host resolves ids to names once via `Registry::role_name`.
pub type RoleId = u32;

/// Emitted across the FFI boundary as a flat `#[repr(C)]` array.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decoration {
    /// UTF-16 code units (DESIGN §3.2).
    pub start: u32,
    pub end: u32,
    pub key: u64,
    pub role: RoleId,
    pub kind: Kind,
    pub reveal: Reveal,
    /// Role-specific small integer: nesting level for quotes/lists, heading level for
    /// headings. Keeping parser-known metadata here prevents every renderer from
    /// re-parsing the same source.
    pub depth: u8,
    /// Paint order among decorations that would otherwise tie.
    ///
    /// `0` means the decoration was derived from the markdown. Higher values are
    /// host-supplied layers (§5.3), painted *after* parsed ones and in ascending order,
    /// so a layer can deliberately override what the parse decided — a focus-mode dim
    /// has to beat a heading's own colour, and cannot if the two only sort by kind.
    ///
    /// This occupies what was previously explicit padding, so the ABI is unchanged.
    pub layer: u8,
}

impl Decoration {
    pub fn new(start: u32, end: u32, kind: Kind, role: RoleId, key: u64) -> Self {
        Decoration { start, end, key, role, kind, reveal: Reveal::Never, depth: 0, layer: 0 }
    }

    pub fn with_reveal(mut self, r: Reveal) -> Self {
        self.reveal = r;
        self
    }

    pub fn with_depth(mut self, d: u8) -> Self {
        self.depth = d;
        self
    }

    pub fn with_layer(mut self, l: u8) -> Self {
        self.layer = l;
        self
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Patch {
    pub removed: Vec<u64>,
    pub added: Vec<Decoration>,
    /// Apply one translation to every surviving decoration whose old start is at or
    /// after `start`. Removals happen first, additions after; explicit moves override.
    pub shifted: Vec<Shift>,
    /// (key, new start, new end) — position changed, no rebuild required. This is
    /// what keeps an image from reloading while you type elsewhere.
    pub moved: Vec<(u64, u32, u32)>,
}

impl Patch {
    pub fn is_empty(&self) -> bool {
        self.removed.is_empty()
            && self.added.is_empty()
            && self.shifted.is_empty()
            && self.moved.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shift {
    pub start: u32,
    pub delta: i32,
}

/// Stable node identity (DESIGN §3.3).
///
/// Position is deliberately excluded from the hash: typing far away must not change
/// the key, or every widget rebuilds on every keystroke. `nth` disambiguates
/// byte-identical siblings, and *does* shift when a sibling is inserted before them —
/// an accepted cost, since identical siblings are visually interchangeable anyway.
///
/// `kind` participates so that two decorations covering the same source with the same
/// role — a `Conceal` and a `Style` over one marker — cannot collide.
pub fn node_key(kind: Kind, role: RoleId, source: &str, nth: u32) -> u64 {
    let mut h = DefaultHasher::new();
    (kind as u8).hash(&mut h);
    role.hash(&mut h);
    source.hash(&mut h);
    nth.hash(&mut h);
    h.finish()
}

/// Position-free identity shared by byte-identical decorations.
///
/// The full-build key adds an occurrence ordinal to disambiguate siblings. Regional
/// rebuilds use this fingerprint to pair new decorations with the old identities in
/// the replaced region, so editing one repeated node does not renumber every identical
/// sibling after it.
pub fn node_identity(kind: Kind, role: RoleId, source: &str) -> u64 {
    node_key(kind, role, source, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_is_position_independent() {
        let a = node_key(Kind::InlineWidget, 1, "![](a.png)", 0);
        let b = node_key(Kind::InlineWidget, 1, "![](a.png)", 0);
        assert_eq!(a, b);
    }

    #[test]
    fn key_changes_when_source_changes() {
        let a = node_key(Kind::InlineWidget, 1, "![](a.png)", 0);
        let b = node_key(Kind::InlineWidget, 1, "![](b.png)", 0);
        assert_ne!(a, b);
    }

    #[test]
    fn identical_siblings_are_disambiguated() {
        let a = node_key(Kind::InlineWidget, 1, "![](a.png)", 0);
        let b = node_key(Kind::InlineWidget, 1, "![](a.png)", 1);
        assert_ne!(a, b);
    }

    #[test]
    fn kind_participates_so_overlapping_decorations_do_not_collide() {
        let a = node_key(Kind::Conceal, 1, "**", 0);
        let b = node_key(Kind::Style, 1, "**", 0);
        assert_ne!(a, b);
    }

    #[test]
    fn decoration_is_ffi_sized() {
        // Guards against accidental layout growth on the hot path.
        assert_eq!(std::mem::size_of::<Decoration>(), 24);
    }
}
