//! `mde-core` — the shared brain behind the iOS, macOS, and web renderers.
//!
//! The core never mutates text. It is a pure function of
//! `(edit stream, selection, registry)`, which makes every bug reducible to a
//! recorded edit log — also the golden-test format. See `DESIGN.md`.

pub mod decorate;
pub mod decoration;
pub mod diff;
pub mod fasthash;
pub mod history;
pub mod region;
pub mod registry;
pub mod text;

pub use decoration::{Decoration, Kind, Patch, Reveal, RoleId, Shift};
pub use history::{Rewind, RevisionInfo, RevisionKind, COALESCE_WINDOW_MS};
pub use registry::{Registry, RegistryError};
pub use text::{Edit, EditError};

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use decorate::Built;
use history::History;
use fasthash::FastMap;
use text::Text;

/// UTF-16 code unit offsets, matching the platform buffers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Selection {
    pub anchor: u32,
    pub head: u32,
}

impl Selection {
    pub fn caret(at: u32) -> Self {
        Selection { anchor: at, head: at }
    }
    fn ordered(&self) -> (u32, u32) {
        (self.anchor.min(self.head), self.anchor.max(self.head))
    }
}

/// One host-supplied decoration, offsets in UTF-16 code units.
///
/// This is the input side of `Engine::set_layer` — see there for what layers are for.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayerSpan {
    pub start: u32,
    pub end: u32,
    pub role: RoleId,
    pub kind: Kind,
    pub depth: u8,
}

/// A named set of host-supplied decorations, kept in UTF-8 offsets internally.
#[derive(Debug, Clone)]
struct Layer {
    name: String,
    /// (start, end, role, kind, depth) in UTF-8 byte offsets.
    spans: Vec<(usize, usize, RoleId, Kind, u8)>,
}

pub struct Engine {
    text: Text,
    registry: Registry,
    built: Vec<Built>,
    emitted: Vec<Decoration>,
    /// Parser-supplied extra text per decoration key — image and link destinations,
    /// table alignments, fence arguments, delimited inner text. Rebuilt on every reparse.
    payloads: FastMap<u64, String>,
    /// `None` means unfocused — no caret, so nothing reveals. A document opened but
    /// not yet edited must render fully collapsed; without this state a caret
    /// implicitly parked at offset 0 would reveal the first heading's `#` on load.
    selection: Option<Selection>,
    history: History,
    /// Host-supplied decorations that no parse produced (DESIGN §5.3). Ordered: a
    /// layer's index is its paint order, so a later layer overrides an earlier one.
    layers: Vec<Layer>,
    /// Safe block boundaries for the current text. Ordinary edits shift this index in
    /// place; structural edits rescan it. `None` means regional parsing is unsafe.
    regions: Option<region::Regions>,
}

impl Engine {
    pub fn new(registry: Registry) -> Self {
        Engine {
            text: Text::new(""),
            registry,
            built: Vec::new(),
            emitted: Vec::new(),
            payloads: FastMap::default(),
            selection: None,
            history: History::new(),
            layers: Vec::new(),
            regions: None,
        }
    }

    #[cfg(feature = "toml-manifest")]
    pub fn from_toml(manifest: &str) -> Result<Self, RegistryError> {
        Ok(Engine::new(Registry::from_toml(manifest)?))
    }

    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    pub fn text(&self) -> &str {
        self.text.as_str()
    }

    /// `None` when unfocused.
    pub fn selection(&self) -> Option<Selection> {
        self.selection
    }

    /// Current effective decoration set, reveal already applied.
    pub fn decorations(&self) -> &[Decoration] {
        &self.emitted
    }

    /// Full resync. Also the recovery path after `EditError::Desync`. Focus state is
    /// preserved: a resync mid-typing must not blur the editor.
    ///
    /// History is cleared. After a desync the recorded offsets describe a document
    /// that never existed on the platform side, so replaying them would corrupt the
    /// buffer — dropping the history is the only safe option.
    pub fn reset(&mut self, text: &str) -> Patch {
        self.text = Text::new(text);
        self.history.clear();
        // Drop the previous emission before reparsing. `reset` means "here is a new
        // document" and callers clear their own state to match, so the patch has to be
        // a complete set of additions. Diffing against the old emission instead makes
        // reopening an *identical* document return an empty patch — and the renderer,
        // having just cleared itself, would show the whole file unstyled.
        self.emitted.clear();
        // Host-computed ranges describe the *old* document; nothing can rebase them.
        self.layers.clear();
        self.clamp_selection();
        self.reparse()
    }

