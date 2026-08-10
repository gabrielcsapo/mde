import type { MarkdownEditor } from './editor.js';
import type { EditorPlugin } from './plugins.js';

export interface PluginCompatibilityOptions {
  markdown?: string;
  selection?: { start: number; end: number };
  /** Time allowed for a debounced or worker-backed plugin to publish its first result. */
  settleMs?: number;
}

export interface PluginCompatibilityReport {
  name: string;
  installed: boolean;
  removed: boolean;
  sourcePreserved: boolean;
  contributedLayerDecorations: number;
  cleanupRemovedLayers: boolean;
}

function layerKeys(editor: MarkdownEditor): Set<bigint> {
  return new Set(
    editor.decorations
      .filter((decoration) => decoration.layer > 0)
      .map((decoration) => decoration.key),
  );
}

/**
 * Exercise the portable plugin contract against a fresh editor in any test runner.
 *
 * The helper intentionally has no Vitest/Jest dependency. It throws lifecycle errors
 * from the plugin itself and returns plain facts a caller can assert with its framework
 * of choice.
 */
export async function checkPluginCompatibility(
  editor: MarkdownEditor,
  plugin: EditorPlugin,
  options: PluginCompatibilityOptions = {},
): Promise<PluginCompatibilityReport> {
  const markdown = options.markdown ?? '# Plugin compatibility\n\nTest **content**.\n';
  editor.setMarkdown(markdown);
  if (options.selection) editor.setSelectionRange(options.selection);
  const before = layerKeys(editor);

  editor.installPlugin(plugin);
  const installed = editor.installedPlugins.includes(plugin.name.trim());
  if ((options.settleMs ?? 0) > 0) {
    await new Promise((resolve) => window.setTimeout(resolve, options.settleMs));
  } else {
    await Promise.resolve();
  }

  const during = layerKeys(editor);
  const contributed = [...during].filter((key) => !before.has(key));
  const sourcePreserved = editor.markdown === markdown;
  const removed = editor.removePlugin(plugin.name.trim());
  const after = layerKeys(editor);

  return {
    name: plugin.name.trim(),
    installed,
    removed,
    sourcePreserved,
    contributedLayerDecorations: contributed.length,
    cleanupRemovedLayers: contributed.every((key) => !after.has(key)),
  };
}
