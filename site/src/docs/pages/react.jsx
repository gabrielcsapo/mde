import { Aside, H2, H3, Lede, Note, SeeAlso } from '../../components/Doc.jsx';
import Api from '../../components/Api.jsx';
import SourceFigure from '../../components/SourceFigure.jsx';
import { Link } from '../../lib/router.jsx';
import { REACT_API } from '../../lib/api.js';
import {
  reactBasicJsx,
  reactCommandsJsx,
  reactHistoryJsx,
  reactLayersJsx,
} from '../../lib/snippets.js';

export default function ReactPage() {
  return (
    <>
      <H2 id="optional">An adapter, not the editor</H2>
      <Lede>
        <code>@mde/react</code> lives in <code>web/react/</code> and is an optional layer over the
        framework-free editor in <code>web/src/</code>. It imports that editor directly — it is
        never a fork of it — and it takes React and React DOM as peer dependencies, so it adds
        nothing to a page that already has them.
      </Lede>
      <p>
        Everything on the rest of this site is still true underneath: the same wasm core, the same
        decoration protocol, the same extension manifest, the same host contracts. The adapter’s job
        is to make the editor’s lifetime and its events look like React, and to keep the two things
        React does that this editor genuinely dislikes from happening.
      </p>
      <Note>
        The <Link to="/try">demo editor</Link> lets you switch between the adapter and the direct
        framework-free mount. The React variant is lazy-loaded, so choosing JS does not load
        the adapter at all.
      </Note>

      <H3 id="installing">Installing it</H3>
      <p>
        Install <code>@mde/react</code> alongside React. It declares <code>@mde/web</code> as a normal
        dependency and React and React DOM as peers, so the adapter remains a thin package boundary
        instead of copying the editor or bundling a second React runtime.
      </p>
      <p>
        Both packages are TypeScript source compiled as ESM libraries with Vite. The framework-free
        build emits JavaScript and wasm separately, and the React build keeps React and{' '}
        <code>@mde/web</code> external. Import <code>@mde/web/theme.css</code> yourself, and{' '}
        <code>@mde/plugins/extensions.css</code> if you use the optional feature package.
      </p>

      <H2 id="uncontrolled">Uncontrolled by design</H2>
      <Lede>
        <code>defaultValue</code> and <code>onChange</code>, not <code>value</code> and{' '}
        <code>onChange</code>. This is not a shortcut — a controlled text input is the one shape
        this editor cannot have.
      </Lede>
      <SourceFigure className="mt-6" path="Editor.jsx" lang="javascript" code={reactBasicJsx} />

      <Aside tone="caution" title="Why not controlled">
        <p>
          <strong>The DOM is the buffer.</strong> The editor does not render the document from a
          value it holds; the <code>contenteditable</code> element <em>is</em> the document, and the
          browser is what mutates it — that is exactly what buys native IME, autocorrect, spellcheck
          and touch selection.
        </p>
        <p>
          A controlled component re-renders from state on every keystroke and hands React the job of
          reconciling the text back into the DOM. Doing that to a live text field destroys the caret
          position on every character, and destroys an in-flight IME composition outright — the
          Japanese or Chinese input that was half-composed is simply gone. It would trade the single
          biggest reason to build on the platform’s text engine for an API convention.
        </p>
        <p>
          There is still a <code>value</code> prop, for the case it actually solves: applying a
          change that came from <em>outside</em> the editor — a collaborative session, a file
          watcher, a revert button. A value equal to what the editor already contains is ignored, so
          your own <code>onChange</code> echoing back through state is free; one that differs is
          reduced to a single minimal replacement and applied through the ordinary edit path, so it
          lands in the undo history and repaints only the lines it touched. Applying one moves the
          caret to the end of the replacement whether or not the editor is focused — so do not drive
          it from a keystroke.
        </p>
      </Aside>

      <H3 id="rerenders">Re-rendering is free, and that is unusual</H3>
      <p>
        Only <code>wasm</code> and the <em>content</em> of <code>manifest</code> rebuild the editor.
        Callbacks, providers and <code>layers</code> are read through refs, so a parent that
        re-renders with fresh closures — or passes an inline object literal — costs nothing. Most
        React libraries would have you memoise all of it; here there is nothing to memoise.
      </p>
      <Note>
        Whether a <code>widgetProvider</code> or <code>resourceResolver</code> is <em>present</em> is
        fixed at mount: the editor holds them for its whole life, and “no resolver” is a real state
        that should not be faked. The implementation behind one may change freely.
      </Note>

      <H2 id="pitfalls">Two pitfalls the adapter exists to handle</H2>

      <H3 id="bigint">The editor instance must never be state or a prop</H3>
      <p>
        Decoration keys are <code>u64</code> (
        <Link to="/concepts/decorations">stable identity, DESIGN §3.3</Link>), which arrive in
        JavaScript as <code>BigInt</code>. React’s development-mode prop logging deep-serialises
        changed props — and <code>JSON.stringify</code> throws on a <code>BigInt</code>. Put the
        editor, or a decoration, into state or into a prop and you get an uncaught error on every
        keystroke, in development only, from code that looks entirely reasonable.
      </p>
      <p>
        So <strong>every member of the handle is a method, never a value</strong>: the editor, its
        engine and its decorations all sit behind function calls, which keeps them out of the render
        path entirely. It is also why <code>onHistoryChange</code> carries four scalars rather than
        the editor — those are safe to put straight into state. This site’s own toolbar reaches the
        editor through a stable callback for the same reason, and says so in{' '}
        <code>site/src/components/Toolbar.jsx</code>.
      </p>

      <H3 id="strictmode">StrictMode double-mounts, which is what destroy() is for</H3>
      <p>
        Under <code>StrictMode</code> React mounts every component twice on purpose, to surface
        effects that are not cleanly reversible. An editor that does not tear down leaves the first
        instance subscribed to <code>selectionchange</code> on <code>document</code> — a listener
        that outlives its element — reacting forever to a document it no longer renders, and fetches
        the wasm twice.
      </p>
      <p>
        <code>MarkdownEditor.destroy()</code> exists for this, and the adapter calls it in effect
        cleanup. It goes further than surviving the double mount: the double-invoked effect is
        cancelled <em>before</em> an editor is ever constructed, so a mount adds exactly one listener
        and an unmount removes exactly one. The example app runs under <code>StrictMode</code> on
        purpose, and <code>activeEditorCount()</code> and <code>loadedCoreCount()</code> are exported
        so a leak is visible rather than theoretical.
      </p>
      <Note>
        The wasm is compiled once per page rather than once per component: a module-level cache
        keyed by source holds the in-flight promise, so two editors mounting in the same tick share
        one fetch and one <code>WebAssembly.Instance</code>. Each still gets its own engine, document
        and history. <code>preloadCore()</code> warms it from a route transition.
      </Note>

      <H2 id="commands">Commands go through a ref</H2>
      <Lede>
        A command acts on a live selection in a live buffer. Expressing “wrap what is selected in{' '}
        <code>**</code>” as state would mean owning the selection, which belongs to the platform —
        so commands are methods on an imperative handle.
      </Lede>
      <SourceFigure className="mt-6" path="Toolbar.jsx" lang="javascript" code={reactCommandsJsx} />

      <H2 id="plugin-ui">React-owned plugin UI</H2>
      <p>
        <code>createReactPresentation</code> renders any React node into an editor-owned popover or
        modal, while <code>usePluginPresentation</code> keeps one synchronized with component state.
        Dismissal unmounts the React root safely even when it originated inside a React event.
        <code>useEditorCommands</code> returns the live central command registry for application
        toolbars and command palettes.
      </p>

      <H2 id="layers-prop">Layers, declaratively</H2>
      <p>
        <Link to="/extend/layers">Host decoration layers</Link> are a natural fit for a prop: the
        host says what the layer <em>is</em>, and the core diffs it. The adapter compares by content
        rather than by identity, so an inline object literal does not re-push a layer on every
        render, and a span’s role may be given as a name rather than an id.
      </p>
      <SourceFigure className="mt-6" path="Highlighted.jsx" lang="javascript" code={reactLayersJsx} />
      <Note>
        Extensions that already exist — <code>web/extensions/typewriter.ts</code>,{' '}
        <code>parts-of-speech.ts</code> — expect the framework-free editor, and get it from{' '}
        <code>handle.getEditor()</code>. They know nothing about React and the adapter knows nothing
        about them; they meet at that one method.
      </Note>

      <H2 id="history-panel">A history panel is a list and a jump</H2>
      <p>
        <code>onHistoryChange</code> carries only scalars — <code>canUndo</code>,{' '}
        <code>canRedo</code>, <code>position</code>, <code>count</code> — and fires only when one of
        them moves, so a toolbar re-renders when Undo becomes available rather than on every
        keystroke. A typing run coalesces into a single revision, so <code>count</code> does not move
        either. A panel that wants labels calls <code>getRevisions()</code>, which is plain numbers
        throughout and safe to render, and travels with <code>jumpTo(n)</code>.
      </p>
      <SourceFigure className="mt-6" path="History.jsx" lang="javascript" code={reactHistoryJsx} />
      <Note>
        <Link to="/concepts/history">History and undo</Link> covers what a revision reports and why{' '}
        <code>jumpTo</code> is one splice however far it travels.
      </Note>

      <Aside tone="note" title="A bug this adapter found, and where it was fixed">
        <p>
          Early versions of the editor could bounce focus straight back on blur: collapsing the
          reveal dirtied a line, the re-render restored the selection it had read <em>before</em>{' '}
          focus left, and calling <code>Selection.addRange</code> inside a{' '}
          <code>contenteditable</code> re-focuses that element. Clicking from a focused editor into
          another input — or into a second editor on the same page — bounced straight back.
        </p>
        <p>
          The fix lives in the editor, not this adapter: <code>MarkdownEditor.applyPatch</code> only
          restores a selection while the editor is the active element, and a regression test pins
          it. It is recorded here because two editors on one page is exactly the situation a React
          host creates — the adapter is how the bug was found.
        </p>
      </Aside>

      <Api groups={REACT_API} />

      <SeeAlso
        links={[
          {
            to: '/install',
            title: 'Install and embed',
            note: 'the same editor without React, and how to build the wasm',
          },
          {
            to: '/reference/web',
            title: 'Web API',
            note: 'what the adapter is wrapping, in full',
          },
          {
            to: '/extend/showcase',
            title: 'Two extensions, no editor changes',
            note: 'what getEditor() is for',
          },
        ]}
      />
    </>
  );
}