    /// Apply platform-side edits and record them in the undo history.
    ///
    /// `expected_len` is the platform's post-edit length in UTF-16 code units; on
    /// mismatch the core reports a desync instead of emitting decorations from a
    /// drifted mirror. `now_ms` drives undo coalescing — consecutive keystrokes within
    /// `COALESCE_WINDOW_MS` merge into one step.
    ///
    /// Do **not** call this for edits that came from `undo`/`redo`; those are already
    /// recorded, and reporting them back would push them onto the history again.
    pub fn edit(
        &mut self,
        edits: &[Edit],
        expected_len: Option<u32>,
        now_ms: u64,
    ) -> Result<Patch, EditError> {
        let sel_before = self.selection;
        // Byte span of the edit in the pre-edit document, captured before the mirror
        // moves; the incremental path needs both sides of the change.
        let span = single_edit_span(edits, &self.text);
        let reuse_regions = match (span, edits) {
            (Some((start, end, _)), [edit]) => self.regions.as_ref().is_some_and(|regions| {
                regions.can_shift_for_edit(
                    self.text.as_str(), start, end, &edit.text, &self.registry,
                )
            }),
            _ => false,
        };
        let inverse = self.text.apply(edits, expected_len)?;
        self.clamp_selection();
        self.history.record(edits, inverse, sel_before, self.selection, now_ms);
        Ok(self.rebuild(span, reuse_regions))
    }

    /// Force the next edit to begin a new undo step. Call before a command that
    /// rewrites text so it never merges into the surrounding typing run.
    pub fn boundary(&mut self) {
        self.history.close_group();
    }

    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    /// Step back one revision. The returned `edits` must be applied to the platform's
    /// own buffer *without* being reported back through `edit`.
    pub fn undo(&mut self) -> Option<(Rewind, Patch)> {
        let rewind = self.history.undo()?;
        Some(self.rewind(rewind))
    }

    pub fn redo(&mut self) -> Option<(Rewind, Patch)> {
        let rewind = self.history.redo()?;
        Some(self.rewind(rewind))
    }

    fn rewind(&mut self, rewind: Rewind) -> (Rewind, Patch) {
        // Inverse edits were derived from this exact document, so they cannot be out
        // of bounds or overlapping unless the mirror already drifted — in which case
        // the desync check on the next `edit` is the right place to catch it.
        let _ = self.text.apply(&rewind.edits, None);
        self.selection = rewind.selection;
        self.clamp_selection();
        let patch = self.reparse();
        (rewind, patch)
    }

    /// Selection changes produce decoration patches, because reveal policy is
    /// selection-dependent (DESIGN §3.1). No reparse is needed.
    ///
    /// Pass `None` on blur so the document collapses back to its rendered form.
    pub fn set_selection(&mut self, sel: Option<Selection>) -> Patch {
        let before = self.selection;
        self.selection = sel;
        self.clamp_selection();
        // Browser selectionchange and TextKit delegate callbacks can repeat the same
        // range several times for one gesture. Reveal is a pure function of the
        // clamped selection, so walking and diffing the entire decoration set again
        // cannot produce useful work.
        if self.selection == before {
            return Patch::default();
        }
        self.emit()
    }

    fn clamp_selection(&mut self) {
        let len = self.text.len_utf16();
        self.selection = self
            .selection
            .map(|s| Selection { anchor: s.anchor.min(len), head: s.head.min(len) });
    }


    // MARK: - Host decoration layers (DESIGN §5.3)

    /// Get (or create) the role id for a name, so a host can decorate with roles that
    /// no manifest declared.
    ///
    /// Roles are open strings by design (§3): the core never interprets one, it only
    /// hands it back so the renderer's theme can look it up. That is what lets a
    /// feature like focus mode or a parts-of-speech highlighter live entirely outside
    /// the core while still using the same decoration pipeline.
    pub fn intern_role(&mut self, name: &str) -> RoleId {
        self.registry.intern(name)
    }

