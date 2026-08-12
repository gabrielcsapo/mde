// Typed wrapper over the wasm core — the web mirror of `apple/Sources/MDECore`.
//
// The wasm boundary stays a hand-written flat struct layout; TypeScript checks the host
// side and Vite turns this module plus the compiled core into one publishable artifact.

/** The library build copies this Wasm file beside the emitted module. */
const DEFAULT_WASM_FILENAME = 'mde.wasm';

/** The separately cached Rust module emitted beside the JavaScript library build. */
export const DEFAULT_WASM_URL = new URL(DEFAULT_WASM_FILENAME, import.meta.url);

export type KindValue = 0 | 1 | 2 | 3 | 4 | 5;

export interface SelectionRange { start: number; end: number }
export interface Decoration {
  start: number;
  end: number;
  key: bigint;
  role: number;
  kind: KindValue;
  reveal: number;
  depth: number;
  layer: number;
}
export interface Patch {
  removed: bigint[];
  added: Decoration[];
  shifted: Array<{ start: number; delta: number }>;
  moved: Array<{ key: bigint; start: number; end: number }>;
}
export interface TextEdit { start: number; end: number; text: string }
export interface LayerSpan {
  start: number;
  end: number;
  role: number;
  kind?: KindValue;
  depth?: number;
}
export interface Rewind {
  edits: TextEdit[];
  selection: SelectionRange | null;
  patch: Patch;
}
export interface Revision {
  index: number;
  at: number;
  atMs: number;
  inserted: number;
  removed: number;
  kind: number;
}
export type WasmSource = string | URL | Response | ArrayBuffer;

/** The closed set of things a renderer must know how to draw (DESIGN §3). */
export const Kind = Object.freeze({
  Style: 0,
  Conceal: 1,
  InlineWidget: 2,
  BlockWidget: 3,
  Gutter: 4,
  Hit: 5,
});

export const Reveal = Object.freeze({
  Never: 0,
  CaretInNode: 1,
  CaretInLine: 2,
  CaretInBlock: 3,
});

/**
 * Built-in role ids. Extension roles are interned after these, so any id >=
 * `FirstExtension` needs a `roleName()` lookup.
 */
export const Role = Object.freeze({
  Heading: 0,
  Marker: 1,
  Emphasis: 2,
  Strong: 3,
  CodeInline: 4,
  CodeBlock: 5,
  Link: 6,
  LinkText: 7,
  Image: 8,
  Quote: 9,
  ListBullet: 10,
  TaskCheckbox: 11,
  Rule: 12,
  Strikethrough: 13,
  Table: 14,
  TableHeader: 15,
  TableDelimiter: 16,
  TableCell: 17,
  Html: 18,
  FirstExtension: 19,
});

const STATUS_OK = 0;
const STATUS_DESYNC = 1;
const STATUS_OUT_OF_BOUNDS = 2;
const STATUS_BAD_ARGUMENT = 3;

/** Matches `Decoration` in crates/mde-core/src/decoration.rs. Guarded by a test. */
const DECORATION_SIZE = 24;
/** Bytes per layer span in the input buffer: start, end, role, kind, depth, padding. */
const LAYER_SPAN_SIZE = 16;
/** Bytes per revision in the scratch buffer. See `mde_revisions`. */
const REVISION_SIZE = 32;

export class EngineError extends Error {
  status: number;
  isDesync: boolean;

  /** @param {number} status */
  constructor(status: number) {
    const names = {
      [STATUS_DESYNC]: 'desync',
      [STATUS_OUT_OF_BOUNDS]: 'out of bounds',
      [STATUS_BAD_ARGUMENT]: 'bad argument',
    };
    super(`mde: ${names[status] ?? `status ${status}`}`);
    this.status = status;
    /** The mirror and the host buffer disagree; recover with `reset()`. */
    this.isDesync = status === STATUS_DESYNC;
  }
}

/**
 * @typedef {object} Decoration
 * @property {number} start  UTF-16 code units
 * @property {number} end
 * @property {bigint} key    stable identity (DESIGN §3.3)
 * @property {number} role
 * @property {KindValue} kind
 * @property {number} reveal
 * @property {number} depth
 * @property {number} layer paint order among ties; 0 is the parse, higher is a host layer
 */

/**
 * @typedef {object} Patch
 * @property {bigint[]} removed
 * @property {Decoration[]} added
 * @property {{start: number, delta: number}[]} shifted
 * @property {{key: bigint, start: number, end: number}[]} moved
 */

/** @returns {Patch} */
const emptyPatch = () => ({ removed: [], added: [], shifted: [], moved: [] });

