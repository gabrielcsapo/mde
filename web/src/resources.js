// Turning a reference in the document into something displayable.
//
// Same contract as `apple/Sources/MDEditorUI/Resources.swift`, and for the same reason:
// the document must stay a portable markdown string. A note holds
// `![chart](assets/q3.png)` — never the bytes. Inlining an image, video, or document as
// base64 would balloon the file, break diffing, and stop other markdown tools reading
// it. So the editor asks the host, which already knows where its assets live.

/**
 * @typedef {object} ResourceRequest
 * @property {string} reference  a path or URL — never content
 * @property {string|null} roleName
 * @property {string} source     full markdown source of the node
 *
 * @typedef {{state: 'loading'} | {state: 'ready', view: HTMLElement} | {state: 'failed', message: string}} ResourceState
 */

/**
 * A host implements this. Resolution is assumed asynchronous: return `{state:'loading'}`
 * and resolve the promise later. The editor reserves space meanwhile and repaints only
 * the nodes pointing at that reference, so one slow image never re-lays-out the
 * document.
 *
 * @typedef {object} ResourceResolver
 * @property {(request: ResourceRequest) => Promise<ResourceState>} resolve
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
  /**
   * @param {ResourceResolver|null} resolver
   * @param {(reference: string) => void} onResolved repaint hook
   */
  constructor(resolver, onResolved) {
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
  }

  reset() {
    this.states.clear();
    this.reserved.clear();
    // `known` deliberately survives: it describes assets, not this document.
  }

  /**
   * Seed sizes remembered from a previous session.
   * @param {Record<string, {width: number, height: number}>} sizes
   */
  remember(sizes) {
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
   * @param {{reference: string|null, roleName: string|null, source: string}} req
   * @returns {HTMLElement|null}
   */
  view(req) {
    if (!req.reference) return null;
    if (!this.resolver) return placeholder('no resolver', true, null);

    const request = {
      reference: req.reference,
      roleName: req.roleName,
      source: req.source,
    };
    const known = this.states.get(req.reference);
    if (!known) {
      // A size we have seen before beats anything the resolver can guess.
      this.reserved.set(
        req.reference,
        this.known.get(req.reference) ?? this.resolver.reservedSize(request),
      );
      this.states.set(req.reference, { state: 'loading' });
      this.start(request);
      return placeholder(basename(req.reference), false, this.reserved.get(req.reference));
    }
    if (known.state === 'ready') return known.view;
    if (known.state === 'failed') return placeholder(known.message, true, null);
    return placeholder(basename(req.reference), false, this.reserved.get(req.reference));
  }

  /** @param {ResourceRequest} request */
  async start(request) {
    let result;
    try {
      result = await this.resolver.resolve(request);
    } catch (error) {
      result = { state: 'failed', message: String(error?.message ?? error) };
    }
    // A reset between request and response means this document is gone.
    if (!this.states.has(request.reference)) return;
    this.states.set(request.reference, result);
    if (result.state === 'ready') {
      const size = measure(result.view, this.reserved.get(request.reference));
      if (size) {
        this.reserved.set(request.reference, size);
        this.known.set(request.reference, size);
      }
    }
    this.onResolved(request.reference);
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
