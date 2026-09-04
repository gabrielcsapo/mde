// The information architecture, in one file.
//
// This is the only place that knows what pages exist, what order they are in, or what
// they are about. The sidebar, the previous/next pair, the search index and the page
// header all read it, so adding a page is adding an entry here plus a component in
// `pages/` and a line in `routes.jsx` — never a fourth list to keep in sync.
//
// The order is a reading order, not an alphabet: what it is → try it → put it in your
// app → the four concepts you need to understand the protocol → how to extend it →
// what each platform actually does → the reference tables → why it is built this way.
// Previous/next walks exactly this sequence, so the site can be read front to back.
//
//   path      the URL, and the identity of the page
//   file      the module in `pages/`, which is how the search index finds its prose
//   title     the <h1>, the sidebar label and the search result heading
//   summary   the lede under the title, and the search result subtitle
//   keywords  terms a reader might search for that the prose does not literally use

/** @typedef {{path: string, file: string, title: string, summary: string, keywords?: string}} Page */
/** @typedef {{id: string, title: string, pages: Page[]}} Group */

/** @type {Group[]} */
export const GROUPS = [
  {
    id: 'start',
    title: 'Getting started',
    pages: [
      {
        path: '/docs/overview',
        file: 'overview',
        title: 'Overview',
        // The one page that opens with a statement rather than with a page title.
        hero: true,
        summary:
          'A drop-in markdown editor for iOS, macOS and the web. The document is always a plain markdown string; the editor is a text editor with a decoration layer over it.',
        keywords: 'introduction index home mdink markdown editor drop-in',
      },
      {
        path: '/docs/try',
        file: 'try',
        title: 'Try it',
        summary:
          'Edit Markdown in the browser with the JS or React integration, custom syntax, media, tables, and plugin-powered tools.',
        keywords: 'demo playground live example sandbox',
      },
    ],
  },
  {
    id: 'embed',
    title: 'Embedding',
    pages: [
      {
        path: '/docs/install',
        file: 'install',
        title: 'Install and embed',
        summary:
          'Copy-paste quickstarts for the framework-free web package, React adapter, and native Swift text view.',
        keywords: 'setup getting started swiftpm npm build wasm xcframework quickstart',
      },
      {
        path: '/docs/embed/react',
        file: 'react',
        title: 'React',
        summary:
          'An optional adapter package over the same framework-free editor. Uncontrolled by design, because the DOM is the buffer.',
        keywords:
          '@mdink/react component hook ref imperative handle jsx uncontrolled defaultValue onChange strictmode bigint',
      },
    ],
  },
  {
    id: 'concepts',
    title: 'Concepts',
    pages: [
      {
        path: '/docs/concepts/inline-rendering',
        file: 'inline-rendering',
        title: 'Inline rendering',
        summary:
          'The source remains Markdown while decorations provide rich, editable presentation in the same view.',
        keywords: 'wysiwyg preview source of truth portability commonmark principles',
      },
      {
        path: '/docs/concepts/decorations',
        file: 'decorations',
        title: 'The decoration protocol',
        summary:
          'Six rendering primitives, extensible roles, UTF-16 offsets, stable keys, and incremental decoration patches.',
        keywords: 'style conceal inline widget block widget gutter hit patch key identity diff',
      },
      {
        path: '/docs/concepts/reveal',
        file: 'reveal',
        title: 'Reveal policy',
        summary:
          'Control when concealed Markdown syntax becomes visible around the caret or selection.',
        keywords: 'caret selection focus blur unfocused collapse markers syntax',
      },
      {
        path: '/docs/concepts/widgets',
        file: 'widgets',
        title: 'Widgets and references',
        summary:
          'Define atomic widget interactions and resolve media from portable references stored in Markdown.',
        keywords: 'attachment image resource resolver reservedSize payload atomic selection',
      },
      {
        path: '/docs/concepts/history',
        file: 'history',
        title: 'History and undo',
        summary:
          'Use consistent undo, redo, revision labels, and timeline navigation on every platform.',
        keywords:
          'undo redo revisions jumpTo historyPosition timeline coalescing boundary rewind branch',
      },
    ],
  },
  {
    id: 'extend',
    title: 'Extending it',
    pages: [
      {
        path: '/docs/extend/manifest',
        file: 'manifest',
        title: 'The extension manifest',
        summary:
          'Custom block types and inline tokens as declarative data. The full field reference for the TOML form and the compact binary form the web build uses.',
        keywords: 'toml fence directive pattern delimited callout chart mention wikilink registry',
      },
      {
        path: '/docs/extend/layers',
        file: 'layers',
        title: 'Host decoration layers',
        summary:
          'Add computed styling for selections, language analysis, diagnostics, and other state outside the Markdown source.',
        keywords: 'setLayer clearLayer internRole rebase paint order runtime roles',
      },
      {
        path: '/docs/extend/plugins',
        file: 'plugins',
        title: 'Interactive plugins',
        summary:
          'Commands, popovers, suggestions, React and SwiftUI helpers, and the included authoring plugins.',
        keywords: 'plugin command palette slash menu autocomplete mention tag wikilink modal toolbar react swiftui',
      },
      {
        path: '/docs/extend/journal',
        file: 'journal',
        title: 'Journal media workflow',
        summary:
          'Picker, paste, drop, local previews, progress, cancellation, metadata, and durable attachment references.',
        keywords: 'journal photo image video audio attachment upload import photos picker drop paste progress',
      },
      {
        path: '/docs/extend/showcase',
        file: 'showcase',
        title: 'Two extensions, no editor changes',
        summary:
          'Typewriter mode and parts-of-speech highlighting built with the public decoration-layer API.',
        keywords: 'typewriter focus mode parts of speech nltagger heuristic tagger toolbar',
      },
    ],
  },
  {
    id: 'platforms',
    title: 'Platform notes',
    pages: [
      {
        path: '/docs/platforms/web',
        file: 'web',
        title: 'Web',
        summary:
          'How the web renderer maps Markdown source, selections, widgets, and decoration patches onto contenteditable.',
        keywords: 'contenteditable plaintext-only dom line height codemirror ime diff',
      },
      {
        path: '/docs/platforms/apple',
        file: 'apple',
        title: 'iOS and macOS',
        summary:
          'UITextView and NSTextView integrations that share decoration, widget, selection, and resource behavior.',
        keywords: 'textkit uikit appkit attachment nstextattachmentviewprovider gallery screenshots',
      },
    ],
  },
  {
    id: 'reference',
    title: 'Reference',
    pages: [
      {
        path: '/docs/reference/markdown',
        file: 'markdown',
        title: 'Markdown support',
        summary:
          'The exact CommonMark and GFM contract: rendered inline, preserved as source, resolved as a widget, or deliberately not enabled.',
        keywords: 'commonmark gfm support matrix footnotes math html tables tasks images links',
      },
      {
        path: '/docs/reference/web',
        file: 'ref-web',
        title: 'Web API',
        summary:
          'Every public entry point in web/src/core.ts and web/src/editor.ts, with signatures taken from the source.',
        keywords: 'loadCore Engine MarkdownEditor javascript api events setMarkdown decorations',
      },
      {
        path: '/docs/reference/swift',
        file: 'ref-swift',
        title: 'Swift API',
        summary:
          'MarkdownEngine, MarkdownTextView and the two protocols a host implements, from apple/Sources.',
        keywords: 'MarkdownEngine MarkdownTextView WidgetProvider ResourceResolver Theme delegate',
      },
      {
        path: '/docs/reference/ffi',
        file: 'ref-ffi',
        title: 'C ABI and wasm exports',
        summary:
          'The C structures used by Swift and the flat-memory interface used by the wasm binding.',
        keywords: 'mde.h header repr(C) linear memory wasm exports struct layout ffi',
      },
      {
        path: '/docs/reference/roles',
        file: 'ref-roles',
        title: 'Roles and CSS classes',
        summary:
          'The nineteen built-in role ids, what class each becomes on the web, and how an extension role is named.',
        keywords: 'heading marker emphasis strong code link quote list task rule strikethrough table html commonmark theme',
      },
    ],
  },
  {
    id: 'internals',
    title: 'Under the hood',
    pages: [
      {
        path: '/docs/internals/architecture',
        file: 'architecture',
        title: 'Architecture',
        summary:
          'The platform owns the buffer, the core owns the meaning, and undo is the one flow that travels the other way.',
        keywords: 'mirror rope desync resync undo history diagram data flow',
      },
      {
        path: '/docs/internals/performance',
        file: 'performance',
        title: 'Performance',
        summary:
          'Edit-latency budgets, benchmark results, incremental parsing, and renderer-specific performance work.',
        keywords: 'benchmark profile incremental prefilter hash speed milliseconds',
      },
      {
        path: '/docs/internals/testing',
        file: 'testing',
        title: 'Testing',
        summary:
          'Golden parser cases, Swift renderer suites, browser tests, performance budgets, and cross-platform visual checks.',
        keywords: 'golden snapshot corpus swift test vitest browser playwright chromium verification',
      },
      {
        path: '/docs/internals/status',
        file: 'status',
        title: 'Status and open questions',
        summary:
          'Implemented capabilities, current limitations, and planned work.',
        keywords: 'roadmap sequencing todo limitations firefox minified paste gutter',
      },
    ],
  },
];

/** Every page, in reading order. */
export const PAGES = GROUPS.flatMap((group) => group.pages.map((page) => ({ ...page, group })));

/** @param {string} path */
export function pageAt(path) {
  return PAGES.find((page) => page.path === path) ?? null;
}

/**
 * The pages either side of `path`, for the footer pager. Groups do not interrupt the
 * sequence — the whole site is one document, and the reader should be able to fall off
 * the end of one section into the start of the next.
 *
 * @param {string} path
 */
export function neighbours(path) {
  const i = PAGES.findIndex((page) => page.path === path);
  if (i === -1) return { previous: null, next: null };
  return { previous: PAGES[i - 1] ?? null, next: PAGES[i + 1] ?? null };
}
