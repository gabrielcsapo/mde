import type {
  CSSProperties,
  ForwardRefExoticComponent,
  HTMLAttributes,
  ReactNode,
  RefAttributes,
} from 'react';
import type {
  Core,
  Decoration,
  EditorPlugin,
  EditorPluginContext,
  Engine,
  LayerSpan as CoreLayerSpan,
  ManifestSpec,
  MarkdownEditor as CoreMarkdownEditor,
  PluginCommandDescriptor,
  PluginPresentationDismissReason,
  PluginPresentationHandle,
  PluginPresentationOptions,
  ResourceResolver,
  Revision,
  SelectionRange,
  WidgetProvider,
} from '@mde/web';

export {
  Kind,
  Reveal,
  Role,
  composeManifests,
  composePluginManifests,
  definePlugin,
  encodeManifest,
} from '@mde/web';
export type {
  Decoration,
  EditorPlugin,
  EditorPluginContext,
  ManifestSpec,
  ResourceRequest,
  ResourceResolver,
  ResourceState,
  Revision,
  SelectionRange,
  WidgetProvider,
  WidgetRequest,
  PluginCommandDescriptor,
  PluginCommandHandle,
  PluginCommandOptions,
  PluginPresentationDismissReason,
  PluginPresentationHandle,
  PluginPresentationOptions,
} from '@mde/web';

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  /** How many revisions are applied. */
  position: number;
  /** How many revisions exist, including ones stepped back from. */
  count: number;
}

export type ResourceSizes = Record<string, { width: number; height: number }>;

// ---------------------------------------------------------------------------
// Layers (DESIGN §5.3)
// ---------------------------------------------------------------------------

export type LayerSpan = Omit<CoreLayerSpan, 'role'> & {
  /** A role id, or a name to be interned on first use. */
  role: number | string;
};

export type Layers = Record<string, LayerSpan[]>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface MarkdownEditorHandle {
  isReady(): boolean;
  getEditor(): CoreMarkdownEditor | null;
  getEngine(): Engine | null;
  getCore(): Core | null;
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
  installPlugin(plugin: EditorPlugin): void;
  removePlugin(name: string): boolean;
  getInstalledPlugins(): string[];
  getCommands(): PluginCommandDescriptor[];
  executeCommand(id: string): boolean;

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
  /** Command/Ctrl-click on a rendered link label requested navigation. */
  onLinkOpen?(
    link: { decoration: Decoration; destination: string },
    editor: MarkdownEditorHandle
  ): void;
  /** Fires only when one of the four scalars moves. Pair with `useEditorHistory`. */
  onHistoryChange?(state: HistoryState): void;
  onCommandsChange?(commands: PluginCommandDescriptor[], editor: MarkdownEditorHandle): void;
  /** The editor exists and the document is rendered. */
  onReady?(editor: MarkdownEditorHandle): void;
  /** The wasm failed to load or the manifest was rejected. */
  onError?(error: unknown): void;

  /** Where `mde.wasm` lives. Pass an imported asset URL when using a bundler. */
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

  /** Runtime plugins. Syntax contributed by `plugin.manifest` is composed at startup. */
  plugins?: readonly EditorPlugin[];

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

export declare function useEditorCommands(): [
  PluginCommandDescriptor[],
  (next: PluginCommandDescriptor[]) => void,
];

export type ReactPresentationOptions = Omit<
  PluginPresentationOptions,
  'element' | 'onDismiss'
> & {
  className?: string;
  onDismiss?: (reason: PluginPresentationDismissReason) => void;
};

export interface ReactPresentationHandle {
  readonly presentation: PluginPresentationHandle;
  readonly element: HTMLDivElement;
  render(node: ReactNode): void;
  update(options: ReactPresentationOptions): void;
  dismiss(reason?: PluginPresentationDismissReason): void;
}

export declare function createReactPresentation(
  context: EditorPluginContext,
  name: string,
  node: ReactNode,
  options?: ReactPresentationOptions,
): ReactPresentationHandle;

export declare function usePluginPresentation(
  context: EditorPluginContext | null,
  name: string,
  node: ReactNode,
  options?: ReactPresentationOptions,
): ReactPresentationHandle | null;

/** Compile the wasm before the first editor mounts. Idempotent. */
export declare function preloadCore(
  source?: string | URL | ArrayBuffer | Response
): Promise<any>;

export declare const DEFAULT_WASM_URL: URL;

/** Diagnostics. How many editors are mounted, and how many wasm sources are loaded. */
export declare function activeEditorCount(): number;
export declare function loadedCoreCount(): number;
