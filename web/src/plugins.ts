import type { Decoration, LayerSpan, SelectionRange } from './core.js';
import type { MarkdownEditor } from './editor.js';
import type { ManifestSpec } from './manifest.js';
import type { ResourceRequest, ResourceResolver } from './resources.js';
import { composeManifests } from './manifest.js';
import type {
  PluginDocumentCapability,
  PluginInputRulesCapability,
  PluginRequirement,
  PluginSelectionCapability,
  PluginSemanticsCapability,
  PluginStateCapability,
  PluginTransfersCapability,
} from '@mde/plugin-sdk';
export {
  MDE_PLUGIN_API_VERSION,
  PluginCompatibilityError,
  assertPluginRequirements,
} from '@mde/plugin-sdk';
export type * from '@mde/plugin-sdk';

export type PluginCleanup = () => void;

export type PluginPresentationAnchor = 'selection' | 'editor' | 'viewport';
export type PluginPresentationPlacement = 'auto' | 'above' | 'below';
export type PluginPresentationDismissReason =
  | 'programmatic'
  | 'escape'
  | 'outside-pointer'
  | 'replaced'
  | 'plugin-removed';

export interface PluginPresentationHandle {
  readonly id: string;
  update(options: Partial<PluginPresentationOptions>): void;
  reposition(): void;
  dismiss(reason?: PluginPresentationDismissReason): void;
}

/** A plugin-owned view that floats above the editor without entering its source DOM. */
export interface PluginPresentationOptions {
  element: HTMLElement;
  /** Selection popover, editor-attached panel, or viewport-centred modal. */
  anchor?: PluginPresentationAnchor;
  /** Selection presentations flip automatically when there is not enough room below. */
  placement?: PluginPresentationPlacement;
  /** Gap from the anchor in CSS pixels. Defaults to 8. */
  offset?: number;
  /** Adds dialog semantics. Viewport presentations default to modal. */
  modal?: boolean;
  /** Escape dismisses by default. */
  dismissOnEscape?: boolean;
  /** Pointer interaction outside the view dismisses it when enabled. */
  dismissOnOutsidePointer?: boolean;
  /** Modal presentations trap Tab by default. */
  trapFocus?: boolean;
  /** Return focus to the previously focused element on dismissal. Defaults to true. */
  restoreFocus?: boolean;
  /** Optional focus target after mounting. */
  initialFocus?: HTMLElement | (() => HTMLElement | null);
  /** Override the portal root. Defaults to document.body. */
  container?: HTMLElement;
  /** Called after teardown with the reason the view closed. */
  onDismiss?: (reason: PluginPresentationDismissReason) => void;
}

export interface PluginCommandOptions {
  /** Human-readable label used by palettes, menus, and toolbars. */
  title: string;
  /** Optional keyboard key. Commands without one remain programmatically discoverable. */
  key?: string;
  /** Command on Apple keyboards and Control elsewhere. */
  primary?: boolean;
  shift?: boolean;
  alt?: boolean;
  category?: string;
  keywords?: readonly string[];
  enabled?: () => boolean;
  checked?: () => boolean;
  handler: (event?: KeyboardEvent) => void | boolean;
}

export interface PluginCommandDescriptor {
  readonly id: string;
  readonly plugin: string;
  readonly name: string;
  readonly title: string;
  readonly key: string | null;
  readonly primary: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly category: string | null;
  readonly keywords: readonly string[];
  readonly enabled: boolean;
  readonly checked: boolean;
}

export interface PluginCommandHandle {
  readonly id: string;
  update(options: Partial<PluginCommandOptions>): void;
  unregister(): void;
}
export interface PluginCommandsCapability {
  register(name: string, command: PluginCommandOptions): PluginCommandHandle;
  list(): PluginCommandDescriptor[];
  execute(id: string, event?: KeyboardEvent): boolean;
}
export interface PluginViewCapability {
  readonly root: HTMLElement;
  focus(): void;
  getActiveDescendant(): string | null;
  setActiveDescendant(id: string | null): void;
  reportError(task: string, error: unknown): void;
}
export interface PluginResourceContribution {
  resolver: ResourceResolver;
  priority?: number;
  accepts?(request: ResourceRequest): boolean;
}
export interface PluginResourcesCapability {
  register(name: string, contribution: PluginResourceContribution): import('@mde/plugin-sdk').PluginOwnedHandle;
}

export interface PluginAnalysisInput {
  /** Immutable source snapshot captured when the analysis was scheduled. */
  readonly markdown: string;
  /** Aborted when superseded, cancelled, or the plugin is removed. */
  readonly signal: AbortSignal;
  /** Monotonic id within this plugin, useful for worker request correlation. */
  readonly sequence: number;
}

export interface PluginAnalysisOptions {
  /** Debounce before starting work. Defaults to zero. */
  delayMs?: number;
  /** Diagnostic threshold for the analysis callback itself. Defaults to 16 ms. */
  budgetMs?: number;
}

