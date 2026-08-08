// Typewriter (focus) mode — an extension, not a feature of the editor.
//
// Nothing in `web/src/` knows this file exists. It never touches the DOM, never asks
// how a line is rendered, and never reaches into the applier. All it does is watch the
// caret and push a decoration layer (DESIGN §5.3): the paragraph being worked on gets
// one role, everything else gets another, and the theme decides what those look like.
//
// That is the whole point of the exercise. If the extension system were only the
// declarative manifest — patterns and fences — this could not exist, because what to
// decorate depends on where the caret is, which no parse can know.

/** The paragraph containing `offset`, as `[start, end)` over the whole document. */
function paragraphAround(text, offset) {
  const at = Math.max(0, Math.min(offset, text.length));

  // A blank line is the boundary, matching how the core segments blocks. Falling back
  // to the single line would make the mode flicker paragraph-by-paragraph as the caret
  // crosses a soft wrap, which reads as noise rather than focus.
  let start = at;
  while (start > 0) {
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    if (lineStart === 0) {
      start = 0;
      break;
    }
    const prevStart = text.lastIndexOf('\n', lineStart - 2) + 1;
    if (text.slice(prevStart, lineStart - 1).trim() === '') {
      start = lineStart;
      break;
    }
    start = lineStart;
  }

  let end = at;
  while (end < text.length) {
    let lineEnd = text.indexOf('\n', end);
    if (lineEnd === -1) {
      end = text.length;
      break;
    }
    const nextEnd = text.indexOf('\n', lineEnd + 1);
    const next = text.slice(lineEnd + 1, nextEnd === -1 ? text.length : nextEnd);
    if (next.trim() === '') {
      end = lineEnd;
      break;
    }
    end = lineEnd + 1;
    if (nextEnd === -1) {
      end = text.length;
      break;
    }
  }

  return [start, Math.max(start, end)];
}

export class TypewriterMode {
  static LAYER = 'typewriter';

  /** @param {import('../src/editor.js').MarkdownEditor} editor */
  constructor(editor) {
    this.editor = editor;
    this.enabled = false;
    this.focusRole = editor.internRole('typewriter-focus');
    this.dimRole = editor.internRole('typewriter-dim');

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
    // `clearLayer`, not an empty push: the layer should stop occupying a paint slot.
    this.editor.clearLayer(TypewriterMode.LAYER);
  }

  recompute() {
    if (!this.enabled) return;
    const text = this.editor.markdown;
    const sel = this.editor.selectionRange();

    // No caret means no focus. Dimming the entire document because the editor lost
    // focus would be a strange thing to look at, so the layer empties instead.
    if (!sel) {
      this.editor.setLayer(TypewriterMode.LAYER, []);
      return;
    }

    const [start, end] = paragraphAround(text, sel.start);
    const spans = [];
    if (start > 0) spans.push({ start: 0, end: start, role: this.dimRole });
    if (end < text.length) spans.push({ start: end, end: text.length, role: this.dimRole });
    if (end > start) spans.push({ start, end, role: this.focusRole });
    this.editor.setLayer(TypewriterMode.LAYER, spans);
  }
}
