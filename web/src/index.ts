// Public framework-free surface. Keeping this one entry point is what lets the package
// be bundled as a vanilla library while the React adapter remains a separate variant.

export { Core, Engine, EngineError, Kind, Reveal, Role, DEFAULT_WASM_URL, loadCore } from './core.js';
export { MarkdownEditor, diffText } from './editor.js';
export type { MarkdownInteractionMode } from './editor.js';
export { composeManifests, encodeManifest } from './manifest.js';
export { composePluginManifests, definePlugin, pluginLayerName } from './plugins.js';
export { MDE_PLUGIN_API_VERSION, PluginCompatibilityError } from '@mdink/plugin-sdk';
export { ResourceCache } from './resources.js';
export { MediaPreviewCache } from './media-previews.js';
export { MarkdownSession } from './session.js';
export { prepareDocument } from './preparation.js';
export { executeMarkdownCommand, markdownCommand } from './commands.js';
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
  PluginAnalysisDiagnostic,
  PluginAnalysisOptions,
  PluginCleanup,
  PluginCommandDescriptor,
  PluginCommandHandle,
  PluginCommandOptions,
  PluginPresentationAnchor,
  PluginPresentationDismissReason,
  PluginPresentationHandle,
  PluginPresentationOptions,
  PluginPresentationPlacement,
  PluginRenderersCapability,
} from './plugins.js';
export type * from '@mdink/plugin-sdk';
export type { ResourceRequest, ResourceResolver, ResourceState } from './resources.js';
export type {
  MediaPreviewCacheOptions,
  MediaPreviewCacheStats,
  MediaPreviewKind,
  MediaPreviewRequest,
} from './media-previews.js';
export type { SessionDocument } from './session.js';
export type { PreparedDocument, PrepareDocumentOptions } from './preparation.js';
export type { CommandResult, MarkdownCommand } from './commands.js';
export type {
  WidgetMount,
  WidgetProvider,
  WidgetRenderContext,
  WidgetRenderer,
  WidgetRequest,
  WidgetResult,
} from './widgets.js';
