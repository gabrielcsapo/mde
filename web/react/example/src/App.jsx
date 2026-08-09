import { useMemo, useRef, useState } from 'react';
import {
  MarkdownEditor,
  Role,
  activeEditorCount,
  loadedCoreCount,
  useEditorHistory,
  useMarkdownEditorRef,
} from '@mde/react';

// An extension written entirely against the layer API (DESIGN §5.3). It knows nothing
// about React, and this adapter knows nothing about it — they meet at `getEditor()`.
import { TypewriterMode } from '@mde/web/extensions/typewriter';
import wasmUrl from '@mde/web/mde.wasm?url';

import { manifestSpec, resourceResolver, sample, second, widgetProvider } from './host.js';

export default function App() {
  const [mounted, setMounted] = useState(true);
  const [showSecond, setShowSecond] = useState(true);

  return (
    <div className="page">
      <h1>@mde/react</h1>
      <p className="lede">
        The React adapter driving the real editor from <code>web/src</code>. Rendered under{' '}
        <code>StrictMode</code>, so every effect here has already run twice.
      </p>

      <section>
        <div className="bar">
          <strong>Uncontrolled</strong>
          <span className="spacer" />
          <button onClick={() => setMounted((m) => !m)} id="toggle-mount">
            {mounted ? 'Unmount' : 'Mount'}
          </button>
        </div>
        {mounted ? <Uncontrolled /> : <p className="empty">unmounted</p>}
      </section>

      <section>
        <div className="bar">
          <strong>A second editor, same wasm</strong>
          <span className="spacer" />
          <button onClick={() => setShowSecond((s) => !s)} id="toggle-second">
            {showSecond ? 'Hide' : 'Show'}
          </button>
        </div>
        {showSecond ? (
          <MarkdownEditor
            id="editor-second"
            wasm={wasmUrl}
            defaultValue={second}
            manifest={manifestSpec}
            widgetProvider={widgetProvider}
          />
        ) : null}
      </section>

      <Controlled />

      <Diagnostics />
    </div>
  );
}

function Uncontrolled() {
  const ref = useMarkdownEditorRef();
  const [history, onHistoryChange] = useEditorHistory();
  const [stats, setStats] = useState({ chars: sample.length, decorations: 0 });
  const [query, setQuery] = useState('');
  const [typewriter, setTypewriter] = useState(false);
  const typewriterRef = useRef(null);

  // A declarative layer: matches of the search box, decorated with a role this host
  // invented at runtime. The editor interns the name on first use and the theme picks it
  // up as `.mde-ext-search-hit` — no change to the editor, the applier, or the core.
  const layers = useMemo(() => {
    if (!query) return {};
    const text = ref.current?.getMarkdown() ?? '';
    const spans = [];
    const needle = query.toLowerCase();
    const hay = text.toLowerCase();
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
      spans.push({ start: i, end: i + needle.length, role: 'search-hit' });
    }
    return { search: spans };
  }, [query, stats.chars, ref]);

  return (
    <>
      <div className="bar">
        <button id="bold" onClick={() => ref.current?.wrapSelection('**')}>
          Bold
        </button>
        <button id="italic" onClick={() => ref.current?.wrapSelection('*')}>
          Italic
        </button>
        <button id="undo" disabled={!history.canUndo} onClick={() => ref.current?.undo()}>
          Undo
        </button>
        <button id="redo" disabled={!history.canRedo} onClick={() => ref.current?.redo()}>
          Redo
        </button>
        <button
          id="typewriter"
          aria-pressed={typewriter}
          onClick={() => {
            const mode = typewriterRef.current;
            if (mode) setTypewriter(mode.toggle());
            ref.current?.focus();
          }}
        >
          Typewriter
        </button>
        {/* Known editor bug, not a wrapper one: clicking this box while the editor holds
            a caret bounces focus straight back, because blurring repaints and the repaint
            restores the selection into the contenteditable. See the README. */}
        <input
          id="search"
          value={query}
          placeholder="highlight…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="spacer" />
        <span id="stats" className="stats">
          {stats.chars} chars · {stats.decorations} decorations
        </span>
      </div>

      <MarkdownEditor
        id="editor-main"
        wasm={wasmUrl}
        ref={ref}
        defaultValue={sample}
        manifest={manifestSpec}
        widgetProvider={widgetProvider}
        resourceResolver={resourceResolver}
        layers={layers}
        onHistoryChange={onHistoryChange}
        onChange={(markdown, editor) =>
          setStats({ chars: markdown.length, decorations: editor.getDecorations().length })
        }
        onHit={({ decoration }) => {
          if (decoration.role === Role.TaskCheckbox) {
            // Handled by the component already (`toggleTasksOnClick`); this is only here
            // to show the hook exists.
          }
        }}
        onLinkOpen={({ destination }) => {
          window.open(destination, '_blank', 'noopener,noreferrer');
        }}
        onReady={(editor) => {
          // The escape hatch: an extension that predates this package, constructed with
          // the framework-free editor it was written against.
          typewriterRef.current = new TypewriterMode(editor.getEditor());
          setTypewriter(false);
          // Exposed so browser-driven checks can drive the same handle the UI does —
          // the same trick `web/examples/vanilla/index.html` uses.
          window.__mde = editor;
        }}
        onError={(error) => console.error(error)}
      />

      <HistoryPanel editorRef={ref} history={history} revision={stats.chars} />
    </>
  );
}

