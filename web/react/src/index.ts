// @mde/react — the React adapter variant for the drop-in markdown editor.
//
// The editor in `web/src/` is framework-free and stays that way; this package is an
// optional layer over it and imports it directly, never a fork of it.

export { MarkdownEditor, activeEditorCount } from './MarkdownEditor.js';
export { useEditorHistory, useMarkdownEditorRef } from './hooks.js';
export { preloadCore, DEFAULT_WASM_URL, loadedCoreCount } from './core.js';

// Re-exported so a host does not have to reach past this package for the vocabulary the
// decoration protocol is written in (DESIGN §3): `Role.TaskCheckbox` in an `onHit`
// handler, `Kind.Style` in a layer span.
export {
  Kind,
  Reveal,
  Role,
  composeManifests,
  composePluginManifests,
  definePlugin,
  encodeManifest,
} from '@mde/web';
