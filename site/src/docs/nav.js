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
        path: '/overview',
        file: 'overview',
        title: 'Overview',
        // The one page that opens with a statement rather than with a page title.
        hero: true,
        summary:
          'A drop-in markdown editor for iOS, macOS and the web. The document is always a plain markdown string; the editor is a text editor with a decoration layer over it.',
        keywords: 'introduction index home mde markdown editor drop-in',
      },
      {
        path: '/try',
        file: 'try',
        title: 'Try it',
        summary:
          'The real editor, running the same wasm core the test suite runs, with the reference host’s extension manifest. Type in it.',
        keywords: 'demo playground live example sandbox',
      },
    ],
  },
  {
    id: 'embed',
    title: 'Embedding',
    pages: [
      {
        path: '/install',
        file: 'install',
        title: 'Install and embed',
        summary:
          'Build the core, then mount the editor: three imports and a host element on the web, a Swift package and a text view on iOS and macOS.',
        keywords: 'setup getting started swiftpm npm build wasm xcframework quickstart',
      },
      {
        path: '/embed/react',
        file: 'react',
        title: 'React',
        summary:
          'An optional adapter package over the same framework-free editor. Uncontrolled by design, because the DOM is the buffer.',
        keywords:
          '@mde/react component hook ref imperative handle jsx uncontrolled defaultValue onChange strictmode bigint',
      },
    ],
  },
  {
    id: 'concepts',
    title: 'Concepts',
    pages: [
      {
        path: '/concepts/inline-rendering',
        file: 'inline-rendering',
        title: 'Inline rendering',
        summary:
          'Why the buffer stays markdown, what that rules out, and why every feature has to be expressible as a range plus a primitive plus a role.',
        keywords: 'wysiwyg preview source of truth portability commonmark principles',
      },
      {
        path: '/concepts/decorations',
        file: 'decorations',
        title: 'The decoration protocol',
        summary:
          'Six primitives, open roles, UTF-16 offsets, stable keys and a patch of removed, added and moved. The contract all three renderers implement.',
        keywords: 'style conceal inline widget block widget gutter hit patch key identity diff',
      },
      {
        path: '/concepts/reveal',
        file: 'reveal',
        title: 'Reveal policy',
        summary:
          'Show me the ** while I am editing this word — decided once, in the core, so it is identical on every platform and tunable per extension.',
        keywords: 'caret selection focus blur unfocused collapse markers syntax',
      },
      {
        path: '/concepts/widgets',
        file: 'widgets',
        title: 'Widgets and references',
        summary:
          'Widgets are atomic, and a document holds a reference rather than the bytes. What that means for the caret, and what the host has to resolve.',
        keywords: 'attachment image resource resolver reservedSize payload atomic selection',
      },
      {
        path: '/concepts/history',
        file: 'history',
        title: 'History and undo',
        summary:
          'The core owns the history, so undo means the same thing on three platforms — and the timeline it keeps can be listed, labelled and jumped around, not just stepped through.',
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
        path: '/extend/manifest',
        file: 'manifest',
        title: 'The extension manifest',
        summary:
          'Custom block types and inline tokens as declarative data. The full field reference for the TOML form and the compact binary form the web build uses.',
        keywords: 'toml fence directive pattern delimited callout chart mention wikilink registry',
      },
      {
        path: '/extend/layers',
        file: 'layers',
        title: 'Host decoration layers',
        summary:
          'For features that are not findable in the text at all. The host computes spans, interns its own roles and hands them over; the machinery already exists.',
        keywords: 'setLayer clearLayer internRole rebase paint order runtime roles',
      },
      {
        path: '/extend/showcase',
        file: 'showcase',
        title: 'Two extensions, no editor changes',
        summary:
          'Typewriter mode and parts-of-speech highlighting, both built entirely on the layer API, both arriving in the demo above as ordinary toolbar buttons.',
        keywords: 'typewriter focus mode parts of speech nltagger heuristic tagger toolbar',
      },
    ],
  },
  {
    id: 'platforms',
    title: 'Platform notes',
    pages: [
      {
        path: '/platforms/web',
        file: 'web',
        title: 'Web',
        summary:
          'Our own layer over contenteditable, not a framework. The one invariant it rests on, and the four things that cost more than the spec expected.',
        keywords: 'contenteditable plaintext-only dom line height codemirror ime diff',
      },
      {
        path: '/platforms/apple',
        file: 'apple',
        title: 'iOS and macOS',
        summary:
          'UITextView and NSTextView on TextKit 2, sharing one applier with no UIKit or AppKit in it. Plus the reference apps, captured.',
        keywords: 'textkit uikit appkit attachment nstextattachmentviewprovider gallery screenshots',
      },
    ],
  },
  {
    id: 'reference',
    title: 'Reference',
    pages: [
      {
        path: '/reference/web',
        file: 'ref-web',
        title: 'Web API',
        summary:
          'Every public entry point in web/src/core.ts and web/src/editor.ts, with signatures taken from the source.',
        keywords: 'loadCore Engine MarkdownEditor javascript api events setMarkdown decorations',
      },
      {
        path: '/reference/swift',
        file: 'ref-swift',
        title: 'Swift API',
        summary:
          'MarkdownEngine, MarkdownTextView and the two protocols a host implements, from apple/Sources.',
        keywords: 'MarkdownEngine MarkdownTextView WidgetProvider ResourceResolver Theme delegate',
      },
      {
        path: '/reference/ffi',
        file: 'ref-ffi',
        title: 'C ABI and wasm exports',
        summary:
          'One C ABI, two consumers — the header Swift links against, and the flat-memory protocol the hand-written wasm binding uses instead.',
        keywords: 'mde.h header repr(C) linear memory wasm exports struct layout ffi',
      },
      {
        path: '/reference/roles',
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
        path: '/internals/architecture',
        file: 'architecture',
        title: 'Architecture',
        summary:
          'The platform owns the buffer, the core owns the meaning, and undo is the one flow that travels the other way.',
        keywords: 'mirror rope desync resync undo history diagram data flow',
      },
      {
        path: '/internals/performance',
        file: 'performance',
        title: 'Performance',
        summary:
          'Reparse per keystroke, measured rather than assumed — including the optimization that was measured and thrown away.',
        keywords: 'benchmark profile incremental prefilter hash speed milliseconds',
      },
      {
        path: '/internals/testing',
        file: 'testing',
        title: 'Testing',
        summary:
          'A golden corpus the three renderers are written against, two Swift suites, a browser suite, and one command that runs all of them.',
        keywords: 'golden snapshot corpus swift test headless chrome verification',
      },
      {
        path: '/internals/status',
        file: 'status',
        title: 'Status and open questions',
        summary:
          'What is done, what is next, and the things that are known to be unresolved rather than quietly hoped about.',
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
