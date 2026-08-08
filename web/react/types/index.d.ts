// Hand-written types. There is no TypeScript build in this repo and this package does not
// add one — the runtime is plain ES modules, and these are here so consumers who do use
// TypeScript get a checked surface without the package growing a toolchain.

import type { CSSProperties, ForwardRefExoticComponent, HTMLAttributes, RefAttributes } from 'react';

// ---------------------------------------------------------------------------
// The decoration protocol (DESIGN §3), as it crosses into JS.
// ---------------------------------------------------------------------------

/** `Kind` — the closed set of things a renderer must know how to draw. */
export declare const Kind: Readonly<{
  Style: 0;
  Conceal: 1;
  InlineWidget: 2;
  BlockWidget: 3;
  Gutter: 4;
  Hit: 5;
}>;

export declare const Reveal: Readonly<{
  Never: 0;
  CaretInNode: 1;
  CaretInLine: 2;
  CaretInBlock: 3;
}>;

/** Built-in role ids. Anything >= `FirstExtension` came from a manifest or `internRole`. */
export declare const Role: Readonly<{
  Heading: 0;
  Marker: 1;
  Emphasis: 2;
  Strong: 3;
  CodeInline: 4;
  CodeBlock: 5;
  Link: 6;
  LinkText: 7;
  Image: 8;
  Quote: 9;
  ListBullet: 10;
  TaskCheckbox: 11;
  Rule: 12;
  Strikethrough: 13;
  FirstExtension: 14;
}>;

export interface Decoration {
  /** UTF-16 code units. */
  start: number;
  end: number;
  /**
   * Stable identity (DESIGN §3.3). This is a `u64` and therefore a `BigInt`: never put a
   * decoration into React state or pass one as a prop — React 19's development-mode prop
   * logging deep-serializes and throws on `BigInt`.
   */
  key: bigint;
  role: number;
  kind: 0 | 1 | 2 | 3 | 4 | 5;
  reveal: number;
  depth: number;
  /** Paint order among ties: 0 is the parse, higher is a host layer. */
  layer: number;
}

export interface SelectionRange {
  start: number;
  end: number;
}

/** One step in the browsable history (DESIGN §9). */
export interface Revision {
  /** Its position in the timeline, oldest first. */
  index: number;
  /** Wall-clock milliseconds when it was recorded. */
  atMs: number;
  /** UTF-16 code units inserted and removed. */
  inserted: number;
  removed: number;
  /** Where in the document it happened. */
  at: number;
  /** How the revision was made, as the core classifies it. */
  kind: number;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  /** How many revisions are applied. */
  position: number;
  /** How many revisions exist, including ones stepped back from. */
  count: number;
}

// ---------------------------------------------------------------------------
// Extension manifest (DESIGN §5)
// ---------------------------------------------------------------------------

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

export interface ManifestSpec {
  blocks?: BlockDef[];
  inlines?: InlineDef[];
}

export declare function encodeManifest(spec: ManifestSpec): Uint8Array;

// ---------------------------------------------------------------------------
// Host services (DESIGN §5.1)
// ---------------------------------------------------------------------------

export interface WidgetRequest {
  /** The name the manifest declared, e.g. `"callout"`. */
  roleName: string | null;
  /** The exact markdown the widget replaces. */
  source: string;
  /** Fence argument, directive body, delimited inner text. */
  payload: string | null;
  decoration: Decoration;
}

export interface WidgetProvider {
  /** Return null to fall through to the resource resolver, then to plain styled text. */
  makeWidget(request: WidgetRequest): HTMLElement | null;
  /**
   * Whether this widget handles its own clicks. Defaults to false, and the default
   * matters — a widget that captures clicks stops the caret ever reaching the source it
   * replaced (DESIGN §4).
   */
  widgetWantsPointerEvents?(roleName: string | null): boolean;
}

export interface ResourceRequest {
  /** A path or URL — never content. */
  reference: string;
  roleName: string | null;
  /** Full markdown source of the node. */
  source: string;
}

export type ResourceState =
  | { state: 'loading' }
  | { state: 'ready'; view: HTMLElement }
  | { state: 'failed'; message: string };

export interface ResourceResolver {
  resolve(request: ResourceRequest): Promise<ResourceState>;
  reservedSize(request: ResourceRequest): { width: number; height: number };
}

export type ResourceSizes = Record<string, { width: number; height: number }>;

// ---------------------------------------------------------------------------
// Layers (DESIGN §5.3)
// ---------------------------------------------------------------------------

export interface LayerSpan {
  start: number;
  end: number;
  /** A role id, or a name to be interned on first use. */
  role: number | string;
  /** Defaults to `Kind.Style`. */
  kind?: number;
  depth?: number;
}

export type Layers = Record<string, LayerSpan[]>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The underlying framework-free editor from `web/src/editor.js`. Typed opaquely here:
 * reach for it through `handle.getEditor()` when you need something this adapter does not
 * expose (an extension from `web/extensions/`, for instance).
 */
