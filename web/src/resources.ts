// Turning a reference in the document into something displayable.
//
// Same contract as `apple/Sources/MDEditorUI/Resources.swift`, and for the same reason:
// the document must stay a portable markdown string. A note holds
// `![chart](assets/q3.png)` — never the bytes. Inlining an image, video, or document as
// base64 would balloon the file, break diffing, and stop other markdown tools reading
// it. So the editor asks the host, which already knows where its assets live.

export interface ResourceRequest {
  reference: string;
  roleName: string | null;
  source: string;
  /** Aborted when the editor replaces the document or is destroyed. */
  signal: AbortSignal;
  /** Lower values start first. Hosts may promote references as they approach view. */
  priority?: number;
}
export type ResourceState =
  | { state: 'loading' }
  | { state: 'ready'; view: HTMLElement }
  | { state: 'failed'; message: string };
export interface ResourceResolver {
  resolve(request: ResourceRequest): Promise<ResourceState>;
  reservedSize(request: ResourceRequest): { width: number; height: number };
}

/**
 * A host implements this. Resolution is assumed asynchronous: return `{state:'loading'}`
 * and resolve the promise later. The editor reserves space meanwhile and repaints only
 * the nodes pointing at that reference, so one slow image never re-lays-out the
 * document.
 *
 * @typedef {object} ResourceResolver
 * @property {(request: ResourceRequest) => Promise<ResourceState>} resolve. The
 * request signal aborts when the document is replaced or the editor is destroyed.
 * @property {(request: ResourceRequest) => {width: number, height: number}} reservedSize
 */

/**
 * Caches resolution by reference, so the same asset used twice loads once and a
 * re-render never refetches.
 *
 * Keyed by reference rather than by decoration key deliberately: the key changes
 * whenever the node's source is edited, but `![a](x.png)` and `![b](x.png)` are the
 * same asset.
 */
export class ResourceCache {
  resolver: ResourceResolver | null;
  onResolved: (reference: string) => void;
  states: Map<string, ResourceState>;
  reserved: Map<string, { width: number; height: number }>;
  known: Map<string, { width: number; height: number }>;
  generation: number;
  controller: AbortController;
  maxConcurrent: number;
  active: Map<string, number>;
  pending: Array<{ request: ResourceRequest; generation: number; order: number }>;
  nextOrder: number;
  peakConcurrent: number;
  suspended: boolean;
  maxReadyViews: number;
  readyOrder: string[];
  viewportReferences: Set<string>;

