// One compiled core per page, not one per component.
//
// `loadCore` fetches the wasm, compiles it and instantiates it. Doing that inside a
// component's mount effect means two editors on a page pay for it twice, and a
// `StrictMode` double-mount pays for it twice again before the first paint. The module
// is stateless with respect to documents — a `Core` hands out independent `Engine`s
// (`mde_engine_new` returns a handle) — so exactly one instance is needed however many
// editors exist.
//
// The cache holds the *promise*, not the resolved core, so concurrent mounts in the same
// tick share the single in-flight fetch rather than racing to start their own. A
// rejection is evicted, so a transient network failure does not poison the page.

import { DEFAULT_WASM_URL, loadCore } from '@mde/web';

export { DEFAULT_WASM_URL };

/** @type {Map<string, Promise<import('@mde/web').Core>>} */
const byUrl = new Map();
/** @type {WeakMap<object, Promise<import('@mde/web').Core>>} */
const byObject = new WeakMap();

/**
 * A stable key for a wasm source, so a component can depend on "which wasm" without
 * depending on the identity of the value that named it. `new URL(...)` in a render body
 * produces a new object every render; the string it stringifies to does not.
 *
 * @param {string|URL|ArrayBuffer|Response} source
 * @returns {string}
 */
export function wasmKey(source) {
  if (typeof source === 'string') return source;
  if (source instanceof URL) return source.href;
  return objectId(source);
}

let nextId = 0;
/** @type {WeakMap<object, string>} */
const ids = new WeakMap();
/** @param {object} value */
function objectId(value) {
  let id = ids.get(value);
  if (!id) {
    id = `#${++nextId}`;
    ids.set(value, id);
  }
  return id;
}

/**
 * The shared `Core` for a wasm source, loading it if this is the first ask.
 *
 * @param {string|URL|ArrayBuffer|Response} [source]
 * @returns {Promise<import('@mde/web').Core>}
 */
export function sharedCore(source = DEFAULT_WASM_URL) {
  if (typeof source === 'string' || source instanceof URL) {
    const key = String(source);
    let pending = byUrl.get(key);
    if (!pending) {
      pending = loadCore(key).catch((error) => {
        byUrl.delete(key);
        throw error;
      });
      byUrl.set(key, pending);
    }
    return pending;
  }

  // An `ArrayBuffer` or `Response` is consumed by `loadCore`, so it can only be used
  // once — but the promise it produced can be handed to every editor that asked with
  // that same object.
  let pending = byObject.get(source);
  if (!pending) {
    pending = loadCore(source);
    byObject.set(source, pending);
  }
  return pending;
}

/**
 * Start compiling before the first editor mounts — from a route transition, say.
 * Idempotent, and the editor will pick up the same promise.
 *
 * @param {string|URL|ArrayBuffer|Response} [source]
 */
export function preloadCore(source = DEFAULT_WASM_URL) {
  return sharedCore(source);
}

/** Number of wasm sources currently loaded or loading. Diagnostics only. */
export function loadedCoreCount() {
  return byUrl.size;
}
