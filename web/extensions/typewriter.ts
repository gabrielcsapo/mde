// Typewriter (focus) mode — an extension, not a feature of the editor.
//
// Nothing in `web/src/` knows this file exists. The extension watches the editor's
// public selection/line model and marks only the active paragraph. CSS dims the other
// line containers in one compositing operation. A generic full-document decoration
// layer was semantically elegant but forced every line's DOM to be rebuilt whenever
// the caret moved — more than a second on an otherwise responsive 100 KB document.

import type { MarkdownEditor } from '../src/editor.js';

/** The paragraph containing `offset`, as `[start, end)` over the whole document. */
function paragraphAround(text: string, offset: number): [number, number] {
  const at = Math.max(0, Math.min(offset, text.length));

  // A blank line is the boundary, matching how the core segments blocks. Falling back
  // to the single line would make the mode flicker paragraph-by-paragraph as the caret
  // crosses a soft wrap, which reads as noise rather than focus.
  let start = at === 0 ? 0 : text.lastIndexOf('\n', at - 1) + 1;
  while (start > 0) {
    const previousEnd = start - 1;
    const previousStart = text.lastIndexOf('\n', previousEnd - 1) + 1;
    if (text.slice(previousStart, previousEnd).trim() === '') break;
    // Move to the previous line, not back to the current line's start. The old scan
    // reassigned `start` to itself here and looped forever whenever the caret sat on
    // the second or later line of a non-blank paragraph.
    start = previousStart;
  }

  let end = text.indexOf('\n', at);
  if (end === -1) end = text.length;
  while (end < text.length) {
    const nextStart = end + 1;
    let nextEnd = text.indexOf('\n', nextStart);
    if (nextEnd === -1) nextEnd = text.length;
    if (text.slice(nextStart, nextEnd).trim() === '') break;
    end = nextEnd;
  }

  return [start, Math.max(start, end)];
}

export class TypewriterMode {
  editor: MarkdownEditor;
  enabled: boolean;
  focusedLines: HTMLElement[];
  onChange: () => void;
  onSelection: () => void;

  /** @param {import('../src/editor.js').MarkdownEditor} editor */
  constructor(editor: MarkdownEditor) {
    this.editor = editor;
    this.enabled = false;
    this.focusedLines = [];

    this.onChange = () => this.recompute();
    this.onSelection = () => this.recompute();
  }

  toggle() {
    if (this.enabled) this.disable();
    else this.enable();
    return this.enabled;
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.editor.addEventListener('selectionchange', this.onSelection);
    // Editing moves the paragraph boundaries under the caret, so text changes matter
    // as much as caret moves.
    this.editor.addEventListener('change', this.onChange);
    this.recompute();
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.editor.removeEventListener('selectionchange', this.onSelection);
    this.editor.removeEventListener('change', this.onChange);
    this.clearFocus();
  }

  recompute() {
    if (!this.enabled) return;
    const text = this.editor.markdown;
    const sel = this.editor.selectionRange();

    // No caret means no focus. Dimming the entire document because the editor lost
    // focus would be a strange thing to look at, so the visual state empties instead.
    if (!sel) {
      this.clearFocus();
      return;
    }

    const [start, end] = paragraphAround(text, sel.start);
    this.clearFocus();
    const first = this.editor.lineIndexAt(start, this.editor.lineStarts);
    const last = this.editor.lineIndexAt(end, this.editor.lineStarts);
    this.focusedLines = this.editor.lineEls.slice(first, last + 1);
    this.editor.root.classList.add('mde-typewriter-active');
    for (const line of this.focusedLines) line.classList.add('mde-typewriter-focus');
  }

  private clearFocus() {
    for (const line of this.focusedLines) line.classList.remove('mde-typewriter-focus');
    this.focusedLines = [];
    this.editor.root.classList.remove('mde-typewriter-active');
  }
}