/**
 * Load the wasm core.
 * @param {string|URL|Response|ArrayBuffer} source
 */
export async function loadCore(source: WasmSource = DEFAULT_WASM_URL): Promise<Core> {
  let bytes;
  if (source instanceof ArrayBuffer) {
    bytes = source;
  } else if (source instanceof Response) {
    bytes = await source.arrayBuffer();
  } else {
    bytes = await (await fetch(source)).arrayBuffer();
  }
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return new Core(instance);
}

/** Owns the wasm instance and hands out engines. */
export class Core {
  exports: Record<string, any> & { memory: WebAssembly.Memory };
  decoder: TextDecoder;
  encoder: TextEncoder;

  /** @param {WebAssembly.Instance} instance */
  constructor(instance: WebAssembly.Instance) {
    /** @type {any} */
    this.exports = instance.exports as Record<string, any> & { memory: WebAssembly.Memory };
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
  }

  /** Memory can be detached by growth, so never cache the buffer. */
  get memory() {
    return new DataView(this.exports.memory.buffer);
  }

  /** @param {Uint8Array} bytes */
  writeInput(bytes: Uint8Array): void {
    const ptr = this.exports.mde_input_reserve(bytes.length);
    new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
  }

  /** @param {string} text */
  writeInputText(text: string): void {
    this.writeInput(this.encoder.encode(text));
  }

  /**
   * @param {import('./manifest.js').Manifest|null} manifest
   * @returns {Engine}
   */
  newEngine(manifest: Uint8Array | null = null): Engine {
    this.writeInput(manifest ? manifest : new Uint8Array(0));
    const handle = this.exports.mde_engine_new();
    if (!handle) throw new Error('mde: manifest is malformed');
    return new Engine(this, handle);
  }
}

/**
 * Safe wrapper over one core engine. Not reentrant — drive it from one place, which is
 * where text input lives anyway.
 */
export class Engine {
  core: Core;
  handle: number;
  roleNames: Map<number, string | null>;

  /**
   * @param {Core} core
   * @param {number} handle
   */
  constructor(core: Core, handle: number) {
    this.core = core;
    this.handle = handle;
    /** @type {Map<number, string|null>} */
    this.roleNames = new Map();
  }

  free(): void {
    this.core.exports.mde_engine_free(this.handle);
    this.handle = 0;
  }

  /**
   * Full resync. Clears undo history — see DESIGN §9.
   * @param {string} text
   * @returns {Patch}
   */
  reset(text: string): Patch {
    this.core.writeInputText(text);
    const status = this.core.exports.mde_reset(this.handle);
    if (status !== STATUS_OK) throw new EngineError(status);
    return this.readPatch();
  }

  /** Export exact parsed state for transfer to another engine with the same manifest. */
  snapshot(): Uint8Array {
    const length = this.core.exports.mde_snapshot(this.handle);
    const pointer = this.core.exports.mde_scratch_ptr();
    return new Uint8Array(this.core.exports.memory.buffer, pointer, length).slice();
  }

  /** Restore exact parsed state prepared by another engine with the same manifest. */
  restoreSnapshot(snapshot: Uint8Array | ArrayBuffer): Patch {
    const bytes = snapshot instanceof Uint8Array ? snapshot : new Uint8Array(snapshot);
    this.writeInput(bytes);
    const status = this.core.exports.mde_snapshot_restore(this.handle);
    if (status !== STATUS_OK) throw new EngineError(status);
    return this.readPatch();
  }

  /**
   * Report an edit the host already applied.
   *
   * Never call this for edits that came out of `undo()`/`redo()` — they are already in
   * the history, and reporting them back would record them again.
   *
   * @param {number} start UTF-16
   * @param {number} end
   * @param {string} text
   * @param {number|null} documentLength post-edit length, checked against the mirror
   * @param {number} now milliseconds, drives undo coalescing
   * @returns {Patch}
   */
  edit(
    start: number,
    end: number,
    text: string,
    documentLength: number | null,
    now = performance.now(),
  ): Patch {
    this.core.writeInputText(text);
    const expected = documentLength === null ? 0xffffffff : documentLength;
    const status = this.core.exports.mde_edit(this.handle, start, end, expected, now);
    if (status !== STATUS_OK) throw new EngineError(status);
    return this.readPatch();
  }

  /**
   * Pass null on blur so the document collapses back to its rendered form.
   * @param {{start: number, end: number}|null} range
   * @returns {Patch}
   */
  setSelection(range: SelectionRange | null): Patch {
    const status = range
      ? this.core.exports.mde_set_selection(this.handle, range.start, range.end)
      : this.core.exports.mde_clear_selection(this.handle);
    if (status !== STATUS_OK) throw new EngineError(status);
    return this.readPatch();
  }

