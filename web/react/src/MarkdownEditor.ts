// The React adapter for `@mde/web`.
//
// Written with `createElement` rather than JSX on purpose: the adapter renders exactly
// one element and gains nothing from JSX. Vite compiles this TypeScript file while
// keeping React and the framework-free editor external.
//
// Three rules this file exists to enforce:
//
// 1. **The editor is never React state and never a prop.** Decoration keys are `u64` and
//    arrive as `BigInt`; React 19's development build deep-serializes changed props when
//    it logs them and throws `TypeError: Do not know how to serialize a BigInt`. Every
//    reference to the editor lives in a ref, and everything it exposes is reached through
//    a function on the imperative handle, never a value sitting in a render tree.
//
// 2. **`StrictMode` double-mounts on purpose.** The mount effect's cleanup calls
//    `editor.destroy()` (which removes the document-level `selectionchange` listener) and
//    `engine.free()`. The wasm itself is cached at module scope, so the second mount is
//    free.
//
// 3. **The DOM is the buffer.** See the controlled/uncontrolled note on `value` below and
//    in the README.

import {
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  MarkdownEditor as CoreEditor,
  Role,
  composePluginManifests,
  diffText,
  encodeManifest,
} from '@mde/web';
import { DEFAULT_WASM_URL, sharedCore, wasmKey } from './core.js';

/**
 * Every editor this module currently has alive. A diagnostic, and the thing an
 * unmount test can actually assert on: `.mde-editor` elements disappear with React's
 * DOM, but an editor that failed to be destroyed would still be in here.
 * @type {Set<CoreEditor>}
 */
const alive = new Set();

/** How many editors are mounted. Diagnostics only — do not render from this. */
export function activeEditorCount() {
  return alive.size;
}

/** @param {unknown} manifest @param {readonly import('@mde/web').EditorPlugin[]} plugins */
function manifestSignature(manifest, plugins) {
  const contributed = plugins.map((plugin) => plugin.manifest ?? null);
  if (!manifest && contributed.every((item) => item === null)) return 'none';
  if (manifest instanceof Uint8Array) {
    if (contributed.some((item) => item !== null)) return 'encoded-with-plugin-manifest';
    return `bytes:${manifest.length}:${Array.from(manifest).join(',')}`;
  }
  return `spec:${JSON.stringify([manifest, contributed])}`;
}

/** @param {unknown} manifest @param {readonly import('@mde/web').EditorPlugin[]} plugins */
function manifestBytes(manifest, plugins) {
  const hasPluginManifest = plugins.some((plugin) => plugin.manifest);
  if (manifest instanceof Uint8Array) {
    if (hasPluginManifest) {
      throw new Error('Plugin manifests cannot be composed with pre-encoded manifest bytes');
    }
    return manifest;
  }
  if (!manifest && !hasPluginManifest) return null;
  return encodeManifest(composePluginManifests(/** @type {any} */ (manifest), plugins));
}

const NO_HISTORY = { canUndo: false, canRedo: false, position: 0, count: 0 };
const NO_PLUGINS = Object.freeze([]);

/** @param {typeof NO_HISTORY} a @param {typeof NO_HISTORY} b */
function sameHistory(a, b) {
  return (
    a.canUndo === b.canUndo &&
    a.canRedo === b.canRedo &&
    a.position === b.position &&
    a.count === b.count
  );
}

/**
 * @param {import('../types').MarkdownEditorProps} props
 * @param {React.ForwardedRef<import('../types').MarkdownEditorHandle>} forwardedRef
 */
