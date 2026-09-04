// The public surfaces, as data.
//
// Every signature here was read out of the source, not remembered:
//
//   web/src/core.ts · web/src/editor.ts · web/src/manifest.ts
//   web/src/widgets.ts · web/src/resources.ts
//   apple/Sources/MDECore/MDECore.swift · apple/Sources/MDEditorUI/*.swift
//
// Written as data rather than as prose for three reasons: the reference pages then have
// one layout instead of forty hand-built ones, the search index can list symbols without
// anybody typing them twice, and a symbol that gains a parameter is edited in exactly one
// place. Summaries are short on purpose — the argument for a design lives in Concepts,
// and repeating it next to every method is how reference documentation becomes unusable.

/**
 * @typedef {object} Symbol
 * @property {string} name       what a reader would search for
 * @property {'function'|'method'|'property'|'class'|'type'|'event'|'protocol'} kind
 * @property {string} signature  exactly as written in the source
 * @property {string} summary    one sentence
 * @property {[string, string][]} [params] name, meaning
 * @property {string} [returns]
 * @property {string} [note]     the thing that bites, when there is one
 */

/**
 * @typedef {object} SymbolGroup
 * @property {string} id      also the `H2` anchor on the page that renders it
 * @property {string} title
 * @property {string} file    where it lives in the repository
 * @property {string} intro
 * @property {Symbol[]} symbols
 */

// ---------------------------------------------------------------- web

