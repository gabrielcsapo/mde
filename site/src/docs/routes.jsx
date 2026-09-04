// Path → component. The only file that imports the pages.
//
// Every document is route-split. The landing page needs none of this prose or the large
// API reference tables, and navigation still begins fetching a page in the same click
// that updates the URL. The live editor remains an isolated chunk inside its route.

import { lazy } from 'react';

const Overview = lazy(() => import('./pages/overview.jsx'));
const Try = lazy(() => import('./pages/try.jsx'));
const Install = lazy(() => import('./pages/install.jsx'));
const React = lazy(() => import('./pages/react.jsx'));
const InlineRendering = lazy(() => import('./pages/inline-rendering.jsx'));
const Decorations = lazy(() => import('./pages/decorations.jsx'));
const Reveal = lazy(() => import('./pages/reveal.jsx'));
const Widgets = lazy(() => import('./pages/widgets.jsx'));
const History = lazy(() => import('./pages/history.jsx'));
const Manifest = lazy(() => import('./pages/manifest.jsx'));
const Layers = lazy(() => import('./pages/layers.jsx'));
const Plugins = lazy(() => import('./pages/plugins.jsx'));
const Journal = lazy(() => import('./pages/journal.jsx'));
const Showcase = lazy(() => import('./pages/showcase.jsx'));
const Web = lazy(() => import('./pages/web.jsx'));
const Apple = lazy(() => import('./pages/apple.jsx'));
const RefWeb = lazy(() => import('./pages/ref-web.jsx'));
const RefSwift = lazy(() => import('./pages/ref-swift.jsx'));
const RefFfi = lazy(() => import('./pages/ref-ffi.jsx'));
const RefRoles = lazy(() => import('./pages/ref-roles.jsx'));
const MarkdownSupport = lazy(() => import('./pages/markdown.jsx'));
const Architecture = lazy(() => import('./pages/architecture.jsx'));
const Performance = lazy(() => import('./pages/performance.jsx'));
const Testing = lazy(() => import('./pages/testing.jsx'));
const Status = lazy(() => import('./pages/status.jsx'));

/** Keyed by the same paths `nav.js` declares; a mismatch is a 404 the site can show. */
export const ROUTES = {
  '/docs/overview': Overview,
  '/docs/try': Try,
  '/docs/install': Install,
  '/docs/embed/react': React,
  '/docs/concepts/inline-rendering': InlineRendering,
  '/docs/concepts/decorations': Decorations,
  '/docs/concepts/reveal': Reveal,
  '/docs/concepts/widgets': Widgets,
  '/docs/concepts/history': History,
  '/docs/extend/manifest': Manifest,
  '/docs/extend/layers': Layers,
  '/docs/extend/plugins': Plugins,
  '/docs/extend/journal': Journal,
  '/docs/extend/showcase': Showcase,
  '/docs/platforms/web': Web,
  '/docs/platforms/apple': Apple,
  '/docs/reference/web': RefWeb,
  '/docs/reference/swift': RefSwift,
  '/docs/reference/ffi': RefFfi,
  '/docs/reference/roles': RefRoles,
  '/docs/reference/markdown': MarkdownSupport,
  '/docs/internals/architecture': Architecture,
  '/docs/internals/performance': Performance,
  '/docs/internals/testing': Testing,
  '/docs/internals/status': Status,
};
