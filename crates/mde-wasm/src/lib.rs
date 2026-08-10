//! wasm32 boundary for the web renderer (DESIGN §6).
//!
//! Deliberately hand-written rather than `wasm-bindgen`: the interface is a flat
//! `#[repr(C)]` struct array, so JS reads it straight out of linear memory with a
//! `DataView`. No glue codegen, no wrapper objects allocated per keystroke, and the
//! exact same memory layout the Swift side consumes.

use mde_core::{Decoration, Edit, Engine, Kind, LayerSpan, Registry, Selection};

/// Scratch buffer the host writes into before calling `reset`/`edit`.
static mut INPUT: Vec<u8> = Vec::new();
/// Flattened patch the host reads after a call. Layout is documented on `read_patch`.
static mut OUTPUT: Vec<u8> = Vec::new();
/// Flattened undo/redo result. Layout is documented on `mde_rewind_ptr`.
static mut REWIND: Vec<u8> = Vec::new();
/// Short strings returned by value — role names and payloads.
static mut SCRATCH: Vec<u8> = Vec::new();

const STATUS_OK: u32 = 0;
const STATUS_DESYNC: u32 = 1;
const STATUS_OUT_OF_BOUNDS: u32 = 2;
const STATUS_BAD_ARGUMENT: u32 = 3;

#[allow(static_mut_refs)]
fn input() -> &'static mut Vec<u8> {
    // Single-threaded by construction: wasm32-unknown-unknown has no threads here and
    // every entry point below runs to completion before JS regains control.
    unsafe { &mut INPUT }
}

#[allow(static_mut_refs)]
fn output() -> &'static mut Vec<u8> {
    unsafe { &mut OUTPUT }
}

#[allow(static_mut_refs)]
fn rewind_buf() -> &'static mut Vec<u8> {
    unsafe { &mut REWIND }
}

#[allow(static_mut_refs)]
fn scratch() -> &'static mut Vec<u8> {
    unsafe { &mut SCRATCH }
}

/// Reserve `len` bytes of input scratch and return a pointer for JS to write into.
#[no_mangle]
pub extern "C" fn mde_input_reserve(len: usize) -> *mut u8 {
    let buf = input();
    buf.clear();
    buf.resize(len, 0);
    buf.as_mut_ptr()
}

/// Construct an engine from the binary manifest in the input buffer (empty for no
/// extensions). See `mde_core::registry::binary` for the layout — the host compiles
/// TOML itself so this build does not carry a TOML parser.
///
/// Returns null if the manifest is malformed.
#[no_mangle]
pub extern "C" fn mde_engine_new() -> *mut Engine {
    let buf = input();
    let registry = if buf.is_empty() {
        Registry::empty()
    } else {
        match Registry::from_binary(buf) {
            Ok(r) => r,
            Err(_) => return std::ptr::null_mut(),
        }
    };
    Box::into_raw(Box::new(Engine::new(registry)))
}

/// # Safety
/// `e` must come from `mde_engine_new` and must not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn mde_engine_free(e: *mut Engine) {
    if !e.is_null() {
        drop(Box::from_raw(e));
    }
}

/// Reset from the UTF-8 document currently in the input buffer.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_reset(e: *mut Engine) -> u32 {
    let Some(e) = e.as_mut() else { return STATUS_BAD_ARGUMENT };
    let Ok(s) = std::str::from_utf8(input()) else {
        write_patch(&mde_core::Patch::default());
        return STATUS_BAD_ARGUMENT;
    };
    let p = e.reset(s);
    write_patch(&p);
    STATUS_OK
}

/// Apply a single edit replacing `[start, end)` (UTF-16 units) with the UTF-8 text in
/// the input buffer. `expected_len` of `u32::MAX` skips the desync check.
///
/// Coalescing multiple edits per frame is a later optimization; keystrokes arrive one
/// at a time and IME commits are a single replacement.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_edit(
    e: *mut Engine,
    start: u32,
    end: u32,
    expected_len: u32,
    now_ms: f64,
) -> u32 {
    let Some(e) = e.as_mut() else { return STATUS_BAD_ARGUMENT };
    let Ok(text) = std::str::from_utf8(input()) else {
        write_patch(&mde_core::Patch::default());
        return STATUS_BAD_ARGUMENT;
    };
    let edit = Edit { start, end, text: text.to_string() };
    let expected = if expected_len == u32::MAX { None } else { Some(expected_len) };
    match e.edit(&[edit], expected, now_ms as u64) {
        Ok(p) => {
            write_patch(&p);
            STATUS_OK
        }
        Err(err) => {
            write_patch(&mde_core::Patch::default());
            match err {
                mde_core::EditError::Desync { .. } => STATUS_DESYNC,
                mde_core::EditError::OutOfBounds => STATUS_OUT_OF_BOUNDS,
                mde_core::EditError::Overlapping => STATUS_BAD_ARGUMENT,
            }
        }
    }
}