    /// Replace the contents of a named layer, returning the resulting patch.
    ///
    /// A layer is decoration that no parse produced — it comes from the host, computed
    /// from something the core knows nothing about: where the caret is, what a language
    /// tagger thinks a word is, whose comment is attached to a range. The spans flow
    /// through exactly the same machinery as parsed decorations (identity, diffing,
    /// `moved`, reveal-free painting), so a renderer needs no new code to draw them.
    ///
    /// Layers paint in registration order, after everything the parse produced.
    ///
    /// Keys deliberately include position. Elsewhere position is excluded so a widget
    /// survives an edit without being rebuilt (§3.3); here the opposite is wanted,
    /// because a layer span that moves is a *styling* change and the renderer has to
    /// repaint the range it left as well as the one it arrived at. Keying on position
    /// turns a move into a remove plus an add, which is exactly the repaint needed.
    pub fn set_layer(&mut self, name: &str, spans: &[LayerSpan]) -> Patch {
        let len = self.text.len_utf16();
        let mut resolved: Vec<(usize, usize, RoleId, Kind, u8)> = Vec::with_capacity(spans.len());
        for s in spans {
            let (lo, hi) = (s.start.min(s.end).min(len), s.end.max(s.start).min(len));
            if lo == hi {
                continue;
            }
            resolved.push((
                self.text.utf16_to_utf8(lo),
                self.text.utf16_to_utf8(hi),
                s.role,
                s.kind,
                s.depth,
            ));
        }
        match self.layers.iter_mut().find(|l| l.name == name) {
            Some(existing) => existing.spans = resolved,
            None => self.layers.push(Layer { name: name.to_string(), spans: resolved }),
        }
        self.emit()
    }

    /// Remove a layer entirely. Turning a feature off is not the same as pushing no
    /// spans — an empty layer still occupies a paint slot.
    pub fn clear_layer(&mut self, name: &str) -> Patch {
        self.layers.retain(|l| l.name != name);
        self.emit()
    }

    pub fn layer_count(&self) -> usize {
        self.layers.len()
    }

    // MARK: - Browsable history (DESIGN §9)

    /// Every revision, oldest first, including ones that have been undone.
    pub fn revisions(&self) -> Vec<RevisionInfo> {
        self.history.revisions()
    }

    /// How many revisions are currently applied — the caret's position in the timeline.
    pub fn history_position(&self) -> usize {
        self.history.position()
    }

    /// Move to any point in the timeline, not just one step.
    ///
    /// Undo and redo are the two-button version of this; a history panel needs to land
    /// anywhere, including several revisions back, in one move.
    ///
    /// The returned `Rewind` is deliberately **one edit**, not the concatenation of the
    /// individual steps. Each step's edits are expressed in the coordinates of the
    /// document as it was at that step, so replaying a chain of them requires the host
    /// to apply every intermediate state in exactly the right order — and any host that
    /// gets it subtly wrong desyncs. Diffing the start and end text instead gives one
    /// replacement that is correct however the host applies it, and collapses a jump
    /// across fifty revisions into a single splice.
    ///
    /// Returns `None` if the target is out of range or already current.
    pub fn jump_to(&mut self, target: usize) -> Option<(Rewind, Patch)> {
        let (past, future) = self.history.depth();
        if target > past + future || target == past {
            return None;
        }

        let before = self.text.as_str().to_string();
        let mut selection = self.selection;
        while self.history.position() > target {
            let step = self.history.undo()?;
            let _ = self.text.apply(&step.edits, None);
            selection = step.selection;
        }
        while self.history.position() < target {
            let step = self.history.redo()?;
            let _ = self.text.apply(&step.edits, None);
            selection = step.selection;
        }

        let after = self.text.as_str();
        let edit = single_replacement(&before, after);
        self.selection = selection;
        self.clamp_selection();
        let patch = self.reparse();
        Some((Rewind { edits: vec![edit], selection: self.selection }, patch))
    }

    /// Extra text the parser already resolved for this decoration: an image or link
    /// destination, a fence argument, the inside of a delimited token.
    ///
    /// Renderers use this instead of re-parsing markdown — a destination like
    /// `![a](b.png)` is a *reference*; resolving it to bytes is the host's job, and the
    /// document never carries the content itself.
    pub fn payload(&self, key: u64) -> Option<&str> {
        self.payloads.get(&key).map(String::as_str)
    }