/** @type {SymbolGroup[]} */
export const WEB_API = [
  {
    id: 'loading',
    title: 'Loading the core',
    file: 'web/src/core.ts',
    intro:
      'The wasm module is fetched and instantiated once. A `Core` owns the instance; an `Engine` is one document’s worth of state, and a page may hold several.',
    symbols: [
      {
        name: 'loadCore',
        kind: 'function',
        signature: 'async loadCore(source: string | URL | Response | ArrayBuffer): Promise<Core>',
        summary:
          'Instantiate the wasm core. Accepts a URL to fetch, a `Response` you already have, or the bytes themselves.',
        note: 'It needs a real origin — a page opened over `file://` cannot instantiate wasm.',
      },
      {
        name: 'Core.newEngine',
        kind: 'method',
        signature: 'newEngine(manifest: Uint8Array | null = null): Engine',
        summary:
          'Create an engine, optionally with an extension manifest encoded by `encodeManifest`.',
        note: 'Throws if the manifest is malformed. No manifest means the built-in markdown constructs and nothing else.',
      },
      {
        name: 'Core.memory',
        kind: 'property',
        signature: 'get memory(): DataView',
        summary:
          'A fresh view over the instance’s linear memory. Never cached, because growth detaches the old buffer.',
      },
      {
        name: 'encodeManifest',
        kind: 'function',
        signature: 'encodeManifest(spec: {blocks?: BlockDef[], inlines?: InlineDef[]}): Uint8Array',
        summary:
          'Encode a manifest into the compact binary form the web build reads. Same fields as the TOML manifest, as a plain object.',
        note: 'Exported from `web/src/manifest.ts`. The web build drops the TOML parser entirely — it cost ~350 KB of wasm for a parse that happens once.',
      },
      {
        name: 'composeManifests',
        kind: 'function',
        signature: 'composeManifests(...specs: (ManifestSpec | null | undefined)[]): ManifestSpec',
        summary:
          'Combine independently authored syntax manifests without mutating them.',
        note: 'Duplicate block or inline names are rejected before engine construction.',
      },
    ],
  },
  {
    id: 'engine',
    title: 'Engine',
    file: 'web/src/core.ts',
    intro:
      'The typed wrapper over the wasm boundary, and the JS mirror of `MarkdownEngine` on Apple. Not reentrant: drive it from one place, which is where text input lives anyway. Every offset is a UTF-16 code unit.',
    symbols: [
      {
        name: 'Engine.reset',
        kind: 'method',
        signature: 'reset(text: string): Patch',
        summary: 'Full resync from an authoritative buffer.',
        note: 'Clears the undo history: after a desync the recorded offsets describe a document that never existed on the host side.',
      },
      {
        name: 'Engine.edit',
        kind: 'method',
        signature:
          'edit(start: number, end: number, text: string, documentLength: number | null, now = performance.now()): Patch',
        summary: 'Report an edit the host has already applied to its own buffer.',
        params: [
          ['start, end', 'the range that was replaced, in the pre-edit document'],
          ['text', 'what replaced it'],
          ['documentLength', 'the post-edit length, checked against the mirror; `null` to skip'],
          ['now', 'milliseconds, which is what drives undo coalescing'],
        ],
        returns: 'A patch of decoration changes.',
        note: 'Throws `EngineError` with `isDesync` set when the length disagrees. Never call it for edits that came out of `undo()` or `redo()` — they are already in the history.',
      },
      {
        name: 'Engine.setSelection',
        kind: 'method',
        signature: 'setSelection(range: {start: number, end: number} | null): Patch',
        summary:
          'Tell the core where the caret is. Pass `null` on blur so the document collapses back to its rendered form.',
        note: 'A selection change produces a decoration patch — that is what reveal is.',
      },
      {
        name: 'Engine.boundary',
        kind: 'method',
        signature: 'boundary(): void',
        summary:
          'Force the next edit to begin a new undo step. Call it either side of a formatting command.',
      },
      {
        name: 'Engine.canUndo',
        kind: 'property',
        signature: 'get canUndo(): boolean',
        summary: 'Whether there is a revision to step back to.',
      },
      {
        name: 'Engine.canRedo',
        kind: 'property',
        signature: 'get canRedo(): boolean',
        summary: 'Whether there is a revision to step forward to.',
      },
      {
        name: 'Engine.undo',
        kind: 'method',
        signature:
          'undo(): {edits: {start, end, text}[], selection: {start, end} | null, patch: Patch} | null',
        summary:
          'Step back one revision. Apply the returned edits to the host buffer *without* reporting them back.',
        note: 'Undo is the one flow that travels core → platform.',
      },
      {
        name: 'Engine.redo',
        kind: 'method',
        signature: 'redo(): ReturnType<Engine["undo"]>',
        summary: 'Step forward one revision, with the same contract as `undo`.',
      },
      {
        name: 'Engine.revisions',
        kind: 'method',
        signature:
          'revisions(): {index, at, atMs, inserted, removed, kind}[] · get historyPosition(): number',
        summary:
          'The whole timeline, oldest first, including revisions that have been undone — a history you can browse has to show the branch you stepped back from.',
      },
      {
        name: 'Engine.jumpTo',
        kind: 'method',
        signature: 'jumpTo(target: number): ReturnType<Engine["undo"]>',
        summary:
          'Move to any point in the timeline rather than one step at a time. Undo and redo are the two-button view of this.',
        note: 'However far it travels, the result is a single splice: the start and end texts are diffed rather than the intermediate steps replayed.',
      },
      {
        name: 'Engine.payload',
        kind: 'method',
        signature: 'payload(key: bigint): string | null',
        summary:
          'Extra text the parser already resolved for a decoration: an image or link destination, a fence argument, the inside of a delimited token.',
        note: 'A reference, never content. Resolving it is the host’s job.',
      },
      {
        name: 'Engine.roleName',
        kind: 'method',
        signature: 'roleName(role: number): string | null',
        summary: 'The interned name for a role id. Cached — the mapping never changes for an engine.',
      },
      {
        name: 'Engine.internRole',
        kind: 'method',
        signature: 'internRole(name: string): number',
        summary:
          'Get, or create, the role id for a name, so a host can decorate with roles that no manifest declared.',
      },
      {
        name: 'Engine.setLayer',
        kind: 'method',
        signature:
          'setLayer(name: string, spans: {start, end, role, kind?, depth?}[]): Patch',
        summary:
          'Replace a named layer’s decorations with host-computed spans. Layers paint after the parse, in registration order.',
      },
      {
        name: 'Engine.clearLayer',
        kind: 'method',
        signature: 'clearLayer(name: string): Patch',
        summary: 'Remove a layer entirely.',
        note: 'Not the same as pushing zero spans — an empty layer keeps its slot in the paint order.',
      },
      {
        name: 'Engine.free',
        kind: 'method',
        signature: 'free(): void',
        summary: 'Release the engine’s wasm-side allocation.',
      },
      {
        name: 'EngineError',
        kind: 'class',
        signature: 'class EngineError extends Error { status: number; isDesync: boolean }',
        summary:
          'Thrown for a non-zero status: `1` desync, `2` out of bounds, `3` bad argument.',
      },
    ],
  },
  {
    id: 'editor',
    title: 'MarkdownEditor',
    file: 'web/src/editor.ts',
    intro:
      'The `contenteditable` host, and the web counterpart of `MarkdownTextView`. It extends `EventTarget`. The DOM is the buffer; the editor keeps a mirror and recovers each edit by diffing.',
    symbols: [
      {
        name: 'new MarkdownEditor',
        kind: 'class',
        signature:
          "new MarkdownEditor(host: HTMLElement, engine: Engine, options?: {widgetProvider?: WidgetProvider, resourceResolver?: ResourceResolver, interactionMode?: 'edit' | 'view'})",
        summary:
          'Take over `host`: it gains `contenteditable="plaintext-only"`, the `mde-editor` class, and the editor owns its contents from that moment.',
        note: 'The engine is not owned — the caller constructed it and may hand it to another view.',
      },
      {
        name: 'MarkdownEditor.interactionMode',
        kind: 'property',
        signature: "get/set interactionMode: 'edit' | 'view' · setInteractionMode(mode): void",
        summary:
          'Edit is source-first. View is selectable and read-only, keeps syntax rendered, opens links normally, and leaves programmatic sync APIs available.',
      },
      {
        name: 'MarkdownEditor.setMarkdown',
        kind: 'method',
        signature: 'setMarkdown(text: string): void',
        summary: 'Load a document. Resets the engine, so it also clears the undo history.',
      },
      {
        name: 'MarkdownEditor.markdown',
        kind: 'property',
        signature: 'get markdown(): string',
        summary: 'The document, which is the whole state there is.',
      },
      {
        name: 'MarkdownEditor.decorations',
        kind: 'property',
        signature: 'get decorations(): Decoration[]',
        summary:
          'Every decoration currently in effect, reveal already applied, sorted by start offset.',
      },
      {
        name: 'MarkdownEditor.resourceSizes',
        kind: 'property',
        signature: 'get/set resourceSizes(): Record<string, {width, height}>',
        summary:
          'Sizes of resources that have already resolved, keyed by reference. Persist them and set them back next load.',
        note: 'Turns “the document shifts once per page load” into “once per asset, ever”.',
      },
      {
        name: 'MarkdownEditor.setLayer',
        kind: 'method',
        signature: 'setLayer(name: string, spans: {start, end, role, kind?, depth?}[]): void',
        summary: 'Replace a host layer and repaint what changed. The seam an extension builds on.',
      },
      {
        name: 'MarkdownEditor.clearLayer',
        kind: 'method',
        signature: 'clearLayer(name: string): void',
        summary: 'Remove a host layer.',
      },
      {
        name: 'MarkdownEditor.internRole',
        kind: 'method',
        signature: 'internRole(name: string): number',
        summary:
          'A role id for a name the theme can style. An unknown role becomes `.mde-ext-<name>` on the run.',
      },
      {
        name: 'MarkdownEditor.replaceRange',
        kind: 'method',
        signature: 'replaceRange(start: number, end: number, text: string): void',
        summary:
          'Programmatic edit through the same path a keystroke takes, so it is recorded and repainted identically.',
        note:
          'Offsets are UTF-16 and must be ordered, in bounds, and between Unicode scalars. Invalid ranges throw `RangeError` before either the JS mirror or Rust core changes.',
      },
      {
        name: 'MarkdownEditor.toggleTask',
        kind: 'method',
        signature: 'toggleTask(decoration: Decoration): void',
        summary: 'Flip a `- [ ]` / `- [x]` checkbox, as its own undo step.',
      },
      {
        name: 'MarkdownEditor.selectionRange',
        kind: 'method',
        signature: 'selectionRange(): {start: number, end: number} | null',
        summary: 'The current selection in document offsets, or `null` when it is not in this editor.',
      },
      {
        name: 'MarkdownEditor.setSelectionRange',
        kind: 'method',
        signature: 'setSelectionRange(range: {start: number, end: number}): void',
        summary: 'Place the selection. Restoring is guarded so it does not re-enter as a user change.',
      },
      {
        name: 'MarkdownEditor.undo',
        kind: 'method',
        signature: 'undo(): boolean · redo(): boolean · closeUndoGroup(): void',
        summary:
          'History, owned by the core. `canUndo` and `canRedo` are properties; `closeUndoGroup` forces a boundary.',
      },
      {
        name: 'MarkdownEditor.revisions',
        kind: 'property',
        signature:
          'get revisions(): Revision[] · get historyPosition(): number · jumpTo(target: number): boolean',
        summary:
          'The browsable timeline. Each entry carries a timestamp and what it did, which is enough for a panel to label it without the core guessing at intent.',
      },
      {
        name: 'MarkdownEditor.destroy',
        kind: 'method',
        signature: 'destroy(): void',
        summary:
          'Detach and stop listening. Required by any host that unmounts: the `selectionchange` listener is on `document` and outlives the element.',
      },
      {
        name: 'MarkdownEditor.installPlugin',
        kind: 'method',
        signature: 'installPlugin(plugin: EditorPlugin): void',
        summary:
          'Install one named plugin with scoped listeners, roles and automatically namespaced layers.',
        note: 'Duplicate or empty names throw. A setup that throws is rolled back completely.',
      },
      {
        name: 'MarkdownEditor.removePlugin',
        kind: 'method',
        signature: 'removePlugin(name: string): boolean · get installedPlugins(): string[]',
        summary:
          'Uninstall a plugin and clear everything it registered through its context.',
      },
      {
        name: 'change',
        kind: 'event',
        signature: "addEventListener('change', () => …)",
        summary: 'The document changed, from a keystroke, a command, undo, or `setMarkdown`.',
      },
      {
        name: 'selectionchange',
        kind: 'event',
        signature:
          "addEventListener('selectionchange', (e) => e.detail.range)",
        summary:
          'The caret or selection moved. Where a host that decorates from the caret recomputes its layer.',
      },
      {
        name: 'modechange',
        kind: 'event',
        signature: "addEventListener('modechange', (e) => e.detail.mode)",
        summary: 'The interaction mode changed without rebuilding the engine or clearing history.',
      },
      {
        name: 'hit',
        kind: 'event',
        signature:
          "addEventListener('hit', (e) => e.detail.decoration, e.detail.source)",
        summary:
          'A `Hit` decoration was clicked — a task checkbox, a mention. The host decides what that means.',
      },
      {
        name: 'linkopen',
        kind: 'event',
        signature:
          "addEventListener('linkopen', (e) => e.detail.destination)",
        summary:
          'A normal click in view mode, or Command/Ctrl-click in edit mode, requested navigation to a parser-resolved destination.',
      },
      {
        name: 'diffText',
        kind: 'function',
        signature:
          'diffText(oldText: string, newText: string): {start: number, end: number, text: string}',
        summary:
          'Reduce two versions of the document to the single replacement between them, without ever cutting a surrogate pair in half.',
      },
    ],
  },
  {
    id: 'host-contracts',
    title: 'What the host supplies',
    file: 'web/src/widgets.ts · web/src/resources.ts',
    intro:
      'Two small objects, both optional. `WidgetProvider` draws content the markdown fully describes; `ResourceResolver` fetches what the markdown only points at.',
    symbols: [
      {
        name: 'EditorPlugin',
        kind: 'type',
        signature:
          'type EditorPlugin = {name: string, manifest?: ManifestSpec, setup(context: EditorPluginContext): void | (() => void)}',
        summary:
          'A package-owned runtime extension. `definePlugin` checks it while preserving TypeScript inference.',
      },
      {
        name: 'EditorPluginContext',
        kind: 'type',
        signature:
          '{editor, signal, name, internRole(), setLayer(), clearLayer(), scheduleAnalysis(), cancelAnalysis(), registerCommand(), showPresentation(), dismissPresentation(), onRoot(), on()}',
        summary:
          'An editor-scoped capability object. Its listeners, layers, commands, analyses, and floating views are owned by the plugin lifecycle.',
        note: 'Analysis is latest-wins; command names replace within a plugin; every owned surface is removed atomically during teardown.',
      },
      {
        name: 'PluginPresentationOptions',
        kind: 'type',
        signature:
          "{element, anchor?, placement?, offset?, modal?, dismissOnEscape?, dismissOnOutsidePointer?, trapFocus?, restoreFocus?, initialFocus?, container?, onDismiss(reason)?} → PluginPresentationHandle",
        summary:
          'Mount plugin UI outside the source projection. The returned handle updates, repositions, or dismisses it; the editor owns focus, collision, and teardown.',
      },
      {
        name: 'PluginCommandOptions',
        kind: 'type',
        signature:
          '{title, key?, primary?, shift?, alt?, category?, keywords?, enabled?, checked?, handler(event)} → PluginCommandHandle',
        summary: 'A discoverable editor command with optional shortcut and live state, removed automatically with its plugin.',
      },
      {
        name: 'MarkdownEditor.listCommands / executeCommand',
        kind: 'method',
        signature: 'listCommands(): PluginCommandDescriptor[] · executeCommand(id: string): boolean',
        summary: 'Build slash menus, toolbars, and palettes from the same deterministic command registry.',
      },
      {
        name: 'checkPluginCompatibility',
        kind: 'function',
        signature:
          "import { checkPluginCompatibility } from '@mdink/web/plugin-testing'",
        summary:
          'Framework-neutral installation, source-preservation, layer-ownership and teardown check for plugin package tests.',
      },
      {
        name: 'WidgetProvider.makeWidget',
        kind: 'method',
        signature:
          'makeWidget(request, context): HTMLElement | WidgetMount | null',
        summary:
          'Draw a replaced range. Return `null` to fall through to the resolver, and failing that to leave the range as styled text.',
      },
      {
        name: 'EditorPluginContext.renderers.register',
        kind: 'method',
        signature: 'renderers.register(name, {matches(request), mount(request, context)})',
        summary:
          'Register a lifecycle-owned custom node renderer. WidgetMount can update, unmount, request layout, and opt into pointer events.',
        note: 'Removal tears down cached and visible views while preserving the exact source projection.',
      },
      {
        name: 'WidgetProvider.widgetWantsPointerEvents',
        kind: 'method',
        signature: 'widgetWantsPointerEvents?(roleName: string | null): boolean',
        summary: 'Whether this widget handles its own clicks. Defaults to false.',
        note: 'The default matters: a widget that swallows clicks stops the caret ever reaching the source it replaced, so its reveal policy never fires and the content cannot be edited.',
      },
      {
        name: 'ResourceResolver.resolve',
        kind: 'method',
        signature:
          'resolve(request: {reference, roleName, source}): Promise<{state: "loading"} | {state: "ready", view: HTMLElement} | {state: "failed", message: string}>',
        summary: 'Turn a reference into a view, asynchronously.',
        note: 'Results are cached by reference, not by decoration key: `![a](x.png)` and `![b](x.png)` are one asset.',
      },
      {
        name: 'ResourceResolver.reservedSize',
        kind: 'method',
        signature: 'reservedSize(request): {width: number, height: number}',
        summary:
          'Space to hold while loading, so the document does not jump when the asset lands.',
      },
    ],
  },
];

