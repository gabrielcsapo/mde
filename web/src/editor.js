// The contenteditable host. The web counterpart of `MarkdownTextView`.
//
// CodeMirror was deliberately not used: it is a framework layered *above* the browser's
// text engine with its own decoration and transaction model, so building against it and
// TextKit 2 would translate this protocol into two foreign vocabularies and let the
// semantics drift (DESIGN §7). This sits at the same level as TextKit 2 — the browser
// supplies IME, spellcheck, accessibility and touch selection; we supply decoration
// application and replaced elements.

import { DomApplier, IGNORE_ATTR } from './applier.js';
import { Kind } from './core.js';
import { ResourceCache } from './resources.js';

/**
 * Walk the document text, skipping presentation-only subtrees.
 *
 * This is the invariant the whole host rests on: **the DOM's text, excluding
 * `data-mde-ignore` subtrees, is exactly the markdown source**. Widget views are marked
 * ignored so a chip reading "@gabe" does not smuggle its label into the document.
 *
 * @param {HTMLElement} root
 * @returns {Text[]}
 */
function textNodes(root) {
  /** @type {Text[]} */
  const out = [];
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          return /** @type {Element} */ (node).hasAttribute(IGNORE_ATTR)
            ? NodeFilter.FILTER_REJECT // skips the whole subtree
            : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );
  let node;
  while ((node = walker.nextNode())) out.push(/** @type {Text} */ (node));
  return out;
}

/** @param {HTMLElement} root */
function documentText(root) {
  let text = '';
  for (const node of textNodes(root)) text += node.data;
  return text;
}

const isHighSurrogate = (/** @type {number} */ c) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (/** @type {number} */ c) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Reduce two versions of the document to the single replacement between them.
 *
 * The browser has already mutated the DOM by the time `input` fires, and it does not
 * tell us what it did in a form we can trust across IME, autocorrect, paste and drag.
 * A common-prefix/suffix diff recovers the edit uniformly from all of them.
 *
 * @param {string} oldText
 * @param {string} newText
 */
export function diffText(oldText, newText) {
  let start = 0;
  const maxStart = Math.min(oldText.length, newText.length);
  while (start < maxStart && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
    start++;
  }
  // Never cut a surrogate pair in half.
  if (start > 0 && isHighSurrogate(oldText.charCodeAt(start - 1))) start--;

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }
  if (oldEnd < oldText.length && isLowSurrogate(oldText.charCodeAt(oldEnd))) {
    oldEnd++;
    newEnd++;
  }
  return { start, end: oldEnd, text: newText.slice(start, newEnd) };
}

