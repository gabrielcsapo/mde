# @mde/react

A React component for the drop-in markdown editor. It depends on `@mde/web` — it is an
adapter, not a fork. The editor itself stays framework-free and has no idea this package
exists.

```jsx
import { MarkdownEditor, useEditorHistory, useMarkdownEditorRef } from '@mde/react';
import '@mde/web/theme.css';

function Note() {
  const ref = useMarkdownEditorRef();
  const [history, onHistoryChange] = useEditorHistory();

  return (
    <>
      <button onClick={() => ref.current.wrapSelection('**')}>Bold</button>
      <button disabled={!history.canUndo} onClick={() => ref.current.undo()}>Undo</button>
      <MarkdownEditor
        ref={ref}
        defaultValue="# Hello\n"
        onChange={(markdown) => save(markdown)}
        onHistoryChange={onHistoryChange}
      />
    </>
  );
}
```

## The editor is uncontrolled, and that is deliberate

**The DOM is the buffer.** This is not a `<textarea>` with a React-owned string behind it:
the contenteditable element *is* the document, and the browser's IME, autocorrect,
spellcheck, drag-and-drop and native undo integration all depend on it staying that way
(DESIGN §2.1, §7). Re-rendering the content from a `value` prop on every keystroke would
mean destroying and rebuilding the text under the caret sixty times a second — the caret
would jump, an IME composition would be cancelled mid-word, and the accessibility tree
would churn.

So the honest shape is `defaultValue` + `onChange`:

- **`defaultValue`** is read exactly once, when the editor instance is created.
- **`onChange(markdown, handle)`** tells you what the document now says.
- To load a *different* document, either change the component's `key` or call
  `handle.setMarkdown(text)`. Both clear the undo history, which is correct — a resync
  makes the recorded offsets describe a document that never existed (DESIGN §9).

### If you really do need `value`

`value` is supported as an escape hatch for the case where something outside React owns
the document — a collaborative session, a file watcher, a "revert" button. It is **not** a
controlled input in the React sense:

- A `value` equal to what the editor already contains is ignored, so your own `onChange`
  echoing back through state is free.
- A `value` that differs is reduced to a **single minimal replacement** (via the editor's
  own `diffText`) and applied through the ordinary edit path, so it lands in the undo
  history and repaints only the lines it touched.
- Applying one moves the caret to the end of the replacement, and does so whether or not
  the editor is focused. Do not drive it from a keystroke.

Typing into a `value` editor works — the round trip through React state is recognised as
your own echo — but `defaultValue` is what you want unless you can name the outside owner
of the document.

## Props

| prop | type | notes |
|---|---|---|
| `defaultValue` | `string` | Initial markdown. Read once, at creation. |
| `value` | `string` | Escape hatch; see above. |
| `onChange` | `(markdown, handle) => void` | Every edit, including undo and programmatic ones. |
| `onSelectionChange` | `(range \| null, handle) => void` | `{start, end}` in UTF-16 code units. |
| `onHit` | `({decoration, source}, handle) => void` | A `Hit` decoration was clicked (DESIGN §3). |
| `onHistoryChange` | `(state) => void` | `{canUndo, canRedo, position, count}`, only when one moves. |
| `onReady` | `(handle) => void` | The editor exists and the document is rendered. |
| `onError` | `(error) => void` | The wasm failed to load, or the manifest was rejected. |
| `wasm` | `string \| URL \| ArrayBuffer \| Response` | Defaults to the `mde.wasm` emitted beside `@mde/web`. Pass an imported asset URL when bundling. |
| `manifest` | `ManifestSpec \| Uint8Array \| null` | Extension manifest (DESIGN §5). A plain object is fine — it is compared by content, not identity. |
| `widgetProvider` | `WidgetProvider` | Host-drawn widgets. |
| `resourceResolver` | `ResourceResolver` | Turns a reference into something displayable (DESIGN §5.1). |
| `resourceSizes` | `Record<string, {width, height}>` | Sizes remembered from a previous session, seeded at mount. |
| `layers` | `Record<string, LayerSpan[]>` | Declarative host decoration layers; see below. |
| `toggleTasksOnClick` | `boolean` | Toggle `- [ ]` checkboxes when clicked. Default `true`. |
| `autoFocus` | `boolean` | Default `false`. |
| `className`, `style`, `id`, `data-*`, … | | Spread onto the editor element. `mde-editor` is always in the class list. |

Changing `wasm` or the *content* of `manifest` rebuilds the editor. Everything else —
callbacks, providers, `layers` — is read through a ref, so a parent that re-renders with
fresh closures costs nothing.