/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_set_selection(e: *mut Engine, anchor: u32, head: u32) -> u32 {
    let Some(e) = e.as_mut() else { return STATUS_BAD_ARGUMENT };
    let p = e.set_selection(Some(Selection { anchor, head }));
    write_patch(&p);
    STATUS_OK
}

/// Call on blur. Without a caret nothing reveals, so the document collapses back to
/// its rendered form.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_clear_selection(e: *mut Engine) -> u32 {
    let Some(e) = e.as_mut() else { return STATUS_BAD_ARGUMENT };
    let p = e.set_selection(None);
    write_patch(&p);
    STATUS_OK
}

/// Pointer to the flattened patch written by the last call.
///
/// Layout, all little-endian:
/// ```text
///   u32 removed_len
///   u32 added_len
///   u32 moved_len
///   u32 shifted_len
///   u64 removed[removed_len]
///   Decoration added[added_len]      // 24 bytes each, matches the Swift layout
///   { u64 key; u32 start; u32 end } moved[moved_len]
///   { u32 start; i32 delta } shifted[shifted_len]
/// ```
#[no_mangle]
pub extern "C" fn mde_patch_ptr() -> *const u8 {
    output().as_ptr()
}

#[no_mangle]
pub extern "C" fn mde_patch_len() -> usize {
    output().len()
}

/// Force the next edit to start a new undo step.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_boundary(e: *mut Engine) {
    if let Some(e) = e.as_mut() {
        e.boundary();
    }
}

/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_can_undo(e: *mut Engine) -> u32 {
    u32::from(e.as_ref().is_some_and(Engine::can_undo))
}

/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_can_redo(e: *mut Engine) -> u32 {
    u32::from(e.as_ref().is_some_and(Engine::can_redo))
}

/// Step back one revision. Returns 0 when there is nothing to undo. On success the
/// decoration patch is in the patch buffer and the edits to apply are in the rewind
/// buffer.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_undo(e: *mut Engine) -> u32 {
    let Some(e) = e.as_mut() else { return 0 };
    match e.undo() {
        Some((r, p)) => {
            write_patch(&p);
            write_rewind(&r);
            1
        }
        None => 0,
    }
}

/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_redo(e: *mut Engine) -> u32 {
    let Some(e) = e.as_mut() else { return 0 };
    match e.redo() {
        Some((r, p)) => {
            write_patch(&p);
            write_rewind(&r);
            1
        }
        None => 0,
    }
}

/// Extra text the parser resolved for a decoration — an image or link destination, a
/// fence argument, the inside of a delimited token. Returns the byte length written to
/// the scratch buffer, or 0 when the decoration has no payload.
///
/// This is a *reference*, never content: resolving it is the host's job, so a document
/// never carries an image or video inline.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_payload(e: *mut Engine, key: u64) -> u32 {
    let Some(e) = e.as_ref() else { return 0 };
    write_scratch(e.payload(key))
}

/// Role name for theme lookup, written to the scratch buffer. Returns 0 for an unknown
/// role.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_role_name(e: *mut Engine, role: u32) -> u32 {
    let Some(e) = e.as_ref() else { return 0 };
    write_scratch(e.registry().role_name(role))
}

#[no_mangle]
pub extern "C" fn mde_scratch_ptr() -> *const u8 {
    scratch().as_ptr()
}

/// Pointer to the last undo/redo result.
///
/// Layout, all little-endian:
/// ```text
///   u32 edit_count
///   u32 has_selection
///   u32 sel_anchor
///   u32 sel_head
///   { u32 start; u32 end; u32 text_off; u32 text_len } edits[edit_count]
///   u8 blob[]   // UTF-8, indexed by text_off/text_len
/// ```
#[no_mangle]
pub extern "C" fn mde_rewind_ptr() -> *const u8 {
    rewind_buf().as_ptr()
}

#[no_mangle]
pub extern "C" fn mde_rewind_len() -> usize {
    rewind_buf().len()
}