// ---------------------------------------------------------------- react

/**
 * `@mdink/react`, read from `web/react/README.md` and `web/react/types/index.d.ts` — the
 * package's own documented surface, which is also what its consumers compile against.
 *
 * That directory belongs to the React adapter and is never written from here; this file
 * quotes it. If the two ever disagree, the package is right.
 *
 * @type {SymbolGroup[]}
 */
export const REACT_API = [
  {
    id: 'component',
    title: 'MarkdownEditor props',
    file: 'web/react/src/MarkdownEditor.ts',
    intro:
      'A forwardRef component over the framework-free editor. Anything not listed here — `className`, `style`, `id`, `data-*` — is spread onto the editor element, which always carries `mde-editor` in its class list.',
    symbols: [
      {
        name: 'defaultValue',
        kind: 'property',
        signature: 'defaultValue?: string',
        summary: 'The initial markdown, read exactly once when the editor instance is created.',
        note: 'To load a different document, change the component\u2019s `key` or call `handle.setMarkdown()`. Both clear the undo history, which is correct.',
      },
      {
        name: 'value',
        kind: 'property',
        signature: 'value?: string',
        summary:
          'An escape hatch for when something outside React owns the document — a collaborative session, a file watcher, a revert button.',
        note: 'A value equal to what the editor already contains is ignored, so your own onChange echoing back through state is free. A value that differs is reduced to a single minimal replacement and applied through the ordinary edit path. Applying one moves the caret to the end of the replacement whether or not the editor is focused, so do not drive it from a keystroke.',
      },
      {
        name: 'interactionMode',
        kind: 'property',
        signature: "interactionMode?: 'edit' | 'view'",
        summary:
          'Switches the live editor between source-first editing and a selectable, fully rendered document without remounting it.',
      },
      {
        name: 'onChange',
        kind: 'property',
        signature: 'onChange?(markdown: string, handle: MarkdownEditorHandle): void',
        summary: 'Every edit, including undo and programmatic ones.',
      },
      {
        name: 'onModeChange',
        kind: 'property',
        signature: "onModeChange?(mode: 'edit' | 'view', handle: MarkdownEditorHandle): void",
        summary: 'The live interaction contract changed.',
      },
      {
        name: 'onSelectionChange',
        kind: 'property',
        signature:
          'onSelectionChange?(range: {start, end} | null, handle: MarkdownEditorHandle): void',
        summary: 'The caret or selection moved. Offsets are UTF-16 code units.',
      },
      {
        name: 'onHit',
        kind: 'property',
        signature:
          'onHit?(hit: {decoration: Decoration, source: string}, handle: MarkdownEditorHandle): void',
        summary: 'A `Hit` decoration was clicked — a task checkbox, a mention.',
      },
      {
        name: 'onLinkOpen',
        kind: 'property',
        signature:
          'onLinkOpen?(link: {decoration: Decoration, destination: string}, handle: MarkdownEditorHandle): void',
        summary: 'Normal click in view, or Command/Ctrl-click in edit, requested navigation without changing source.',
      },
      {
        name: 'onHistoryChange',
        kind: 'property',
        signature:
          'onHistoryChange?(state: {canUndo: boolean, canRedo: boolean, position: number, count: number}): void',
        summary:
          'Fires only when one of those four moves, so a toolbar re-renders when Undo becomes available rather than on every keystroke.',
        note: 'Scalars only, which is what makes it safe to put straight into state. Pair it with `useEditorHistory`.',
      },
      {
        name: 'onReady',
        kind: 'property',
        signature: 'onReady?(handle: MarkdownEditorHandle): void',
        summary: 'The editor exists and the document is rendered. Where an extension is constructed.',
      },
      {
        name: 'onError',
        kind: 'property',
        signature: 'onError?(error: unknown): void',
        summary: 'The wasm failed to load, or the manifest was rejected.',
      },
      {
        name: 'wasm',
        kind: 'property',
        signature: 'wasm?: string | URL | ArrayBuffer | Response',
        summary: 'Where `mde.wasm` lives. Defaults to the copy next to `web/src`.',
        note: 'One of the two props that rebuilds the editor when it changes.',
      },
      {
        name: 'manifest',
        kind: 'property',
        signature: 'manifest?: ManifestSpec | Uint8Array | null',
        summary: 'The extension manifest, as a spec object or pre-encoded bytes.',
        note: 'Compared by content, not identity, so an inline object literal is fine — but changing what it says rebuilds the editor, because a registry is fixed for an engine\u2019s life.',
      },
      {
        name: 'widgetProvider',
        kind: 'property',
        signature: 'widgetProvider?: WidgetProvider',
        summary: 'Host-drawn widgets, the same contract as the framework-free editor.',
        note: 'Whether one is present is fixed at mount — “no resolver” is a real state and should not be faked — but the implementation behind it may change freely.',
      },
      {
        name: 'resourceResolver',
        kind: 'property',
        signature: 'resourceResolver?: ResourceResolver',
        summary: 'Turns a reference into something displayable. Same lifetime rule as `widgetProvider`.',
      },
      {
        name: 'resourceSizes',
        kind: 'property',
        signature: 'resourceSizes?: Record<string, {width: number, height: number}>',
        summary: 'Sizes remembered from a previous session, seeded at mount.',
      },
      {
        name: 'layers',
        kind: 'property',
        signature: 'layers?: Record<string, LayerSpan[]>',
        summary:
          'Declarative host decoration layers, diffed by content — an inline object literal costs nothing.',
        note: 'A `role` given as a string is interned on first use, so a role can be invented at runtime; the theme picks it up as `.mde-ext-<name>`. Removing a name from the object clears that layer.',
      },
      {
        name: 'toggleTasksOnClick',
        kind: 'property',
        signature: 'toggleTasksOnClick?: boolean',
        summary: 'Toggle `- [ ]` checkboxes when one is clicked. Defaults to true.',
      },
      {
        name: 'autoFocus',
        kind: 'property',
        signature: 'autoFocus?: boolean',
        summary: 'Defaults to false.',
      },
    ],
  },
  {
    id: 'handle',
    title: 'The imperative handle',
    file: 'web/react/types/index.d.ts',
    intro:
      'What a `ref` gives you. Every member is a method, never a value — decoration keys are u64 and arrive as BigInt, and React 19\u2019s development build deep-serializes changed props when it logs them, which throws on a BigInt. Keeping the editor and its decorations behind function calls keeps them out of the render path entirely.',
    symbols: [
      {
        name: 'getMarkdown / setMarkdown',
        kind: 'method',
        signature: 'getMarkdown(): string · setMarkdown(text: string): void',
        summary: 'Read the document, or replace it wholesale.',
        note: '`setMarkdown` resyncs the engine, which clears the undo history.',
      },
      {
        name: 'getInteractionMode / setInteractionMode',
        kind: 'method',
        signature: "getInteractionMode(): 'edit' | 'view' · setInteractionMode(mode): void",
        summary: 'Read or switch the interaction contract without rebuilding the component.',
      },
      {
        name: 'wrapSelection',
        kind: 'method',
        signature: 'wrapSelection(prefix: string, suffix?: string): boolean',
        summary:
          'Wrap the selection as one undo step. `wrapSelection("**")` is the Bold command; `suffix` defaults to `prefix`.',
      },
      {
        name: 'insertText / replaceRange',
        kind: 'method',
        signature:
          'insertText(text: string): boolean · replaceRange(start: number, end: number, text: string): void',
        summary:
          'Replace the selection, or an explicit range, through the same path a keystroke takes.',
      },
      {
        name: 'getSelection / setSelection',
        kind: 'method',
        signature:
          'getSelection(): {start, end} | null · setSelection(range: {start, end}): void',
        summary: 'The selection, in document offsets.',
      },
      {
        name: 'toggleTask',
        kind: 'method',
        signature: 'toggleTask(decoration: Decoration): void',
        summary: 'Flip a `- [ ]` checkbox, as its own undo step.',
      },
      {
        name: 'undo / redo',
        kind: 'method',
        signature:
          'canUndo(): boolean · canRedo(): boolean · undo(): boolean · redo(): boolean · closeUndoGroup(): void',
        summary: 'History, owned by the core rather than by the browser.',
      },
      {
        name: 'getRevisions / jumpTo',
        kind: 'method',
        signature:
          'getRevisions(): Revision[] · getHistoryPosition(): number · jumpTo(n: number): boolean',
        summary:
          'The browsable timeline. Plain numbers throughout, so a history panel can render the list directly.',
        note: 'Jumping to a revision\u2019s `index + 1` lands just after it, however far it travels — one splice, not a replay.',
      },
      {
        name: 'setLayer / clearLayer / internRole',
        kind: 'method',
        signature:
          'internRole(name: string): number · setLayer(name: string, spans: LayerSpan[]): void · clearLayer(name: string): void',
        summary:
          'The layer API directly, for updates too frequent to want a prop diff in the way.',
      },
      {
        name: 'getDecorations',
        kind: 'method',
        signature:
          'getDecorations(): Decoration[] · getResourceSizes(): ResourceSizes · setResourceSizes(sizes): void',
        summary: 'Live decorations, and the measured sizes worth persisting between sessions.',
        note: 'Decorations carry BigInt keys. Do not put the result in state.',
      },
      {
        name: 'getEditor',
        kind: 'method',
        signature:
          'isReady(): boolean · getEditor() · getEngine() · getCore() · getElement() · focus(): void',
        summary:
          'The escape hatch. `getEditor()` returns the framework-free instance, which is what an extension from `web/extensions/` expects to be handed.',
      },
    ],
  },
  {
    id: 'hooks',
    title: 'Hooks, helpers and re-exports',
    file: 'web/react/src/hooks.ts · src/core.ts · src/index.ts',
    intro: 'Small, and all optional.',
    symbols: [
      {
        name: 'useMarkdownEditorRef',
        kind: 'function',
        signature: 'useMarkdownEditorRef(): {current: MarkdownEditorHandle | null}',
        summary: 'A typed ref, so a TypeScript consumer does not have to name the handle type.',
      },
      {
        name: 'useEditorHistory',
        kind: 'function',
        signature:
          'useEditorHistory(): [{canUndo, canRedo, position, count}, (state) => void]',
        summary:
          'State for a toolbar, shaped so the setter can be handed straight to `onHistoryChange`.',
      },
      {
        name: 'preloadCore',
        kind: 'function',
        signature: 'preloadCore(source?: string | URL | ArrayBuffer | Response): Promise<Core>',
        summary:
          'Warm the wasm from a route transition. The compile is cached per source, so two editors mounting in the same tick share one fetch and one instance.',
      },
      {
        name: 'DEFAULT_WASM_URL',
        kind: 'property',
        signature: 'const DEFAULT_WASM_URL: URL',
        summary: 'Where the adapter looks for `mde.wasm` when no `wasm` prop is given.',
      },
      {
        name: 'activeEditorCount',
        kind: 'function',
        signature: 'activeEditorCount(): number · loadedCoreCount(): number',
        summary:
          'Diagnostics: how many editors are mounted, and how many wasm sources are loaded. A leak shows up here first.',
      },
      {
        name: 'Kind / Reveal / Role / encodeManifest',
        kind: 'type',
        signature: "import { Kind, Reveal, Role, encodeManifest } from '@mdink/react'",
        summary:
          'Re-exported from the editor, so a host does not have to reach past this package for the vocabulary the decoration protocol is written in.',
      },
    ],
  },
];

