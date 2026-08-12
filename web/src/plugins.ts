import type { Decoration, LayerSpan, SelectionRange } from './core.js';
import type { MarkdownEditor } from './editor.js';
import type { ManifestSpec } from './manifest.js';
import { composeManifests } from './manifest.js';

export type PluginCleanup = () => void;

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
  /** Called once for each editor. Return cleanup for non-editor resources. */
  setup(context: EditorPluginContext): void | PluginCleanup;
}

/** The narrow, automatically-cleaned surface a plugin normally needs. */
export interface EditorPluginContext {
  readonly editor: MarkdownEditor;
  readonly signal: AbortSignal;
  readonly name: string;
  internRole(name: string): number;
  setLayer(name: string, spans: LayerSpan[]): void;
  clearLayer(name: string): void;
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
