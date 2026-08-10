// Decorations -> DOM. The web counterpart of
// `apple/Sources/MDEditorUI/DecorationApplier.swift`, and deliberately the same shape:
// the same `live` map, the same paint ordering, the same rule that `shifted` and
// `moved` entries never cause a repaint. Where the Apple side writes
// NSAttributedString attributes, this writes spans.

import { Kind, Role } from './core.js';
import type { Decoration, Engine } from './core.js';
import type { ResourceCache } from './resources.js';
import type { WidgetProvider } from './widgets.js';

/** Marks subtrees that are presentation only and contribute no document text. */
export const IGNORE_ATTR = 'data-mde-ignore';

/**
 * Broad decorations paint first so narrow ones win: a concealed `**` must beat the
 * emphasis span it sits inside.
 * @param {import('./core.js').Decoration} d
 */
function paintOrder(d) {
  switch (d.kind) {
    case Kind.Style:
      return 0;
    case Kind.Gutter:
      return 1;
    case Kind.Hit:
      return 2;
    case Kind.Conceal:
      return 3;
    default:
      return 4;
  }
}

const BUILTIN_CLASS = {
  [Role.Heading]: 'heading',
  [Role.Marker]: 'marker',
  [Role.Emphasis]: 'emphasis',
  [Role.Strong]: 'strong',
  [Role.CodeInline]: 'code-inline',
  [Role.CodeBlock]: 'code-block',
  [Role.Link]: 'link',
  [Role.LinkText]: 'link-text',
  [Role.Image]: 'image',
  [Role.Quote]: 'quote',
  [Role.ListBullet]: 'list-bullet',
  [Role.TaskCheckbox]: 'task-checkbox',
  [Role.Rule]: 'rule',
  [Role.Strikethrough]: 'strikethrough',
  [Role.Table]: 'table',
  [Role.TableHeader]: 'table-header',
  [Role.TableDelimiter]: 'table-delimiter',
  [Role.TableCell]: 'table-cell',
  [Role.Html]: 'html',
};

