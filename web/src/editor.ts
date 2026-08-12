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
import type { Decoration, Engine, LayerSpan, Patch, Rewind, Revision, SelectionRange } from './core.js';
import { ResourceCache } from './resources.js';
import type { ResourceResolver } from './resources.js';
import type { WidgetProvider } from './widgets.js';
import { pluginLayerName } from './plugins.js';
import type {
  EditorPlugin,
  EditorPluginContext,
  InstalledPlugin,
  PluginAnalysisRun,
} from './plugins.js';
import type { PreparedDocument } from './preparation.js';

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
function textNodes(root: HTMLElement): Text[] {
  /** @type {Text[]} */
  const out = [];
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          return (node as Element).hasAttribute(IGNORE_ATTR)
            ? NodeFilter.FILTER_REJECT // skips the whole subtree
            : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );
  let node;
  while ((node = walker.nextNode())) out.push(node as Text);
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
export function diffText(oldText: string, newText: string): { start: number; end: number; text: string } {
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
  engine: Engine;
  applier: DomApplier;
  root: HTMLElement;
  rootHadEditorClass: boolean;
  previousContentEditable: string | null;
  defaultAttributes: string[];
  text: string;
  lines: string[];
  lineStarts: number[];
  lineEls: Array<HTMLElement | null>;
  chunkEls: HTMLElement[];
  activeChunk: HTMLElement | null;
  suppressSelection: boolean;
  events: AbortController;
  onDocumentSelectionChange: () => void;
  destroyed: boolean;
  private plugins: Map<string, InstalledPlugin>;
  private resourcePriorityFrame: number | null;
  private virtualizationFrame: number | null;
  private virtualizesDocument: boolean;
  private progressiveToken: number;
  private presentationSuspended: boolean;
  /** Diagnostic: chunk geometry reads used by viewport scheduling. */
  viewportLayoutProbeCount: number;

  /**
   * @param {HTMLElement} host
   * @param {import('./core.js').Engine} engine
   * @param {{widgetProvider?: import('./widgets.js').WidgetProvider,
   *          resourceResolver?: import('./resources.js').ResourceResolver}} [options]
   */
  constructor(
    host: HTMLElement,
    engine: Engine,
    options: { widgetProvider?: WidgetProvider; resourceResolver?: ResourceResolver } = {},
  ) {
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
    /** UTF-16 start offset of each rendered line, shared by decoration-only repaints. */
    this.lineStarts = [];
    /** @type {HTMLElement[]} */
    this.lineEls = [];
    /** Layout/paint containment groups. Source text still remains wholly in the DOM. */
    this.chunkEls = [];
    this.activeChunk = null;

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
    this.root.addEventListener('blur', () => {
      this.applyPatch(this.engine.setSelection(null));
      this.activateChunk(null);
    }, listener);
    this.root.addEventListener('click', (e) => this.onClick(e), listener);
    // Before the browser gets to place a caret — see `onMouseDown`.
    this.root.addEventListener('mousedown', (e) => this.onMouseDown(e), listener);
    this.resourcePriorityFrame = null;
    this.virtualizationFrame = null;
    this.virtualizesDocument = false;
    this.progressiveToken = 0;
    this.presentationSuspended = false;
    this.viewportLayoutProbeCount = 0;
    this.root.addEventListener('scroll', () => {
      this.scheduleResourcePriorities();
      this.scheduleVirtualization();
    }, listener);

    // This is the only listener that is not on `root`: `selectionchange` fires on the
    // document, so it outlives the element and would keep a detached editor alive. The
    // shared abort signal removes it together with the element listeners.
    this.onDocumentSelectionChange = () => {
      if (document.activeElement === this.root) this.onSelectionChange();
    };
    document.addEventListener('selectionchange', this.onDocumentSelectionChange, listener);
    this.plugins = new Map();
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
    for (const name of [...this.plugins.keys()].reverse()) {
      try {
        this.removePlugin(name);
      } catch (error) {
        // Teardown must continue so listeners, layers, and the DOM are never leaked.
        console.error(`Plugin "${name}" failed during cleanup`, error);
      }
    }
    this.events.abort();
    if (this.resourcePriorityFrame !== null) cancelAnimationFrame(this.resourcePriorityFrame);
    if (this.virtualizationFrame !== null) cancelAnimationFrame(this.virtualizationFrame);
    this.applier.reset();
    if (this.previousContentEditable === null) this.root.removeAttribute('contenteditable');
    else this.root.setAttribute('contenteditable', this.previousContentEditable);
    for (const name of this.defaultAttributes) this.root.removeAttribute(name);
    if (!this.rootHadEditorClass) this.root.classList.remove('mde-editor');
    this.root.replaceChildren();
  }

  /** Pause speculative rendering and resource work while a host app is backgrounded. */
  suspend(): void {
    if (this.destroyed || this.presentationSuspended) return;
    this.presentationSuspended = true;
    if (this.resourcePriorityFrame !== null) cancelAnimationFrame(this.resourcePriorityFrame);
    if (this.virtualizationFrame !== null) cancelAnimationFrame(this.virtualizationFrame);
    this.resourcePriorityFrame = null;
    this.virtualizationFrame = null;
    this.applier.resources?.suspend();
    this.root.dataset.mdeSuspended = '';
  }

  /** Resume the current source without reparsing it or rebuilding the engine. */
  resume(): void {
    if (this.destroyed || !this.presentationSuspended) return;
    this.presentationSuspended = false;
    this.applier.resources?.resume();
    delete this.root.dataset.mdeSuspended;
    this.renderAll(true);
  }

  // MARK: - Document

  /** @param {string} text */
  setMarkdown(text: string): void {
    this.progressiveToken++;
    this.root.setAttribute('contenteditable', 'plaintext-only');
    this.root.removeAttribute('aria-busy');
    delete this.root.dataset.mdeStatus;
    this.text = text;
    this.applier.reset();
    this.applier.ingest(this.engine.reset(text));
    this.renderAll();
    this.dispatchEvent(new CustomEvent('change'));
  }

  /**
   * Present the exact source immediately, then atomically install worker-prepared
   * engine state. The source projection is read-only until activation, so a keystroke
   * can never race an engine that still describes the previous document.
   */
  async setMarkdownProgressively(
    text: string,
    prepared: PreparedDocument | Promise<PreparedDocument>,
  ): Promise<boolean> {
    const token = ++this.progressiveToken;
    this.text = text;
    this.applier.reset();
    this.lines = text.split('\n');
    this.lineStarts = lineStarts(this.lines);
    this.lineEls = new Array(this.lines.length).fill(null);
    this.chunkEls = [];
    this.activeChunk = null;
    this.virtualizesDocument = this.lines.length > 64;
    const fragment = document.createDocumentFragment();
    for (let first = 0; first < this.lines.length; first += 64) {
      const last = Math.min(this.lines.length - 1, first + 63);
      const projection = this.makeViewportChunk(this.virtualizesDocument);
      projection.classList.add('mde-progressive-source', 'mde-chunk-virtual');
      projection.dataset.mdeChunk = String(this.chunkEls.length);
      projection.appendChild(document.createTextNode(text.slice(
        this.lineStarts[first], this.lineEnd(last, this.lines, this.lineStarts),
      )));
      this.chunkEls.push(projection);
      fragment.appendChild(projection);
    }
    this.root.replaceChildren(fragment);
    this.root.setAttribute('contenteditable', 'false');
    this.root.setAttribute('aria-busy', 'true');
    this.root.dataset.mdeStatus = 'preparing';
    this.dispatchEvent(new CustomEvent('progress', { detail: { phase: 'source' } }));

    let result: PreparedDocument;
    try {
      result = await prepared;
      if (token !== this.progressiveToken || this.destroyed) return false;
      if (result.markdown !== text) throw new Error('Prepared document does not match the requested Markdown');
      this.applier.ingest(this.engine.restoreSnapshot(result.snapshot));
      this.applier.text = text;
      this.root.setAttribute('contenteditable', 'plaintext-only');
      this.root.removeAttribute('aria-busy');
      delete this.root.dataset.mdeStatus;
      this.renderAll();
      this.dispatchEvent(new CustomEvent('progress', {
        detail: { phase: 'ready', preparationMs: result.durationMs },
      }));
      this.dispatchEvent(new CustomEvent('change'));
      return true;
    } catch (error) {
      if (token !== this.progressiveToken || this.destroyed) return false;
      this.root.setAttribute('contenteditable', 'plaintext-only');
      this.root.removeAttribute('aria-busy');
      delete this.root.dataset.mdeStatus;
      throw error;
    }
  }

  /** Capture a detached, resource-task-free presentation for bounded session reuse. */
  captureProjection(): EditorProjectionSnapshot {
    return {
      markdown: this.text,
      html: this.root.innerHTML,
      lines: [...this.lines],
      lineStarts: [...this.lineStarts],
    };
  }

  /** Restore a recent document without rebuilding every styled run from decorations. */
  restoreProjection(snapshot: EditorProjectionSnapshot): boolean {
    if (snapshot.markdown.length === 0 && snapshot.lines.length === 0) return false;
    this.text = snapshot.markdown;
    this.applier.reset();
    this.applier.ingest(this.engine.reset(snapshot.markdown));
    this.applier.text = snapshot.markdown;
    this.lines = [...snapshot.lines];
    this.lineStarts = [...snapshot.lineStarts];
    this.root.innerHTML = snapshot.html;
    this.chunkEls = Array.from(this.root.children) as HTMLElement[];
    this.lineEls = new Array(this.lines.length).fill(null);
    for (let chunkIndex = 0; chunkIndex < this.chunkEls.length; chunkIndex++) {
      const chunk = this.chunkEls[chunkIndex];
      if (chunk.classList.contains('mde-chunk-virtual')) continue;
      let line = chunkIndex * 64;
      for (const child of chunk.children) this.lineEls[line++] = child as HTMLElement;
    }
    this.virtualizesDocument = this.lines.length > 2048;
    this.activeChunk = null;
    this.scheduleResourcePriorities();
    this.scheduleVirtualization();
    this.dispatchEvent(new CustomEvent('change'));
    return true;
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

  set resourceSizes(sizes: Record<string, { width: number; height: number }>) {
    this.applier.resources?.remember(sizes);
  }

  // MARK: - Host decoration layers (DESIGN §5.3)

  /** Install a plugin once for this editor. Duplicate names are rejected. */
  installPlugin(plugin: EditorPlugin): void {
    if (this.destroyed) throw new Error('Cannot install a plugin on a destroyed editor');
    const name = plugin.name.trim();
    if (!name) throw new Error('A plugin name must not be empty');
    if (this.plugins.has(name)) throw new Error(`Plugin "${name}" is already installed`);

    const controller = new AbortController();
    const installed: InstalledPlugin = {
      plugin,
      controller,
      layers: new Set(),
      analyses: new Map(),
      analysisSequence: 0,
    };
    const cancelAnalysis = (task: string) => {
      const canonical = task.trim();
      const run = installed.analyses.get(canonical);
      if (!run) return;
      installed.analyses.delete(canonical);
      if (run.timer !== null) window.clearTimeout(run.timer);
      run.controller.abort();
      run.diagnosticPublished = true;
      this.dispatchEvent(new CustomEvent('plugindiagnostic', {
        detail: {
          plugin: name,
          task: canonical,
          sequence: run.sequence,
          durationMs: 0,
          budgetMs: 0,
          overBudget: false,
          cancelled: true,
        },
      }));
    };
    const context: EditorPluginContext = {
      editor: this,
      signal: controller.signal,
      name,
      internRole: (role) => controller.signal.aborted ? -1 : this.internRole(role),
      setLayer: (local, spans) => {
        if (controller.signal.aborted) return;
        const layer = pluginLayerName(name, local);
        installed.layers.add(layer);
        this.setLayer(layer, spans);
      },
      clearLayer: (local) => {
        if (controller.signal.aborted) return;
        const layer = pluginLayerName(name, local);
        installed.layers.delete(layer);
        this.clearLayer(layer);
      },
      scheduleAnalysis: (task, analyze, apply, options = {}) => {
        if (controller.signal.aborted) return;
        const canonical = task.trim();
        if (!canonical) throw new Error(`Plugin "${name}" used an empty analysis name`);
        cancelAnalysis(canonical);

        const runController = new AbortController();
        const sequence = ++installed.analysisSequence;
        const run: PluginAnalysisRun = {
          controller: runController, timer: null, sequence, diagnosticPublished: false,
        };
        installed.analyses.set(canonical, run);
        const markdown = this.markdown;
        run.timer = window.setTimeout(async () => {
          run.timer = null;
          const started = performance.now();
          let cancelled = false;
          try {
            const result = await analyze({
              markdown,
              signal: runController.signal,
              sequence,
            });
            cancelled = runController.signal.aborted
              || installed.analyses.get(canonical) !== run;
            if (
              runController.signal.aborted
              || installed.analyses.get(canonical) !== run
            ) return;
            installed.analyses.delete(canonical);
            apply(result);
          } catch (error) {
            if (!runController.signal.aborted) {
              const event = new CustomEvent('pluginerror', {
                cancelable: true,
                detail: { plugin: name, task: canonical, error },
              });
              if (this.dispatchEvent(event)) {
                console.error(`Plugin "${name}" analysis "${canonical}" failed`, error);
              }
            }
          } finally {
            const durationMs = performance.now() - started;
            const budgetMs = Math.max(0, options.budgetMs ?? 16);
            if (!run.diagnosticPublished) {
              run.diagnosticPublished = true;
              this.dispatchEvent(new CustomEvent('plugindiagnostic', {
                detail: {
                  plugin: name,
                  task: canonical,
                  sequence,
                  durationMs,
                  budgetMs,
                  overBudget: durationMs > budgetMs,
                  cancelled: cancelled || runController.signal.aborted,
                },
              }));
            }
            if (installed.analyses.get(canonical) === run) {
              installed.analyses.delete(canonical);
            }
          }
        }, Math.max(0, options.delayMs ?? 0));
      },
      cancelAnalysis,
      on: (type, listener) => this.addEventListener(
        type,
        listener as EventListener,
        { signal: controller.signal },
      ),
    };

    // Reserve the name before setup, so a re-entrant install cannot create two owners.
    this.plugins.set(name, installed);
    try {
      const cleanup = plugin.setup(context);
      if (cleanup !== undefined && typeof cleanup !== 'function') {
        throw new TypeError(`Plugin "${name}" setup must return a function or undefined`);
      }
      if (typeof cleanup === 'function') installed.cleanup = cleanup;
    } catch (error) {
      this.plugins.delete(name);
      controller.abort();
      for (const task of [...installed.analyses.keys()]) cancelAnalysis(task);
      for (const layer of installed.layers) this.clearLayer(layer);
      throw error;
    }
  }

  /** Remove a plugin and every listener/layer it registered through its context. */
  removePlugin(name: string): boolean {
    const canonical = name.trim();
    const installed = this.plugins.get(canonical);
    if (!installed) return false;
    this.plugins.delete(canonical);
    installed.controller.abort();
    for (const task of [...installed.analyses.keys()]) {
      const run = installed.analyses.get(task);
      installed.analyses.delete(task);
      if (run?.timer !== null) window.clearTimeout(run.timer);
      run?.controller.abort();
    }

    let cleanupError: unknown;
    try {
      installed.cleanup?.();
    } catch (error) {
      cleanupError = error;
    } finally {
      for (const layer of installed.layers) this.clearLayer(layer);
      installed.layers.clear();
    }
    if (cleanupError !== undefined) throw cleanupError;
    return true;
  }

  /** Installed plugin names, in installation order. */
  get installedPlugins(): string[] {
    return [...this.plugins.keys()];
  }

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
  setLayer(name: string, spans: LayerSpan[]): void {
    this.applyPatch(this.engine.setLayer(name, spans));
  }

  /** @param {string} name */
  clearLayer(name: string): void {
    this.applyPatch(this.engine.clearLayer(name));
  }

  /**
   * Get (or create) a role id for a name, so an extension can decorate with roles no
   * manifest declared. The theme styles them by name.
   * @param {string} name
   */
  internRole(name: string): number {
    return this.engine.internRole(name);
  }

  /** Every decoration currently in effect, reveal already applied. */
  get decorations(): Decoration[] {
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
  get revisions(): Revision[] {
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
  jumpTo(target: number): boolean {
    return this.rewind(this.engine.jumpTo(target));
  }

  /** Force the next edit to start a new undo step. */
  closeUndoGroup() {
    this.engine.boundary();
  }

  /** @param {ReturnType<import('./core.js').Engine['undo']>} rewind */
  rewind(rewind: Rewind | null): boolean {
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
   * Ordinary single-line input stays with the browser. One exception is a structurally
   * empty line: Chrome consumes the following newline when the first character is
   * typed there, so that first character also goes through `replaceRange`.
   *
   * @param {InputEvent} e
   */
  onBeforeInput(e) {
    let text = null;
    let selection = null;
    switch (e.inputType) {
      case 'insertParagraph':
      case 'insertLineBreak':
        text = '\n';
        break;
      case 'insertText':
        if (e.data != null) {
          selection = this.selectionRange();
          const onEmptyLine = selection &&
            selection.start === selection.end &&
            (selection.start === 0 || this.text[selection.start - 1] === '\n') &&
            (selection.start === this.text.length || this.text[selection.start] === '\n');
          if (e.data.includes('\n') || onEmptyLine) text = e.data;
        }
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
    const sel = selection ?? this.selectionRange();
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
    const lineChange = this.spliceLineModel(edit.start, edit.end, edit.text);
    const caret = this.selectionRange();
    this.text = next;

    const canonical = this.domIsCanonical();
    try {
      const patch = this.engine.edit(edit.start, edit.end, edit.text, next.length);
      if (canonical) {
        this.applyPatch(
          patch,
          { start: edit.start, end: edit.start + edit.text.length },
          caret,
          lineChange,
        );
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
    if (this.root.childNodes.length !== this.chunkEls.length) return false;
    let line = 0;
    for (let chunk = 0; chunk < this.chunkEls.length; chunk++) {
      const el = this.chunkEls[chunk];
      if (this.root.childNodes[chunk] !== el) return false;
      if (el.classList.contains('mde-chunk-virtual')) {
        const first = chunk * 64;
        const last = Math.min(this.lines.length - 1, first + 63);
        const source = this.text.slice(
          this.lineStarts[first],
          this.lineEnd(last, this.lines, this.lineStarts),
        );
        if (el.childNodes.length !== 1 || el.textContent !== source) return false;
        line = last + 1;
        continue;
      }
      for (const child of el.children) {
        if (child !== this.lineEls[line++]) return false;
      }
    }
    return line === this.lineEls.length;
  }

  onSelectionChange() {
    if (this.suppressSelection) return;
    const range = this.selectionRange();
    this.activateChunk(range?.start ?? null, range);
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
    if (event.metaKey || event.ctrlKey) {
      const link = this.applier.link(range.start);
      const destination = link ? this.engine.payload(link.key) : null;
      if (link && destination) {
        event.preventDefault();
        this.dispatchEvent(
          new CustomEvent('linkopen', {
            detail: { decoration: link, destination },
          })
        );
        return;
      }
    }
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
  toggleTask(decoration: Decoration): void {
    const current = this.text.slice(decoration.start, decoration.end);
    const replacement = /x/i.test(current) ? '[ ]' : '[x]';
    this.engine.boundary();
    this.replaceRange(decoration.start, decoration.end, replacement);
    this.engine.boundary();
  }

  /**
   * Programmatic edit: goes through the same path a keystroke does, so it is recorded
   * in the history and repainted identically.
   * @param {number} start @param {number} end @param {string} text
   */
  replaceRange(start: number, end: number, text: string): void {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new RangeError('edit offsets must be safe integers');
    }
    if (start < 0 || end < start || end > this.text.length) {
      throw new RangeError(`edit range ${start}..${end} is outside 0..${this.text.length}`);
    }
    // Public offsets are UTF-16, but they must still land between Unicode scalars.
    // JavaScript's slice accepts a boundary between a surrogate pair and creates a
    // lone surrogate; Rust correctly rejects it. Validate before touching either
    // mirror so a bad host call cannot leave the editor half-mutated.
    if (splitsSurrogatePair(this.text, start) || splitsSurrogatePair(this.text, end)) {
      throw new RangeError('edit range splits a UTF-16 surrogate pair');
    }
    const next = this.text.slice(0, start) + text + this.text.slice(end);
    const patch = this.engine.edit(start, end, text, next.length);
    const lineChange = this.spliceLineModel(start, end, text);
    // The core accepted the edit; only now publish the matching JS mirror.
    this.text = next;
    const caret = document.activeElement === this.root
      ? { start: start + text.length, end: start + text.length }
      : null;
    this.applyPatch(patch, { start, end: start + text.length }, caret, lineChange);
    this.dispatchEvent(new CustomEvent('change'));
  }

  // MARK: - Rendering

  /**
   * @param {import('./core.js').Patch} patch
   * @param {{start: number, end: number}|null} [alsoDirty]
   * @param {{start: number, end: number}|null} [caret]
   */
  applyPatch(
    patch: Patch,
    alsoDirty: SelectionRange | null = null,
    caret: SelectionRange | null = null,
    lineChange: LineChange | null = null,
  ): void {
    // Disjoint ranges, not a bounding box: see `dirtyRanges`.
    const dirty = this.applier.dirtyRanges(patch, alsoDirty);
    this.applier.ingest(patch);
    // Restore a selection only while this editor actually holds focus. Blur produces a
    // patch too — the reveal collapses — and re-rendering those lines used to put back
    // the selection read *before* focus left. `Selection.addRange` inside a
    // contenteditable focuses that element, so clicking from the editor into any other
    // input (or a second editor) bounced focus straight back.
    const at =
      caret ?? (document.activeElement === this.root ? this.selectionRange() : null);
    if (lineChange) {
      this.renderLineChange(lineChange, at);
    }
    if (dirty.length === 0) return;
    // Back to front, so an earlier range's line indices stay valid while the later ones
    // are still pending.
    for (let i = dirty.length - 1; i >= 0; i--) {
      const range = dirty[i];
      if (
        lineChange &&
        range.start >= lineChange.newStart &&
        range.end <= lineChange.newEnd
      ) continue;
      this.renderRange(range, at);
    }
  }

  renderAll(reuseLineModel = false) {
    this.applier.text = this.text;
    if (!reuseLineModel) this.lines = this.text.split('\n');
    this.lineEls = [];
    this.chunkEls = [];
    this.activeChunk = null;
    if (!reuseLineModel) this.lineStarts = lineStarts(this.lines);
    this.virtualizesDocument = this.lines.length > 2048;
    const frag = document.createDocumentFragment();
    let chunk: HTMLElement | null = null;
    for (let i = 0; i < this.lines.length; i++) {
      if (i % 64 === 0) {
        chunk = this.makeViewportChunk();
        chunk.dataset.mdeChunk = String(this.chunkEls.length);
        this.chunkEls.push(chunk);
        frag.appendChild(chunk);
      }
      if (this.virtualizesDocument && i >= 128) {
        this.lineEls.push(null);
        if (i % 64 === 0) {
          const last = Math.min(this.lines.length - 1, i + 63);
          chunk!.classList.add('mde-chunk-virtual');
          chunk!.appendChild(document.createTextNode(this.text.slice(
            this.lineStarts[i],
            this.lineEnd(last, this.lines, this.lineStarts),
          )));
        }
        continue;
      }
      const el = this.applier.buildLine(
        this.lineStarts[i],
        this.lineEnd(i, this.lines, this.lineStarts)
      );
      this.lineEls.push(el);
      chunk!.appendChild(el);
    }
    this.root.replaceChildren(frag);
    this.scheduleResourcePriorities();
    this.scheduleVirtualization();
  }

  /** Promote media in and just around the visible containment chunks. */
  scheduleResourcePriorities(): void {
    if (this.presentationSuspended || this.resourcePriorityFrame !== null) return;
    this.resourcePriorityFrame = requestAnimationFrame(() => {
      this.resourcePriorityFrame = null;
      const resources = this.applier.resources;
      if (!resources || this.lineEls.length === 0) return;
      const [firstChunk, lastChunk] = this.viewportChunkWindow();
      const first = Math.max(0, firstChunk * 64);
      const last = Math.min(this.lineEls.length - 1, (lastChunk + 1) * 64 - 1);
      const from = this.lineStarts[first] ?? 0;
      const to = this.lineEnd(last, this.lines, this.lineStarts);
      resources.prioritize(this.applier.referencesInRange(from, to));
    });
  }

  /** A block formatting context the browser may skip when it is outside the viewport. */
  makeViewportChunk(contained = this.lines.length > 128): HTMLElement {
    const chunk = document.createElement('div');
    chunk.className = 'mde-document-chunk';
    // WebKit can misplace a native caret inside a `content-visibility` subtree. Keep
    // short documents on its ordinary editing path; containment only pays for itself
    // once there are multiple offscreen groups anyway.
    if (contained) chunk.classList.add('mde-viewport-chunk');
    return chunk;
  }

  /** Keep the chunk containing the native caret out of layout skipping. */
  activateChunk(offset: number | null, preserve: SelectionRange | null = null): void {
    if (offset !== null && this.virtualizesDocument) {
      const chunkIndex = Math.floor(this.lineIndexAt(offset, this.lineStarts) / 64);
      this.hydrateChunk(chunkIndex, preserve);
    }
    const next = offset === null || this.lineEls.length === 0
      ? null
      : this.lineEls[this.lineIndexAt(offset, this.lineStarts)]?.parentElement ?? null;
    if (next === this.activeChunk) return;
    this.activeChunk?.classList.remove('mde-viewport-active');
    next?.classList.add('mde-viewport-active');
    this.activeChunk = next;
  }

  scheduleVirtualization(): void {
    if (this.presentationSuspended || !this.virtualizesDocument || this.virtualizationFrame !== null) return;
    this.virtualizationFrame = requestAnimationFrame(() => {
      this.virtualizationFrame = null;
      const [firstChunk, lastChunk] = this.viewportChunkWindow();
      const visible = new Set<number>();
      for (let index = firstChunk; index <= lastChunk; index++) {
        visible.add(index);
        this.hydrateChunk(index);
      }
      const active = this.activeChunk ? this.chunkEls.indexOf(this.activeChunk) : -1;
      if (active >= 0) visible.add(active);
      for (let index = 0; index < this.chunkEls.length; index++) {
        if (!visible.has(index)) this.virtualizeChunk(index);
      }
      this.scheduleResourcePriorities();
    });
  }

  /**
   * Locate the viewport plus one-screen overscan with monotonic binary searches.
   * A multi-megabyte document can contain thousands of chunks; reading every chunk's
   * geometry on each scroll made scroll work linear in document length.
   */
  viewportChunkWindow(): [number, number] {
    const count = this.chunkEls.length;
    if (count === 0) return [0, -1];
    const rootRect = this.root.getBoundingClientRect();
    const viewportTop = Math.max(rootRect.top, 0);
    const viewportBottom = Math.min(rootRect.bottom, globalThis.innerHeight);
    const viewportHeight = Math.max(1, viewportBottom - viewportTop);
    const from = viewportTop - viewportHeight;
    const to = viewportBottom + viewportHeight;
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const rect = this.chunkEls[middle].getBoundingClientRect();
      this.viewportLayoutProbeCount++;
      if (rect.bottom < from) low = middle + 1;
      else high = middle;
    }
    const first = Math.min(low, count - 1);
    low = first;
    high = count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const rect = this.chunkEls[middle].getBoundingClientRect();
      this.viewportLayoutProbeCount++;
      if (rect.top <= to) low = middle + 1;
      else high = middle;
    }
    return [first, Math.max(first, low - 1)];
  }

  hydrateChunk(index: number, preserve: SelectionRange | null = null): void {
    const chunk = this.chunkEls[index];
    if (!chunk?.classList.contains('mde-chunk-virtual')) return;
    const selection = preserve ?? this.selectionRange();
    const first = index * 64;
    const last = Math.min(this.lines.length - 1, first + 63);
    const fragment = document.createDocumentFragment();
    for (let line = first; line <= last; line++) {
      const element = this.applier.buildLine(
        this.lineStarts[line],
        this.lineEnd(line, this.lines, this.lineStarts),
      );
      this.lineEls[line] = element;
      fragment.appendChild(element);
    }
    chunk.classList.remove('mde-chunk-virtual');
    chunk.replaceChildren(fragment);
    if (selection && document.activeElement === this.root) this.setSelectionRange(selection);
  }

  virtualizeChunk(index: number): void {
    const chunk = this.chunkEls[index];
    if (!chunk || chunk.classList.contains('mde-chunk-virtual') || chunk === this.activeChunk) return;
    const first = index * 64;
    const last = Math.min(this.lines.length - 1, first + 63);
    for (let line = first; line <= last; line++) this.lineEls[line] = null;
    chunk.classList.add('mde-chunk-virtual');
    chunk.replaceChildren(document.createTextNode(this.text.slice(
      this.lineStarts[first],
      this.lineEnd(last, this.lines, this.lineStarts),
    )));
  }

  /** Replace line nodes without disturbing untouched containment groups. */
  replaceLineElements(first: number, removeCount: number, rebuilt: HTMLElement[]): void {
    const nextLineCount = this.lineEls.length - removeCount + rebuilt.length;
    const shouldContain = nextLineCount > 128;
    const anchor = this.lineEls[first + removeCount] ?? null;
    let container = anchor?.parentElement ?? this.lineEls[first]?.parentElement ?? null;
    if (!container) {
      container = this.chunkEls[this.chunkEls.length - 1] ?? this.makeViewportChunk(shouldContain);
      if (!container.parentElement) this.root.appendChild(container);
    }
    for (let i = 0; i < removeCount; i++) this.lineEls[first + i]?.remove();
    for (const el of rebuilt) container.insertBefore(el, anchor);
    this.lineEls.splice(first, removeCount, ...rebuilt);

    for (const chunk of this.chunkEls) {
      if (chunk.childElementCount === 0) chunk.remove();
    }
    // A large paste may create many lines at once. Split only the touched group; normal
    // typing leaves every distant group and its remembered intrinsic size untouched.
    let current: HTMLElement | null = container;
    while (current && current.childElementCount > 128) {
      const next = this.makeViewportChunk(shouldContain);
      while (current.childElementCount > 64) next.appendChild(current.children[64]);
      current.after(next);
      current = next;
    }
    this.chunkEls = Array.from(this.root.children) as HTMLElement[];
    for (const chunk of this.chunkEls) {
      chunk.classList.toggle('mde-viewport-chunk', shouldContain);
    }
  }

  /** Exclusive end of a line, including its trailing newline when it has one. */
  /** @param {number} i @param {string[]} lines @param {number[]} starts */
  lineEnd(i, lines, starts) {
    return starts[i] + lines[i].length + (i < lines.length - 1 ? 1 : 0);
  }

  /**
   * Derive the next line model from only the edited lines.
   *
   * JavaScript strings are immutable, so constructing the next document still copies
   * its characters. The expensive avoidable work was then splitting that entire string
   * and comparing every line before the caret. This preserves the untouched prefix and
   * suffix and splits only the source fragment that actually changed.
   */
  spliceLineModel(start: number, end: number, inserted: string): LineChange {
    // A host can programmatically edit immediately after construction, before its
    // first `setMarkdown`. Treat that unrendered initial buffer as one empty line.
    const oldLines = this.lines.length > 0 ? this.lines : [this.text];
    const oldStarts = this.lineStarts.length > 0 ? this.lineStarts : [0];
    const first = this.lineIndexAt(start, oldStarts);
    const lastOld = this.lineIndexAt(end, oldStarts);
    const modelStart = oldStarts[first];
    const oldContentEnd = oldStarts[lastOld] + oldLines[lastOld].length;
    const replacement =
      this.text.slice(modelStart, start) + inserted + this.text.slice(end, oldContentEnd);
    const replacementLines = replacement.split('\n');
    const oldCount = lastOld - first + 1;
    const nextLines = oldLines.slice();
    nextLines.splice(first, oldCount, ...replacementLines);

    const nextStarts = oldStarts.slice(0, first);
    let offset = modelStart;
    for (const line of replacementLines) {
      nextStarts.push(offset);
      offset += line.length + 1;
    }
    const delta = inserted.length - (end - start);
    for (let i = lastOld + 1; i < oldStarts.length; i++) {
      nextStarts.push(oldStarts[i] + delta);
    }
    const lastNew = first + replacementLines.length - 1;
    return {
      first,
      lastOld,
      lastNew,
      lines: nextLines,
      starts: nextStarts,
      newStart: nextStarts[first],
      newEnd: this.lineEnd(lastNew, nextLines, nextStarts),
    };
  }

  /** Apply one already-computed local line splice to the DOM. */
  renderLineChange(change: LineChange, caret: SelectionRange | null): void {
    this.applier.text = this.text;
    if (this.virtualizesDocument) {
      this.lines = change.lines;
      this.lineStarts = change.starts;
      const oldCount = change.lastOld - change.first + 1;
      const newCount = change.lastNew - change.first + 1;
      if (oldCount !== newCount) {
        this.renderAll(true);
      } else {
        const firstChunk = Math.floor(change.first / 64);
        const lastChunk = Math.floor(change.lastNew / 64);
        for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex++) {
          this.rebuildChunk(chunkIndex);
        }
      }
      if (caret) this.setSelectionRange(caret);
      return;
    }
    const rebuilt = [];
    for (let i = change.first; i <= change.lastNew; i++) {
      rebuilt.push(
        this.applier.buildLine(
          change.starts[i],
          this.lineEnd(i, change.lines, change.starts),
        ),
      );
    }
    const removeCount = change.lastOld - change.first + 1;
    this.replaceLineElements(change.first, removeCount, rebuilt);
    this.lines = change.lines;
    this.lineStarts = change.starts;
    if (caret) this.setSelectionRange(caret);
  }

  rebuildChunk(index: number): void {
    const chunk = this.chunkEls[index];
    if (!chunk) return;
    const first = index * 64;
    const last = Math.min(this.lines.length - 1, first + 63);
    if (chunk.classList.contains('mde-chunk-virtual')) {
      chunk.replaceChildren(document.createTextNode(this.text.slice(
        this.lineStarts[first],
        this.lineEnd(last, this.lines, this.lineStarts),
      )));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (let line = first; line <= last; line++) {
      const element = this.applier.buildLine(
        this.lineStarts[line],
        this.lineEnd(line, this.lines, this.lineStarts),
      );
      this.lineEls[line] = element;
      fragment.appendChild(element);
    }
    chunk.replaceChildren(fragment);
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
    const textChanged = this.applier.text !== this.text;
    if (textChanged) {
      // All ordinary edits provide a local line splice. This is a defensive recovery
      // path for a host that mutates the public fields or for a future caller that
      // forgets to do so.
      this.renderAll();
      if (caret) this.setSelectionRange(caret);
      return;
    }
    this.applier.text = this.text;
    // Selection, reveal, resource, and host-layer patches do not change the buffer.
    // Reuse the line model for those extremely common paths: splitting the entire
    // document and comparing from line zero made a caret move near EOF O(document).
    const newLines = this.lines;
    const starts = this.lineStarts;

    // Widen the dirty offsets to whole lines, then to whole *changed* lines by
    // comparing old and new from both ends.
    let first = this.lineIndexAt(dirty.start, starts);
    let lastNew = this.lineIndexAt(dirty.end, starts);
    let lastOld = lastNew + (this.lines.length - newLines.length);

    lastOld = Math.min(lastOld, this.lines.length - 1);
    lastNew = Math.min(lastNew, newLines.length - 1);

    if (this.virtualizesDocument) {
      const firstChunk = Math.floor(first / 64);
      const lastChunk = Math.floor(lastNew / 64);
      for (let chunk = firstChunk; chunk <= lastChunk; chunk++) this.hydrateChunk(chunk, caret);
      for (let line = first; line <= lastNew; line++) {
        const previous = this.lineEls[line];
        if (!previous) continue;
        const rebuilt = this.applier.buildLine(starts[line], this.lineEnd(line, newLines, starts));
        previous.replaceWith(rebuilt);
        this.lineEls[line] = rebuilt;
      }
      if (caret) this.setSelectionRange(caret);
      this.scheduleVirtualization();
      return;
    }

    /** @type {HTMLElement[]} */
    const rebuilt = [];
    for (let i = first; i <= lastNew; i++) {
      rebuilt.push(this.applier.buildLine(starts[i], this.lineEnd(i, newLines, starts)));
    }

    const removeCount = Math.max(0, lastOld - first + 1);
    // Anchor on the first element *after* the replaced range: anchoring on the range's
    // own first element would leave `insertBefore` holding a node we just removed.
    this.replaceLineElements(first, removeCount, rebuilt);
    this.lines = newLines;
    this.lineStarts = starts;

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

  /** @param {number} offset @param {number[]} starts */
  lineIndexAt(offset, starts) {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const middle = (lo + hi) >> 1;
      if (starts[middle] <= offset) lo = middle + 1;
      else hi = middle;
    }
    return Math.max(0, Math.min(lo - 1, starts.length - 1));
  }

  // MARK: - Selection

  /** @returns {{start: number, end: number}|null} */
  selectionRange(): SelectionRange | null {
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
  setSelectionRange(range: SelectionRange): void {
    // WebKit can otherwise accept the DOM range but place subsequent native input at
    // the start of a content-visibility subtree.
    // Mutating the active containment class forces Chromium to reconsider layout for
    // every preceding skipped chunk before a DOM Range can be installed. On very large
    // documents that turns a local edit into seconds of synchronous style/layout. The
    // active chunk matters only while native input is focused; programmatic edits and
    // background session updates do not need to wake it.
    if (this.virtualizesDocument) {
      this.hydrateChunk(Math.floor(this.lineIndexAt(range.start, this.lineStarts) / 64), range);
      this.hydrateChunk(Math.floor(this.lineIndexAt(range.end, this.lineStarts) / 64), range);
    }
    if (document.activeElement === this.root) this.activateChunk(range.start, range);
    /** @param {number} target */
    const locate = (target) => {
      // The line model already maps absolute offsets to one bounded DOM subtree.
      // Walking every text node made restoring the caret O(document) — over 200,000
      // nodes in the 1 MB fixture — even though a normal edit rebuilds one line.
      const line = this.lineIndexAt(target, this.lineStarts);
      const element = this.lineEls[line];
      if (!element) return null;
      const nodes = textNodes(element);
      let offset = this.lineStarts[line] ?? 0;
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

interface LineChange {
  first: number;
  lastOld: number;
  lastNew: number;
  lines: string[];
  starts: number[];
  newStart: number;
  newEnd: number;
}

export interface EditorProjectionSnapshot {
  markdown: string;
  html: string;
  lines: string[];
  lineStarts: number[];
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

/** True when `offset` falls between the two code units of one Unicode scalar. */
function splitsSurrogatePair(text, offset) {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export { documentText, textNodes, Kind };