    /// Rebuild decorations after an edit, reparsing only what the edit could have
    /// changed when that is provably enough (DESIGN §2.2).
    ///
    /// Falls back to a full reparse whenever the region scan cannot vouch for the
    /// document. The fallback is not a rare path to be embarrassed about — it is what
    /// makes the optimization safe to have at all.
    fn rebuild(&mut self, span: Option<(usize, usize, isize)>, reuse_regions: bool) -> Patch {
        self.rebase_layers(span);
        let trusted_before = self.regions.is_some();
        if reuse_regions {
            let (_, old_end, delta) = span.expect("a shifted region index belongs to one edit");
            self.regions
                .as_mut()
                .expect("only a trusted region index can be reused")
                .shift_after(old_end, delta);
        } else {
            self.regions = region::Regions::scan(self.text.as_str(), &self.registry);
        }

        let (Some((old_start, old_end, delta)), Some(regions), true) =
            (span, self.regions.as_ref(), trusted_before)
        else {
            return self.full_rebuild();
        };
        let src = self.text.as_str();

        let new_end = (old_end as isize + delta) as usize;
        // `new_end + 1`, not `new_end`: an edit sitting exactly on a boundary still
        // changes the block that *starts* there — inserting a newline at the first
        // character of an indented code block turns it into a paragraph. Without the
        // extra character that block looks untouched and its old decorations survive.
        let (mut lo, mut hi) = regions.enclosing(old_start, new_end + 1, src.len());

        // Boundaries describe the *new* document, but the decorations being kept
        // describe the old one. An edit that splits a paragraph invents a boundary
        // inside a block that used to be whole, and a decoration in that block then
        // belongs to neither the kept prefix nor the rebuilt region — it just
        // disappears. Widen until no surviving block straddles either edge.
        loop {
            let old_hi = (hi as isize - delta) as usize;
            let mut widened = false;

            if let Some(start) = self
                .built
                .iter()
                .filter(|d| d.block.0 < lo && d.block.1 > lo)
                .map(|d| d.block.0)
                .min()
            {
                let next = regions.at_or_before(start);
                if next < lo {
                    lo = next;
                    widened = true;
                }
            }
            if let Some(end) = self
                .built
                .iter()
                .filter(|d| d.block.0 < old_hi && d.block.1 > old_hi)
                .map(|d| d.block.1)
                .max()
            {
                let next = regions.at_or_after((end as isize + delta) as usize, src.len());
                if next > hi {
                    hi = next;
                    widened = true;
                }
            }
            if !widened {
                break;
            }
        }

        // Reparsing nearly everything is slower than reparsing everything, once the
        // splice and the boundary scan are counted.
        if hi - lo > src.len() / 2 {
            return self.full_rebuild();
        }
        let old_hi = (hi as isize - delta) as usize;
        let region = decorate::build_region(&src[lo..hi], &self.registry, lo);

        // Widening guaranteed no block straddles either edge, so every decoration is
        // wholly before `lo`, wholly inside the region, or wholly at/after `old_hi` —
        // which makes the split a partition on `start` alone, and the splice an
        // in-place mutation rather than a rebuild. Cloning the list here instead cost
        // an allocation per decoration with a payload, on every keystroke.
        let first = self.built.partition_point(|d| d.start < lo);
        let last = self.built.partition_point(|d| d.start < old_hi);
        for d in &mut self.built[last..] {
            shift(d, delta);
        }
        self.built.splice(first..last, region);

        // Keys depend on how many byte-identical siblings precede a node, so they are
        // reassigned over the whole list — cheap, and it is what keeps an incremental
        // result identical to a full reparse.
        decorate::assign_keys(&mut self.built, src);
        self.rebuild_payloads();
        self.emit()
    }

    fn reparse(&mut self) -> Patch {
        self.regions = region::Regions::scan(self.text.as_str(), &self.registry);
        self.full_rebuild()
    }

    fn full_rebuild(&mut self) -> Patch {
        self.built = decorate::build(&self.text, &self.registry);
        self.rebuild_payloads();
        self.emit()
    }

    /// Slide host layer spans over an edit.
    ///
    /// A layer is computed from the *old* text, so after an edit its offsets are stale.
    /// The host will recompute — a focus band on the next selection change, a language
    /// tagger on the next idle — but "eventually" is not good enough while someone is
    /// typing: without this, every keystroke visibly drags the highlighting out of
    /// alignment with the words underneath it until the host catches up.
    ///
    /// Spans wholly after the edit shift; spans wholly before are untouched; spans the
    /// edit actually landed inside are dropped, because nothing here can know what the
    /// host would now say about that text. Dropping is the honest answer: a stale span
    /// that survives is a lie about the new text, and the host re-pushes shortly.
    fn rebase_layers(&mut self, span: Option<(usize, usize, isize)>) {
        let Some((start, end, delta)) = span else {
            // A batch edit is a command, not a keystroke; the host re-pushes.
            for layer in &mut self.layers {
                layer.spans.clear();
            }
            return;
        };
        for layer in &mut self.layers {
            layer.spans.retain_mut(|s| {
                if s.1 <= start {
                    return true;
                }
                if s.0 >= end {
                    s.0 = (s.0 as isize + delta).max(0) as usize;
                    s.1 = (s.1 as isize + delta).max(0) as usize;
                    return true;
                }
                false
            });
        }
    }

    fn rebuild_payloads(&mut self) {
        self.payloads = self
            .built
            .iter()
            .filter_map(|b| b.payload.as_ref().map(|p| (b.key, p.clone())))
            .collect();
    }