  /**
   * @param {ResourceResolver|null} resolver
   * @param {(reference: string) => void} onResolved repaint hook
   */
  constructor(
    resolver: ResourceResolver | null,
    onResolved: (reference: string) => void,
    options: { maxConcurrent?: number } = {},
  ) {
    this.resolver = resolver;
    this.onResolved = onResolved;
    /** @type {Map<string, ResourceState>} */
    this.states = new Map();
    /** @type {Map<string, {width: number, height: number}>} */
    this.reserved = new Map();
    /**
     * Sizes learned from resources that have already resolved.
     *
     * This is what stops `reservedSize` being a guess *twice*. The first time a
     * reference is seen nobody knows how big it is, so the document shifts once when it
     * lands. Handing these to the host to persist, and seeding them on open, means that
     * shift happens at most once per asset ever rather than once per page load.
     * @type {Map<string, {width: number, height: number}>}
     */
    this.known = new Map();
    /** Invalidates completions belonging to a document that has since been reset. */
    this.generation = 0;
    this.controller = new AbortController();
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 6));
    this.active = new Map();
    this.pending = [];
    this.nextOrder = 0;
    this.peakConcurrent = 0;
    this.suspended = false;
    this.maxReadyViews = 32;
    this.readyOrder = [];
    this.viewportReferences = new Set();
  }

  reset() {
    this.controller.abort();
    this.controller = new AbortController();
    this.generation++;
    this.states.clear();
    this.reserved.clear();
    this.active.clear();
    this.pending.length = 0;
    this.readyOrder.length = 0;
    this.viewportReferences.clear();
    // `known` deliberately survives: it describes assets, not this document.
  }

  /** Stop queued host work while the containing app is backgrounded. */
  suspend() {
    if (this.suspended) return;
    this.suspended = true;
    this.controller.abort();
    this.controller = new AbortController();
    this.generation++;
    for (const [reference, state] of this.states) {
      if (state.state === 'loading') this.states.delete(reference);
    }
    this.active.clear();
    this.pending.length = 0;
  }

  resume() {
    this.suspended = false;
  }

  /**
   * Seed sizes remembered from a previous session.
   * @param {Record<string, {width: number, height: number}>} sizes
   */
  remember(sizes: Record<string, { width: number; height: number }>) {
    for (const [reference, size] of Object.entries(sizes ?? {})) {
      if (size && size.width > 0 && size.height > 0) this.known.set(reference, size);
    }
  }

  /** Every size resolved so far, for the host to persist. */
  sizes() {
    return Object.fromEntries(this.known);
  }

  /**
   * The element to show right now. Kicks off resolution on first sight of a reference.
   * @param {{reference: string|null, roleName: string|null, source: string, priority?: number}} req
   * @returns {HTMLElement|null}
   */
  view(req) {
    if (!req.reference) return null;
    if (!this.resolver) return placeholder('no resolver', true, null);

    const request = {
      reference: req.reference,
      roleName: req.roleName,
      source: req.source,
      signal: this.controller.signal,
      priority: Number.isFinite(req.priority) ? req.priority : 100,
    };
    if (this.suspended) {
      if (!this.reserved.has(req.reference)) {
        this.reserved.set(
          req.reference,
          this.known.get(req.reference) ?? this.resolver.reservedSize(request),
        );
      }
      return placeholder(basename(req.reference), false, this.reserved.get(req.reference));
    }
    const known = this.states.get(req.reference);
    if (!known) {
      // A size we have seen before beats anything the resolver can guess.
      this.reserved.set(
        req.reference,
        this.known.get(req.reference) ?? this.resolver.reservedSize(request),
      );
      this.states.set(req.reference, { state: 'loading' });
      this.pending.push({ request, generation: this.generation, order: this.nextOrder++ });
      this.pump();
      return placeholder(basename(req.reference), false, this.reserved.get(req.reference));
    }
    if (known.state === 'ready') {
      this.touchReady(req.reference);
      return known.view;
    }
    if (known.state === 'failed') return placeholder(known.message, true, null);
    return placeholder(basename(req.reference), false, this.reserved.get(req.reference));
  }

  /** Promote queued references as they approach the viewport without restarting work. */
  prioritize(references: Iterable<string>, priority = 0) {
    const wanted = new Set(references);
    this.viewportReferences = wanted;
    for (const item of this.pending) {
      if (wanted.has(item.request.reference)) item.request.priority = priority;
    }
    this.evictReadyViews();
    this.pump();
  }

  get readyViewCount() {
    return this.readyOrder.length;
  }

  touchReady(reference: string) {
    const at = this.readyOrder.indexOf(reference);
    if (at >= 0) this.readyOrder.splice(at, 1);
    this.readyOrder.push(reference);
  }

  evictReadyViews() {
    while (this.readyOrder.length > Math.max(1, this.maxReadyViews)) {
      let victim = this.readyOrder.findIndex(
        (reference) => !this.viewportReferences.has(reference),
      );
      if (victim < 0) victim = 0;
      const reference = this.readyOrder.splice(victim, 1)[0];
      if (this.states.get(reference)?.state === 'ready') this.states.delete(reference);
    }
  }

  pump() {
    if (!this.resolver || this.suspended) return;
    this.pending.sort((a, b) =>
      (a.request.priority ?? 100) - (b.request.priority ?? 100) || a.order - b.order
    );
    while (this.active.size < this.maxConcurrent && this.pending.length > 0) {
      const item = this.pending.shift();
      if (!item || item.generation !== this.generation || item.request.signal.aborted) continue;
      this.active.set(item.request.reference, item.generation);
      this.peakConcurrent = Math.max(this.peakConcurrent, this.active.size);
      void this.start(item.request, item.generation);
    }
  }

  /**
   * A presentation-only copy for a second projection of the same resource, such as an
   * image inside a rendered table. Resolution remains cached once by reference; only
   * the DOM node is copied because one node cannot have two parents.
   */
  viewCopy(req) {
    const view = this.view(req);
    const copy = view?.cloneNode(true);
    return copy instanceof HTMLElement ? copy : null;
  }

  /** @param {ResourceRequest} request */
  async start(request: ResourceRequest, generation: number) {
    let result;
    try {
      result = await this.resolver.resolve(request);
    } catch (error) {
      result = { state: 'failed', message: String(error?.message ?? error) };
    }
    // A reset between request and response means this document is gone. Checking only
    // for the reference is insufficient: the next document may already be loading the
    // same path, in which case the old completion must not overwrite its new request.
    if (this.active.get(request.reference) === generation) {
      this.active.delete(request.reference);
    }
    if (generation === this.generation && this.states.has(request.reference)) {
      this.states.set(request.reference, result);
      if (result.state === 'ready') {
        const size = measure(result.view, this.reserved.get(request.reference));
        if (size) {
          this.reserved.set(request.reference, size);
          this.known.set(request.reference, size);
        }
        this.touchReady(request.reference);
        this.evictReadyViews();
      }
      this.onResolved(request.reference);
    }
    this.pump();
  }
}

/**
 * The resolved element's own size, so the next sighting reserves the right box.
 *
 * A detached element has no layout, so fall back to the intrinsic dimensions an image
 * carries with it, then to whatever was reserved.
 * @param {HTMLElement} view
 * @param {{width: number, height: number}|undefined} fallback
 */
function measure(view, fallback) {
  const rect = view.getBoundingClientRect?.();
  if (rect && rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height };
  }
  const w = Number(view.getAttribute?.('width') ?? view.naturalWidth ?? 0);
  const h = Number(view.getAttribute?.('height') ?? view.naturalHeight ?? 0);
  if (w > 0 && h > 0) return { width: w, height: h };
  return fallback ?? null;
}

/** @param {string} reference */
function basename(reference) {
  return reference.split('/').pop() || reference;
}

/**
 * @param {string} text
 * @param {boolean} failed
 * @param {{width: number, height: number}|null} size
 */
function placeholder(text, failed, size) {
  const el = document.createElement('span');
  el.className = failed ? 'mde-resource mde-resource-failed' : 'mde-resource';
  el.textContent = (failed ? '⚠ ' : '◌ ') + text;
  if (size) {
    // Reserving the space is what stops the document jumping when the bytes land.
    el.style.width = `${size.width}px`;
    el.style.height = `${size.height}px`;
  }
  return el;
}