function MarkdownEditorImpl(props, forwardedRef) {
  // Everything the component consumes is named here, so `rest` contains only things that
  // genuinely belong on the element — `id`, `aria-label`, `data-*`, `onKeyDown`.
  const {
    className,
    style,
    manifest = null,
    wasm = DEFAULT_WASM_URL,
    /* eslint-disable no-unused-vars */
    defaultValue,
    value,
    onChange,
    onSelectionChange: _onSelectionChange,
    onHit,
    onLinkOpen,
    onHistoryChange,
    onReady,
    onError,
    widgetProvider,
    resourceResolver,
    resourceSizes,
    layers,
    plugins = NO_PLUGINS,
    toggleTasksOnClick,
    autoFocus,
    /* eslint-enable no-unused-vars */
    ...rest
  } = props;

  const hostRef = useRef(/** @type {HTMLDivElement|null} */ (null));
  const editorRef = useRef(/** @type {CoreEditor|null} */ (null));
  const coreRef = useRef(/** @type {any} */ (null));
  const engineRef = useRef(/** @type {any} */ (null));

  // The single mutable window onto the current props. Callbacks, providers and `layers`
  // are read through this, so a parent that re-renders with new closures every time
  // never causes the editor to be torn down and rebuilt.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  /** Suppresses the `change` the initial `setMarkdown` dispatches. */
  const quiet = useRef(false);
  /** Exact local value awaiting acknowledgement from a controlled parent. */
  const pendingControlledValue = useRef(/** @type {string|null} */ (null));
  const history = useRef(NO_HISTORY);
  /** Layer signatures and interned role ids, reset whenever the engine is replaced. */
  const layerState = useRef({ /** @type {Record<string,string>} */ sigs: {}, roles: new Map() });
  const pluginState = useRef(/** @type {Map<string, import('@mde/web').EditorPlugin>} */ (new Map()));

  const [status, setStatus] = useState(/** @type {'loading'|'ready'|'error'} */ ('loading'));
  // Bumped when an editor instance is created. Effects that need an editor depend on it;
  // it is a number, never the editor itself.
  const [generation, setGeneration] = useState(0);

  // One permanently stable handle. Its identity never changes, so it is safe in a
  // dependency array and safe to hand to `onReady` once.
  const apiRef = useRef(/** @type {import('../types').MarkdownEditorHandle|null} */ (null));
  if (apiRef.current === null) {
    apiRef.current = makeHandle({ editorRef, coreRef, engineRef, hostRef });
  }
  const api = apiRef.current;
  useImperativeHandle(forwardedRef, () => api, [api]);

  const key = wasmKey(wasm);
  const signature = useMemo(() => manifestSignature(manifest, plugins), [manifest, plugins]);

  // MARK: - Mount
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let cancelled = false;
    /** @type {CoreEditor|null} */
    let editor = null;
    /** @type {any} */
    let engine = null;

    // Cheap scalars only, so a toolbar can re-render on the transitions rather than on
    // every keystroke. A history panel wanting labels calls `getRevisions()` — `count`
    // and `position` are what tell it something worth re-reading has happened.
    const emitHistory = () => {
      if (!editor) return;
      const next = {
        canUndo: !!editor.canUndo,
        canRedo: !!editor.canRedo,
        position: editor.historyPosition,
        count: editor.revisions.length,
      };
      if (sameHistory(next, history.current)) return;
      history.current = next;
      latest.current.onHistoryChange?.(next);
    };

    const onChange = () => {
      if (quiet.current || !editor) return;
      if (latest.current.value !== undefined) pendingControlledValue.current = editor.markdown;
      latest.current.onChange?.(editor.markdown, api);
      emitHistory();
    };

    const onSelectionChange = (/** @type {any} */ event) => {
      latest.current.onSelectionChange?.(event.detail?.range ?? null, api);
    };

    const onHit = (/** @type {any} */ event) => {
      const detail = event.detail;
      const wantsTasks = latest.current.toggleTasksOnClick !== false;
      if (wantsTasks && editor && detail?.decoration?.role === Role.TaskCheckbox) {
        editor.toggleTask(detail.decoration);
      }
      latest.current.onHit?.(detail, api);
    };

    const onLinkOpen = (/** @type {any} */ event) => {
      latest.current.onLinkOpen?.(event.detail, api);
    };

    sharedCore(latest.current.wasm ?? DEFAULT_WASM_URL)
      .then((core) => {
        if (cancelled) return;
        const props0 = latest.current;

        const plugins0 = props0.plugins ?? [];
        engine = core.newEngine(manifestBytes(props0.manifest, plugins0));
        engineRef.current = engine;
        coreRef.current = core;

        // Providers are wrapped rather than passed straight through. The editor holds
        // them strongly for its whole life (DESIGN §5.1), so passing the prop directly
        // would freeze whatever the first render happened to produce; an indirection
        // through `latest` lets a host swap the implementation without a remount.
        // Whether there *is* a provider is still decided once, at construction: the
        // editor's "no resolver" rendering is a real state and should not be faked.
        const widgetProvider = props0.widgetProvider
          ? {
              makeWidget: (/** @type {any} */ request) =>
                latest.current.widgetProvider?.makeWidget(request) ?? null,
              widgetWantsPointerEvents: (/** @type {any} */ roleName) =>
                latest.current.widgetProvider?.widgetWantsPointerEvents?.(roleName) ?? false,
            }
          : undefined;
        const resourceResolver = props0.resourceResolver
          ? {
              resolve: (/** @type {any} */ request) =>
                latest.current.resourceResolver.resolve(request),
              reservedSize: (/** @type {any} */ request) =>
                latest.current.resourceResolver.reservedSize(request),
            }
          : undefined;

        editor = new CoreEditor(host, engine, { widgetProvider, resourceResolver });
        editorRef.current = editor;
        alive.add(editor);
        layerState.current = { sigs: {}, roles: new Map() };
        history.current = NO_HISTORY;

        if (props0.resourceSizes) editor.resourceSizes = props0.resourceSizes;

        editor.addEventListener('change', onChange);
        editor.addEventListener('selectionchange', onSelectionChange);
        editor.addEventListener('hit', onHit);
        editor.addEventListener('linkopen', onLinkOpen);

        const initial = props0.value !== undefined ? props0.value : (props0.defaultValue ?? '');
        // Mounting is not a change the host made; firing `onChange` here would look like
        // an edit and, in the controlled shape, would set state during mount for nothing.
        quiet.current = true;
        try {
          editor.setMarkdown(initial);
        } finally {
          quiet.current = false;
        }

        // Setup sees the actual initial document. A plugin can compute its first layer
        // immediately instead of depending on a synthetic mount-time change event.
        pluginState.current.clear();
        for (const plugin of plugins0) {
          editor.installPlugin(plugin);
          pluginState.current.set(plugin.name.trim(), plugin);
        }

        setStatus('ready');
        setGeneration((g) => g + 1);
        latest.current.onReady?.(api);
        emitHistory();
        if (props0.autoFocus) editor.root.focus();
      })
      .catch((error) => {
        if (cancelled) return;
        editor?.destroy();
        if (editor) alive.delete(editor);
        engine?.free();
        editor = null;
        engine = null;
        editorRef.current = null;
        engineRef.current = null;
        coreRef.current = null;
        pluginState.current.clear();
        setStatus('error');
        if (latest.current.onError) latest.current.onError(error);
        else console.error('@mde/react: failed to load the editor core', error);
      });

    return () => {
      cancelled = true;
      if (editor) {
        editor.removeEventListener('change', onChange);
        editor.removeEventListener('selectionchange', onSelectionChange);
        editor.removeEventListener('hit', onHit);
        // Removes the document-level `selectionchange` listener. Without this a
        // `StrictMode` double-mount leaves the first editor subscribed forever,
        // reacting to a document it no longer renders.
        editor.destroy();
        alive.delete(editor);
      }
      // The engine is owned by this component: it was created here and nothing else
      // holds it, so its wasm allocation is released here too.
      if (engine) engine.free();
      editorRef.current = null;
      engineRef.current = null;
      coreRef.current = null;
      history.current = NO_HISTORY;
      layerState.current = { sigs: {}, roles: new Map() };
      pluginState.current.clear();
    };
    // `key` and `signature` are content-derived strings, so an inline manifest object or
    // a freshly constructed URL does not rebuild the editor on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, signature, api]);

  // MARK: - `value`, when a host insists on one
  //
  // Only differences that did not originate here are applied, and they are applied as a
  // single minimal replacement through the ordinary edit path — never by re-setting the
  // whole document, which would clear the undo history and drop the caret on every
  // keystroke. See the README for why `defaultValue` is the honest shape.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || value === undefined) return;
    if (value === editor.markdown) {
      if (pendingControlledValue.current === value) pendingControlledValue.current = null;
      return;
    }
    // Concurrent parents can briefly render their previous value after a local edit.
    // Keep the accepted local source until its exact acknowledgement arrives instead
    // of applying an unnecessary rollback and replay through the engine.
    if (pendingControlledValue.current === editor.markdown) return;
    pendingControlledValue.current = null;

    const edit = diffText(editor.markdown, value);
    editor.closeUndoGroup();
    editor.replaceRange(edit.start, edit.end, edit.text);
    editor.closeUndoGroup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, generation]);

  // MARK: - Declarative layers (DESIGN §5.3)
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const state = layerState.current;
    const wanted = layers ?? {};
    for (const name of Object.keys(state.sigs)) {
      if (!(name in wanted)) {
        editor.clearLayer(name);
        delete state.sigs[name];
      }
    }
    for (const [name, spans] of Object.entries(wanted)) {
      const resolved = ((spans ?? []) as Array<{ role: number | string }>).map((span) => ({
        ...span,
        role: typeof span.role === 'string' ? internRole(editor, state, span.role) : span.role,
      }));
      const sig = JSON.stringify(resolved);
      if (state.sigs[name] === sig) continue;
      state.sigs[name] = sig;
      editor.setLayer(name, resolved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, generation]);

  // Runtime-only plugin changes do not rebuild the engine. A plugin manifest changing
  // updates `signature` above and remounts because parser syntax is startup state.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const installed = pluginState.current;
    const wanted = new Map();
    try {
      for (const plugin of plugins) {
        const name = plugin.name.trim();
        if (wanted.has(name)) throw new Error(`Duplicate plugin "${name}"`);
        wanted.set(name, plugin);
      }
      const currentOrder = [...installed.keys()];
      const wantedOrder = [...wanted.keys()];
      const orderChanged =
        currentOrder.length === wantedOrder.length &&
        currentOrder.some((name, index) => name !== wantedOrder[index]) &&
        currentOrder.every((name) => wanted.has(name));
      const errors = [];
      if (orderChanged) {
        for (const name of currentOrder.reverse()) {
          try {
            editor.removePlugin(name);
          } catch (error) {
            errors.push(error);
          }
        }
        installed.clear();
      }
      for (const [name, plugin] of installed) {
        if (wanted.get(name) !== plugin) {
          try {
            editor.removePlugin(name);
          } catch (error) {
            errors.push(error);
          } finally {
            installed.delete(name);
          }
        }
      }
      for (const [name, plugin] of wanted) {
        if (installed.has(name)) continue;
        try {
          editor.installPlugin(plugin);
          installed.set(name, plugin);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw errors.length === 1
          ? errors[0]
          : new AggregateError(errors, 'Multiple plugin lifecycle operations failed');
      }
    } catch (error) {
      if (latest.current.onError) latest.current.onError(error);
      else console.error('@mde/react: failed to update plugins', error);
    }
  }, [plugins, generation]);

  return createElement('div', {
    ...rest,
    ref: hostRef,
    // The editor adds `mde-editor` itself; including it here means a later `className`
    // change cannot take it away when React rewrites the attribute.
    className: className ? `mde-editor ${className}` : 'mde-editor',
    style,
    'data-mde-status': status,
  });
}