    fn emit(&mut self) -> Patch {
        // Unfocused: no caret, so nothing reveals.
        let sel = self.selection.map(|s| {
            let (lo, hi) = s.ordered();
            (self.text.utf16_to_utf8(lo), self.text.utf16_to_utf8(hi))
        });

        let mut next = Vec::with_capacity(self.built.len());
        for b in &self.built {
            let revealed = match (sel, b.reveal) {
                (None, _) | (_, Reveal::Never) => false,
                (Some((lo, hi)), Reveal::CaretInNode) => intersects(lo, hi, b.node.0, b.node.1),
                (Some((lo, hi)), Reveal::CaretInLine) => {
                    let s = self.text.line_range(b.node.0).0;
                    let e = self.text.line_range(b.node.1.min(self.text.as_str().len())).1;
                    intersects(lo, hi, s, e)
                }
                (Some((lo, hi)), Reveal::CaretInBlock) => {
                    intersects(lo, hi, b.block.0, b.block.1)
                }
            };

            // Revealing collapses a hiding primitive to plain styled source, keeping
            // the same key and role so the renderer's theme still applies.
            let kind = if revealed {
                match b.kind {
                    Kind::Conceal | Kind::InlineWidget | Kind::BlockWidget => Kind::Style,
                    k => k,
                }
            } else {
                b.kind
            };

            next.push(Decoration {
                start: self.text.utf8_to_utf16(b.start),
                end: self.text.utf8_to_utf16(b.end),
                key: b.key,
                role: b.role,
                kind,
                reveal: b.reveal,
                depth: b.depth,
                layer: 0,
            });
        }

        // Host layers last, so they paint over what the parse decided.
        for (index, layer) in self.layers.iter().enumerate() {
            let ordinal = (index as u8).saturating_add(1);
            for &(start, end, role, kind, depth) in &layer.spans {
                let (s16, e16) = (self.text.utf8_to_utf16(start), self.text.utf8_to_utf16(end));
                let mut hasher = DefaultHasher::new();
                layer.name.hash(&mut hasher);
                role.hash(&mut hasher);
                s16.hash(&mut hasher);
                e16.hash(&mut hasher);
                next.push(Decoration {
                    start: s16,
                    end: e16,
                    key: hasher.finish(),
                    role,
                    kind,
                    reveal: Reveal::Never,
                    depth,
                    layer: ordinal,
                });
            }
        }

        let patch = diff::diff(&self.emitted, &next);
        self.emitted = next;
        patch
    }
}

/// The one replacement that turns `before` into `after`, as UTF-16 offsets.
///
/// A common-prefix/suffix diff, trimmed so it never splits a surrogate pair — the same
/// shape the web host uses to recover an edit from `contenteditable`. Offsets are UTF-16
/// because that is what every boundary in this API speaks (DESIGN §3.2).
fn single_replacement(before: &str, after: &str) -> Edit {
    let b: Vec<u16> = before.encode_utf16().collect();
    let a: Vec<u16> = after.encode_utf16().collect();

    let mut start = 0usize;
    while start < b.len() && start < a.len() && b[start] == a[start] {
        start += 1;
    }
    // Never cut a surrogate pair in half.
    if start > 0 && (0xD800..0xDC00).contains(&b[start - 1]) {
        start -= 1;
    }

    let mut b_end = b.len();
    let mut a_end = a.len();
    while b_end > start && a_end > start && b[b_end - 1] == a[a_end - 1] {
        b_end -= 1;
        a_end -= 1;
    }
    if b_end < b.len() && (0xDC00..0xE000).contains(&b[b_end]) {
        b_end += 1;
        a_end += 1;
    }

    Edit {
        start: start as u32,
        end: b_end as u32,
        text: String::from_utf16_lossy(&a[start..a_end]),
    }
}

/// Byte span of a single-replacement edit, plus its length change.
///
/// Returns `None` for a batch: multi-range edits are commands, not keystrokes, so the
/// simplicity of a full reparse is worth more there than the speed.
fn single_edit_span(edits: &[Edit], before: &Text) -> Option<(usize, usize, isize)> {
    let [edit] = edits else { return None };
    let start = before.utf16_to_utf8(edit.start);
    let end = before.utf16_to_utf8(edit.end);
    Some((start, end, edit.text.len() as isize - (end - start) as isize))
}

fn shift(d: &mut decorate::Built, delta: isize) {
    let by = |v: usize| (v as isize + delta) as usize;
    d.start = by(d.start);
    d.end = by(d.end);
    d.node = (by(d.node.0), by(d.node.1));
    d.block = (by(d.block.0), by(d.block.1));
}

/// Inclusive at the endpoints: a caret resting against a node's edge reveals it.
fn intersects(lo: usize, hi: usize, s: usize, e: usize) -> bool {
    lo <= e && hi >= s
}