  /** Force the next edit to begin a new undo step. Call before a formatting command. */
  boundary(): void {
    this.core.exports.mde_boundary(this.handle);
  }

  get canUndo() {
    return this.core.exports.mde_can_undo(this.handle) === 1;
  }

  get canRedo() {
    return this.core.exports.mde_can_redo(this.handle) === 1;
  }

  /**
   * Step back one revision. The returned edits must be applied to the host's own
   * buffer without being reported back through `edit()`.
   * @returns {{edits: {start: number, end: number, text: string}[],
   *            selection: {start: number, end: number}|null,
   *            patch: Patch}|null}
   */
  undo(): Rewind | null {
    return this.core.exports.mde_undo(this.handle) === 1 ? this.readRewind() : null;
  }

  /** @returns {ReturnType<Engine['undo']>} */
  redo(): Rewind | null {
    return this.core.exports.mde_redo(this.handle) === 1 ? this.readRewind() : null;
  }

  /**
   * Extra text the parser already resolved for this decoration: an image or link
   * destination, table alignments, a fence argument, or a delimited token's content.
   *
   * A resource payload is a **reference, never content**. A document holds
   * `![alt](photo.jpg)`, not the bytes of the photo; displaying it is the host's job.
   *
   * @param {bigint} key
   * @returns {string|null}
   */
  payload(key: bigint): string | null {
    const len = this.core.exports.mde_payload(this.handle, key);
    return len === 0 ? null : this.readScratch(len);
  }

  /** @param {number} role @returns {string|null} */
  roleName(role: number): string | null {
    if (this.roleNames.has(role)) return this.roleNames.get(role) ?? null;
    const len = this.core.exports.mde_role_name(this.handle, role);
    const name = len === 0 ? null : this.readScratch(len);
    this.roleNames.set(role, name);
    return name;
  }

  // ---- host decoration layers (DESIGN §5.3) -------------------------------

  /**
   * Get (or create) the role id for a name, so a host can decorate with roles that no
   * manifest declared. Roles are open strings by design — the core never interprets
   * one, it just hands it back for the theme to look up.
   * @param {string} name
   * @returns {number}
   */
  internRole(name: string): number {
    const bytes = this.core.encoder.encode(name);
    this.writeInput(bytes);
    return this.core.exports.mde_intern_role(this.handle);
  }

  /**
   * Replace a named layer's decorations — ranges the parser never produced, computed
   * by the host from something the core knows nothing about (where the caret is, what
   * a language tagger calls a word). They flow through the same identity and diffing
   * machinery as parsed decorations, so the renderer needs no new code to draw them.
   *
   * Layers paint after the parse, in registration order.
   *
   * @param {string} name
   * @param {{start: number, end: number, role: number, kind?: number, depth?: number}[]} spans
   * @returns {Patch}
   */
  setLayer(name: string, spans: LayerSpan[]): Patch {
    const nameBytes = this.core.encoder.encode(name);
    const buf = new Uint8Array(4 + nameBytes.length + spans.length * LAYER_SPAN_SIZE);
    const view = new DataView(buf.buffer);
    view.setUint32(0, nameBytes.length, true);
    buf.set(nameBytes, 4);
    let off = 4 + nameBytes.length;
    for (const s of spans) {
      view.setUint32(off, s.start, true);
      view.setUint32(off + 4, s.end, true);
      view.setUint32(off + 8, s.role, true);
      view.setUint8(off + 12, s.kind ?? 0);
      view.setUint8(off + 13, s.depth ?? 0);
      off += LAYER_SPAN_SIZE;
    }
    this.writeInput(buf);
    const status = this.core.exports.mde_set_layer(this.handle);
    if (status !== STATUS_OK) throw new EngineError(status);
    return this.readPatch();
  }

  /**
   * Remove a layer entirely. Not the same as pushing zero spans — an empty layer keeps
   * its slot in the paint order.
   * @param {string} name
   * @returns {Patch}
   */
  clearLayer(name: string): Patch {
    this.writeInput(this.core.encoder.encode(name));
    const status = this.core.exports.mde_clear_layer(this.handle);
    if (status !== STATUS_OK) throw new EngineError(status);
    return this.readPatch();
  }

  // ---- browsable history (DESIGN §9) --------------------------------------

  /** How many revisions are applied — the caret's position in the timeline. */
  get historyPosition() {
    return this.core.exports.mde_history_position(this.handle);
  }

