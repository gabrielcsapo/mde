// Public framework-free surface. Keeping this one entry point is what lets the package
// be bundled as a vanilla library while the React adapter remains a separate variant.

export { Core, Engine, EngineError, Kind, Reveal, Role, DEFAULT_WASM_URL, loadCore } from './core.js';
export { MarkdownEditor, diffText } from './editor.js';
export { composeManifests, encodeManifest } from './manifest.js';
export { composePluginManifests, definePlugin, pluginLayerName } from './plugins.js';
export { ResourceCache } from './resources.js';
export { IGNORE_ATTR, mergeRanges } from './applier.js';
export type {
  Decoration,
  KindValue,
  LayerSpan,
  Patch,
  Revision,
  Rewind,
  SelectionRange,
  TextEdit,
  WasmSource,
} from './core.js';
export type {
  BlockDef,
  BlockSyntax,
  InlineDef,
  InlineSyntax,
  Manifest,
  ManifestSpec,
  RenderSpec,
  RevealSpec,
} from './manifest.js';
export type {
  EditorEventMap,
  EditorPlugin,
  EditorPluginContext,
  PluginAnalysisInput,
  PluginAnalysisOptions,
  PluginCleanup,
} from './plugins.js';
export type { ResourceRequest, ResourceResolver, ResourceState } from './resources.js';
export type { WidgetProvider, WidgetRequest } from './widgets.js';
