//! C ABI for the Apple renderers (DESIGN §6).
//!
//! Patches are returned as a borrowed view over engine-owned storage, valid until the
//! next call on the same engine. Swift reads them as `UnsafeBufferPointer` — no JSON,
//! no per-keystroke allocation churn in the host.

use mde_core::{Decoration, Edit, Engine, Kind, LayerSpan, Registry, Selection};
use std::ffi::{c_char, CStr};
use std::slice;

#[repr(C)]
pub struct MdeEdit {
    /// UTF-16 code units.
    pub start: u32,
    pub end: u32,
    /// UTF-8, not NUL-terminated.
    pub text: *const u8,
    pub text_len: usize,
}

#[repr(u32)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MdeStatus {
    Ok = 0,
    /// The mirror and the platform buffer disagree. The host must call `mde_reset`.
    Desync = 1,
    OutOfBounds = 2,
    BadArgument = 3,
}

/// A borrowed view of the last patch. Pointers are engine-owned and invalidated by
/// the next call.
#[repr(C)]
pub struct MdePatch {
    pub status: MdeStatus,
    pub removed: *const u64,
    pub removed_len: usize,
    pub added: *const Decoration,
    pub added_len: usize,
    /// Triples of (key_lo, key_hi, start, end) are avoided: moves are a packed struct.
    pub moved: *const MdeMove,
    pub moved_len: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct MdeMove {
    pub key: u64,
    pub start: u32,
    pub end: u32,
}

/// One edit the host must apply to its own buffer. `text_off`/`text_len` index into
/// the rewind's UTF-8 blob — variable-length strings stay out of the struct so the
/// whole array is a single contiguous read.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MdeAppliedEdit {
    pub start: u32,
    pub end: u32,
    pub text_off: u32,
    pub text_len: u32,
}

/// The result of an undo or redo. Apply `edits` to the platform buffer **without**
/// reporting them back through `mde_edit` — they are already in the history.
#[repr(C)]
pub struct MdeRewind {
    pub patch: MdePatch,
    pub edits: *const MdeAppliedEdit,
    pub edits_len: usize,
    pub text: *const u8,
    pub text_len: usize,
    pub sel_anchor: u32,
    pub sel_head: u32,
    pub has_selection: bool,
}

pub struct MdeEngine {
    inner: Engine,
    removed: Vec<u64>,
    added: Vec<Decoration>,
    moved: Vec<MdeMove>,
    patch: MdePatch,
    rewind_edits: Vec<MdeAppliedEdit>,
    rewind_text: Vec<u8>,
    rewind: MdeRewind,
    /// Owned by the engine so the pointer handed out by `mde_revisions` stays valid
    /// until the next call, like every other borrowed buffer here.
    revisions: Vec<MdeRevision>,
}

impl MdeEngine {
    fn store(&mut self, p: mde_core::Patch, status: MdeStatus) -> *const MdePatch {
        self.removed = p.removed;
        self.added = p.added;
        self.moved = p.moved.into_iter().map(|(key, start, end)| MdeMove { key, start, end }).collect();
        self.patch = MdePatch {
            status,
            removed: self.removed.as_ptr(),
            removed_len: self.removed.len(),
            added: self.added.as_ptr(),
            added_len: self.added.len(),
            moved: self.moved.as_ptr(),
            moved_len: self.moved.len(),
        };
        &self.patch
    }

    fn fail(&mut self, status: MdeStatus) -> *const MdePatch {
        self.store(mde_core::Patch::default(), status)
    }

    fn store_rewind(&mut self, r: mde_core::Rewind, patch: mde_core::Patch) -> *const MdeRewind {
        self.store(patch, MdeStatus::Ok);
        self.rewind_edits.clear();
        self.rewind_text.clear();
        for e in &r.edits {
            let off = self.rewind_text.len() as u32;
            self.rewind_text.extend_from_slice(e.text.as_bytes());
            self.rewind_edits.push(MdeAppliedEdit {
                start: e.start,
                end: e.end,
                text_off: off,
                text_len: e.text.len() as u32,
            });
        }
        self.rewind = MdeRewind {
            patch: MdePatch {
                status: self.patch.status,
                removed: self.removed.as_ptr(),
                removed_len: self.removed.len(),
                added: self.added.as_ptr(),
                added_len: self.added.len(),
                moved: self.moved.as_ptr(),
                moved_len: self.moved.len(),
            },
            edits: self.rewind_edits.as_ptr(),
            edits_len: self.rewind_edits.len(),
            text: self.rewind_text.as_ptr(),
            text_len: self.rewind_text.len(),
            sel_anchor: r.selection.map_or(0, |s| s.anchor),
            sel_head: r.selection.map_or(0, |s| s.head),
            has_selection: r.selection.is_some(),
        };
        &self.rewind
    }
}