export interface PluginAnalysisDiagnostic {
  plugin: string;
  task: string;
  sequence: number;
  durationMs: number;
  budgetMs: number;
  overBudget: boolean;
  cancelled: boolean;
}

/** A runtime extension with an editor-scoped lifecycle. */
export interface EditorPlugin {
  /** Stable, package-qualified identity, for example `acme.comments`. */
  name: string;
  /** Optional parser syntax contributed before the engine is created. */
  manifest?: ManifestSpec;
  /** Explicit host contract, checked before setup runs. */
  requires?: PluginRequirement;
  /** Called once for each editor. Return cleanup for non-editor resources. */
  setup(context: EditorPluginContext): void | PluginCleanup;
}

/** The narrow, automatically-cleaned surface a plugin normally needs. */
export interface EditorPluginContext {
  readonly apiVersion: 1;
  readonly capabilities: ReadonlySet<import('@mde/plugin-sdk').PluginCapabilityName>;
  readonly document: PluginDocumentCapability;
  readonly selection: PluginSelectionCapability;
  readonly semantics: PluginSemanticsCapability;
  readonly state: PluginStateCapability;
  readonly inputRules: PluginInputRulesCapability;
  readonly transfers: PluginTransfersCapability;
  readonly commands: PluginCommandsCapability;
  readonly view: PluginViewCapability;
  readonly resources: PluginResourcesCapability;
  /** @deprecated Use the small capability objects above. */
  readonly editor: MarkdownEditor;
  readonly signal: AbortSignal;
  readonly name: string;
  internRole(name: string): number;
  setLayer(name: string, spans: LayerSpan[]): void;
  clearLayer(name: string): void;
  /** Register an automatically removed editor keyboard command. */
  registerCommand(name: string, command: PluginCommandOptions): PluginCommandHandle;
  /** Show or replace one plugin-owned floating view. */
  showPresentation(name: string, options: PluginPresentationOptions): PluginPresentationHandle;
  dismissPresentation(name: string, reason?: PluginPresentationDismissReason): void;
  /** Listen on the contenteditable host with the plugin lifecycle signal. */
  onRoot<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void;
  /**
   * Run latest-wins analysis against a source snapshot. A replacement with the same
   * name aborts the previous signal; results from stale work are never applied.
   * Expensive analyzers should use a Worker and resolve the returned promise.
   */
  scheduleAnalysis<T>(
    name: string,
    analyze: (input: PluginAnalysisInput) => T | Promise<T>,
    apply: (result: T) => void,
    options?: PluginAnalysisOptions,
  ): void;
  cancelAnalysis(name: string): void;
  on<K extends keyof EditorEventMap>(
    type: K,
    listener: (event: EditorEventMap[K]) => void,
  ): void;
}

export interface EditorEventMap {
  change: Event;
  selectionchange: CustomEvent<{ range: SelectionRange | null }>;
  hit: CustomEvent<{ decoration: Decoration; source: string }>;
  linkopen: CustomEvent<{ decoration: Decoration; destination: string }>;
  pluginerror: CustomEvent<{ plugin: string; task: string; error: unknown }>;
  plugindiagnostic: CustomEvent<PluginAnalysisDiagnostic>;
  commandschange: CustomEvent<{ commands: PluginCommandDescriptor[] }>;
  commandconflict: CustomEvent<{ shortcut: string; commandIds: string[]; winner: string }>;
  plugintransaction: CustomEvent<{
    plugin: string;
    transaction: import('@mde/plugin-sdk').PluginTransaction;
    result: import('@mde/plugin-sdk').PluginTransactionResult;
  }>;
}

/** Preserve inference while checking a plugin object at its declaration site. */
export function definePlugin<T extends EditorPlugin>(plugin: T): T {
  if (!plugin.name.trim()) throw new Error('A plugin name must not be empty');
  return plugin;
}

export interface InstalledPlugin {
  plugin: EditorPlugin;
  controller: AbortController;
  layers: Set<string>;
  analyses: Map<string, PluginAnalysisRun>;
  commands: Set<string>;
  presentations: Set<string>;
  inputRules: Set<string>;
  transfers: Set<string>;
  resources: Set<string>;
  legacyEditorAccessed: boolean;
  analysisSequence: number;
  cleanup?: PluginCleanup;
}

export interface PluginAnalysisRun {
  controller: AbortController;
  timer: number | null;
  sequence: number;
  diagnosticPublished: boolean;
}

export function pluginLayerName(plugin: string, local: string): string {
  if (!local.trim()) throw new Error(`Plugin "${plugin}" used an empty layer name`);
  return `plugin:${plugin}:${local}`;
}

/** Compose an application's syntax with every plugin contribution, in install order. */
export function composePluginManifests(
  base: ManifestSpec | null | undefined,
  plugins: readonly EditorPlugin[],
): ManifestSpec {
  return composeManifests(base, ...plugins.map((plugin) => plugin.manifest));
}