/**
 * @param {CoreEditor} editor
 * @param {{roles: Map<string, number>}} state
 * @param {string} name
 */
function internRole(editor, state, name) {
  let id = state.roles.get(name);
  if (id === undefined) {
    id = editor.internRole(name);
    state.roles.set(name, id);
  }
  return id;
}

/**
 * The imperative surface.
 *
 * Everything is a method. Nothing here is a value that React could end up serializing,
 * which is what keeps `BigInt` decoration keys out of the render path even when the
 * handle is passed around.
 */
function makeHandle({ editorRef, coreRef, engineRef, hostRef }) {
  /** @returns {CoreEditor|null} */
  const ed = () => editorRef.current;

  return {
    // ---- lifecycle / escape hatches
    isReady: () => ed() !== null,
    getEditor: () => ed(),
    getEngine: () => engineRef.current,
    getCore: () => coreRef.current,
    getElement: () => hostRef.current,
    focus: () => ed()?.root.focus(),

    // ---- document
    getMarkdown: () => ed()?.markdown ?? '',
    /** Replaces the document wholesale. Clears the undo history (DESIGN §9). */
    setMarkdown: (text) => ed()?.setMarkdown(text),
    replaceRange: (start, end, text) => ed()?.replaceRange(start, end, text),
    insertText(text) {
      const editor = ed();
      if (!editor) return false;
      const at = editor.selectionRange();
      if (!at) return false;
      editor.replaceRange(at.start, at.end, text);
      return true;
    },

    // ---- selection
    getSelection: () => ed()?.selectionRange() ?? null,
    setSelection(range) {
      const editor = ed();
      if (!editor) return;
      editor.setSelectionRange(range);
      editor.onSelectionChange();
    },

    // ---- commands
    /**
     * The `Bold` button from the reference demo, generalised. Fenced by undo boundaries
     * so it comes off in one step rather than as two stray marker insertions.
     */
    wrapSelection(prefix, suffix = prefix) {
      const editor = ed();
      if (!editor) return false;
      const at = editor.selectionRange();
      if (!at || at.start === at.end) return false;
      const text = editor.markdown.slice(at.start, at.end);
      editor.closeUndoGroup();
      editor.replaceRange(at.start, at.end, `${prefix}${text}${suffix}`);
      editor.closeUndoGroup();
      editor.setSelectionRange({
        start: at.start + prefix.length,
        end: at.end + prefix.length,
      });
      return true;
    },
    toggleTask: (decoration) => ed()?.toggleTask(decoration),

    // ---- history (DESIGN §9)
    canUndo: () => !!ed()?.canUndo,
    canRedo: () => !!ed()?.canRedo,
    undo: () => !!ed()?.undo(),
    redo: () => !!ed()?.redo(),
    closeUndoGroup: () => ed()?.closeUndoGroup(),
    /**
     * The whole timeline, oldest first, including revisions that have been undone. All
     * plain numbers — safe to render, unlike a decoration.
     */
    getRevisions: () => ed()?.revisions ?? [],
    /** How many revisions are applied: the caret's position in the timeline. */
    getHistoryPosition: () => ed()?.historyPosition ?? 0,
    /** Move anywhere in the timeline. Undo and redo are the one-step view of this. */
    jumpTo: (target) => !!ed()?.jumpTo(target),

    // ---- host decoration layers (DESIGN §5.3)
    internRole: (name) => ed()?.internRole(name) ?? -1,
    setLayer: (name, spans) => ed()?.setLayer(name, spans),
    clearLayer: (name) => ed()?.clearLayer(name),
    installPlugin: (plugin) => ed()?.installPlugin(plugin),
    removePlugin: (name) => !!ed()?.removePlugin(name),
    getInstalledPlugins: () => ed()?.installedPlugins ?? [],

    // ---- introspection
    /** Live decorations. These carry `BigInt` keys — never put the result in state. */
    getDecorations: () => ed()?.decorations ?? [],
    getResourceSizes: () => ed()?.resourceSizes ?? {},
    setResourceSizes(sizes) {
      const editor = ed();
      if (editor) editor.resourceSizes = sizes;
    },
  };
}

export const MarkdownEditor = forwardRef(MarkdownEditorImpl);
MarkdownEditor.displayName = 'MarkdownEditor';