fn empty_patch() -> MdePatch {
    MdePatch {
        status: MdeStatus::Ok,
        removed: std::ptr::null(),
        removed_len: 0,
        added: std::ptr::null(),
        added_len: 0,
        moved: std::ptr::null(),
        moved_len: 0,
    }
}

/// # Safety
/// `manifest` must be a valid NUL-terminated UTF-8 string, or null for no extensions.
/// Returns null if the manifest fails to parse.
#[no_mangle]
pub unsafe extern "C" fn mde_engine_new(manifest: *const c_char) -> *mut MdeEngine {
    let registry = if manifest.is_null() {
        Registry::empty()
    } else {
        let Ok(s) = CStr::from_ptr(manifest).to_str() else { return std::ptr::null_mut() };
        match Registry::from_toml(s) {
            Ok(r) => r,
            Err(_) => return std::ptr::null_mut(),
        }
    };
    Box::into_raw(Box::new(MdeEngine {
        inner: Engine::new(registry),
        removed: Vec::new(),
        added: Vec::new(),
        moved: Vec::new(),
        patch: empty_patch(),
        rewind_edits: Vec::new(),
        rewind_text: Vec::new(),
        revisions: Vec::new(),
        rewind: MdeRewind {
            patch: empty_patch(),
            edits: std::ptr::null(),
            edits_len: 0,
            text: std::ptr::null(),
            text_len: 0,
            sel_anchor: 0,
            sel_head: 0,
            has_selection: false,
        },
    }))
}

/// # Safety
/// `e` must come from `mde_engine_new` and must not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn mde_engine_free(e: *mut MdeEngine) {
    if !e.is_null() {
        drop(Box::from_raw(e));
    }
}

/// # Safety
/// `text` must point to `len` bytes of UTF-8.
#[no_mangle]
pub unsafe extern "C" fn mde_reset(
    e: *mut MdeEngine,
    text: *const u8,
    len: usize,
) -> *const MdePatch {
    let Some(e) = e.as_mut() else { return std::ptr::null() };
    let bytes = if len == 0 { &[][..] } else { slice::from_raw_parts(text, len) };
    let Ok(s) = std::str::from_utf8(bytes) else { return e.fail(MdeStatus::BadArgument) };
    let p = e.inner.reset(s);
    e.store(p, MdeStatus::Ok)
}

/// # Safety
/// `edits` must point to `n` valid `MdeEdit`s whose text pointers are valid UTF-8.
/// `expected_len` is the platform's post-edit length in UTF-16 code units; pass
/// `u32::MAX` to skip the desync check. `now_ms` drives undo coalescing — pass a
/// monotonically increasing millisecond clock.
#[no_mangle]
pub unsafe extern "C" fn mde_edit(
    e: *mut MdeEngine,
    edits: *const MdeEdit,
    n: usize,
    expected_len: u32,
    now_ms: u64,
) -> *const MdePatch {
    let Some(e) = e.as_mut() else { return std::ptr::null() };
    let raw = if n == 0 { &[][..] } else { slice::from_raw_parts(edits, n) };
    let mut owned = Vec::with_capacity(n);
    for r in raw {
        let bytes = if r.text_len == 0 { &[][..] } else { slice::from_raw_parts(r.text, r.text_len) };
        let Ok(s) = std::str::from_utf8(bytes) else { return e.fail(MdeStatus::BadArgument) };
        owned.push(Edit { start: r.start, end: r.end, text: s.to_string() });
    }
    let expected = if expected_len == u32::MAX { None } else { Some(expected_len) };
    match e.inner.edit(&owned, expected, now_ms) {
        Ok(p) => e.store(p, MdeStatus::Ok),
        Err(mde_core::EditError::Desync { .. }) => e.fail(MdeStatus::Desync),
        Err(mde_core::EditError::OutOfBounds) => e.fail(MdeStatus::OutOfBounds),
        Err(mde_core::EditError::Overlapping) => e.fail(MdeStatus::BadArgument),
    }
}