export type CoreMarkdownEditor = EventTarget & Record<string, any>;

export interface MarkdownEditorHandle {
  isReady(): boolean;
  getEditor(): CoreMarkdownEditor | null;
  getEngine(): any;
  getCore(): any;
  getElement(): HTMLDivElement | null;
  focus(): void;

  getMarkdown(): string;
  /** Replaces the document wholesale. Clears the undo history (DESIGN §9). */
  setMarkdown(text: string): void;
  replaceRange(start: number, end: number, text: string): void;
  /** Replaces the selection. Returns false when there is no caret in the editor. */
  insertText(text: string): boolean;

  getSelection(): SelectionRange | null;
  setSelection(range: SelectionRange): void;

  /**
   * Wrap the selection, as one undo step. `wrapSelection('**')` is the Bold command.
   * Returns false when the selection is empty or the editor is not ready.
   */
  wrapSelection(prefix: string, suffix?: string): boolean;
  toggleTask(decoration: Decoration): void;

  canUndo(): boolean;
  canRedo(): boolean;
  undo(): boolean;
  redo(): boolean;
  /** Force the next edit to start a new undo step. */
  closeUndoGroup(): void;
  /**
   * The whole timeline, oldest first, including revisions that have been undone. Plain
   * numbers throughout — safe to render, unlike a `Decoration`.
   */
  getRevisions(): Revision[];
  /** How many revisions are applied: the caret's position in the timeline. */
  getHistoryPosition(): number;
  /** Move anywhere in the timeline. Undo and redo are the one-step view of this. */
  jumpTo(target: number): boolean;

  internRole(name: string): number;
  setLayer(name: string, spans: LayerSpan[]): void;
  clearLayer(name: string): void;

  /** Live decorations. These carry `BigInt` keys — do not put the result in state. */
  getDecorations(): Decoration[];
  getResourceSizes(): ResourceSizes;
  setResourceSizes(sizes: ResourceSizes): void;
}

export interface MarkdownEditorProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'onSelect' | 'defaultValue' | 'children'> {
  /**
   * Initial markdown. The editor is uncontrolled: this is read once, when the instance is
   * created. Change the `key` to load a different document declaratively, or call
   * `handle.setMarkdown()`.
   */
  defaultValue?: string;
  /**
   * Optional controlled-ish value. Only differences that did **not** come from the editor
   * are applied, and they are applied as one minimal replacement through the normal edit
   * path. It is not a per-keystroke controlled input — the DOM is the buffer. See the
   * README.
   */
  value?: string;
  onChange?(markdown: string, editor: MarkdownEditorHandle): void;
  onSelectionChange?(range: SelectionRange | null, editor: MarkdownEditorHandle): void;
  onHit?(
    hit: { decoration: Decoration; source: string },
    editor: MarkdownEditorHandle
  ): void;
  /** Fires only when one of the four scalars moves. Pair with `useEditorHistory`. */
  onHistoryChange?(state: HistoryState): void;
  /** The editor exists and the document is rendered. */
  onReady?(editor: MarkdownEditorHandle): void;
  /** The wasm failed to load or the manifest was rejected. */
  onError?(error: unknown): void;

  /** Where `mde.wasm` lives. Defaults to the copy next to `web/src`. */
  wasm?: string | URL | ArrayBuffer | Response;
  /** Extension manifest, as a spec object or pre-encoded bytes. */
  manifest?: ManifestSpec | Uint8Array | null;

  /**
   * Host-drawn widgets. Whether one is supplied is fixed at mount; the implementation may
   * change freely afterwards.
   */
  widgetProvider?: WidgetProvider;
  /** Same lifetime rule as `widgetProvider`. */
  resourceResolver?: ResourceResolver;
  /** Sizes remembered from a previous session, seeded at mount. */
  resourceSizes?: ResourceSizes;

  /** Declarative host decoration layers. Diffed by content, not by identity. */
  layers?: Layers;

  /** Toggle `- [ ]` checkboxes when one is clicked. Default true. */
  toggleTasksOnClick?: boolean;
  autoFocus?: boolean;

  className?: string;
  style?: CSSProperties;
}

export declare const MarkdownEditor: ForwardRefExoticComponent<
  MarkdownEditorProps & RefAttributes<MarkdownEditorHandle>
>;

// ---------------------------------------------------------------------------
// Hooks and module-level helpers
// ---------------------------------------------------------------------------

export declare function useMarkdownEditorRef(): { current: MarkdownEditorHandle | null };

export declare function useEditorHistory(): [HistoryState, (next: HistoryState) => void];

/** Compile the wasm before the first editor mounts. Idempotent. */
export declare function preloadCore(
  source?: string | URL | ArrayBuffer | Response
): Promise<any>;

export declare const DEFAULT_WASM_URL: URL;

/** Diagnostics. How many editors are mounted, and how many wasm sources are loaded. */
export declare function activeEditorCount(): number;
export declare function loadedCoreCount(): number;