#[cfg(test)]
mod tests {
    use super::*;
    use registry::role;

    #[cfg(feature = "toml-manifest")]
    const MANIFEST: &str = r#"
        [[inline]]
        name   = "mention"
        syntax = { kind = "pattern", regex = "@[a-zA-Z0-9_-]+" }
        render = "inline_widget"
        reveal = "caret_in_node"
    "#;

    fn kinds_at(e: &Engine, src_range: (u32, u32)) -> Vec<Kind> {
        e.decorations()
            .iter()
            .filter(|d| d.start == src_range.0 && d.end == src_range.1)
            .map(|d| d.kind)
            .collect()
    }

    #[test]
    fn an_unfocused_document_renders_fully_collapsed() {
        let mut e = Engine::new(Registry::empty());
        e.reset("# Title\n\n**bold**");
        assert_eq!(e.selection(), None);
        assert!(
            e.decorations().iter().all(|d| d.kind != Kind::Style || d.role != role::MARKER),
            "a document that was never focused must not reveal its markers"
        );
    }

    #[test]
    fn markers_conceal_when_the_caret_is_away_and_reveal_when_it_lands() {
        let mut e = Engine::new(Registry::empty());
        e.reset("hello **world** end");
        // "**" occupies [6,8)
        assert_eq!(kinds_at(&e, (6, 8)), vec![Kind::Conceal]);

        e.set_selection(Some(Selection::caret(10))); // inside "world"
        assert_eq!(kinds_at(&e, (6, 8)), vec![Kind::Style]);

        e.set_selection(Some(Selection::caret(0))); // start of line, outside the node
        assert_eq!(kinds_at(&e, (6, 8)), vec![Kind::Conceal]);
    }

    #[test]
    fn a_caret_resting_against_a_node_edge_reveals_it() {
        let mut e = Engine::new(Registry::empty());
        e.reset("hello **world** end");
        e.set_selection(Some(Selection::caret(6))); // immediately before the "**"
        assert_eq!(kinds_at(&e, (6, 8)), vec![Kind::Style]);
        e.set_selection(Some(Selection::caret(15))); // immediately after the node
        assert_eq!(kinds_at(&e, (6, 8)), vec![Kind::Style]);
    }

    #[test]
    fn blurring_collapses_the_document_again() {
        let mut e = Engine::new(Registry::empty());
        e.reset("hello **world** end");
        e.set_selection(Some(Selection::caret(10)));
        assert_eq!(kinds_at(&e, (6, 8)), vec![Kind::Style]);
        e.set_selection(None);
        assert_eq!(kinds_at(&e, (6, 8)), vec![Kind::Conceal]);
    }

    #[test]
    fn reveal_survives_a_round_trip_without_leaking_decorations() {
        let mut e = Engine::new(Registry::empty());
        e.reset("hello **world** end");
        let n = e.decorations().len();
        e.set_selection(Some(Selection::caret(10)));
        e.set_selection(Some(Selection::caret(0)));
        assert_eq!(e.decorations().len(), n);
    }

    #[test]
    fn selection_change_emits_a_patch_without_reparsing() {
        let mut e = Engine::new(Registry::empty());
        e.reset("x **a**");
        let p = e.set_selection(Some(Selection::caret(4)));
        assert!(!p.is_empty(), "moving into the node must repaint its markers");
    }

    #[test]
    fn repeating_a_selection_is_a_no_op() {
        let mut e = Engine::new(Registry::empty());
        e.reset("x **a**");
        e.set_selection(Some(Selection::caret(4)));

        assert!(e.set_selection(Some(Selection::caret(4))).is_empty());
        // Equality is checked after clamping, so noisy out-of-bounds callbacks are
        // cheap too.
        e.set_selection(Some(Selection::caret(999)));
        assert!(e.set_selection(Some(Selection::caret(999))).is_empty());
    }

    #[test]
    #[cfg(feature = "toml-manifest")]
    fn typing_far_away_does_not_rebuild_an_untouched_widget() {
        let mut e = Engine::from_toml(MANIFEST).unwrap();
        e.reset("@gabe wrote this\n\ntail");
        let widget = e.decorations().iter().find(|d| d.kind == Kind::InlineWidget).unwrap().key;

        // Append a character at the very end of the document.
        let len = e.text().chars().map(|c| c.len_utf16() as u32).sum::<u32>();
        let p = e.edit(&[Edit { start: len, end: len, text: "!".into() }], Some(len + 1), 0).unwrap();

        assert!(!p.removed.contains(&widget), "widget was torn down by a distant edit");
        assert!(e.decorations().iter().any(|d| d.key == widget));
    }