fn write_scratch(s: Option<&str>) -> u32 {
    let buf = scratch();
    buf.clear();
    match s {
        Some(s) => {
            buf.extend_from_slice(s.as_bytes());
            s.len() as u32
        }
        None => 0,
    }
}

fn write_rewind(r: &mde_core::Rewind) {
    let out = rewind_buf();
    out.clear();
    out.extend_from_slice(&(r.edits.len() as u32).to_le_bytes());
    out.extend_from_slice(&u32::from(r.selection.is_some()).to_le_bytes());
    out.extend_from_slice(&r.selection.map_or(0, |s| s.anchor).to_le_bytes());
    out.extend_from_slice(&r.selection.map_or(0, |s| s.head).to_le_bytes());

    // Strings live in a trailing blob so the edit array stays a fixed-stride read.
    let header = out.len() + r.edits.len() * 16;
    let mut blob = Vec::new();
    for e in &r.edits {
        out.extend_from_slice(&e.start.to_le_bytes());
        out.extend_from_slice(&e.end.to_le_bytes());
        out.extend_from_slice(&((header + blob.len()) as u32).to_le_bytes());
        out.extend_from_slice(&(e.text.len() as u32).to_le_bytes());
        blob.extend_from_slice(e.text.as_bytes());
    }
    out.extend_from_slice(&blob);
}

/// Bytes per layer span in the input buffer: start, end, role, kind, depth, 2 padding.
const LAYER_SPAN_BYTES: usize = 16;

/// Get (or create) a role id for the UTF-8 name in the input buffer. Returns
/// `u32::MAX` on failure.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_intern_role(e: *mut Engine) -> u32 {
    let Some(e) = e.as_mut() else { return u32::MAX };
    match std::str::from_utf8(input()) {
        Ok(name) => e.intern_role(name),
        Err(_) => u32::MAX,
    }
}

/// Replace a named layer's decorations (DESIGN §5.3), reading both the name and the
/// spans from the input buffer:
///
/// ```text
/// u32 name_len | name_len bytes of UTF-8 | spans…
/// span: u32 start | u32 end | u32 role | u8 kind | u8 depth | u16 padding
/// ```
///
/// Offsets are UTF-16 code units. The patch lands in the patch buffer as usual.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_set_layer(e: *mut Engine) -> u32 {
    let Some(e) = e.as_mut() else { return STATUS_BAD_ARGUMENT };
    let buf = input();
    if buf.len() < 4 {
        return STATUS_BAD_ARGUMENT;
    }
    let name_len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    let Some(rest) = buf.get(4..) else { return STATUS_BAD_ARGUMENT };
    let Some(name_bytes) = rest.get(..name_len) else { return STATUS_BAD_ARGUMENT };
    let Ok(name) = std::str::from_utf8(name_bytes) else { return STATUS_BAD_ARGUMENT };
    let name = name.to_string();

    let spans = &rest[name_len..];
    let mut list = Vec::with_capacity(spans.len() / LAYER_SPAN_BYTES);
    for c in spans.chunks_exact(LAYER_SPAN_BYTES) {
        list.push(LayerSpan {
            start: u32::from_le_bytes([c[0], c[1], c[2], c[3]]),
            end: u32::from_le_bytes([c[4], c[5], c[6], c[7]]),
            role: u32::from_le_bytes([c[8], c[9], c[10], c[11]]),
            kind: kind_from(c[12]),
            depth: c[13],
        });
    }
    write_patch(&e.set_layer(&name, &list));
    STATUS_OK
}

/// Remove the layer named by the UTF-8 input buffer.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_clear_layer(e: *mut Engine) -> u32 {
    let Some(e) = e.as_mut() else { return STATUS_BAD_ARGUMENT };
    let Ok(name) = std::str::from_utf8(input()) else { return STATUS_BAD_ARGUMENT };
    let name = name.to_string();
    write_patch(&e.clear_layer(&name));
    STATUS_OK
}

/// An unknown kind falls back to `Style`: a layer is presentation, and throwing the
/// whole push away over one stray byte would lose every other span with it.
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

/// Bytes per revision in the scratch buffer.
const REVISION_BYTES: usize = 32;

/// How many revisions have been applied — the caret's position in the timeline.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_history_position(e: *mut Engine) -> u32 {
    e.as_ref().map_or(0, |e| e.history_position() as u32)
}

