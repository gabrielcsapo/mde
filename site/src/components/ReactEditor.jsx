import { useCallback, useEffect, useReducer, useState } from 'react';
import { MarkdownEditor, useEditorHistory, useMarkdownEditorRef } from '@mde/react';
import { attachmentComposer, mentionAutocomplete } from '@mde/web/extensions/composer';
import wasmUrl from '@mde/web/mde.wasm?url';

import {
  manifestSpec,
  resourceResolver,
  widgetProvider,
} from '../../../web/examples/vanilla/host.js';
import { TOOLBAR } from '../lib/toolbar.js';
import { sample } from '../lib/sample.js';
import HistoryPanel from './HistoryPanel.jsx';
import Toolbar from './Toolbar.jsx';

const COMPOSER_PLUGINS = [
  mentionAutocomplete({ candidates: [
    { handle: 'gabe', label: 'Gabriel', detail: 'Editor team' },
    { handle: 'grace', label: 'Grace', detail: 'Design' },
    { handle: 'mira', label: 'Mira', detail: 'Journal' },
  ] }),
  attachmentComposer(),
];

export default function ReactEditor({ historyInitiallyOpen, descriptionId }) {
  const editorRef = useMarkdownEditorRef();
  const [history, onHistoryChange] = useEditorHistory();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('loading core…');
  const [historyOpen, setHistoryOpen] = useState(
    () => historyInitiallyOpen ?? matchMedia('(min-width: 721px)').matches,
  );
  const [, refresh] = useReducer((n) => n + 1, 0);

  const getEditor = useCallback(() => editorRef.current?.getEditor() ?? null, [editorRef]);
  const updateStatus = useCallback(() => {
    const editor = getEditor();
    if (!editor) return;
    setStatus(`${editor.markdown.length} chars · ${editor.decorations.length} decorations`);
    refresh();
  }, [getEditor]);

  useEffect(
    () => () => {
      if (window.__mde?.variant === 'react') delete window.__mde;
    },
    [],
  );

  return (
    <div className="editor-shell">
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
        <button
          type="button"
          className="tool"
          title="The revision timeline — every edit, including undone ones; click to land anywhere"
          disabled={!ready || !!error}
          aria-pressed={String(historyOpen)}
          aria-controls="revision-history"
          onClick={() => setHistoryOpen((open) => !open)}
        >
          History
        </button>
        <span className="status" role="status" aria-live="polite">
          {error ? 'core unavailable' : status}
        </span>
      </div>

      {error ? (
        <div className="editor-fallback">
          <p>The React adapter could not start: {error}</p>
        </div>
      ) : null}

      <div className={historyOpen && ready && !error ? 'editor-body with-history' : 'editor-body'}>
        <MarkdownEditor
          id="editor"
          ref={editorRef}
          aria-label="Live markdown editor using the React adapter"
          aria-describedby={descriptionId}
          hidden={!!error}
          defaultValue={sample}
          manifest={manifestSpec}
          wasm={wasmUrl}
          widgetProvider={widgetProvider}
          resourceResolver={resourceResolver}
          plugins={COMPOSER_PLUGINS}
          onChange={updateStatus}
          onSelectionChange={refresh}
          onLinkOpen={({ destination }) => {
            window.open(destination, '_blank', 'noopener,noreferrer');
          }}
          onHistoryChange={(next) => {
            onHistoryChange(next);
            refresh();
          }}
          onReady={(handle) => {
            setReady(true);
            setStatus(
              `${handle.getMarkdown().length} chars · ${handle.getDecorations().length} decorations`,
            );
            window.__mde = {
              editor: handle.getEditor(),
              handle,
              variant: 'react',
            };
          }}
          onError={(reason) => setError(reason?.message ?? String(reason))}
        />
        {historyOpen && ready && !error ? (
          <HistoryPanel
            getEditor={getEditor}
            onJump={() => {
              updateStatus();
              onHistoryChange({
                canUndo: editorRef.current?.canUndo() ?? false,
                canRedo: editorRef.current?.canRedo() ?? false,
                position: editorRef.current?.getHistoryPosition() ?? 0,
                count: editorRef.current?.getRevisions().length ?? 0,
              });
            }}
          />
        ) : null}
      </div>
      <span className="sr-only" aria-live="polite">
        React history position {history.position} of {history.count}
      </span>
    </div>
  );
}
