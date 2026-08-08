import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

// The real editor, imported across the directory boundary rather than copied. This is
// the whole claim the section makes: the page runs the same modules `web/demo` and the
// browser test suite run, and the same `mde.wasm` binary. `vite.config.js` widens
// `server.fs.allow` to the repository root so the dev server can read them, and the
// `?url` import makes the wasm an emitted asset rather than something bundled.
import { loadCore, Role } from '../../../web/src/core.js';
import { encodeManifest } from '../../../web/src/manifest.js';
import { MarkdownEditor } from '../../../web/src/editor.js';
import { manifestSpec, widgetProvider, resourceResolver } from '../../../web/demo/host.js';
import wasmUrl from '../../../web/mde.wasm?url';

import { TOOLBAR } from '../lib/toolbar.js';
import { sample } from '../lib/sample.js';
import Toolbar from './Toolbar.jsx';
import HistoryPanel from './HistoryPanel.jsx';

// Remembered resource dimensions. `reservedSize` is otherwise a guess, and a wrong
// guess shifts the document once when the asset lands; seeding known sizes means that
// happens at most once per asset, ever.
const SIZES_KEY = 'mde.site.resourceSizes';

export default function LiveEditor() {
  const host = useRef(null);

  // The editor lives in a ref, not in state, and is never passed as a prop. It is a
  // live imperative object — the DOM is its buffer — and putting it in the React tree
  // would mean React walking it: its decorations carry `u64` keys, which arrive as
  // BigInt and throw in React's development prop logging. `ready` is the state.
  const editor = useRef(null);
  const getEditor = useCallback(() => editor.current, []);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('loading core…');
  // Open by default: the timeline is part of the pitch, not a hidden extra. The
  // toggle stays, because a quarter of the width is worth reclaiming while writing.
  const [historyOpen, setHistoryOpen] = useState(true);

  // The toolbar's enabled/pressed state is a function of the document *and* the
  // selection, and neither is React state. So rather than mirroring the editor, a
  // counter forces a re-render and the descriptors are re-evaluated against the live
  // object.
  const [, refresh] = useReducer((n) => n + 1, 0);

  useEffect(() => {
    let live = true;

    (async () => {
      const core = await loadCore(wasmUrl);
      if (!live) return;
      const engine = core.newEngine(encodeManifest(manifestSpec));
      const ed = new MarkdownEditor(host.current, engine, { widgetProvider, resourceResolver });

      try {
        ed.resourceSizes = JSON.parse(localStorage.getItem(SIZES_KEY) ?? '{}');
      } catch {
        // A corrupt entry is not worth failing to open the document over.
      }

      const onChange = () => {
        setStatus(`${ed.markdown.length} chars · ${ed.decorations.length} decorations`);
        refresh();
      };
      ed.addEventListener('change', onChange);

      ed.addEventListener('hit', (e) => {
        if (e.detail.decoration.role === Role.TaskCheckbox) {
          ed.toggleTask(e.detail.decoration);
          onChange();
        }
      });

      ed.setMarkdown(sample);
      editor.current = ed;
      setReady(true);
      // Exposed so browser-driven checks can drive the same API the UI does.
      window.__mde = { editor: ed, engine, core };
    })().catch((err) => {
      // A failure here must not take the rest of the page with it, and must never
      // leave a dead grey box: say what went wrong and how to serve the page properly.
      console.warn('editor boot failed', err);
      if (live) setError(err?.message ?? String(err));
    });

    // This page is now one route among twenty, so the editor genuinely unmounts when
    // the reader navigates away — and it has to be taken apart when it does.
    // `destroy()` removes the `selectionchange` listener the editor keeps on
    // `document`, which is the one listener that outlives its element: without it the
    // orphan keeps reacting to a document it no longer renders.
    //
    // The engine is deliberately *not* freed. Resource resolution is asynchronous by
    // design, and this host's resolver takes 350 ms on purpose — so navigating away
    // quickly leaves a promise that will still call back into the editor to repaint the
    // node that was waiting for it. That call reaches the engine, and a freed handle
    // turns it into a wasm trap in the console. One abandoned engine per visit to this
    // page is a few kilobytes of linear memory; a use-after-free is a crash.
    return () => {
      live = false;
      editor.current?.destroy();
      editor.current = null;
      if (window.__mde) delete window.__mde;
    };
  }, []);

  // Enabled state depends on the selection as much as on the document — the bold
  // command is dead without a range — so the toolbar tracks selection too. Registered
  // on `document` because that is where the event fires.
  useEffect(() => {
    if (!ready) return;
    document.addEventListener('selectionchange', refresh);
    return () => document.removeEventListener('selectionchange', refresh);
  }, [ready]);

  // Sizes are an optimization, not state we need, so a full storage quota is silent.
  useEffect(() => {
    if (!ready) return;
    const save = () => {
      try {
        if (!editor.current) return;
        localStorage.setItem(SIZES_KEY, JSON.stringify(editor.current.resourceSizes));
      } catch {
        /* storage full or blocked */
      }
    };
    addEventListener('pagehide', save);
    return () => removeEventListener('pagehide', save);
  }, [ready]);

  return (
    <div className="editor-shell mt-[30px]">
      <div className="editor-bar">
        <span className="doc">
          <span className="doc-name inline-flex items-center gap-[7px]">note.md</span>
        </span>
        <Toolbar
          descriptors={TOOLBAR}
          getEditor={getEditor}
          ready={ready && !error}
          onRun={refresh}
        />
        {/* History is a view, not a command, so it lives beside the descriptor-driven
            toolbar rather than inside it. */}
        <button
          type="button"
          className="tool"
          id="history"
          title="The revision timeline — every edit, including undone ones; click to land anywhere"
          disabled={!ready || !!error}
          aria-pressed={String(historyOpen)}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          History
        </button>
        <span className="status" id="status">
          {error ? 'core unavailable' : status}
        </span>
      </div>

      {error ? (
        <div className="editor-fallback">
          <p>The editor could not start: {error}</p>
          <p>
            The wasm core is fetched over HTTP, so this usually means the dev or preview
            server is no longer running — restart <code>./scripts/serve-site.sh</code> (or{' '}
            <code>npm run preview</code> in <code>site/</code>) and reload. Opening the
            built files directly from disk fails the same way: modules and wasm both need
            a real origin.
          </p>
        </div>
      ) : null}

      {/* Two columns while the timeline is open: the document keeps three quarters,
          the history takes the last quarter as a sidebar. The editor's node is never
          unmounted by the toggle — only the wrapper's grid changes — because React
          must never touch that subtree once the editor owns it. */}
      <div className={historyOpen && ready && !error ? 'editor-body with-history' : 'editor-body'}>
        {/* React never puts children in here: the editor owns this node's contents and
            its `contenteditable` attribute from the moment it mounts. */}
        <div id="editor" ref={host} hidden={!!error} />
        {historyOpen && ready && !error ? (
          <HistoryPanel getEditor={getEditor} onJump={refresh} />
        ) : null}
      </div>
    </div>
  );
}