// ---------------------------------------------------------------- swift

/** @type {SymbolGroup[]} */
export const SWIFT_API = [
  {
    id: 'engine',
    title: 'MarkdownEngine',
    file: 'apple/Sources/MDECore/MDECore.swift',
    intro:
      'The safe wrapper over the Rust core. Not thread-safe — drive it from the main actor, which is where text input lives anyway. Ranges are `NSRange` in UTF-16 code units, so they drop straight into `NSTextStorage`.',
    symbols: [
      {
        name: 'MarkdownEngine.init',
        kind: 'method',
        signature: 'init?(manifest: String? = nil)',
        summary: 'Build an engine from a TOML extension manifest. Returns nil if it fails to parse.',
      },
      {
        name: 'MarkdownEngine.reset',
        kind: 'method',
        signature: '@discardableResult func reset(_ text: String) -> Patch',
        summary: 'Full resync. Clears the undo history.',
      },
      {
        name: 'MarkdownEngine.apply',
        kind: 'method',
        signature:
          'func apply(_ edits: [TextEdit], documentLength: Int?, now: UInt64 = MarkdownEngine.now()) throws -> Patch',
        summary: 'Report edits the platform already applied.',
        note: 'Throws `EngineError.desync` when `documentLength` disagrees with the mirror. Never call it for edits that came out of undo.',
      },
      {
        name: 'MarkdownEngine.setSelection',
        kind: 'method',
        signature: '@discardableResult func setSelection(_ range: NSRange?) -> Patch',
        summary: 'Pass nil on blur so the document collapses back to its rendered form.',
      },
      {
        name: 'MarkdownEngine.internRole',
        kind: 'method',
        signature: 'func internRole(_ name: String) -> UInt32',
        summary: 'A role id for a name no manifest declared.',
      },
      {
        name: 'MarkdownEngine.setLayer',
        kind: 'method',
        signature:
          '@discardableResult func setLayer(_ name: String, _ spans: [LayerSpan]) -> Patch',
        summary: 'Replace a host layer’s decorations.',
      },
      {
        name: 'MarkdownEngine.clearLayer',
        kind: 'method',
        signature: '@discardableResult func clearLayer(_ name: String) -> Patch',
        summary: 'Remove a layer, and its slot in the paint order with it.',
      },
      {
        name: 'MarkdownEngine.undo',
        kind: 'method',
        signature: 'func undo() -> Rewind? · func redo() -> Rewind?',
        summary:
          'Step through the history. `canUndo` and `canRedo` are properties; `boundary()` forces a new step.',
      },
      {
        name: 'MarkdownEngine.revisions',
        kind: 'method',
        signature:
          'func revisions() -> [Revision] · var historyPosition: Int · func jump(to target: Int) -> Rewind?',
        summary:
          'The browsable timeline, oldest first, including revisions that have been undone. `Revision` is `Identifiable`, so a SwiftUI `List` over it needs nothing else.',
      },
      {
        name: 'MarkdownEngine.payload',
        kind: 'method',
        signature: 'func payload(for key: UInt64) -> String?',
        summary: 'The reference a decoration carries — a path, a fence argument, a delimited body.',
      },
      {
        name: 'MarkdownEngine.roleName',
        kind: 'method',
        signature: 'func roleName(_ role: UInt32) -> String?',
        summary: 'Role name for theme lookup, cached.',
      },
      {
        name: 'MarkdownEngine.now',
        kind: 'method',
        signature: 'static func now() -> UInt64',
        summary: 'Monotonic millisecond clock, which is what undo coalescing measures against.',
      },
    ],
  },
  {
    id: 'textview',
    title: 'MarkdownTextView',
    file: 'apple/Sources/MDEditorUI/MarkdownTextView.swift · MarkdownTextViewMac.swift',
    intro:
      'A `UITextView` on iOS and an `NSTextView` on macOS, with the same name and the same public surface. The text storage stays exactly the markdown source; everything visible is an attribute or an attachment over it.',
    symbols: [
      {
        name: 'MarkdownTextView.init',
        kind: 'method',
        signature:
          'convenience init(manifest: String? = nil, theme: Theme = Theme()) · init(engine: MarkdownEngine, theme: Theme = Theme())',
        summary:
          'A manifest that fails to parse falls back to no extensions rather than trapping; check it with `MarkdownEngine(manifest:)` at startup to fail loudly instead.',
      },
      {
        name: 'MarkdownTextView.markdown',
        kind: 'property',
        signature: 'var markdown: String { get } · func setMarkdown(_ text: String)',
        summary: 'The document. Reading it is reading the text storage.',
      },
      {
        name: 'MarkdownTextView.interactionMode',
        kind: 'property',
        signature: 'var interactionMode: MarkdownInteractionMode // .edit or .view',
        summary:
          'View mode keeps UIKit/AppKit text selectable and renderer controls interactive, but prevents native edits, syntax reveal, and task toggles.',
      },
      {
        name: 'MarkdownTextView.decorations',
        kind: 'property',
        signature: 'var decorations: [Decoration] { get }',
        summary:
          'Every decoration in effect. Useful for acting on the document’s structure — collect every checkbox, find every mention — without reparsing it.',
      },
      {
        name: 'MarkdownTextView.widgetProvider',
        kind: 'property',
        signature: 'var widgetProvider: (any WidgetProvider)?',
        summary: 'Draws replaced ranges. Held strongly.',
        note: 'Strongly on purpose: hosts write `view.widgetProvider = MyWidgets()`, and a weak reference would deallocate before the first paint. Providers must not retain the view.',
      },
      {
        name: 'MarkdownTextView.resourceResolver',
        kind: 'property',
        signature: 'var resourceResolver: (any ResourceResolver)?',
        summary: 'Resolves references to views, asynchronously. Also held strongly.',
      },
      {
        name: 'MarkdownTextView.resourceSizes',
        kind: 'property',
        signature: 'var resourceSizes: [String: CGSize]',
        summary: 'Resolved sizes to persist and seed on the next launch.',
      },
      {
        name: 'MarkdownTextView.theme',
        kind: 'property',
        signature: 'var theme: Theme',
        summary: 'Maps roles to attributes. Setting it repaints the document.',
      },
      {
        name: 'MarkdownTextView.undo',
        kind: 'method',
        signature:
          '@discardableResult func performUndo() -> Bool · performRedo() -> Bool · func closeUndoGroup()',
        summary:
          'History lives in the core; the view installs an inert `UndoManager` so the platform’s own cannot interfere.',
      },
      {
        name: 'MarkdownTextView.revisions',
        kind: 'property',
        signature:
          'var revisions: [Revision] · var historyPosition: Int · @discardableResult func jump(to target: Int) -> Bool',
        summary: 'The same timeline, forwarded to the engine and applied to the text storage.',
      },
      {
        name: 'MarkdownTextView.toggleTask',
        kind: 'method',
        signature: 'func toggleTask(at decoration: Decoration)',
        summary: 'Flip a checkbox through the normal edit path, as its own undo step.',
      },
      {
        name: 'MarkdownTextView.replaceMarkdown',
        kind: 'method',
        signature:
          '@discardableResult func replaceMarkdown(in range: NSRange, with text: String, selection: NSRange? = nil) -> Bool',
        summary:
          'Apply an exact source edit through the normal storage, history, decoration, and callback path. Intended for plugin UI and host commands.',
      },
      {
        name: 'MarkdownTextView.requestOpenLink',
        kind: 'method',
        signature: '@discardableResult func requestOpenLink(at offset: Int) -> Bool',
        summary:
          'Ask the host delegate to open the parser-resolved link at an offset. View mode uses an ordinary click/tap; edit mode uses Command-click or iOS long press.',
      },
      {
        name: 'MarkdownTextView.setLayer',
        kind: 'method',
        signature:
          'func setLayer(_ name: String, _ spans: [LayerSpan]) · func clearLayer(_ name: String) · func internRole(_ name: String) -> UInt32',
        summary: 'The layer API, forwarded to the engine and repainted.',
      },
      {
        name: 'MarkdownTextView.installPlugin',
        kind: 'method',
        signature:
          'func installPlugin(_ plugin: any MarkdownPlugin) throws · func removePlugin(named: String) -> Bool · var installedPluginNames: [String]',
        summary:
          'Own a plugin lifecycle and forward document and selection changes on UIKit and AppKit.',
        note: 'A failed installation rolls back its layers and does not reserve its name.',
      },
      {
        name: 'MarkdownTextView.init(plugins:)',
        kind: 'method',
        signature:
          'convenience init(plugins: [any MarkdownPlugin], manifest: String? = nil, theme: Theme = Theme()) throws',
        summary:
          'Compose every plugin TOML fragment into the engine, then install their runtime lifecycles.',
      },
      {
        name: 'MarkdownTextViewDelegate',
        kind: 'protocol',
        signature:
          'func markdownTextView(_:didTap:source:) · markdownTextView(_:didRequestOpenLink:) · markdownTextViewDidChange(_:) · markdownTextViewDidChangeSelection(_:)',
        summary:
          'Observe the view without taking its `UITextViewDelegate` slot, which it needs for itself. Every method has a default, so implement only what you use.',
      },
    ],
  },
  {
    id: 'host-contracts',
    title: 'What the host supplies',
    file: 'apple/Sources/MDEditorUI/Plugins.swift · Widgets.swift · Resources.swift · Theme.swift',
    intro:
      'The per-platform seam. The core resolves syntax, ranges, reveal state, identity and the reference; the host only draws.',
    symbols: [
      {
        name: 'MarkdownPlugin',
        kind: 'protocol',
        signature:
          'var name: String { get } · var manifest: String? { get } · install(in:) throws · uninstall() · markdownDidChange() · selectionDidChange()',
        summary:
          'A host-side extension lifecycle. Every callback except `install` and `name` has a default.',
      },
      {
        name: 'MarkdownPluginContext',
        kind: 'class',
        signature:
          'editor · name · layers/analysis · registerCommand(_:command:) → MarkdownPluginCommandHandle · showPresentation(_:options:) → MarkdownPluginPresentationHandle · dismissPresentation(_:reason:)',
        summary:
          'The weak editor reference and automatically cleaned, plugin-namespaced layer, command, and floating-presentation surface.',
        note: 'Analysis publishes only the latest result. Commands and presentations are removed atomically with the plugin.',
      },
      {
        name: 'MarkdownPluginPresentationAnchor',
        kind: 'enum',
        signature: 'case selection · case editor · case viewport',
        summary:
          'Place plugin-owned UI at the caret, editor edge, or viewport center without adding anything to markdown storage.',
      },
      {
        name: 'MarkdownPluginContext.registerRenderer',
        kind: 'method',
        signature: 'registerRenderer(_:contribution: MarkdownPluginRendererContribution)',
        summary: 'Mount a plugin-owned UIView or NSView through the same cached widget pipeline as tables and media.',
        note: 'Stable nodes update in place; source changes, selection reveal, and plugin removal invoke teardown.',
      },
      {
        name: 'MarkdownPluginPresentationOptions / Handle',
        kind: 'type',
        signature: 'view · anchor · placement · offset · modal · Escape/outside interaction · initial/focus restoration · onDismiss · update/reposition/dismiss',
        summary: 'Cross-platform owned popovers and dialogs with safe-area collision and explicit dismissal reasons.',
      },
      {
        name: 'MarkdownPluginCommandModifiers',
        kind: 'type',
        signature: 'OptionSet · .primary · .shift · .option',
        summary: 'Portable hardware-keyboard modifiers for editor-scoped plugin commands.',
      },
      {
        name: 'registeredPluginCommands / executePluginCommand',
        kind: 'property',
        signature: 'var registeredPluginCommands: [MarkdownPluginCommandDescriptor] · func executePluginCommand(id: String) -> Bool',
        summary: 'The central native registry used by hardware shortcuts, menus, toolbars, and slash commands.',
      },
      {
        name: 'MarkdownPluginCompatibility.check',
        kind: 'function',
        signature:
          'static func check(_ plugin: any MarkdownPlugin, in editor: MarkdownTextView, markdown: String = …) throws -> MarkdownPluginCompatibilityReport',
        summary:
          'Framework-neutral lifecycle and cleanup check for a Swift plugin package test suite.',
      },
      {
        name: 'WidgetProvider',
        kind: 'protocol',
        signature:
          'func makeWidget(roleName: String, source: String, payload: String?) -> PlatformView?\nfunc updateWidget(_:roleName:source:payload:)\nfunc removeWidget(_:)\nfunc widgetSize(roleName: String, source: String, fittingWidth: CGFloat) -> CGSize?',
        summary:
          'Draw a replaced range. All three have defaults — nil, nil, and false.',
        note: '`widgetWantsTouches` defaults to false because a view that takes touches swallows them before the text view sees them, so the caret can never land in the widget’s source.',
      },
      {
        name: 'ResourceResolver',
        kind: 'protocol',
        signature:
          'func resolve(_ request: ResourceRequest, deliver: @escaping (ResourceState) -> Void) -> ResourceState\nfunc reservedSize(_ request: ResourceRequest) -> CGSize',
        summary:
          'Turn a reference into a view. Return `.loading` and call `deliver` later, exactly once, on the main thread.',
      },
      {
        name: 'ResourceRequest',
        kind: 'type',
        signature:
          'struct ResourceRequest { let reference: String; let roleName: String; let source: String; let fittingWidth: CGFloat }',
        summary:
          '`reference` is a path or URL, never content. `source` is the node’s full markdown, for hosts that need the alt text too.',
      },
      {
        name: 'Theme',
        kind: 'type',
        signature:
          'struct Theme { var bodyFont, monoFont, textColor, mutedColor, accentColor, codeBackground, lineSpacing; var extensionRoles: [String: [NSAttributedString.Key: Any]] }',
        summary:
          'Built-in roles resolve by id, extension roles by the name the manifest — or `internRole` — declared. Heading sizes derive from `bodyFont`, so Dynamic Type still applies.',
      },
    ],
  },
  {
    id: 'types',
    title: 'Value types',
    file: 'apple/Sources/MDECore/MDECore.swift',
    intro: 'All `Sendable`, all plain structs over the C layout.',
    symbols: [
      {
        name: 'Decoration',
        kind: 'type',
        signature:
          'struct Decoration { var range: NSRange; let key: UInt64; let role: UInt32; let kind: DecorationKind; let reveal: Reveal; let depth: UInt8; let layer: UInt8 }',
        summary:
          '`range` is mutable so a renderer can absorb a `moved` entry in place rather than rebuilding.',
      },
      {
        name: 'Patch',
        kind: 'type',
        signature:
          'struct Patch { let removed: [UInt64]; let added: [Decoration]; let moved: [(key: UInt64, range: NSRange)] }',
        summary: 'What changed. `moved` means position changed and identity did not.',
      },
      {
        name: 'LayerSpan',
        kind: 'type',
        signature:
          'struct LayerSpan { var range: NSRange; var role: UInt32; var kind: DecorationKind = .style; var depth: UInt8 = 0 }',
        summary: 'One host-supplied decoration.',
      },
      {
        name: 'Rewind',
        kind: 'type',
        signature:
          'struct Rewind { let edits: [TextEdit]; let selection: NSRange?; let patch: Patch }',
        summary: 'What the platform must do to its own buffer after undo or redo.',
      },
      {
        name: 'Revision',
        kind: 'type',
        signature:
          'struct Revision: Identifiable { let index: UInt32; let at: UInt32; let atMs: UInt64; let inserted: UInt32; let removed: UInt32; let kind: RevisionKind }\nenum RevisionKind { case insert, delete, replace }',
        summary:
          'One entry in a browsable history. Coarse on purpose — counts of code units and which side was non-empty, never a guess at intent.',
      },
      {
        name: 'EngineError',
        kind: 'type',
        signature: 'enum EngineError { case desync, outOfBounds, badArgument, unknown(UInt32) }',
        summary: '`desync` is the one that matters: recover with `reset(_:)`.',
      },
    ],
  },
];

/** Everything, for the search index. */
export const API_PAGES = [
  { path: '/docs/reference/web', groups: WEB_API },
  { path: '/docs/reference/swift', groups: SWIFT_API },
  { path: '/docs/embed/react', groups: REACT_API },
];