/// Force the next edit to start a new undo step.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_boundary(e: *mut MdeEngine) {
    if let Some(e) = e.as_mut() {
        e.inner.boundary();
    }
}

/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_can_undo(e: *mut MdeEngine) -> bool {
    e.as_ref().is_some_and(|e| e.inner.can_undo())
}

/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_can_redo(e: *mut MdeEngine) -> bool {
    e.as_ref().is_some_and(|e| e.inner.can_redo())
}

/// Step back one revision. Returns null when there is nothing to undo. The returned
/// pointer is valid until the next call on this engine.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_undo(e: *mut MdeEngine) -> *const MdeRewind {
    let Some(e) = e.as_mut() else { return std::ptr::null() };
    match e.inner.undo() {
        Some((r, p)) => e.store_rewind(r, p),
        None => std::ptr::null(),
    }
}

/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_redo(e: *mut MdeEngine) -> *const MdeRewind {
    let Some(e) = e.as_mut() else { return std::ptr::null() };
    match e.inner.redo() {
        Some((r, p)) => e.store_rewind(r, p),
        None => std::ptr::null(),
    }
}

/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_set_selection(
    e: *mut MdeEngine,
    anchor: u32,
    head: u32,
) -> *const MdePatch {
    let Some(e) = e.as_mut() else { return std::ptr::null() };
    let p = e.inner.set_selection(Some(Selection { anchor, head }));
    e.store(p, MdeStatus::Ok)
}

/// Call on blur. Without a caret nothing reveals, so the document collapses back to
/// its rendered form.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_clear_selection(e: *mut MdeEngine) -> *const MdePatch {
    let Some(e) = e.as_mut() else { return std::ptr::null() };
    let p = e.inner.set_selection(None);
    e.store(p, MdeStatus::Ok)
}

/// Extra text the parser already resolved for a decoration: an image or link
/// destination, a fence argument, the inside of a delimited token. Returns null when
/// the decoration has none.
///
/// This is a *reference*, never content — resolving it to bytes is the host's job, so
/// a document never carries an image or video inline.
///
/// # Safety
/// `e` must come from `mde_engine_new`. The returned string is NOT NUL-terminated;
/// use `out_len`. It is valid until the next reparse.
#[no_mangle]
pub unsafe extern "C" fn mde_payload(
    e: *mut MdeEngine,
    key: u64,
    out_len: *mut usize,
) -> *const u8 {
    let Some(e) = e.as_mut() else { return std::ptr::null() };
    match e.inner.payload(key) {
        Some(p) => {
            if !out_len.is_null() {
                *out_len = p.len();
            }
            p.as_ptr()
        }
        None => std::ptr::null(),
    }
}

/// Resolve an interned role id to its name, for theme lookup. Returns null for an
/// unknown id. The pointer is valid for the engine's lifetime.
///
/// # Safety
/// `e` must come from `mde_engine_new`. The returned string is NOT NUL-terminated;
/// use `out_len`.
#[no_mangle]
pub unsafe extern "C" fn mde_role_name(
    e: *mut MdeEngine,
    role: u32,
    out_len: *mut usize,
) -> *const u8 {
    let Some(e) = e.as_mut() else { return std::ptr::null() };
    match e.inner.registry().role_name(role) {
        Some(name) => {
            if !out_len.is_null() {
                *out_len = name.len();
            }
            name.as_ptr()
        }
        None => std::ptr::null(),
    }
}

/// One entry in a browsable history. Offsets are UTF-16 code units.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct MdeRevision {
    pub at_ms: u64,
    pub index: u32,
    pub inserted: u32,
    pub removed: u32,
    pub at: u32,
    pub kind: u8,
    _pad: [u8; 7],
}

/// How many revisions are applied — the caret's position in the timeline.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_history_position(e: *mut MdeEngine) -> u32 {
    e.as_ref().map_or(0, |e| e.inner.history_position() as u32)
}

/// The whole timeline, oldest first, *including revisions that have been undone*.
///
/// Writes `*out_len` entries and returns a pointer valid until the next call. Undone
/// revisions are included deliberately: a history you can browse has to show the branch
/// you stepped back from, or there is nothing to step forward to.
///
/// # Safety
/// `e` must come from `mde_engine_new`; `out_len` must be writable.
#[no_mangle]
pub unsafe extern "C" fn mde_revisions(
    e: *mut MdeEngine,
    out_len: *mut usize,
) -> *const MdeRevision {
    let Some(e) = e.as_mut() else { return std::ptr::null() };
    e.revisions = e
        .inner
        .revisions()
        .iter()
        .map(|r| MdeRevision {
            at_ms: r.at_ms,
            index: r.index,
            inserted: r.inserted,
            removed: r.removed,
            at: r.at,
            kind: r.kind as u8,
            _pad: [0; 7],
        })
        .collect();
    if !out_len.is_null() {
        *out_len = e.revisions.len();
    }
    e.revisions.as_ptr()
}