Whether a `widgetProvider` or `resourceResolver` is present is fixed at mount (the editor
holds them for its whole life, and "no resolver" is a real state that should not be
faked); the *implementation* behind one may change freely.

## The handle

Everything on the imperative handle is a **method**, never a value. That is not styling:
decoration keys are `u64` and arrive as `BigInt`, and React 19's development build
deep-serializes changed props when it logs them, which throws
`TypeError: Do not know how to serialize a BigInt` on every keystroke. Keeping the editor
and its decorations behind function calls keeps them out of the render path entirely.

```
isReady()  getEditor()  getEngine()  getCore()  getElement()  focus()

getMarkdown()            setMarkdown(text)        replaceRange(start, end, text)
insertText(text)         getSelection()           setSelection({start, end})

wrapSelection(prefix, suffix = prefix)     // the Bold command: wrapSelection('**')
toggleTask(decoration)

canUndo()  canRedo()  undo()  redo()  closeUndoGroup()
getRevisions()  getHistoryPosition()  jumpTo(n)      // browsable history, DESIGN §9

internRole(name)  setLayer(name, spans)  clearLayer(name)     // DESIGN §5.3

getDecorations()  getResourceSizes()  setResourceSizes(sizes)
```

`getEditor()` is the escape hatch to the framework-free editor underneath. The two
extensions in `web/extensions/` — typewriter mode and parts-of-speech highlighting — were
written years before this package and are constructed with it directly:

```jsx
<MarkdownEditor onReady={(handle) => new TypewriterMode(handle.getEditor())} />
```

### History

`onHistoryChange` carries only scalars, so a toolbar re-renders when Undo becomes
available and not on every keystroke (a typing run coalesces into one revision, so `count`
does not move either). A panel that wants labels calls `getRevisions()` — plain numbers
throughout, safe to render — and travels with `jumpTo(n)`:

```jsx
const revisions = useMemo(() => ref.current?.getRevisions() ?? [], [history.count, history.position]);
revisions.map((r) => <button onClick={() => ref.current.jumpTo(r.index + 1)}>+{r.inserted}</button>)
```

### Layers

Host decoration layers are the seam for anything not findable in the text — search hits,
comments, focus mode (DESIGN §5.3). The `layers` prop is the declarative form, diffed by
content so an inline object literal is fine:

```jsx
<MarkdownEditor layers={{ search: hits.map((h) => ({ ...h, role: 'search-hit' })) }} />
```

A `role` given as a string is interned on first use, so you can invent one at runtime; the
theme picks it up as `.mde-ext-search-hit`. Removing a name from the object clears that
layer. For very high-frequency updates, call `handle.setLayer` directly instead.

## Lifecycle

- The wasm is compiled **once per page**, not once per component: a module-level cache
  keyed by source holds the in-flight promise, so two editors mounting in the same tick
  share one fetch and one `WebAssembly.Instance`. Each editor still gets its own engine,
  document and history. `preloadCore(source)` warms it from a route transition.
- Unmount calls `editor.destroy()` (which removes the document-level `selectionchange`
  listener) and frees the engine's wasm allocation.
- `StrictMode` is supported and exercised by the example: the double-invoked effect is
  cancelled before an editor is ever constructed, so a mount adds exactly one listener and
  an unmount removes exactly one. `activeEditorCount()` and `loadedCoreCount()` are
  exported as diagnostics if you want to assert on that yourself.

## Install

`@mde/react` declares `@mde/web` as a dependency and React and React DOM as peers. Its
Vite library build keeps all three external, so consumers get one framework-free editor
and their existing React runtime rather than copied implementations.

```sh
pnpm add @mde/react @mde/web
```

The theme is not bundled either. Import it yourself, and `extensions.css` too if you use
the shipped extensions:

```js
import '@mde/web/theme.css';
```

The runtime is TypeScript compiled to ESM. Adapter-specific declarations reuse the types
exported by `@mde/web`, so the decoration and host-service contracts have one source.

## Example

```
cd web/react/example
pnpm install
pnpm run dev
```

Three editors under `StrictMode`: an uncontrolled one with a toolbar, a history timeline,
a search-highlight layer and the typewriter extension; a second one proving the shared
core; and a `value`-controlled one.

## A bug this adapter found (fixed in the editor)

Early versions of the editor re-focused themselves on blur: collapsing the reveal dirtied
a line, and `renderRange` restored the selection it read *before* focus left — and
`Selection.addRange` inside a `contenteditable` focuses that element. Clicking from a
focused editor into another input, or into a second editor on the same page, bounced
focus straight back.

Two editors on one page is exactly the situation a React host creates, which is how this
was found. The fix is in `MarkdownEditor.applyPatch` — a selection is only restored while
the editor is the active element — with a regression test in the web suite pinning it.