export class MarkdownEditor extends EventTarget {
  /**
   * @param {HTMLElement} host
   * @param {import('./core.js').Engine} engine
   * @param {{widgetProvider?: import('./widgets.js').WidgetProvider,
   *          resourceResolver?: import('./resources.js').ResourceResolver}} [options]
   */
  constructor(host, engine, options = {}) {
    super();
    this.engine = engine;
    this.applier = new DomApplier(engine);
    this.applier.widgetProvider = options.widgetProvider ?? null;
    this.applier.resources = new ResourceCache(options.resourceResolver ?? null, (ref) =>
      this.repaintReferencing(ref)
    );

    this.root = host;
    this.rootHadEditorClass = this.root.classList.contains('mde-editor');
    this.previousContentEditable = this.root.getAttribute('contenteditable');
    this.root.classList.add('mde-editor');
    // `plaintext-only` keeps the browser from inventing block structure on Enter: it
    // inserts a real newline character, which is what the document actually contains.
    this.root.setAttribute('contenteditable', 'plaintext-only');
    // These defaults make the framework-free editor usable on its own while preserving
    // any host-supplied accessible name or spellcheck preference. React applies DOM
    // props before its mount effect constructs us, so component props win here too.
    this.defaultAttributes = [];
    for (const [name, value] of [
      ['role', 'textbox'],
      ['aria-multiline', 'true'],
      ['aria-label', 'Markdown editor'],
      ['spellcheck', 'true'],
    ]) {
      if (!this.root.hasAttribute(name)) {
        this.root.setAttribute(name, value);
        this.defaultAttributes.push(name);
      }
    }

    /** Authoritative only as a mirror of the DOM; the DOM is the buffer. */
    this.text = '';
    /** @type {string[]} */
    this.lines = [];
    /** @type {HTMLElement[]} */
    this.lineEls = [];

    /** Guards the selection restore from re-entering as a user selection change. */
    this.suppressSelection = false;

    // Before the browser mutates anything — see `onBeforeInput` for why newline input
    // cannot be left to `plaintext-only`.
    // One controller owns every listener, including those on `root`. A destroyed editor
    // can leave its host element in the page and a new editor can reuse it; anonymous
    // listeners that merely wait for the element to disappear would make both engines
    // process every later keystroke.
    this.events = new AbortController();
    const listener = { signal: this.events.signal };
    this.root.addEventListener('beforeinput', (e) => this.onBeforeInput(e), listener);
    this.root.addEventListener('input', () => this.onInput(), listener);
    this.root.addEventListener('focus', () => this.onSelectionChange(), listener);
    this.root.addEventListener(
      'blur',
      () => this.applyPatch(this.engine.setSelection(null)),
      listener
    );
    this.root.addEventListener('click', (e) => this.onClick(e), listener);
    // Before the browser gets to place a caret — see `onMouseDown`.
    this.root.addEventListener('mousedown', (e) => this.onMouseDown(e), listener);

    // This is the only listener that is not on `root`: `selectionchange` fires on the
    // document, so it outlives the element and would keep a detached editor alive. The
    // shared abort signal removes it together with the element listeners.
    this.onDocumentSelectionChange = () => {
      if (document.activeElement === this.root) this.onSelectionChange();
    };
    document.addEventListener('selectionchange', this.onDocumentSelectionChange, listener);
    this.destroyed = false;
  }