/// Move to any point in the timeline. Returns null when the target is out of range or
/// already current.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_jump_to(e: *mut MdeEngine, target: u32) -> *const MdeRewind {
    let Some(e) = e.as_mut() else { return std::ptr::null() };
    match e.inner.jump_to(target as usize) {
        Some((r, p)) => e.store_rewind(r, p),
        None => std::ptr::null(),
    }
}

/// One host-supplied decoration. Offsets are UTF-16 code units, matching every other
/// boundary in the API (DESIGN §3.2).
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct MdeLayerSpan {
    pub start: u32,
    pub end: u32,
    pub role: u32,
    pub kind: u8,
    pub depth: u8,
}

/// Get (or create) the role id for a name, so a host can decorate with roles no
/// manifest declared. Returns `u32::MAX` on a bad pointer or non-UTF-8 name.
///
/// # Safety
/// `e` must come from `mde_engine_new`; `name` must be `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn mde_intern_role(
    e: *mut MdeEngine,
    name: *const u8,
    len: usize,
) -> u32 {
    let Some(e) = e.as_mut() else { return u32::MAX };
    let Some(name) = str_from(name, len) else { return u32::MAX };
    e.inner.intern_role(name)
}

/// Replace a named layer's decorations (DESIGN §5.3). Offsets are UTF-16 code units.
///
/// # Safety
/// `e` must come from `mde_engine_new`; `name` must be `name_len` readable bytes and
/// `spans` must point to `span_count` `MdeLayerSpan` values.
#[no_mangle]
pub unsafe extern "C" fn mde_set_layer(
    e: *mut MdeEngine,
    name: *const u8,
    name_len: usize,
    spans: *const MdeLayerSpan,
    span_count: usize,
) -> *const MdePatch {
    let Some(e) = e.as_mut() else { return std::ptr::null() };
    let Some(name) = str_from(name, name_len) else { return std::ptr::null() };
    let name = name.to_string();
    let list: Vec<LayerSpan> = if span_count == 0 || spans.is_null() {
        Vec::new()
    } else {
        std::slice::from_raw_parts(spans, span_count)
            .iter()
            .map(|s| LayerSpan {
                start: s.start,
                end: s.end,
                role: s.role,
                kind: kind_from(s.kind),
                depth: s.depth,
            })
            .collect()
    };
    let p = e.inner.set_layer(&name, &list);
    e.store(p, MdeStatus::Ok)
}

/// Remove a layer entirely.
///
/// # Safety
/// `e` must come from `mde_engine_new`; `name` must be `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn mde_clear_layer(
    e: *mut MdeEngine,
    name: *const u8,
    len: usize,
) -> *const MdePatch {
    let Some(e) = e.as_mut() else { return std::ptr::null() };
    let Some(name) = str_from(name, len) else { return std::ptr::null() };
    let name = name.to_string();
    let p = e.inner.clear_layer(&name);
    e.store(p, MdeStatus::Ok)
}

/// Borrow a UTF-8 string from a caller-owned buffer.
unsafe fn str_from<'a>(ptr: *const u8, len: usize) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).ok()
}