/** Sort and coalesce overlapping or touching ranges. */
export function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out = [sorted[0]];
  for (const r of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/**
 * True when this line lies wholly inside a block widget that began on an earlier line —
 * i.e. it contributes only concealed source and should take up no vertical space.
 * @param {import('./core.js').Decoration} w
 * @param {number} lineStart @param {number} lineEnd
 * @param {string} text the full document
 */
function isBlockContinuation(w, lineStart, lineEnd, text) {
  if (w.kind !== Kind.BlockWidget || w.start >= lineStart) return false;
  // The *closing* line of a block widget keeps its newline outside the widget's range —
  // the widget ends at the last backtick — so that one character is allowed to fall past
  // the end. Without this the closing fence line stays full height and the collapse
  // looks half-done.
  const contentEnd = text[lineEnd - 1] === '\n' ? lineEnd - 1 : lineEnd;
  return w.end >= contentEnd;
}

/** Index of the first decoration starting at or after `offset`. */
function lowerBound(index, offset) {
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index[mid].start < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class DomApplier {
  engine: Engine;
  text: string;
  live: Map<bigint, Decoration>;
  resources: ResourceCache | null;
  widgetProvider: WidgetProvider | null;
  sorted: Decoration[];
  indexStale: boolean;
  maxLength: number;
  widgetViews: Map<bigint, HTMLElement>;
  widgetOrder: bigint[];
  widgetCacheLimit: number;
  references: Map<string, Set<bigint>>;
  referenceByKey: Map<bigint, string>;

  /**
   * @param {import('./core.js').Engine} engine
   */
  constructor(engine: Engine) {
    this.engine = engine;
    /** Full document text. Segments and widget sources are sliced from it. */
    this.text = '';
    /** @type {Map<bigint, import('./core.js').Decoration>} Every decoration in effect. */
    this.live = new Map();
    /** @type {import('./resources.js').ResourceCache|null} */
    this.resources = null;
    /** @type {import('./widgets.js').WidgetProvider|null} */
    this.widgetProvider = null;
    /** @type {import('./core.js').Decoration[]} */
    this.sorted = [];
    this.indexStale = true;
    this.maxLength = 0;
    /**
     * Host-drawn widget views, kept by decoration key so a re-render of the line does
     * not ask the host to build the same callout again.
     * @type {Map<bigint, HTMLElement>}
     */
    this.widgetViews = new Map();
    /** Insertion order, for eviction. @type {bigint[]} */
    this.widgetOrder = [];
    this.widgetCacheLimit = 256;
    /** Resource/reference lookup maintained with `live`, avoiding a document scan on resolve. */
    this.references = new Map();
    this.referenceByKey = new Map();
  }

  reset() {
    this.live.clear();
    this.references.clear();
    this.referenceByKey.clear();
    this.indexStale = true;
    this.resources?.reset();
    this.widgetViews.clear();
    this.widgetOrder.length = 0;
  }

  /** @param {bigint} key */
  cachedWidget(key) {
    return this.widgetViews.get(key) ?? null;
  }

  /**
   * @param {bigint} key
   * @param {HTMLElement|null|undefined} view
   * @returns {HTMLElement|null}
   */
  cacheWidget(key, view) {
    if (!view) return null;
    this.widgetViews.set(key, view);
    this.widgetOrder.push(key);
    if (this.widgetOrder.length > this.widgetCacheLimit) {
      // Drop the oldest entry that is no longer a live decoration before evicting
      // anything the document still points at.
      let victim = this.widgetOrder.findIndex((k) => !this.live.has(k));
      if (victim < 0) victim = 0;
      this.widgetViews.delete(this.widgetOrder[victim]);
      this.widgetOrder.splice(victim, 1);
    }
    return view;
  }

  /**
   * `live` sorted by start, so a line render can binary-search the decorations that
   * touch it instead of filtering all of them. Rebuilt lazily — a keystroke mutates
   * `live` several times before anything is drawn.
   */
  get index() {
    if (this.indexStale) {
      this.sorted = [...this.live.values()].sort((a, b) => a.start - b.start || a.end - b.end);
      this.maxLength = this.sorted.reduce((m, d) => Math.max(m, d.end - d.start), 0);
      this.indexStale = false;
    }
    return this.sorted;
  }

  /**
   * Decorations overlapping `[from, to)`, found by binary search rather than by
   * scanning every live decoration — which made rendering one line O(document).
   * @param {number} from @param {number} to
   */
  covering(from, to) {
    const index = this.index;
    // A block widget can start far above the line being rendered, so the search starts
    // back by the longest decoration seen.
    const lo = lowerBound(index, from - this.maxLength);
    const out = [];
    for (let i = lo; i < index.length && index[i].start < to; i++) {
      if (index[i].end > from) out.push(index[i]);
    }
    return out;
  }

  /** @param {import('./core.js').Patch} patch */
  ingest(patch) {
    this.indexStale = true;
    for (const key of patch.removed) {
      this.unindexReference(key);
      this.live.delete(key);
      // A removed key can never come back: it encodes the node's own source, so its
      // view is unreachable and would just occupy the cache.
      if (this.widgetViews.delete(key)) {
        const at = this.widgetOrder.indexOf(key);
        if (at >= 0) this.widgetOrder.splice(at, 1);
      }
    }
    for (const shift of patch.shifted) {
      for (const d of this.live.values()) {
        if (d.start < shift.start) continue;
        d.start += shift.delta;
        d.end += shift.delta;
      }
    }
    for (const m of patch.moved) {
      const d = this.live.get(m.key);
      if (d) {
        d.start = m.start;
        d.end = m.end;
      }
    }
    for (const d of patch.added) {
      this.unindexReference(d.key);
      this.live.set(d.key, d);
      if (d.role === Role.Table) continue;
      const reference = this.engine.payload(d.key);
      if (!reference) continue;
      this.referenceByKey.set(d.key, reference);
      const keys = this.references.get(reference) ?? new Set();
      keys.add(d.key);
      this.references.set(reference, keys);
    }
  }

  /** @param {bigint} key */
  unindexReference(key) {
    const reference = this.referenceByKey.get(key);
    if (!reference) return;
    this.referenceByKey.delete(key);
    const keys = this.references.get(reference);
    keys?.delete(key);
    if (keys?.size === 0) this.references.delete(reference);
  }

  /**
   * The ranges a patch requires re-rendering — *disjoint*, not a bounding box.
   *
   * Two separate reasons, both measured:
   *
   * `shifted` and `moved` entries are excluded because both preserve identity and
   * appearance while changing only offsets; the line is re-rendered from the model
   * anyway. Including them widens the range to the end of the document on every
   * keystroke.
   *
   * And the rest are kept apart rather than unioned, because editing a node changes how
   * many byte-identical siblings precede its twin elsewhere, which changes that twin's
   * key (DESIGN §3.3) and so puts a removal far from the caret. Unioning the two turned
   * one keystroke into a whole-document re-render.
   *
   * @param {import('./core.js').Patch} patch
   * @param {{start: number, end: number}|null} alsoDirty range the edit itself touched
   * @returns {{start: number, end: number}[]}
   */
  dirtyRanges(patch, alsoDirty) {
    const ranges = [];
    for (const key of patch.removed) {
      const d = this.live.get(key);
      if (d) ranges.push({ start: d.start, end: d.end });
    }
    for (const d of patch.added) ranges.push({ start: d.start, end: d.end });
    if (alsoDirty) ranges.push(alsoDirty);
    return mergeRanges(ranges);
  }

  /** Offsets of every node whose reference is `reference`. */
  /** @param {string} reference */
  rangesReferencing(reference) {
    const out = [];
    for (const key of this.references.get(reference) ?? []) {
      const d = this.live.get(key);
      if (!d) continue;
      const table = this.covering(d.start, d.end).find(
        (candidate) =>
          candidate.kind === Kind.BlockWidget &&
          candidate.role === Role.Table &&
          candidate.start <= d.start &&
          candidate.end >= d.end
      );
      out.push(table ? { start: table.start, end: table.end } : { start: d.start, end: d.end });
    }
    return mergeRanges(out);
  }

  /** The smallest `Hit` decoration containing `offset`, if any. */
  /** @param {number} offset */
  hit(offset) {
    let best = null;
    for (const d of this.covering(offset, offset + 1)) {
      if (d.kind !== Kind.Hit || offset < d.start || offset >= d.end) continue;
      if (!best || d.end - d.start < best.end - best.start) best = d;
    }
    return best;
  }

  /** The smallest visible link label containing `offset`, if any. */
  /** @param {number} offset */
  link(offset) {
    let best = null;
    for (const d of this.covering(offset, offset + 1)) {
      if (d.role !== Role.LinkText || offset < d.start || offset >= d.end) continue;
      if (!best || d.end - d.start < best.end - best.start) best = d;
    }
    return best;
  }

  /**
   * Build the DOM for one line of the document.
   *
   * The line's trailing `\n` is treated as an ordinary character of the line, not
   * appended afterwards. That matters for block widgets: their source spans several
   * lines, and the newlines *inside* it must be concealed too. A hairline newline
   * contributes no height, which is exactly how the Apple renderers collapse the same
   * source behind a single attachment.
   *
   * @param {number} lineStart absolute UTF-16 offset of the line's first character
   * @param {number} lineEnd   exclusive, including the trailing `\n` when there is one
   * @returns {HTMLElement}
   */
  buildLine(lineStart, lineEnd) {
    const el = document.createElement('span');
    el.className = 'mde-line';

    // Ties break on `layer`, so a host layer paints over what the parse decided —
    // a focus-mode dim has to beat a heading's own colour.
    const covering = this.covering(lineStart, lineEnd)
      .slice()
      .sort((a, b) => paintOrder(a) - paintOrder(b) || a.layer - b.layer);

    // A table is a semantic HTML view until the caret enters its source. The view is
    // ignored by the editor's text walk; every Markdown character remains underneath.
    const table = covering.find((d) => d.role === Role.Table);
    const tableIsEditing = table?.kind === Kind.Style;
    if (table && !tableIsEditing) {
      if (table.start === lineStart) {
        el.appendChild(this.buildRenderedTable(table, lineStart, lineEnd));
        el.classList.add('mde-line-block');
      } else {
        const source = document.createElement('span');
        source.className = 'mde-run mde-conceal';
        source.setAttribute('aria-hidden', 'true');
        source.appendChild(document.createTextNode(this.text.slice(lineStart, lineEnd)));
        el.appendChild(source);
        el.classList.add('mde-line-concealed');
      }
      return el;
    }

    // While editing, the ordinary line DOM returns so the pipes, delimiter and every
    // source character are available to the native contenteditable selection.
    if (tableIsEditing) {
      el.classList.add('mde-line-table');
      if (table.start === lineStart) el.classList.add('mde-line-table-start');
      if (table.end === lineEnd) el.classList.add('mde-line-table-end');
      if (covering.some((d) => d.role === Role.TableHeader)) {
        el.classList.add('mde-line-table-header');
      }
      if (covering.some((d) => d.role === Role.TableDelimiter)) {
        el.classList.add('mde-line-table-delimiter');
      }
    }

    // Widgets own their whole range, so they carve the line up first; everything else
    // is segmented inside the gaps between them.
    const widgets = covering
      .filter((d) => d.kind === Kind.InlineWidget || d.kind === Kind.BlockWidget)
      .sort((a, b) => a.start - b.start);

    let cursor = lineStart;
    for (const w of widgets) {
      const wStart = Math.max(w.start, lineStart);
      if (wStart > cursor) this.appendStyledRun(el, cursor, wStart, covering);
      el.appendChild(this.buildWidget(w, wStart, Math.min(w.end, lineEnd)));
      cursor = Math.min(w.end, lineEnd);
    }
    if (cursor < lineEnd) this.appendStyledRun(el, cursor, lineEnd, covering);
    if (lineEnd === lineStart) {
      // An empty last line still needs a text node so the caret has somewhere to land.
      el.appendChild(document.createTextNode(''));
    }

    // A block widget's continuation lines carry nothing but concealed source. Concealing
    // shrinks the *glyphs* to a hairline but not the line box they sit in, so without
    // this a three-line callout draws the card followed by two full-height empty bands.
    // The line has to collapse itself: its own `line-height` is the only thing that
    // governs the box, since the container's strut is zeroed for exactly this reason.
    if (widgets.some((w) => isBlockContinuation(w, lineStart, lineEnd, this.text))) {
      el.classList.add('mde-line-concealed');
    } else if (widgets.some((w) => w.kind === Kind.BlockWidget)) {
      // The line that *draws* the block. Its widget is a block box inside an inline
      // span, which splits the span into empty inline fragments above and below it —
      // two more full-height bands of nothing. Making the line itself a block removes
      // the fragments; there is nothing else on it to keep inline.
      el.classList.add('mde-line-block');
    }
    return el;
  }

  /**
   * Build the presentation-only HTML table plus the concealed source slice belonging
   * to its first line. Continuation lines retain the rest of the source separately.
   * @param {import('./core.js').Decoration} tableDecoration
   * @param {number} from @param {number} to
   */
  buildRenderedTable(tableDecoration: Decoration, from: number, to: number): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'mde-widget mde-widget-block mde-table-widget';
    wrap.dataset.mdeKey = String(tableDecoration.key);

    const view = document.createElement('span');
    view.className = 'mde-widget-view mde-table-view';
    view.setAttribute(IGNORE_ATTR, '');
    view.setAttribute('contenteditable', 'false');

    const htmlTable = document.createElement('table');
    htmlTable.className = 'mde-rendered-table';
    const head = document.createElement('thead');
    const body = document.createElement('tbody');

    const source = this.text.slice(tableDecoration.start, tableDecoration.end);
    const sourceLines = source.split('\n');
    const alignments = [...(this.engine.payload(tableDecoration.key) ?? '')].map((alignment) => {
      if (alignment === 'c') return 'center';
      if (alignment === 'r') return 'right';
      return 'left';
    });
    const allDecorations = this.covering(tableDecoration.start, tableDecoration.end)
      .slice()
      .sort((a, b) => paintOrder(a) - paintOrder(b) || a.layer - b.layer);
    const cellDecorations = allDecorations
      .filter((d) => d.kind === Kind.Style && d.role === Role.TableCell)
      .sort((a, b) => a.start - b.start);
    const decorationsByCell = new Map();
    let containingCell = 0;
    for (const decoration of allDecorations.slice().sort((a, b) => a.start - b.start || a.end - b.end)) {
      while (
        containingCell < cellDecorations.length &&
        cellDecorations[containingCell].end <= decoration.start
      ) containingCell++;
      const cell = cellDecorations[containingCell];
      if (cell && decoration.start >= cell.start && decoration.end <= cell.end) {
        const entries = decorationsByCell.get(cell.key) ?? [];
        entries.push(decoration);
        decorationsByCell.set(cell.key, entries);
      }
    }

    let lineStart = tableDecoration.start;
    let nextCell = 0;
    for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
      const line = sourceLines[lineIndex];
      const lineEnd = lineStart + line.length;
      if (lineIndex !== 1) {
        while (nextCell < cellDecorations.length && cellDecorations[nextCell].end <= lineStart) {
          nextCell++;
        }
        const cells = [];
        while (
          nextCell < cellDecorations.length &&
          cellDecorations[nextCell].start >= lineStart &&
          cellDecorations[nextCell].end <= lineEnd
        ) {
          cells.push(cellDecorations[nextCell]);
          nextCell++;
        }
        if (cells.length > 0) {
          const row = document.createElement('tr');
          cells.forEach((cell, column) => {
            const element = document.createElement(lineIndex === 0 ? 'th' : 'td');
            let cellStart = cell.start;
            let cellEnd = cell.end;
            while (cellStart < cellEnd && /\s/.test(this.text[cellStart])) cellStart++;
            while (cellEnd > cellStart && /\s/.test(this.text[cellEnd - 1])) cellEnd--;
            if (cellEnd > cellStart) {
              this.appendTableCellContent(
                element,
                cellStart,
                cellEnd,
                decorationsByCell.get(cell.key) ?? [cell]
              );
            }
            element.dataset.align = alignments[column] ?? 'left';
            row.appendChild(element);
          });
          (lineIndex === 0 ? head : body).appendChild(row);
        }
      }
      lineStart = lineEnd + 1;
    }

    htmlTable.append(head, body);
    view.appendChild(htmlTable);
    wrap.appendChild(view);

    const sourceRun = document.createElement('span');
    sourceRun.className = 'mde-run mde-conceal';
    sourceRun.setAttribute('aria-hidden', 'true');
    sourceRun.appendChild(document.createTextNode(this.text.slice(from, to)));
    wrap.appendChild(sourceRun);
    return wrap;
  }

  /**
   * Render inline Markdown inside a presentation table cell. A resource is resolved
   * once by reference, then copied into this second projection because one DOM node
   * cannot be parented in two places.
   */
  appendTableCellContent(parent, from, to, covering) {
    const images = covering
      .filter(
        (d) =>
          d.kind === Kind.InlineWidget &&
          d.role === Role.Image &&
          d.start >= from &&
          d.end <= to
      )
      .sort((a, b) => a.start - b.start);
    let cursor = from;
    for (const image of images) {
      if (image.start > cursor) this.appendStyledRun(parent, cursor, image.start, covering);
      const source = this.text.slice(image.start, image.end);
      const alt = source.match(/^!\[([^\]]*)\]/)?.[1] || 'image';
      const reference = this.engine.payload(image.key);
      const frame = document.createElement('span');
      frame.className = 'mde-table-resource';
      frame.setAttribute('role', 'img');
      frame.setAttribute('aria-label', alt);
      frame.title = reference || alt;
      const view = this.resources?.viewCopy({
        reference,
        roleName: this.engine.roleName(image.role),
        source,
      });
      if (view) {
        view.classList.add('mde-table-resource-content');
        if (view instanceof HTMLImageElement) {
          view.alt = alt;
          view.classList.add('mde-table-resource-image');
        }
        frame.appendChild(view);
      } else {
        frame.textContent = alt;
      }
      parent.appendChild(frame);
      cursor = image.end;
    }
    if (cursor < to) this.appendStyledRun(parent, cursor, to, covering);
  }

  /**
   * Segment `[from, to)` at every decoration boundary and emit one span per segment.
   * @param {HTMLElement} parent
   * @param {number} from
   * @param {number} to
   * @param {import('./core.js').Decoration[]} covering
   */
  appendStyledRun(parent, from, to, covering) {
    /** @type {Set<number>} */
    const cuts = new Set([from, to]);
    for (const d of covering) {
      if (d.start > from && d.start < to) cuts.add(d.start);
      if (d.end > from && d.end < to) cuts.add(d.end);
    }
    const points = [...cuts].sort((a, b) => a - b);
    const startsAt = new Map<number, Decoration[]>();
    const endsAt = new Map<number, Decoration[]>();
    const active = new Set<Decoration>();
    for (const d of covering) {
      if (d.end <= from || d.start >= to) continue;
      if (d.start <= from) active.add(d);
      else {
        const starts = startsAt.get(d.start) ?? [];
        starts.push(d);
        startsAt.set(d.start, starts);
      }
      if (d.end < to) {
        const ends = endsAt.get(d.end) ?? [];
        ends.push(d);
        endsAt.set(d.end, ends);
      }
    }

    let pendingClass = null;
    let pendingText = '';
    const flush = () => {
      if (pendingText.length === 0) return;
      // Plain source inherits everything it needs from the line. Keeping it as a bare
      // text node avoids an otherwise meaningless element for every gap between
      // markdown roles. Styled source retains `.mde-run` as the public theme hook.
      if (pendingClass === null) {
        parent.appendChild(document.createTextNode(pendingText));
      } else {
        const span = document.createElement('span');
        span.className = pendingClass;
        span.appendChild(document.createTextNode(pendingText));
        parent.appendChild(span);
      }
      pendingText = '';
    };

    for (let i = 0; i < points.length - 1; i++) {
      const segStart = points[i];
      const segEnd = points[i + 1];
      for (const d of endsAt.get(segStart) ?? []) active.delete(d);
      for (const d of startsAt.get(segStart) ?? []) active.add(d);
      const text = this.text.slice(segStart, segEnd);
      if (text.length === 0) continue;

      const classes = ['mde-run'];
      let concealed = false;
      for (const d of active) {
        if (d.kind === Kind.InlineWidget || d.kind === Kind.BlockWidget) continue;
        if (d.kind === Kind.Conceal) concealed = true;
        const name = this.className(d);
        if (name) classes.push(name);
        if (d.role === Role.Heading) {
          classes.push(`mde-h${d.depth || this.headingLevel(d.start)}`);
        }
        if (d.kind === Kind.Gutter && d.depth > 0) classes.push(`mde-depth-${d.depth}`);
      }
      if (concealed) classes.push('mde-conceal');

      const className = classes.length === 1 ? null : classes.join(' ');
      if (className !== pendingClass) {
        flush();
        pendingClass = className;
      }
      pendingText += text;
    }
    flush();
  }

  /**
   * A widget is its rendered view plus its concealed source. The source characters stay
   * in the DOM — the document text must remain exactly the markdown — while the view is
   * marked `data-mde-ignore` so it contributes no text of its own.
   *
   * A block widget spans several lines. Only the line it *starts* on draws the view;
   * the rest simply conceal their share of the source, so the host's `makeWidget` is
   * called once with the whole source rather than once per line with a fragment of it.
   *
   * @param {import('./core.js').Decoration} d
   * @param {number} from
   * @param {number} to
   */
  buildWidget(d, from, to) {
    const wrap = document.createElement('span');
    wrap.className =
      d.kind === Kind.BlockWidget ? 'mde-widget mde-widget-block' : 'mde-widget';
    wrap.dataset.mdeKey = String(d.key);

    if (from === d.start) {
      const roleName = this.engine.roleName(d.role);
      const payload = this.engine.payload(d.key);
      const source = this.text.slice(d.start, d.end);

      const view = document.createElement('span');
      view.className = 'mde-widget-view';
      view.setAttribute(IGNORE_ATTR, '');
      view.setAttribute('contenteditable', 'false');
      // Opt-in only: by default clicks pass through so the caret can reach the source.
      if (this.widgetProvider?.widgetWantsPointerEvents?.(roleName)) {
        view.setAttribute('data-mde-interactive', '');
      }

      // Host-drawn views are cached by decoration key. That is safe precisely because
      // keys are stable across edits (DESIGN §3.3): a key changes exactly when its
      // node's own source changes, so the cache invalidates itself for free. Resource
      // views are already cached by the resolver and are reused as-is.
      const built =
        this.cachedWidget(d.key) ??
        this.cacheWidget(
          d.key,
          this.widgetProvider?.makeWidget({ roleName, source, payload, decoration: d }),
        ) ??
        this.resources?.view({ reference: payload, roleName, source }) ??
        null;
      // Re-parenting is the point: an element lives in one place, and the wrapper it
      // came from is being discarded.
      if (built) view.appendChild(built);
      wrap.appendChild(view);
    }

    const src = document.createElement('span');
    src.className = 'mde-run mde-conceal';
    src.appendChild(document.createTextNode(this.text.slice(from, to)));
    wrap.appendChild(src);
    return wrap;
  }

  /** @param {import('./core.js').Decoration} d */
  className(d) {
    const builtin = BUILTIN_CLASS[d.role];
    if (builtin) return `mde-${builtin}`;
    const name = this.engine.roleName(d.role);
    return name ? `mde-ext-${name.replace(/[^\w-]/g, '-')}` : null;
  }

  /** @param {number} lineStart offset of the heading's first character */
  headingLevel(lineStart) {
    let n = 0;
    while (this.text[lineStart + n] === '#') n++;
    return Math.min(Math.max(n, 1), 6);
  }
}