  /**
   * Detach from the DOM and stop listening.
   *
   * Required by any host that mounts and unmounts — a React component under
   * `StrictMode` mounts twice on purpose, and without this the first editor stays
   * subscribed to input and selection events forever, reacting to a host it no longer
   * renders. This also makes it safe to construct another editor on the same element.
   *
   * The engine is *not* freed here: the caller constructed it and may outlive the view
   * or hand it to another one.
   */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.events.abort();
    this.applier.reset();
    if (this.previousContentEditable === null) this.root.removeAttribute('contenteditable');
    else this.root.setAttribute('contenteditable', this.previousContentEditable);
    for (const name of this.defaultAttributes) this.root.removeAttribute(name);
    if (!this.rootHadEditorClass) this.root.classList.remove('mde-editor');
    this.root.replaceChildren();
  }

  // MARK: - Document

  /** @param {string} text */
  setMarkdown(text) {
    this.text = text;
    this.applier.reset();
    this.applier.ingest(this.engine.reset(text));
    this.renderAll();
    this.dispatchEvent(new CustomEvent('change'));
  }

  get markdown() {
    return this.text;
  }

  /**
   * Sizes of resources that have already resolved, keyed by reference.
   *
   * Persist these and set them back on the next load. `reservedSize` is otherwise a
   * guess, and a wrong guess shifts the document once when the resource lands; seeding
   * known sizes means that shift happens at most once per asset ever.
   */
  get resourceSizes() {
    return this.applier.resources?.sizes() ?? {};
  }

  set resourceSizes(sizes) {
    this.applier.resources?.remember(sizes);
  }

  // MARK: - Host decoration layers (DESIGN §5.3)

  /**
   * Replace a named layer's decorations and repaint what changed.
   *
   * This is the seam an extension builds on. The editor knows nothing about *why* a
   * range matters — only that the host wants it decorated with a role the theme can
   * style. Focus mode and the parts-of-speech highlighter are both written entirely
   * against this method and are not part of the editor at all.
   *
   * @param {string} name
   * @param {{start: number, end: number, role: number, kind?: number, depth?: number}[]} spans
   */
  setLayer(name, spans) {
    this.applyPatch(this.engine.setLayer(name, spans));
  }

  /** @param {string} name */
  clearLayer(name) {
    this.applyPatch(this.engine.clearLayer(name));
  }

  /**
   * Get (or create) a role id for a name, so an extension can decorate with roles no
   * manifest declared. The theme styles them by name.
   * @param {string} name
   */
  internRole(name) {
    return this.engine.internRole(name);
  }

  /** Every decoration currently in effect, reveal already applied. */
  get decorations() {
    return [...this.applier.live.values()].sort((a, b) => a.start - b.start);
  }

  // MARK: - Undo

  get canUndo() {
    return this.engine.canUndo;
  }

  get canRedo() {
    return this.engine.canRedo;
  }

  undo() {
    return this.rewind(this.engine.undo());
  }

  redo() {
    return this.rewind(this.engine.redo());
  }

  // MARK: - Browsable history (DESIGN §9)

  /**
   * The whole timeline, oldest first, including revisions that have been undone.
   * Each entry carries a timestamp and what it did, which is enough for a panel to
   * label it without the core guessing at intent.
   */
  get revisions() {
    return this.engine.revisions();
  }

  /** How many revisions are applied — the caret's position in the timeline. */
  get historyPosition() {
    return this.engine.historyPosition;
  }

  /**
   * Move to any point in the timeline. Undo and redo are the two-button view of this.
   * @param {number} target
   */
  jumpTo(target) {
    return this.rewind(this.engine.jumpTo(target));
  }

  /** Force the next edit to start a new undo step. */
  closeUndoGroup() {
    this.engine.boundary();
  }

  /** @param {ReturnType<import('./core.js').Engine['undo']>} rewind */
  rewind(rewind) {
    if (!rewind) return false;
    // Apply back-to-front so earlier offsets stay valid, matching the core.
    let text = this.text;
    for (const e of [...rewind.edits].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, e.start) + e.text + text.slice(e.end);
    }
    this.text = text;
    this.applier.ingest(rewind.patch);
    this.renderAll();
    if (rewind.selection) this.setSelectionRange(rewind.selection);
    this.dispatchEvent(new CustomEvent('change'));
    return true;
  }

  // MARK: - Input

  /**
   * Take over any input that inserts a newline, before the browser acts.
   *
   * `contenteditable="plaintext-only"` promises plain text, and for characters it
   * delivers — but Enter is not a character to Chrome. At the end of the document it
   * inserts a `<div><br></div>` whose text content is *empty*, and it will wrap
   * existing line elements inside that div. The tree walk sees no new text, so the
   * engine never learns about the newline; the caret then lives in an element the
   * editor does not track, and every subsequent keystroke compounds the divergence —
   * one fossil copy of the line per keypress.
   *
   * So anything newline-shaped is cancelled here and routed through `replaceRange`,
   * which inserts a real `\n` through the engine and rebuilds the affected lines. Real
   * keyboards fire `insertParagraph` (Enter) and `insertLineBreak` (Shift+Enter); IME
   * confirm and paste arrive as `insertText`/`insertFromPaste` with the text attached.
   * Single-line input stays with the browser, which handles it correctly.
   *
   * @param {InputEvent} e
   */
  onBeforeInput(e) {
    let text = null;
    switch (e.inputType) {
      case 'insertParagraph':
      case 'insertLineBreak':
        text = '\n';
        break;
      case 'insertText':
        if (e.data != null && e.data.includes('\n')) text = e.data;
        break;
      case 'insertFromPaste':
      case 'insertFromDrop': {
        const plain = e.dataTransfer?.getData('text/plain');
        if (plain && /[\r\n]/.test(plain)) text = plain;
        break;
      }
      default:
        return;
    }
    if (text == null) return;

    e.preventDefault();
    const sel = this.selectionRange();
    if (!sel) return;
    // Clipboards from other platforms carry CRLF; the document speaks \n only.
    this.replaceRange(sel.start, sel.end, text.replace(/\r\n?/g, '\n'));
  }

  onInput() {
    const next = documentText(this.root);
    if (next === this.text) {
      // The text is unchanged but the DOM may not be canonical: an input type that
      // slipped past `onBeforeInput` (nothing fires `beforeinput` for `execCommand`,
      // for instance) can leave browser-made elements that contribute no text — and a
      // caret parked inside one is invisible to the tree walk. Rebuild to the canonical
      // shape rather than diverging silently on the next keystroke.
      if (!this.domIsCanonical()) {
        const caret = this.selectionRange();
        this.renderAll();
        if (caret) this.setSelectionRange(caret);
      }
      return;
    }

    const edit = diffText(this.text, next);
    const caret = this.selectionRange();
    this.text = next;

    const canonical = this.domIsCanonical();
    try {
      const patch = this.engine.edit(edit.start, edit.end, edit.text, next.length);
      if (canonical) {
        this.applyPatch(patch, { start: edit.start, end: edit.start + edit.text.length }, caret);
      } else {
        // Splicing individual lines assumes the DOM still has the shape the editor
        // built. When the browser has restructured it, rebuild wholesale instead —
        // renderRange would target elements that are no longer where it thinks.
        this.applier.ingest(patch);
        this.renderAll();
        if (caret) this.setSelectionRange(caret);
      }
    } catch (error) {
      if (!(/** @type {any} */ (error).isDesync)) throw error;
      // The mirror drifted. Resync from the authoritative buffer rather than rendering
      // decorations computed from a document that no longer exists.
      this.applier.reset();
      this.applier.ingest(this.engine.reset(next));
      this.renderAll();
      if (caret) this.setSelectionRange(caret);
    }
    this.dispatchEvent(new CustomEvent('change'));
  }

  /**
   * True while every child of the root is a line element the editor built, in order.
   * The browser breaks this by wrapping lines in divs or inserting its own elements.
   */
  domIsCanonical() {
    const children = this.root.children;
    if (children.length !== this.lineEls.length) return false;
    for (let i = 0; i < this.lineEls.length; i++) {
      if (children[i] !== this.lineEls[i]) return false;
    }
    return true;
  }

  onSelectionChange() {
    if (this.suppressSelection) return;
    const range = this.selectionRange();
    this.applyPatch(this.engine.setSelection(range), null, range);
    // Hosts that decorate from the caret's position — a focus mode, a live outline —
    // recompute here and push a layer (DESIGN §5.3).
    this.dispatchEvent(new CustomEvent('selectionchange', { detail: { range } }));
  }

  /**
   * Place the caret in a widget's source when the widget itself is clicked.
   *
   * This cannot be left to the browser. The source a widget stands for is concealed to
   * a hairline, so it has almost no geometry: clicking anywhere in a tall block widget
   * maps to the nearest *real* text position, which is the line below it, and clicking
   * a chip lands on an arbitrary offset inside the token rather than where the pointer
   * was. Either way the widget looks unclickable or the caret jumps somewhere the user
   * did not point at.
   *
   * So the click is claimed here and the caret goes to the start of the source, which
   * reveals it (per its reveal policy) and leaves the now-visible text available to
   * click precisely.
   *
   * @param {MouseEvent} event
   */
  onMouseDown(event) {
    const target = /** @type {Element|null} */ (event.target);
    const wrap = target?.closest?.('.mde-widget');
    if (!wrap || !this.root.contains(wrap)) return;

    const key = wrap.getAttribute('data-mde-key');
    let decoration = null;
    for (const d of this.applier.live.values()) {
      if (String(d.key) === key) {
        decoration = d;
        break;
      }
    }
    if (!decoration) return;

    event.preventDefault();
    this.root.focus();
    const at = { start: decoration.start, end: decoration.start };
    this.setSelectionRange(at);
    this.applyPatch(this.engine.setSelection(at), null, at);
  }

  /** @param {MouseEvent} event */
  onClick(event) {
    const range = this.selectionRange();
    if (!range) return;
    const hit = this.applier.hit(range.start);
    if (!hit) return;
    const source = this.text.slice(hit.start, hit.end);
    this.dispatchEvent(new CustomEvent('hit', { detail: { decoration: hit, source } }));
  }

  /**
   * Toggle a `- [ ]` / `- [x]` checkbox. Goes through the normal edit path, so it lands
   * in the undo history as its own step.
   * @param {import('./core.js').Decoration} decoration
   */
  toggleTask(decoration) {
    const current = this.text.slice(decoration.start, decoration.end);
    const replacement = current.includes('x') ? '[ ]' : '[x]';
    this.engine.boundary();
    this.replaceRange(decoration.start, decoration.end, replacement);
    this.engine.boundary();
  }

  /**
   * Programmatic edit: goes through the same path a keystroke does, so it is recorded
   * in the history and repainted identically.
   * @param {number} start @param {number} end @param {string} text
   */
  replaceRange(start, end, text) {
    const next = this.text.slice(0, start) + text + this.text.slice(end);
    this.text = next;
    const patch = this.engine.edit(start, end, text, next.length);
    this.applyPatch(patch, { start, end: start + text.length }, {
      start: start + text.length,
      end: start + text.length,
    });
    this.dispatchEvent(new CustomEvent('change'));
  }

  // MARK: - Rendering

  /**
   * @param {import('./core.js').Patch} patch
   * @param {{start: number, end: number}|null} [alsoDirty]
   * @param {{start: number, end: number}|null} [caret]
   */
  applyPatch(patch, alsoDirty = null, caret = null) {
    // Disjoint ranges, not a bounding box: see `dirtyRanges`.
    const dirty = this.applier.dirtyRanges(patch, alsoDirty);
    this.applier.ingest(patch);
    if (dirty.length === 0) return;
    // Restore a selection only while this editor actually holds focus. Blur produces a
    // patch too — the reveal collapses — and re-rendering those lines used to put back
    // the selection read *before* focus left. `Selection.addRange` inside a
    // contenteditable focuses that element, so clicking from the editor into any other
    // input (or a second editor) bounced focus straight back.
    const at =
      caret ?? (document.activeElement === this.root ? this.selectionRange() : null);
    // Back to front, so an earlier range's line indices stay valid while the later ones
    // are still pending.
    for (let i = dirty.length - 1; i >= 0; i--) this.renderRange(dirty[i], at);
  }

  renderAll() {
    this.applier.text = this.text;
    this.lines = this.text.split('\n');
    this.lineEls = [];
    const starts = lineStarts(this.lines);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < this.lines.length; i++) {
      const el = this.applier.buildLine(starts[i], this.lineEnd(i, this.lines, starts));
      this.lineEls.push(el);
      frag.appendChild(el);
    }
    this.root.replaceChildren(frag);
  }

  /** Exclusive end of a line, including its trailing newline when it has one. */
  /** @param {number} i @param {string[]} lines @param {number[]} starts */
  lineEnd(i, lines, starts) {
    return starts[i] + lines[i].length + (i < lines.length - 1 ? 1 : 0);
  }

  /**
   * Re-render only the lines the change touched.
   *
   * Typing inside a paragraph rebuilds one line. Lines after an inserted newline are
   * spliced rather than rebuilt, since their text and decorations are unchanged — the
   * DOM equivalent of the `moved`-does-not-repaint rule.
   *
   * @param {{start: number, end: number}} dirty absolute offsets in the new text
   * @param {{start: number, end: number}|null} caret
   */
  renderRange(dirty, caret) {
    this.applier.text = this.text;
    const newLines = this.text.split('\n');

    // Widen the dirty offsets to whole lines, then to whole *changed* lines by
    // comparing old and new from both ends.
    let first = this.lineIndexAt(dirty.start, newLines);
    let lastNew = this.lineIndexAt(dirty.end, newLines);
    let lastOld = lastNew + (this.lines.length - newLines.length);

    const commonHead = Math.min(first, this.lines.length, newLines.length);
    for (let i = 0; i < commonHead; i++) {
      if (this.lines[i] !== newLines[i]) {
        first = i;
        break;
      }
    }
    while (
      lastOld < this.lines.length &&
      lastNew < newLines.length &&
      this.lines[lastOld] !== newLines[lastNew]
    ) {
      lastOld++;
      lastNew++;
    }
    lastOld = Math.min(lastOld, this.lines.length - 1);
    lastNew = Math.min(lastNew, newLines.length - 1);

    const starts = lineStarts(newLines);
    /** @type {HTMLElement[]} */
    const rebuilt = [];
    for (let i = first; i <= lastNew; i++) {
      rebuilt.push(this.applier.buildLine(starts[i], this.lineEnd(i, newLines, starts)));
    }

    const removeCount = Math.max(0, lastOld - first + 1);
    // Anchor on the first element *after* the replaced range: anchoring on the range's
    // own first element would leave `insertBefore` holding a node we just removed.
    const anchor = this.lineEls[lastOld + 1] ?? null;
    for (let i = 0; i < removeCount; i++) this.lineEls[first + i]?.remove();
    for (const el of rebuilt) this.root.insertBefore(el, anchor);

    this.lineEls.splice(first, removeCount, ...rebuilt);
    this.lines = newLines;

    if (caret) this.setSelectionRange(caret);
  }

  /** A resource resolved: repaint only the lines that reference it. */
  /** @param {string} reference */
  repaintReferencing(reference) {
    const ranges = this.applier.rangesReferencing(reference);
    if (ranges.length === 0) return;
    const caret = this.selectionRange();
    for (const r of ranges) this.renderRange(r, caret);
  }

  /** @param {number} offset @param {string[]} lines */
  lineIndexAt(offset, lines) {
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      acc += lines[i].length + 1;
      if (offset < acc) return i;
    }
    return Math.max(0, lines.length - 1);
  }

  // MARK: - Selection

  /** @returns {{start: number, end: number}|null} */
  selectionRange() {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!this.root.contains(range.startContainer)) return null;

    const nodes = textNodes(this.root);
    const start = this.offsetAt(range.startContainer, range.startOffset, nodes);
    const end = this.offsetAt(range.endContainer, range.endOffset, nodes) ?? start;
    return start === null ? null : { start, end };
  }

  /**
   * Map one DOM boundary point to a document offset.
   *
   * A boundary is not always inside a text node. Click below the last line, press End,
   * or land after a widget and the browser anchors the caret at *(element, childIndex)*
   * — the root itself, or a line span. The old mapping only recognised text nodes, so
   * those carets read as "no selection", and anything keyed off the selection (Enter
   * interception above all) silently did nothing exactly where typing usually starts.
   *
   * Element anchors are resolved by summing the text nodes that lie before the point,
   * which handles every shape the browser produces with one rule.
   *
   * @param {Node} container @param {number} boundary @param {Text[]} nodes
   * @returns {number|null}
   */
  offsetAt(container, boundary, nodes) {
    if (container.nodeType === Node.TEXT_NODE) {
      let offset = 0;
      for (const node of nodes) {
        if (node === container) return offset + boundary;
        offset += node.data.length;
      }
      // A text node inside a widget view: ignored subtrees carry no document text, so
      // the nearest honest answer is "no mappable selection".
      return null;
    }

    const probe = document.createRange();
    try {
      probe.setStart(container, Math.min(boundary, container.childNodes.length));
    } catch {
      return null;
    }
    let offset = 0;
    for (const node of nodes) {
      // A node wholly at or before the point contributes all of its text.
      if (probe.comparePoint(node, node.data.length) <= 0) {
        offset += node.data.length;
      } else {
        break;
      }
    }
    return offset;
  }

  /** @param {{start: number, end: number}} range */
  setSelectionRange(range) {
    const nodes = textNodes(this.root);
    /** @param {number} target */
    const locate = (target) => {
      let offset = 0;
      for (const node of nodes) {
        const next = offset + node.data.length;
        if (target <= next) return { node, offset: Math.max(0, target - offset) };
        offset = next;
      }
      const last = nodes[nodes.length - 1];
      return last ? { node: last, offset: last.data.length } : null;
    };

    const from = locate(range.start);
    const to = locate(range.end);
    if (!from || !to) return;

    const sel = document.getSelection();
    if (!sel) return;
    // Restoring fires `selectionchange`; without this guard it re-enters as a user
    // selection and repaints in a loop.
    this.suppressSelection = true;
    try {
      const domRange = document.createRange();
      domRange.setStart(from.node, Math.min(from.offset, from.node.data.length));
      domRange.setEnd(to.node, Math.min(to.offset, to.node.data.length));
      sel.removeAllRanges();
      sel.addRange(domRange);
    } finally {
      this.suppressSelection = false;
    }
  }
}

/** @param {string[]} lines */
function lineStarts(lines) {
  const starts = new Array(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    starts[i] = offset;
    offset += lines[i].length + 1;
  }
  return starts;
}

export { documentText, textNodes, Kind };
