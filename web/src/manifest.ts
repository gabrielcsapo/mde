// Extension manifests for the web build.
//
// TOML stays the authoring format across platforms, but shipping a TOML parser into
// wasm cost ~350 KB for a parse that happens once at startup (DESIGN §5, the
// `toml-manifest` feature). The web build drops it and takes the compact binary form
// instead — encoded here, from a plain object.
//
// Layout must match `mde_core::registry::binary`.

export type BlockSyntax =
  | { kind: 'fence'; info: string }
  | { kind: 'directive'; marker: string; name: string };
export type InlineSyntax =
  | { kind: 'pattern'; regex: string }
  | { kind: 'delimited'; open: string; close: string };
export type RenderSpec = 'style' | 'inline_widget' | 'block_widget' | 'hit';
export type RevealSpec = 'never' | 'caret_in_node' | 'caret_in_line' | 'caret_in_block';
export interface BlockDef {
  name: string;
  syntax: BlockSyntax;
  render: RenderSpec;
  reveal?: RevealSpec;
}
export interface InlineDef {
  name: string;
  syntax: InlineSyntax;
  render: RenderSpec;
  reveal?: RevealSpec;
}
export interface ManifestSpec { blocks?: BlockDef[]; inlines?: InlineDef[] }
export type Manifest = Uint8Array;

/** Combine independently-authored syntax manifests and reject ambiguous names early. */
export function composeManifests(...specs: Array<ManifestSpec | null | undefined>): ManifestSpec {
  const blocks: BlockDef[] = [];
  const inlines: InlineDef[] = [];
  const blockNames = new Set<string>();
  const inlineNames = new Set<string>();

  for (const spec of specs) {
    if (!spec) continue;
    for (const block of spec.blocks ?? []) {
      if (blockNames.has(block.name)) {
        throw new Error(`Duplicate block extension name "${block.name}"`);
      }
      blockNames.add(block.name);
      blocks.push({ ...block, syntax: { ...block.syntax } });
    }
    for (const inline of spec.inlines ?? []) {
      if (inlineNames.has(inline.name)) {
        throw new Error(`Duplicate inline extension name "${inline.name}"`);
      }
      inlineNames.add(inline.name);
      inlines.push({ ...inline, syntax: { ...inline.syntax } });
    }
  }

  return { blocks, inlines };
}

const RENDER = { style: 0, inline_widget: 1, block_widget: 2, hit: 3 };
const REVEAL = { never: 0, caret_in_node: 1, caret_in_line: 2, caret_in_block: 3 };
const MAGIC = [0x4d, 0x44, 0x45, 0x4d]; // "MDEM"

class Writer {
  bytes: number[];
  encoder: TextEncoder;

  constructor() {
    /** @type {number[]} */
    this.bytes = [];
    this.encoder = new TextEncoder();
  }

  /** @param {number} n */
  u32(n) {
    this.bytes.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
    return this;
  }

  /** @param {number[]} values */
  u8s(values) {
    this.bytes.push(...values);
    return this;
  }

  /** @param {string} s */
  str(s) {
    const encoded = this.encoder.encode(s);
    this.u32(encoded.length);
    this.bytes.push(...encoded);
    return this;
  }

  finish() {
    return new Uint8Array(this.bytes);
  }
}

/** @param {Render} render @param {RevealSpec|undefined} reveal @param {string} where */
function codes(render: RenderSpec, reveal: RevealSpec | undefined, where: string) {
  if (!(render in RENDER)) throw new Error(`${where}: unknown render "${render}"`);
  const rev = reveal ?? 'never';
  if (!(rev in REVEAL)) throw new Error(`${where}: unknown reveal "${rev}"`);
  return [RENDER[render], REVEAL[rev]];
}

/**
 * Encode an extension manifest for `Core.newEngine`.
 *
 * @param {{blocks?: BlockDef[], inlines?: InlineDef[]}} spec
 * @returns {Manifest}
 */
export function encodeManifest(spec: ManifestSpec): Manifest {
  const blocks = spec.blocks ?? [];
  const inlines = spec.inlines ?? [];

  const w = new Writer();
  w.u8s(MAGIC).u32(blocks.length).u32(inlines.length);

  for (const b of blocks) {
    const [render, reveal] = codes(b.render, b.reveal, `block "${b.name}"`);
    // `a`/`b` carry the syntax-specific strings; see the Rust side for the mapping.
    let syntax;
    let a;
    let x = '';
    if (b.syntax.kind === 'fence') {
      syntax = 0;
      a = b.syntax.info;
    } else if (b.syntax.kind === 'directive') {
      syntax = 1;
      a = b.syntax.marker;
      x = b.syntax.name;
    } else {
      throw new Error(`block "${b.name}": unknown syntax kind`);
    }
    w.u8s([render, reveal, syntax, 0]).str(b.name).str(a).str(x);
  }

  for (const i of inlines) {
    const [render, reveal] = codes(i.render, i.reveal, `inline "${i.name}"`);
    let syntax;
    let a;
    let x = '';
    if (i.syntax.kind === 'pattern') {
      syntax = 0;
      a = i.syntax.regex;
    } else if (i.syntax.kind === 'delimited') {
      syntax = 1;
      a = i.syntax.open;
      x = i.syntax.close;
    } else {
      throw new Error(`inline "${i.name}": unknown syntax kind`);
    }
    w.u8s([render, reveal, syntax, 0]).str(i.name).str(a).str(x);
  }

  return w.finish();
}
