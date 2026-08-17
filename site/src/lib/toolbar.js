// The toolbar is a list of descriptors, not markup. Adding a capability — a formatting
// command, or a mode contributed by an extension — means pushing one object here; the
// rendering, the enabled/pressed state and the refresh loop are already generic.
//
//   id       stable identifier, also the button's DOM id
//   label    the button's text
//   title    tooltip / accessible description
//   run      (editor) => void, invoked on click
//   enabled  (editor) => boolean          — optional, defaults to always enabled
//   pressed  (editor) => boolean | null   — optional; when present the button is a
//                                           toggle and carries `aria-pressed`
//
// Nothing in `Toolbar.jsx` knows any of these ids. It renders whatever this array
// holds and re-evaluates `enabled` / `pressed` whenever the document or the selection
// changes, so a new entry is a new button with working state and nothing else to wire.

import { TypewriterMode } from '@mde/plugins/typewriter';
import { PartsOfSpeech } from '@mde/plugins/parts-of-speech';

// Extension instances, one per editor.
//
// Note where these are imported from: `web/extensions/`, not `web/src/`. Neither feature
// is part of the editor — both are written entirely against the public layer API
// (DESIGN §5.3), and both arrive here as ordinary toolbar entries, which is the point
// the Extensions section makes in prose.
const instances = new WeakMap();

function extensionFor(editor, key, Kind) {
  let byKey = instances.get(editor);
  if (!byKey) {
    byKey = {};
    instances.set(editor, byKey);
  }
  byKey[key] ??= new Kind(editor);
  return byKey[key];
}

/**
 * @typedef {object} ToolDescriptor
 * @property {string} id
 * @property {string} label
 * @property {string} title
 * @property {(editor: any) => void} run
 * @property {(editor: any) => boolean} [enabled]
 * @property {(editor: any) => boolean|null} [pressed]
 */

/** @type {ToolDescriptor[]} */
export const TOOLBAR = [
  {
    id: 'view-mode',
    label: 'View',
    title: 'View mode: select and copy rendered content, open links normally, and never edit source',
    pressed: (editor) => editor.interactionMode === 'view',
    run: (editor) => {
      editor.interactionMode = editor.interactionMode === 'edit' ? 'view' : 'edit';
    },
  },
  {
    id: 'bold',
    label: 'Bold',
    title: 'Wrap the selection in ** — one undo step, not two marker insertions',
    enabled: (editor) => {
      if (editor.interactionMode !== 'edit') return false;
      const sel = editor.selectionRange();
      return !!sel && sel.start !== sel.end;
    },
    run: (editor) => {
      const sel = editor.selectionRange();
      if (!sel || sel.start === sel.end) return;
      const text = editor.markdown.slice(sel.start, sel.end);
      // Fenced by undo boundaries so the command comes off in one step.
      editor.closeUndoGroup();
      editor.replaceRange(sel.start, sel.end, `**${text}**`);
      editor.closeUndoGroup();
    },
  },
  {
    id: 'undo',
    label: 'Undo',
    title: 'Undo the last revision — the core owns the history, not the browser',
    enabled: (editor) => editor.interactionMode === 'edit' && editor.canUndo,
    run: (editor) => editor.undo(),
  },
  {
    id: 'redo',
    label: 'Redo',
    title: 'Redo the last undone revision',
    enabled: (editor) => editor.interactionMode === 'edit' && editor.canRedo,
    run: (editor) => editor.redo(),
  },
  {
    id: 'typewriter',
    label: 'Typewriter',
    title:
      'Focus mode: dim everything but the paragraph under the caret. An extension — '
      + 'the editor has no idea it exists.',
    enabled: (editor) => editor.interactionMode === 'edit',
    pressed: (editor) => extensionFor(editor, 'typewriter', TypewriterMode).enabled,
    run: (editor) => {
      extensionFor(editor, 'typewriter', TypewriterMode).toggle();
      // Toolbar clicks move focus away from the document. Restore it so the retained
      // caret drives the focus layer immediately instead of making the mode look inert.
      editor.root.focus();
    },
  },
  {
    id: 'parts-of-speech',
    label: 'Parts of speech',
    title:
      'Tint nouns, verbs, adjectives and adverbs — decoration that depends on language, '
      + 'which no markdown parser could ever find.',
    enabled: (editor) => editor.interactionMode === 'edit',
    pressed: (editor) => extensionFor(editor, 'pos', PartsOfSpeech).enabled,
    run: (editor) => extensionFor(editor, 'pos', PartsOfSpeech).toggle(),
  },
];