/**
 * Browsable history (DESIGN §9). The revisions are plain numbers, so unlike a decoration
 * they are safe to render; `jumpTo` is undo/redo without the one-step-at-a-time part.
 */
function HistoryPanel({ editorRef, history, revision }) {
  const revisions = useMemo(
    () => editorRef.current?.getRevisions() ?? [],
    // `history.count` moves when a revision is added; `revision` also moves while a
    // typing run coalesces into the revision that is already there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editorRef, history.count, history.position, revision]
  );
  if (revisions.length === 0) return null;

  return (
    <div className="timeline" id="timeline">
      <button
        className={history.position === 0 ? 'now' : ''}
        onClick={() => editorRef.current?.jumpTo(0)}
      >
        opened
      </button>
      {revisions.map((r) => (
        <button
          key={r.index}
          data-index={r.index}
          className={history.position === r.index + 1 ? 'now' : ''}
          title={new Date(r.atMs).toLocaleTimeString()}
          onClick={() => editorRef.current?.jumpTo(r.index + 1)}
        >
          +{r.inserted}/−{r.removed}
        </button>
      ))}
    </div>
  );
}

/**
 * The `value` escape hatch. Not a per-keystroke controlled input — the DOM is the buffer
 * — but a document that something outside React can replace.
 */
function Controlled() {
  const [text, setText] = useState('A **controlled** document.\n');

  return (
    <section>
      <div className="bar">
        <strong>Controlled by a `value` prop</strong>
        <button id="external-set" onClick={() => setText(`# Replaced externally\n\nat ${new Date().toLocaleTimeString()}\n`)}>
          Replace from outside
        </button>
        <span className="spacer" />
        <span className="stats">{text.length} chars in React state</span>
      </div>
      <MarkdownEditor id="editor-controlled" wasm={wasmUrl} value={text} onChange={setText} />
    </section>
  );
}

function Diagnostics() {
  const [counts, setCounts] = useState(null);
  return (
    <section className="diagnostics">
      <button
        id="count"
        onClick={() =>
          setCounts({
            roots: document.querySelectorAll('.mde-editor').length,
            editors: activeEditorCount(),
            cores: loadedCoreCount(),
          })
        }
      >
        Count
      </button>
      {counts ? (
        <span id="counts">
          {counts.roots} roots · {counts.editors} live editors · {counts.cores} wasm cores
        </span>
      ) : null}
    </section>
  );
}
