// C ABI for mde-core. Layout must stay in lockstep with crates/mde-ffi/src/lib.rs;
// `decoration_is_ffi_sized` in the Rust tests and `layoutMatchesTheRustSide` in the
// Swift tests both guard the struct size.
//
// All text offsets are UTF-16 code units, matching NSTextStorage (DESIGN §3.2).

#ifndef MDE_H
#define MDE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct MdeEngine MdeEngine;

// Kind
enum {
    MDE_STYLE = 0,
    MDE_CONCEAL = 1,
    MDE_INLINE_WIDGET = 2,
    MDE_BLOCK_WIDGET = 3,
    MDE_GUTTER = 4,
    MDE_HIT = 5,
};

// Reveal
enum {
    MDE_REVEAL_NEVER = 0,
    MDE_REVEAL_CARET_IN_NODE = 1,
    MDE_REVEAL_CARET_IN_LINE = 2,
    MDE_REVEAL_CARET_IN_BLOCK = 3,
};

// Status
enum {
    MDE_OK = 0,
    MDE_DESYNC = 1,
    MDE_OUT_OF_BOUNDS = 2,
    MDE_BAD_ARGUMENT = 3,
};

// Built-in role ids, interned before any extension role.
enum {
    MDE_ROLE_HEADING = 0,
    MDE_ROLE_MARKER = 1,
    MDE_ROLE_EMPHASIS = 2,
    MDE_ROLE_STRONG = 3,
    MDE_ROLE_CODE_INLINE = 4,
    MDE_ROLE_CODE_BLOCK = 5,
    MDE_ROLE_LINK = 6,
    MDE_ROLE_LINK_TEXT = 7,
    MDE_ROLE_IMAGE = 8,
    MDE_ROLE_QUOTE = 9,
    MDE_ROLE_LIST_BULLET = 10,
    MDE_ROLE_TASK_CHECKBOX = 11,
    MDE_ROLE_RULE = 12,
    MDE_ROLE_STRIKETHROUGH = 13,
};

typedef struct {
    uint32_t start;
    uint32_t end;
    uint64_t key;
    uint32_t role;
    uint8_t kind;
    uint8_t reveal;
    uint8_t depth;
    /* Paint order among ties. 0 = derived from the markdown; higher values are
       host-supplied layers, painted after the parse and in ascending order. */
    uint8_t layer;
} MdeDecoration;

typedef struct {
    uint64_t key;
    uint32_t start;
    uint32_t end;
} MdeMove;

typedef struct {
    uint32_t status;
    const uint64_t *removed;
    size_t removed_len;
    const MdeDecoration *added;
    size_t added_len;
    const MdeMove *moved;
    size_t moved_len;
} MdePatch;

typedef struct {
    uint32_t start;
    uint32_t end;
    const uint8_t *text; // UTF-8, not NUL-terminated
    size_t text_len;
} MdeEdit;

// One edit the host must apply to its own buffer. text_off/text_len index into the
// rewind's UTF-8 blob.
typedef struct {
    uint32_t start;
    uint32_t end;
    uint32_t text_off;
    uint32_t text_len;
} MdeAppliedEdit;

// Result of undo/redo. Apply `edits` to the platform buffer WITHOUT reporting them
// back through mde_edit — they are already recorded in the history.
typedef struct {
    MdePatch patch;
    const MdeAppliedEdit *edits;
    size_t edits_len;
    const uint8_t *text;
    size_t text_len;
    uint32_t sel_anchor;
    uint32_t sel_head;
    bool has_selection;
} MdeRewind;

// `manifest` is NUL-terminated TOML, or NULL for no extensions. Returns NULL if the
// manifest fails to parse.
MdeEngine *mde_engine_new(const char *manifest);
void mde_engine_free(MdeEngine *e);

// Returned pointers are engine-owned and invalidated by the next call on that engine.
const MdePatch *mde_reset(MdeEngine *e, const uint8_t *text, size_t len);
const MdePatch *mde_edit(MdeEngine *e, const MdeEdit *edits, size_t n,
                         uint32_t expected_len, uint64_t now_ms);
const MdePatch *mde_set_selection(MdeEngine *e, uint32_t anchor, uint32_t head);
const MdePatch *mde_clear_selection(MdeEngine *e);

void mde_boundary(MdeEngine *e);
bool mde_can_undo(MdeEngine *e);
bool mde_can_redo(MdeEngine *e);
const MdeRewind *mde_undo(MdeEngine *e); // NULL when there is nothing to undo
const MdeRewind *mde_redo(MdeEngine *e);

// Extra text the parser already resolved for a decoration: an image or link
// destination, a fence argument, the inside of a delimited token. NULL when there is
// none. NOT NUL-terminated; use out_len.
//
// This is a *reference*, never content. Resolving it to bytes is the host's job, so a
// document never carries an image or video inline.
const uint8_t *mde_payload(MdeEngine *e, uint64_t key, size_t *out_len);

// Role name for theme lookup. NOT NUL-terminated; use out_len.
const uint8_t *mde_role_name(MdeEngine *e, uint32_t role, size_t *out_len);

/* ---- Browsable history (DESIGN 9) --------------------------------------------- */

/* What a revision did. Coarse on purpose: the core knows which characters moved, not
   what the person meant. */
enum {
    MDE_REVISION_INSERT = 0,
    MDE_REVISION_DELETE = 1,
    MDE_REVISION_REPLACE = 2,
};

typedef struct {
    uint64_t at_ms;
    uint32_t index;
    uint32_t inserted;
    uint32_t removed;
    uint32_t at;
    uint8_t kind;
    uint8_t _pad[7];
} MdeRevision;

/* How many revisions are applied — the caret's position in the timeline. */
uint32_t mde_history_position(MdeEngine *e);

/* The whole timeline, oldest first, including revisions that have been undone. The
   pointer is valid until the next call. */
const MdeRevision *mde_revisions(MdeEngine *e, size_t *out_len);

/* Move to any point in the timeline. Returns NULL if the target is out of range or
   already current. */
const MdeRewind *mde_jump_to(MdeEngine *e, uint32_t target);

/* ---- Host decoration layers (DESIGN 5.3) -------------------------------------- */

/* One host-supplied decoration. Offsets are UTF-16 code units, as everywhere else. */
typedef struct {
    uint32_t start;
    uint32_t end;
    uint32_t role;
    uint8_t kind;
    uint8_t depth;
} MdeLayerSpan;

/* Get (or create) a role id by name, so a host can decorate with roles that no
   manifest declared. Returns UINT32_MAX on failure. */
uint32_t mde_intern_role(MdeEngine *e, const uint8_t *name, size_t len);

/* Replace a named layer's decorations. Layers paint after everything the parse
   produced, in registration order. */
const MdePatch *mde_set_layer(MdeEngine *e,
                              const uint8_t *name,
                              size_t name_len,
                              const MdeLayerSpan *spans,
                              size_t span_count);

/* Remove a layer entirely. Not the same as pushing zero spans: an empty layer keeps
   its place in the paint order. */
const MdePatch *mde_clear_layer(MdeEngine *e, const uint8_t *name, size_t len);

#ifdef __cplusplus
}
#endif

#endif // MDE_H