/// Write the whole timeline into the scratch buffer and return how many revisions it
/// holds. Layout per entry, little-endian:
///
/// ```text
/// u32 index | u64 at_ms | u32 inserted | u32 removed | u32 at | u8 kind | 7 padding
/// ```
///
/// Undone revisions are included: a browsable history that hides the branch you stepped
/// back from has nothing to step forward to.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_revisions(e: *mut Engine) -> u32 {
    let Some(e) = e.as_ref() else { return 0 };
    let revisions = e.revisions();
    let out = scratch();
    out.clear();
    out.reserve(revisions.len() * REVISION_BYTES);
    for r in &revisions {
        out.extend_from_slice(&r.index.to_le_bytes());
        out.extend_from_slice(&r.at_ms.to_le_bytes());
        out.extend_from_slice(&r.inserted.to_le_bytes());
        out.extend_from_slice(&r.removed.to_le_bytes());
        out.extend_from_slice(&r.at.to_le_bytes());
        out.push(r.kind as u8);
        out.extend_from_slice(&[0u8; 7]);
    }
    revisions.len() as u32
}

/// Move to any point in the timeline. Returns 0 when the target is out of range or
/// already current; on success the patch and rewind buffers are filled as for undo.
///
/// # Safety
/// `e` must come from `mde_engine_new`.
#[no_mangle]
pub unsafe extern "C" fn mde_jump_to(e: *mut Engine, target: u32) -> u32 {
    let Some(e) = e.as_mut() else { return 0 };
    match e.jump_to(target as usize) {
        Some((r, p)) => {
            write_patch(&p);
            write_rewind(&r);
            1
        }
        None => 0,
    }
}

