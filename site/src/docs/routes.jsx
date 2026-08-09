// Path → component. The only file that imports the pages.
//
// Prose stays eager so moving between documentation pages is immediate. The one route
// that imports the editor, reference host, extensions and wasm binding is split: none of
// that code helps a reader on the landing page or in an API reference.

import { lazy } from 'react';

import Overview from './pages/overview.jsx';
const Try = lazy(() => import('./pages/try.jsx'));
import Install from './pages/install.jsx';
import React from './pages/react.jsx';
import InlineRendering from './pages/inline-rendering.jsx';
import Decorations from './pages/decorations.jsx';
import Reveal from './pages/reveal.jsx';
import Widgets from './pages/widgets.jsx';
import History from './pages/history.jsx';
import Manifest from './pages/manifest.jsx';
import Layers from './pages/layers.jsx';
import Showcase from './pages/showcase.jsx';
import Web from './pages/web.jsx';
import Apple from './pages/apple.jsx';
import RefWeb from './pages/ref-web.jsx';
import RefSwift from './pages/ref-swift.jsx';
import RefFfi from './pages/ref-ffi.jsx';
import RefRoles from './pages/ref-roles.jsx';
import MarkdownSupport from './pages/markdown.jsx';
import Architecture from './pages/architecture.jsx';
import Performance from './pages/performance.jsx';
import Testing from './pages/testing.jsx';
import Status from './pages/status.jsx';

/** Keyed by the same paths `nav.js` declares; a mismatch is a 404 the site can show. */
export const ROUTES = {
  '/overview': Overview,
  '/try': Try,
  '/install': Install,
  '/embed/react': React,
  '/concepts/inline-rendering': InlineRendering,
  '/concepts/decorations': Decorations,
  '/concepts/reveal': Reveal,
  '/concepts/widgets': Widgets,
  '/concepts/history': History,
  '/extend/manifest': Manifest,
  '/extend/layers': Layers,
  '/extend/showcase': Showcase,
  '/platforms/web': Web,
  '/platforms/apple': Apple,
  '/reference/web': RefWeb,
  '/reference/swift': RefSwift,
  '/reference/ffi': RefFfi,
  '/reference/roles': RefRoles,
  '/reference/markdown': MarkdownSupport,
  '/internals/architecture': Architecture,
  '/internals/performance': Performance,
  '/internals/testing': Testing,
  '/internals/status': Status,
};