  /**
   * The whole timeline, oldest first, *including revisions that have been undone* —
   * a history you can browse has to show the branch you stepped back from.
   * @returns {{index: number, at: number, atMs: number, inserted: number,
   *            removed: number, kind: number}[]}
   */
  revisions(): Revision[] {
    const count = this.core.exports.mde_revisions(this.handle);
    if (count === 0) return [];
    const ptr = this.core.exports.mde_scratch_ptr();
    const view = new DataView(this.core.exports.memory.buffer, ptr, count * REVISION_SIZE);
    const out = [];
    for (let i = 0; i < count; i++) {
      const off = i * REVISION_SIZE;
      out.push({
        index: view.getUint32(off, true),
        atMs: Number(view.getBigUint64(off + 4, true)),
        inserted: view.getUint32(off + 12, true),
        removed: view.getUint32(off + 16, true),
        at: view.getUint32(off + 20, true),
        kind: view.getUint8(off + 24),
      });
    }
    return out;
  }

  /**
   * Move to any point in the timeline rather than one step at a time.
   * @param {number} target
   * @returns {ReturnType<Engine['undo']>}
   */
  jumpTo(target: number): Rewind | null {
    if (this.core.exports.mde_jump_to(this.handle, target) === 0) return null;
    return this.readRewind();
  }

  /** @param {Uint8Array} bytes */
  writeInput(bytes: Uint8Array): void {
    const ptr = this.core.exports.mde_input_reserve(bytes.length);
    new Uint8Array(this.core.exports.memory.buffer, ptr, bytes.length).set(bytes);
  }

  /** @param {number} len */
  readScratch(len: number): string {
    const ptr = this.core.exports.mde_scratch_ptr();
    return this.core.decoder.decode(
      new Uint8Array(this.core.exports.memory.buffer, ptr, len)
    );
  }

  /** @returns {Patch} */
  readPatch(): Patch {
    const { exports } = this.core;
    const len = exports.mde_patch_len();
    if (len === 0) return emptyPatch();
    const view = new DataView(exports.memory.buffer, exports.mde_patch_ptr(), len);

    const removedLen = view.getUint32(0, true);
    const addedLen = view.getUint32(4, true);
    const movedLen = view.getUint32(8, true);
    const shiftedLen = view.getUint32(12, true);

    let off = 16;
    /** @type {bigint[]} */
    const removed = [];
    for (let i = 0; i < removedLen; i++, off += 8) removed.push(view.getBigUint64(off, true));

    /** @type {Decoration[]} */
    const added = [];
    for (let i = 0; i < addedLen; i++, off += DECORATION_SIZE) {
      added.push({
        start: view.getUint32(off, true),
        end: view.getUint32(off + 4, true),
        key: view.getBigUint64(off + 8, true),
        role: view.getUint32(off + 16, true),
        kind: /** @type {KindValue} */ (view.getUint8(off + 20)),
        reveal: view.getUint8(off + 21),
        depth: view.getUint8(off + 22),
        layer: view.getUint8(off + 23),
      });
    }

    /** @type {{key: bigint, start: number, end: number}[]} */
    const moved = [];
    for (let i = 0; i < movedLen; i++, off += 16) {
      moved.push({
        key: view.getBigUint64(off, true),
        start: view.getUint32(off + 8, true),
        end: view.getUint32(off + 12, true),
      });
    }
    const shifted = [];
    for (let i = 0; i < shiftedLen; i++, off += 8) {
      shifted.push({
        start: view.getUint32(off, true),
        delta: view.getInt32(off + 4, true),
      });
    }
    return { removed, added, shifted, moved };
  }

  readRewind(): Rewind {
    const { exports } = this.core;
    const base = exports.mde_rewind_ptr();
    const len = exports.mde_rewind_len();
    const view = new DataView(exports.memory.buffer, base, len);
    const bytes = new Uint8Array(exports.memory.buffer, base, len);

    const count = view.getUint32(0, true);
    const hasSelection = view.getUint32(4, true) === 1;
    const anchor = view.getUint32(8, true);
    const head = view.getUint32(12, true);

    const edits = [];
    for (let i = 0; i < count; i++) {
      const off = 16 + i * 16;
      const textOff = view.getUint32(off + 8, true);
      const textLen = view.getUint32(off + 12, true);
      edits.push({
        start: view.getUint32(off, true),
        end: view.getUint32(off + 4, true),
        text: this.core.decoder.decode(bytes.subarray(textOff, textOff + textLen)),
      });
    }

    return {
      edits,
      selection: hasSelection
        ? { start: Math.min(anchor, head), end: Math.max(anchor, head) }
        : null,
      patch: this.readPatch(),
    };
  }
}