    #[test]
    #[cfg(feature = "toml-manifest")]
    fn editing_a_widgets_own_source_rebuilds_it() {
        let mut e = Engine::from_toml(MANIFEST).unwrap();
        e.reset("@gabe");
        let before = e.decorations().iter().find(|d| d.kind == Kind::InlineWidget).unwrap().key;
        e.edit(&[Edit { start: 5, end: 5, text: "x".into() }], Some(6), 0).unwrap();
        let after =
            e.decorations().iter().find(|d| d.kind == Kind::InlineWidget).map(|d| d.key);
        assert_ne!(Some(before), after);
    }

    #[test]
    fn reset_preserves_focus_so_a_resync_does_not_blur_the_editor() {
        let mut e = Engine::new(Registry::empty());
        e.reset("hello **world** end");
        e.set_selection(Some(Selection::caret(10)));
        e.reset("hello **world** end!");
        assert_eq!(e.selection(), Some(Selection::caret(10)));
        assert_eq!(kinds_at(&e, (6, 8)), vec![Kind::Style]);
    }

    #[test]
    fn utf16_offsets_are_emitted_not_byte_offsets() {
        let mut e = Engine::new(Registry::empty());
        e.reset("\u{1F600} **b**"); // emoji is 4 bytes but 2 UTF-16 units
        let conceal = e
            .decorations()
            .iter()
            .find(|d| d.kind == Kind::Conceal && d.role == role::MARKER)
            .unwrap();
        assert_eq!(conceal.start, 3, "expected UTF-16 offset, got a byte offset");
    }

    #[test]
    fn desync_is_refused_rather_than_decorated() {
        let mut e = Engine::new(Registry::empty());
        e.reset("abc");
        let r = e.edit(&[Edit { start: 0, end: 0, text: "z".into() }], Some(77), 0);
        assert!(matches!(r, Err(EditError::Desync { .. })));
    }

    #[test]
    fn reset_recovers_from_desync() {
        let mut e = Engine::new(Registry::empty());
        e.reset("abc");
        let _ = e.edit(&[Edit { start: 0, end: 0, text: "z".into() }], Some(77), 0);
        e.reset("**fresh**");
        assert!(e.decorations().iter().any(|d| d.kind == Kind::Conceal));
    }

    #[test]
    fn selection_is_clamped_to_the_document() {
        let mut e = Engine::new(Registry::empty());
        e.reset("ab");
        e.set_selection(Some(Selection { anchor: 0, head: 9999 }));
        assert_eq!(e.selection().unwrap().head, 2);
    }

    /// The contract renderers depend on: undo hands back edits, the platform applies
    /// them to its own buffer, and the two stay in step.
    #[test]
    fn undo_returns_edits_that_reproduce_the_cores_own_text() {
        let mut e = Engine::new(Registry::empty());
        e.reset("The quick fox");
        let mut mirror = String::from("The quick fox");

        e.set_selection(Some(Selection::caret(13)));
        e.edit(&[Edit { start: 13, end: 13, text: " jumps".into() }], Some(19), 1000).unwrap();
        apply_to(&mut mirror, &[Edit { start: 13, end: 13, text: " jumps".into() }]);
        assert_eq!(mirror, e.text());

        let (rewind, _) = e.undo().expect("one revision recorded");
        apply_to(&mut mirror, &rewind.edits);
        assert_eq!(mirror, e.text(), "platform buffer diverged from the core on undo");
        assert_eq!(mirror, "The quick fox");

        let (rewind, _) = e.redo().expect("one revision to redo");
        apply_to(&mut mirror, &rewind.edits);
        assert_eq!(mirror, e.text(), "platform buffer diverged from the core on redo");
        assert_eq!(mirror, "The quick fox jumps");
    }

    /// Stands in for `UITextView.replaceCharacters`.
    fn apply_to(buf: &mut String, edits: &[Edit]) {
        let mut asc: Vec<&Edit> = edits.iter().collect();
        asc.sort_by_key(|e| e.start);
        for e in asc.iter().rev() {
            let units: Vec<u16> = buf.encode_utf16().collect();
            let head = String::from_utf16_lossy(&units[..e.start as usize]);
            let tail = String::from_utf16_lossy(&units[e.end as usize..]);
            *buf = format!("{head}{}{tail}", e.text);
        }
    }