fn write_patch(p: &mde_core::Patch) {
    let out = output();
    out.clear();
    out.extend_from_slice(&(p.removed.len() as u32).to_le_bytes());
    out.extend_from_slice(&(p.added.len() as u32).to_le_bytes());
    out.extend_from_slice(&(p.moved.len() as u32).to_le_bytes());
    out.extend_from_slice(&(p.shifted.len() as u32).to_le_bytes());
    for k in &p.removed {
        out.extend_from_slice(&k.to_le_bytes());
    }
    for d in &p.added {
        let bytes: [u8; std::mem::size_of::<Decoration>()] =
            unsafe { std::mem::transmute_copy(d) };
        out.extend_from_slice(&bytes);
    }
    for (k, s, e) in &p.moved {
        out.extend_from_slice(&k.to_le_bytes());
        out.extend_from_slice(&s.to_le_bytes());
        out.extend_from_slice(&e.to_le_bytes());
    }
    for shift in &p.shifted {
        out.extend_from_slice(&shift.start.to_le_bytes());
        out.extend_from_slice(&shift.delta.to_le_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    /// The scratch buffers are `static mut`, which is sound on `wasm32-unknown-unknown`
    /// where there are no threads — but `cargo test` runs on a multi-threaded host and
    /// would let these tests stomp each other's buffers. Serialise them rather than
    /// weakening the buffers for a constraint the real target does not have.
    static LOCK: Mutex<()> = Mutex::new(());

    fn guard() -> MutexGuard<'static, ()> {
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn put(s: &str) {
        let ptr = mde_input_reserve(s.len());
        unsafe { std::ptr::copy_nonoverlapping(s.as_ptr(), ptr, s.len()) };
    }

    fn put_bytes(b: &[u8]) {
        let ptr = mde_input_reserve(b.len());
        unsafe { std::ptr::copy_nonoverlapping(b.as_ptr(), ptr, b.len()) };
    }

    #[test]
    fn patch_header_describes_the_payload() {
        let _lock = guard();
        unsafe {
            put("");
            let e = mde_engine_new();
            put("# hi\n\n**bold**");
            assert_eq!(mde_reset(e), STATUS_OK);

            let buf = std::slice::from_raw_parts(mde_patch_ptr(), mde_patch_len());
            let removed = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
            let added = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
            let moved = u32::from_le_bytes(buf[8..12].try_into().unwrap()) as usize;
            let shifted = u32::from_le_bytes(buf[12..16].try_into().unwrap()) as usize;
            assert_eq!(removed, 0);
            assert!(added > 0);
            assert_eq!(moved, 0);
            assert_eq!(shifted, 0);

            let expected = 16 + removed * 8 + added * 24 + moved * 16 + shifted * 8;
            assert_eq!(buf.len(), expected, "header and payload disagree");

            mde_engine_free(e);
        }
    }

    #[test]
    fn a_binary_manifest_registers_extensions() {
        let _lock = guard();
        // Layout per `mde_core::registry::binary`: one inline `mention` rule rendered
        // as an inline widget revealing on caret-in-node.
        let mut m = Vec::new();
        m.extend_from_slice(b"MDEM");
        m.extend_from_slice(&0u32.to_le_bytes()); // blocks
        m.extend_from_slice(&1u32.to_le_bytes()); // inlines
        m.extend_from_slice(&[1, 1, 0, 0]); // render=InlineWidget, reveal=CaretInNode, pattern
        for s in ["mention", "@[a-z]+", ""] {
            m.extend_from_slice(&(s.len() as u32).to_le_bytes());
            m.extend_from_slice(s.as_bytes());
        }

        unsafe {
            put_bytes(&m);
            let e = mde_engine_new();
            assert!(!e.is_null(), "valid binary manifest was rejected");
            put("hi @gabe");
            assert_eq!(mde_reset(e), STATUS_OK);

            let buf = std::slice::from_raw_parts(mde_patch_ptr(), mde_patch_len());
            let added = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
            assert_eq!(added, 1, "expected exactly the mention widget");
            // Decoration.kind sits at byte 20 of the 24-byte struct; 2 = InlineWidget.
            assert_eq!(buf[16 + 20], 2);
            mde_engine_free(e);
        }
    }

    #[test]
    fn a_malformed_binary_manifest_returns_null() {
        let _lock = guard();
        {
            put_bytes(b"NOPE\0\0\0\0");
            assert!(mde_engine_new().is_null());
        }
    }

    #[test]
    fn undo_round_trips_through_the_rewind_buffer() {
        let _lock = guard();
        unsafe {
            put("");
            let e = mde_engine_new();
            put("hello");
            mde_reset(e);
            assert_eq!(mde_can_undo(e), 0);

            put(" world");
            assert_eq!(mde_edit(e, 5, 5, 11, 1000.0), STATUS_OK);
            assert_eq!(mde_can_undo(e), 1);

            assert_eq!(mde_undo(e), 1);
            let buf = std::slice::from_raw_parts(mde_rewind_ptr(), mde_rewind_len());
            let count = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
            assert_eq!(count, 1);

            // The single edit should delete the six characters that were inserted.
            let start = u32::from_le_bytes(buf[16..20].try_into().unwrap());
            let end = u32::from_le_bytes(buf[20..24].try_into().unwrap());
            let text_len = u32::from_le_bytes(buf[28..32].try_into().unwrap());
            assert_eq!((start, end, text_len), (5, 11, 0));

            assert_eq!(mde_can_redo(e), 1);
            assert_eq!(mde_redo(e), 1);
            assert_eq!(mde_undo(e), 1);
            assert_eq!(mde_undo(e), 0, "history should be exhausted");
            mde_engine_free(e);
        }
    }

    #[test]
    fn payload_and_role_name_come_back_through_the_scratch_buffer() {
        let _lock = guard();
        unsafe {
            put("");
            let e = mde_engine_new();
            put("![alt](assets/big.mp4)");
            mde_reset(e);

            let buf = std::slice::from_raw_parts(mde_patch_ptr(), mde_patch_len());
            let added = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
            assert!(added > 0);
            // Decoration is 24 bytes: key at +8, role at +16.
            let key = u64::from_le_bytes(buf[24..32].try_into().unwrap());
            let role = u32::from_le_bytes(buf[32..36].try_into().unwrap());

            let n = mde_payload(e, key) as usize;
            let s = std::str::from_utf8(std::slice::from_raw_parts(mde_scratch_ptr(), n)).unwrap();
            assert_eq!(s, "assets/big.mp4");

            let n = mde_role_name(e, role) as usize;
            let s = std::str::from_utf8(std::slice::from_raw_parts(mde_scratch_ptr(), n)).unwrap();
            assert_eq!(s, "image");

            assert_eq!(mde_payload(e, 0xdead_beef), 0);
            mde_engine_free(e);
        }
    }

    #[test]
    fn desync_status_is_reported() {
        let _lock = guard();
        unsafe {
            put("");
            let e = mde_engine_new();
            put("abc");
            mde_reset(e);
            put("z");
            assert_eq!(mde_edit(e, 0, 0, 77, 0.0), STATUS_DESYNC);
            mde_engine_free(e);
        }
    }
}
