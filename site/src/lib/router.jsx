// A router, rather than a router dependency.
//
// What a documentation site needs from routing is small and completely specified: read
// the current path, change it without a reload, intercept in-site links, and put the
// viewport where the reader expects it afterwards. That is this file. Shipping
// `react-router` for it would add a matcher, a data layer and a loader protocol that
// nothing here would ever call.
//
// Paths are real paths, not hashes, because `#` is spent on section anchors — a deep
// link into one idea is `/docs/concepts/reveal#unfocused`, and that only reads correctly if
// the fragment means "this heading". Vite's dev server and `vite preview` both fall back
// to `index.html` for unknown paths; `vite.config.js` also writes a `404.html` copy so
// static hosts that use one behave the same.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { withBase, withoutBase } from './base.js';

/** @typedef {{path: string, hash: string}} Route */

const RouteContext = createContext(/** @type {Route} */ ({ path: '/', hash: '' }));
const LEGACY_DOC_ROOTS = new Set([
  'overview',
  'try',
  'install',
  'embed',
  'concepts',
  'extend',
  'platforms',
  'reference',
  'internals',
]);

/** Trailing slashes are noise; `/docs/concepts/reveal/` and `/docs/concepts/reveal` are one page. */
export function normalize(path) {
  if (!path) return '/';
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** Keep previously published links working while `/docs/…` remains canonical. */
export function canonicalPath(path) {
  const normalized = normalize(path);
  if (normalized === '/docs') return '/docs/overview';
  const root = normalized.split('/')[1];
  return LEGACY_DOC_ROOTS.has(root) ? `/docs${normalized}` : normalized;
}

/** @returns {Route} */
function read() {
  const requestedPath = normalize(withoutBase(location.pathname));
  const path = canonicalPath(requestedPath);
  if (path !== requestedPath) {
    history.replaceState(null, '', `${withBase(path)}${location.search}${location.hash}`);
  }
  return { path, hash: decodeURIComponent(location.hash.slice(1)) };
}

/**
 * Go somewhere. Same entry point for links, the search palette and prev/next, so there
 * is exactly one place that decides what a navigation does.
 *
 * @param {string} href
 * @param {{replace?: boolean}} [options]
 */
export function navigate(href, { replace = false } = {}) {
  const url = new URL(href, location.href);
  // An external link is not ours to intercept.
  if (url.origin !== location.origin) {
    location.href = url.href;
    return;
  }
  url.pathname = withBase(canonicalPath(withoutBase(url.pathname)));
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  // `pushState` deliberately does not fire `popstate`, so the one listener below would
  // never hear about our own navigations. Announcing it here keeps forward navigation
  // and the back button on the same code path.
  dispatchEvent(new PopStateEvent('popstate'));
}

export function RouterProvider({ children }) {
  const [route, setRoute] = useState(read);

  useEffect(() => {
    const sync = () => setRoute(read());
    addEventListener('popstate', sync);
    // A bare `#anchor` href handled by the browser still has to reach React, because the
    // table of contents highlights from the route.
    addEventListener('hashchange', sync);
    return () => {
      removeEventListener('popstate', sync);
      removeEventListener('hashchange', sync);
    };
  }, []);

  return <RouteContext.Provider value={route}>{children}</RouteContext.Provider>;
}

/** @returns {Route} */
export function useRoute() {
  return useContext(RouteContext);
}

/**
 * Put the viewport where the reader expects it after a navigation.
 *
 * A new page starts at the top. A fragment scrolls to its heading — `scroll-margin-top`
 * in the stylesheet keeps it clear of the sticky bar, so nothing here needs to know how
 * tall that is.
 *
 * The timeout is not decoration: the target element only exists after React has
 * committed the new page. `requestAnimationFrame` would be the usual choice and is
 * deliberately avoided — it never fires in a backgrounded tab, which is a real state for
 * a page being screenshotted or restored, and a scroll that silently never happens is
 * worse than one a frame late.
 *
 * @param {Route} route
 */
export function useScrollToRoute(route) {
  useEffect(() => {
    const id = setTimeout(() => {
      if (route.hash) {
        const el = document.getElementById(route.hash);
        if (el) {
          el.scrollIntoView({ behavior: 'auto', block: 'start' });
          return;
        }
      }
      scrollTo({ top: 0, behavior: 'auto' });
    }, 0);
    return () => clearTimeout(id);
  }, [route.path, route.hash]);
}

/**
 * An in-site link. Falls back to ordinary browser behaviour for anything the reader
 * clearly meant to do themselves — a modified click, a middle click, a new tab.
 *
 * @param {{to: string, children: any, className?: string} & Record<string, any>} props
 */
export function Link({ to, children, onClick, ...rest }) {
  const handle = useCallback(
    (/** @type {MouseEvent} */ event) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      navigate(to);
    },
    [to, onClick]
  );

  return (
    <a href={withBase(to)} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
