import type { Decoration, LayerSpan, SelectionRange } from './core.js';
import type { MarkdownEditor } from './editor.js';
import type { ManifestSpec } from './manifest.js';
import { composeManifests } from './manifest.js';

export type PluginCleanup = () => void;

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
  cleanup?: PluginCleanup;
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