/// An out-of-range kind is clamped to `Style` rather than rejected: a layer is
/// presentation, and refusing the whole push over one bad byte would lose the rest.
fn kind_from(raw: u8) -> Kind {
    match raw {
        1 => Kind::Conceal,
        2 => Kind::InlineWidget,
        3 => Kind::BlockWidget,
        4 => Kind::Gutter,
        5 => Kind::Hit,
        _ => Kind::Style,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn round_trip_through_the_c_abi() {
        unsafe {
            let manifest = CString::new(
                r#"
                [[inline]]
                name   = "mention"
                syntax = { kind = "pattern", regex = "@[a-z]+" }
                render = "inline_widget"
                "#,
            )
            .unwrap();
            let e = mde_engine_new(manifest.as_ptr());
            assert!(!e.is_null());

            let src = "hi @gabe **x**";
            let p = &*mde_reset(e, src.as_ptr(), src.len());
            assert_eq!(p.status, MdeStatus::Ok);
            assert!(p.added_len > 0);

            let added = slice::from_raw_parts(p.added, p.added_len);
            assert!(added.iter().any(|d| d.kind == mde_core::Kind::InlineWidget));

            let mut len = 0usize;
            let name = mde_role_name(e, added[0].role, &mut len);
            assert!(!name.is_null());

            mde_engine_free(e);
        }
    }

    #[test]
    fn desync_surfaces_as_a_status_not_a_crash() {
        unsafe {
            let e = mde_engine_new(std::ptr::null());
            let src = "abc";
            mde_reset(e, src.as_ptr(), src.len());
            let t = "z";
            let edit = MdeEdit { start: 0, end: 0, text: t.as_ptr(), text_len: 1 };
            let p = &*mde_edit(e, &edit, 1, 77, 0);
            assert_eq!(p.status, MdeStatus::Desync);
            mde_engine_free(e);
        }
    }

    /// Mirrors what the Swift renderer does: apply the returned edits to its own
    /// buffer and expect to land exactly where the core is.
    #[test]
    fn undo_and_redo_hand_back_applicable_edits() {
        unsafe {
            let e = mde_engine_new(std::ptr::null());
            let src = "hello";
            mde_reset(e, src.as_ptr(), src.len());
            let mut mirror = String::from(src);

            let ins = " world";
            let edit = MdeEdit { start: 5, end: 5, text: ins.as_ptr(), text_len: ins.len() };
            assert_eq!((*mde_edit(e, &edit, 1, 11, 1000)).status, MdeStatus::Ok);
            mirror.push_str(ins);
            assert!(mde_can_undo(e));

            let r = &*mde_undo(e);
            apply(&mut mirror, r);
            assert_eq!(mirror, "hello");
            assert!(mde_can_redo(e));

            let r = &*mde_redo(e);
            apply(&mut mirror, r);
            assert_eq!(mirror, "hello world");

            mde_engine_free(e);
        }
    }

    #[test]
    fn payload_exposes_the_reference_over_the_abi() {
        unsafe {
            let e = mde_engine_new(std::ptr::null());
            let src = "![alt](assets/big-video.mp4)";
            let p = &*mde_reset(e, src.as_ptr(), src.len());
            let added = slice::from_raw_parts(p.added, p.added_len);
            let widget = added.iter().find(|d| d.kind == mde_core::Kind::InlineWidget).unwrap();

            let mut len = 0usize;
            let ptr = mde_payload(e, widget.key, &mut len);
            assert!(!ptr.is_null());
            let s = std::str::from_utf8(slice::from_raw_parts(ptr, len)).unwrap();
            assert_eq!(s, "assets/big-video.mp4");

            assert!(mde_payload(e, 0xdead_beef, &mut len).is_null());
            mde_engine_free(e);
        }
    }

    #[test]
    fn undo_on_an_empty_history_returns_null() {
        unsafe {
            let e = mde_engine_new(std::ptr::null());
            let src = "abc";
            mde_reset(e, src.as_ptr(), src.len());
            assert!(mde_undo(e).is_null());
            assert!(mde_redo(e).is_null());
            mde_engine_free(e);
        }
    }

    unsafe fn apply(buf: &mut String, r: &MdeRewind) {
        let edits = slice::from_raw_parts(r.edits, r.edits_len);
        let blob = slice::from_raw_parts(r.text, r.text_len);
        let mut sorted: Vec<&MdeAppliedEdit> = edits.iter().collect();
        sorted.sort_by_key(|e| e.start);
        for ed in sorted.iter().rev() {
            let units: Vec<u16> = buf.encode_utf16().collect();
            let head = String::from_utf16_lossy(&units[..ed.start as usize]);
            let tail = String::from_utf16_lossy(&units[ed.end as usize..]);
            let mid = std::str::from_utf8(
                &blob[ed.text_off as usize..(ed.text_off + ed.text_len) as usize],
            )
            .unwrap();
            *buf = format!("{head}{mid}{tail}");
        }
    }

    #[test]
    fn a_bad_manifest_returns_null_rather_than_panicking() {
        unsafe {
            let bad = CString::new("[[inline]]\nname = \"x\"\n").unwrap();
            assert!(mde_engine_new(bad.as_ptr()).is_null());
        }
    }
}