    /// Found by the performance pass: reopening the same document rendered it as plain
    /// text, because the reset patch diffed against decorations the renderer had
    /// already discarded.
    #[test]
    fn resetting_to_identical_text_still_emits_the_full_set() {
        let mut e = Engine::new(Registry::empty());
        let doc = "# Title\n\n**bold** and *italic*";
        let first = e.reset(doc);
        assert!(!first.added.is_empty());

        let second = e.reset(doc);
        assert_eq!(
            second.added.len(),
            first.added.len(),
            "reopening an identical document must re-emit every decoration"
        );
        assert!(second.removed.is_empty());
        assert_eq!(e.decorations().len(), first.added.len());
    }

    #[test]
    fn undo_repaints_decorations() {
        let mut e = Engine::new(Registry::empty());
        e.reset("plain text");
        e.edit(&[Edit { start: 0, end: 0, text: "# ".into() }], Some(12), 1000).unwrap();
        assert!(e.decorations().iter().any(|d| d.role == role::HEADING));

        let (_, patch) = e.undo().unwrap();
        assert!(!patch.is_empty(), "undo must emit a decoration patch");
        assert!(!e.decorations().iter().any(|d| d.role == role::HEADING));
    }

    #[test]
    fn undo_restores_the_caret_to_where_the_edit_began() {
        let mut e = Engine::new(Registry::empty());
        e.reset("abc");
        e.set_selection(Some(Selection::caret(3)));
        e.edit(&[Edit { start: 3, end: 3, text: "def".into() }], Some(6), 1000).unwrap();
        e.set_selection(Some(Selection::caret(0))); // user clicks elsewhere
        e.undo().unwrap();
        assert_eq!(e.selection(), Some(Selection::caret(3)));
    }

    #[test]
    fn a_typing_run_through_the_engine_is_one_undo_step() {
        let mut e = Engine::new(Registry::empty());
        e.reset("");
        for (i, ch) in "hello".chars().enumerate() {
            let at = i as u32;
            e.edit(&[Edit { start: at, end: at, text: ch.into() }], Some(at + 1), 1000 + i as u64 * 40)
                .unwrap();
        }
        assert_eq!(e.text(), "hello");
        e.undo().unwrap();
        assert_eq!(e.text(), "");
        assert!(!e.can_undo());
    }

    #[test]
    fn boundary_splits_a_command_off_from_the_typing_around_it() {
        let mut e = Engine::new(Registry::empty());
        e.reset("");
        e.edit(&[Edit { start: 0, end: 0, text: "ab".into() }], Some(2), 1000).unwrap();
        e.boundary();
        // A "toggle bold" command wrapping the word.
        e.edit(
            &[Edit { start: 0, end: 0, text: "**".into() }, Edit { start: 2, end: 2, text: "**".into() }],
            Some(6),
            1010,
        )
        .unwrap();
        assert_eq!(e.text(), "**ab**");
        e.undo().unwrap();
        assert_eq!(e.text(), "ab", "the command must undo as one step, not two markers");
        e.undo().unwrap();
        assert_eq!(e.text(), "");
    }

    #[test]
    fn a_desync_clears_history_because_the_recorded_offsets_are_untrustworthy() {
        let mut e = Engine::new(Registry::empty());
        e.reset("abc");
        e.edit(&[Edit { start: 3, end: 3, text: "d".into() }], Some(4), 1000).unwrap();
        assert!(e.can_undo());
        e.reset("something else entirely");
        assert!(!e.can_undo(), "history from a drifted buffer must not survive a resync");
    }

    #[test]
    fn the_engine_hands_back_a_reference_never_the_content() {
        let mut e = Engine::new(Registry::empty());
        e.reset("![a diagram](assets/diagram.png)");
        let widget = e.decorations().iter().find(|d| d.role == role::IMAGE).unwrap();
        assert_eq!(e.payload(widget.key), Some("assets/diagram.png"));
        // The document itself is untouched: still just the reference.
        assert_eq!(e.text(), "![a diagram](assets/diagram.png)");
    }

    #[test]
    fn payloads_follow_the_key_across_an_unrelated_edit() {
        let mut e = Engine::new(Registry::empty());
        e.reset("intro\n\n![a](x.png)");
        let key = e.decorations().iter().find(|d| d.role == role::IMAGE).unwrap().key;
        e.edit(&[Edit { start: 0, end: 0, text: "# ".into() }], Some(20), 0).unwrap();
        assert_eq!(e.payload(key), Some("x.png"), "payload lost after a distant edit");
    }







    #[test]
    fn shrinking_the_document_clamps_a_stale_selection() {
        let mut e = Engine::new(Registry::empty());
        e.reset("hello world");
        e.set_selection(Some(Selection::caret(11)));
        e.edit(&[Edit { start: 2, end: 11, text: String::new() }], Some(2), 0).unwrap();
        assert_eq!(e.selection().unwrap().head, 2);
    }
}
