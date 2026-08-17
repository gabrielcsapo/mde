// Web renderer tests.
//
// These run in a real browser rather than under a DOM shim, deliberately: every hard
// bug in this layer — contenteditable behaviour, selection restore, CSS precedence on
// concealed runs — only exists in a real engine. Vitest Browser Mode drives Chromium
// through Playwright so input and layout stay native.

import { afterEach, beforeAll, expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../src/theme.css';
import '../extensions/extensions.css';

import {
  IGNORE_ATTR,
  Kind,
  MarkdownEditor,
  MediaPreviewCache,
  MarkdownSession,
  ResourceCache,
  Role,
  composeManifests,
  definePlugin,
  diffText,
  encodeManifest,
  loadCore,
  markdownCommand,
  executeMarkdownCommand,
  prepareDocument,
} from '../dist/index.js';
// Deliberately imported from `../extensions/`, not `../src/`: these are not part of the
// editor, and testing them here is the check that they never needed to be.
import { TypewriterMode } from '../dist/extensions/typewriter.js';
import { PartsOfSpeech, tagWord } from '../dist/extensions/parts-of-speech.js';
import {
  attachmentComposer,
  mentionAutocomplete,
  slashCommandMenu,
  tagAutocomplete,
  wikilinkAutocomplete,
} from '../dist/extensions/composer.js';
import { suggestionPlugin } from '../dist/extensions/suggestions.js';
import { findAndReplace, linkEditor, templatePicker } from '../dist/extensions/productivity.js';
import { journalAttachments } from '../dist/extensions/journal-attachments.js';
import { checkPluginCompatibility } from '../dist/plugin-testing.js';
import { backlinks, mediaGallery } from '../dist/extensions/examples.js';

function assert(condition, message) {
  expect(condition, message).toBeTruthy();
}

function assertEqual(actual, expected, message) {
  expect(actual, message).toEqual(expected);
}

const manifestSpec = {
  blocks: [
    {
      name: 'callout',
      syntax: { kind: 'fence', info: 'callout' },
      render: 'block_widget',
      reveal: 'caret_in_block',
    },
  ],
  inlines: [
    {
      name: 'mention',
      syntax: { kind: 'pattern', regex: '@[a-zA-Z0-9_-]+' },
      render: 'inline_widget',
      reveal: 'caret_in_node',
    },
  ],
};

/**
 * The invariant the whole host rests on: the DOM's text, excluding presentation-only
 * subtrees, is exactly the markdown source.
 */
function domText(root) {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (n) =>
        n.nodeType === Node.ELEMENT_NODE
          ? n.hasAttribute(IGNORE_ATTR)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_SKIP
          : NodeFilter.FILTER_ACCEPT,
    }
  );
  let text = '';
  let node;
  while ((node = walker.nextNode())) text += node.data;
  return text;
}

let core;

beforeAll(async () => {
  core = await loadCore('/dist/mde.wasm');
});

const sandbox = document.createElement('div');
sandbox.id = 'sandbox';
sandbox.style.cssText = 'width:100%;max-width:600px;border:1px dashed #ccc;margin-top:24px';
document.body.appendChild(sandbox);

const editors = [];

function trackedEditor(host, engine, options = {}) {
  const editor = new MarkdownEditor(host, engine, options);
  editors.push({ editor, engine });
  return editor;
}

afterEach(() => {
  for (const { editor, engine } of editors.reverse()) {
    editor.destroy();
    if (engine.handle !== 0) engine.free();
  }
  editors.length = 0;
  sandbox.replaceChildren();
  document.getSelection()?.removeAllRanges();
});

test('video posters and audio waveforms persist across cache instances', async () => {
  const name = `mde-preview-test-${crypto.randomUUID()}`;
  const first = new MediaPreviewCache({ name, maxEntries: 4 });
  let generations = 0;
  const generate = async (kind) => {
    generations++;
    await new Promise((resolve) => setTimeout(resolve, 40));
    return new Blob([kind], { type: 'image/webp' });
  };
  const video = { kind: 'video-poster', reference: 'journal.mov', width: 640, version: 'v1' };
  const audio = { kind: 'audio-waveform', reference: 'voice.m4a', width: 640, version: 'v1' };

  const coldStarted = performance.now();
  await first.getOrCreate(video, () => generate('poster'));
  await first.getOrCreate(audio, () => generate('waveform'));
  const cold = performance.now() - coldStarted;

  // A new instance models reopening the journal after the in-memory editor is gone.
  const reopened = new MediaPreviewCache({ name, maxEntries: 4 });
  const warmStarted = performance.now();
  const poster = await reopened.getOrCreate(video, () => generate('wrong'));
  const waveform = await reopened.getOrCreate(audio, () => generate('wrong'));
  const warm = performance.now() - warmStarted;

  assertEqual(await poster.text(), 'poster');
  assertEqual(await waveform.text(), 'waveform');
  assertEqual(generations, 2);
  assertEqual(reopened.stats.persistentHits, 2);
  expect(warm).toBeLessThan(cold);
  await reopened.clear();
});

test('media preview identities include size/version and persistent storage stays bounded', async () => {
  const name = `mde-preview-bounds-${crypto.randomUUID()}`;
  const previews = new MediaPreviewCache({ name, maxEntries: 2 });
  let generations = 0;
  for (const [width, version] of [[320, 'v1'], [640, 'v1'], [640, 'v2']]) {
    await previews.getOrCreate(
      { kind: 'video-poster', reference: 'clip.mov', width, version },
      () => new Blob([String(++generations)]),
    );
  }

  assertEqual(generations, 3);
  assertEqual((await (await caches.open(name)).keys()).length, 2);
  await previews.clear();
});

/** @param {object} [options] */
function makeEditor(options = {}) {
  const host = document.createElement('div');
  sandbox.replaceChildren(host);
  const engine = core.newEngine(encodeManifest(manifestSpec));
  return trackedEditor(host, engine, options);
}

  // ---- pure helpers -------------------------------------------------------

  test('diffText finds a single insertion', () => {
    assertEqual(diffText('hello world', 'hello brave world'), {
      start: 6,
      end: 6,
      text: 'brave ',
    });
  });

  test('diffText finds a single deletion', () => {
    assertEqual(diffText('hello brave world', 'hello world'), {
      start: 6,
      end: 12,
      text: '',
    });
  });

  test('diffText never splits a surrogate pair', () => {
    const d = diffText('a😀b', 'a😀X b');
    const rebuilt = 'a😀b'.slice(0, d.start) + d.text + 'a😀b'.slice(d.end);
    assertEqual(rebuilt, 'a😀X b', 'diff did not reconstruct the new text');
  });

  test('a malformed manifest is rejected rather than silently ignored', () => {
    let threw = false;
    try {
      encodeManifest({ inlines: [{ name: 'x', syntax: { kind: 'nope' }, render: 'style' }] });
    } catch {
      threw = true;
    }
    assert(threw, 'unknown syntax kind should throw');
  });

  test('independent manifests compose without mutating their packages', () => {
    const first = { inlines: [manifestSpec.inlines[0]] };
    const second = { blocks: [manifestSpec.blocks[0]] };
    const combined = composeManifests(first, second);
    assertEqual(combined.inlines.length, 1);
    assertEqual(combined.blocks.length, 1);
    combined.inlines[0].name = 'changed';
    assertEqual(first.inlines[0].name, 'mention', 'composition mutated a plugin manifest');
  });

  test('manifest composition rejects ambiguous extension names', () => {
    expect(() => composeManifests(
      { inlines: [manifestSpec.inlines[0]] },
      { inlines: [manifestSpec.inlines[0]] },
    )).toThrow(/Duplicate inline extension name "mention"/);
  });

  // ---- decorations --------------------------------------------------------

  test('the storage is exactly the markdown source', () => {
    const e = makeEditor();
    const source = '# Title\n\nSome **bold** and ![a](x.png).';
    e.setMarkdown(source);
    assertEqual(e.markdown, source);
    assertEqual(domText(e.root), source, 'DOM text diverged from the source');
  });

  test('a bare editor exposes native text-editing semantics', () => {
    const e = makeEditor();
    assertEqual(e.root.getAttribute('role'), 'textbox');
    assertEqual(e.root.getAttribute('aria-multiline'), 'true');
    assertEqual(e.root.getAttribute('aria-label'), 'Markdown editor');
    assertEqual(e.root.getAttribute('spellcheck'), 'true');
  });

  test('host accessibility and spellcheck preferences win', () => {
    const host = document.createElement('div');
    host.setAttribute('aria-label', 'Release notes');
    host.setAttribute('spellcheck', 'false');
    document.getElementById('sandbox').replaceChildren(host);
    const engine = core.newEngine(encodeManifest(manifestSpec));
    const e = trackedEditor(host, engine);

    assertEqual(e.root.getAttribute('aria-label'), 'Release notes');
    assertEqual(e.root.getAttribute('spellcheck'), 'false');
  });

  test('destroy detaches listeners before a host is reused', () => {
    const host = document.createElement('div');
    document.getElementById('sandbox').replaceChildren(host);
    const old = trackedEditor(host, core.newEngine(encodeManifest(manifestSpec)));
    old.setMarkdown('old');
    old.destroy();

    const current = trackedEditor(host, core.newEngine(encodeManifest(manifestSpec)));
    current.setMarkdown('new');
    current.root.focus();
    current.setSelectionRange({ start: 3, end: 3 });
    const event = new InputEvent('beforeinput', {
      inputType: 'insertParagraph',
      bubbles: true,
      cancelable: true,
    });
    current.root.dispatchEvent(event);

    assertEqual(current.markdown, 'new\n');
    assertEqual(old.markdown, 'old', 'the destroyed editor still handled input');
  });

  test('markers are concealed while unfocused', () => {
    const e = makeEditor();
    e.setMarkdown('hello **world** end');
    const marker = e.decorations.find((d) => d.start === 6 && d.end === 8);
    assertEqual(marker.kind, Kind.Conceal);
    const span = [...e.root.querySelectorAll('.mde-conceal')].find(
      (el) => el.textContent === '**'
    );
    assert(span, 'no concealed span rendered for the "**"');
  });

  test('conceal wins over the role styling on the same run', () => {
    const e = makeEditor();
    e.setMarkdown('## Heading');
    const marker = [...e.root.querySelectorAll('.mde-conceal')].find(
      (el) => el.textContent === '## '
    );
    assert(marker, 'the "## " was not concealed');
    // Regression guard: `.mde-h2` and `.mde-conceal` are both single-class selectors,
    // so without !important the heading's font-size wins on source order.
    const size = parseFloat(getComputedStyle(marker).fontSize);
    assert(size < 1, `concealed marker rendered at ${size}px`);
  });

  test('only the node under the caret reveals', () => {
    const e = makeEditor();
    e.setMarkdown('**one** and *two*');
    e.root.focus();
    e.setSelectionRange({ start: 3, end: 3 });
    e.onSelectionChange();

    const strongMarker = e.decorations.find((d) => d.start === 0 && d.end === 2);
    const emMarker = e.decorations.find((d) => d.start === 12 && d.end === 13);
    assertEqual(strongMarker.kind, Kind.Style, 'the caret’s own markers should reveal');
    assertEqual(emMarker.kind, Kind.Conceal, 'the other node should stay collapsed');
  });

  test('blur collapses the document again', () => {
    const e = makeEditor();
    e.setMarkdown('**one**');
    e.root.focus();
    e.setSelectionRange({ start: 3, end: 3 });
    e.onSelectionChange();
    assertEqual(e.decorations.find((d) => d.start === 0).kind, Kind.Style);

    e.applyPatch(e.engine.setSelection(null));
    assertEqual(e.decorations.find((d) => d.start === 0).kind, Kind.Conceal);
  });

  test('an unregistered fence stays styled source', () => {
    const e = makeEditor();
    e.setMarkdown('```swift\nlet x = 1\n```\n');
    assert(
      !e.decorations.some((d) => d.kind === Kind.BlockWidget),
      'an unregistered fence became a widget'
    );
    assert(e.root.querySelector('.mde-code-block'), 'it should render as code');
  });

  test('a GFM table resolves nested images as semantic HTML without changing source', async () => {
    let resolutions = 0;
    const e = makeEditor({
      resourceResolver: {
        async resolve({ reference }) {
          resolutions++;
          const image = document.createElement('img');
          image.src = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="blue"/></svg>`;
          image.width = 160;
          image.height = 90;
          image.dataset.reference = reference;
          return { state: 'ready', view: image };
        },
        reservedSize: () => ({ width: 160, height: 90 }),
      },
    });
    const source =
      '| Name | Detail | Asset |\n' +
      '| :--- | :----: | ----: |\n' +
      '| **Ada** | [profile](https://example.dev) + `10` | ![chart](chart.png) |\n';
    e.setMarkdown(source);
    await Promise.resolve();
    await Promise.resolve();

    const table = e.root.querySelector('table.mde-rendered-table');
    assert(table, 'the table did not become a real table element');
    assertEqual(table.querySelectorAll('thead th').length, 3);
    assertEqual(table.querySelectorAll('tbody td').length, 3);
    assertEqual(table.querySelector('thead th')?.textContent, 'Name');
    assertEqual(table.querySelector('thead th:last-child')?.dataset.align, 'right');
    assertEqual(table.querySelector('tbody td:nth-child(2)')?.dataset.align, 'center');
    assert(table.querySelector('strong, .mde-strong'), 'bold content was flattened');
    assert(table.querySelector('.mde-link-text'), 'link content was flattened');
    assert(table.querySelector('.mde-code-inline'), 'inline code was flattened');
    const image = table.querySelector('img.mde-table-resource-image');
    assert(image, 'the resource resolver did not produce a real table image');
    assertEqual(image.getAttribute('aria-label') ?? image.alt, 'chart');
    assertEqual(image.dataset.reference, 'chart.png');
    assertEqual(resolutions, 1, 'the table fetched the same resource more than once');
    assertEqual(
      e.root.querySelectorAll('img').length,
      1,
      'the nested image was also rendered as a duplicate full-size widget'
    );
    assertEqual(e.decorations.filter((d) => d.role === Role.TableCell).length, 6);
    assertEqual(domText(e.root), source, 'the semantic view changed the Markdown source');
  });

  test('table images support reference syntax and mixed text through the core', async () => {
    const requested = [];
    const e = makeEditor({
      resourceResolver: {
        async resolve({ reference }) {
          requested.push(reference);
          const image = document.createElement('img');
          image.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
          image.dataset.reference = reference;
          return { state: 'ready', view: image };
        },
        reservedSize: () => ({ width: 64, height: 36 }),
      },
    });
    const source =
      '| Mixed | Reference |\n' +
      '| :--- | ---: |\n' +
      '| before ![chart][chart-ref] after | ![photo][photo-ref] |\n\n' +
      '[chart-ref]: chart.png\n' +
      '[photo-ref]: photo.png\n';
    e.setMarkdown(source);
    await Promise.resolve();
    await Promise.resolve();

    const table = e.root.querySelector('table.mde-rendered-table');
    assertEqual(table?.querySelectorAll('img.mde-table-resource-image').length, 2);
    assert(table?.textContent.includes('before') && table?.textContent.includes('after'));
    assertEqual(requested.sort(), ['chart.png', 'photo.png']);
    assertEqual(domText(e.root), source);
  });

  test('a 100 by 10 table projects within the interactive test budget', () => {
    const columns = Array.from({ length: 10 }, (_, index) => `C${index}`);
    const rows = Array.from({ length: 100 }, (_, row) =>
      `| ${columns.map((_, column) => `r${row}c${column}`).join(' | ')} |`
    );
    const source =
      `| ${columns.join(' | ')} |\n` +
      `| ${columns.map(() => '---').join(' | ')} |\n` +
      `${rows.join('\n')}\n`;
    const e = makeEditor();
    const started = performance.now();
    e.setMarkdown(source);
    const elapsed = performance.now() - started;

    assertEqual(e.root.querySelectorAll('tbody td').length, 1000);
    assertEqual(domText(e.root), source);
    assert(elapsed < 1500, `large table projection took ${elapsed.toFixed(1)}ms`);
  });

  test('clicking a rendered table reveals its editable pipe source', () => {
    const e = makeEditor();
    const source = '| Name | Score |\n| :--- | ----: |\n| Ada | 10 |\n\nafter\n';
    e.setMarkdown(source);

    const cell = e.root.querySelector('tbody td');
    assert(cell, 'the rendered table has no body cell to click');
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    assert(!e.root.querySelector('table.mde-rendered-table'), 'the table view stayed over its source');
    assertEqual(e.root.querySelectorAll('.mde-line-table').length, 3);
    assertEqual(e.selectionRange(), { start: 0, end: 0 });
    assertEqual(domText(e.root), source, 'revealing the table changed its source');

    const after = source.indexOf('after');
    e.setSelectionRange({ start: after, end: after });
    e.onSelectionChange();
    assert(e.root.querySelector('table.mde-rendered-table'), 'the table did not render again');
  });

  test('selecting table rows reveals the exact Markdown range then restores the grid', () => {
    const e = makeEditor();
    const source =
      '| Person | Platform | Detail |\n' +
      '| :--- | :---: | ---: |\n' +
      '| **Ada** | [Web](https://example.dev) | `Wasm` |\n' +
      '| **Grace** | *iOS* | ![chart](chart.png) |\n' +
      '| **Linus** | ~~macOS~~ | `FFI` |\n\n' +
      'after\n';
    e.setMarkdown(source);
    e.root.focus();

    const start = source.indexOf('| **Ada**');
    const end = source.indexOf('| **Linus**');
    e.setSelectionRange({ start, end });
    e.onSelectionChange();

    assert(!e.root.querySelector('table.mde-rendered-table'), 'the grid covered selected source');
    assertEqual(e.root.querySelectorAll('.mde-line-table').length, 5);
    const firstSourceLine = e.root.querySelector('.mde-line-table-start');
    assert(firstSourceLine, 'the first editable table line was not marked');
    const sourceStyle = getComputedStyle(firstSourceLine);
    assertEqual(sourceStyle.backgroundColor, 'rgba(0, 0, 0, 0)');
    assertEqual(sourceStyle.borderTopWidth, '0px');
    assertEqual(sourceStyle.borderLeftWidth, '0px');
    assertEqual(sourceStyle.paddingLeft, '0px');
    assertEqual(sourceStyle.boxShadow, 'none');
    assertEqual(e.selectionRange(), { start, end });
    assertEqual(document.getSelection()?.toString(), source.slice(start, end));
    assertEqual(domText(e.root), source, 'selecting rows changed the Markdown source');

    const after = source.indexOf('after');
    e.setSelectionRange({ start: after, end: after });
    e.onSelectionChange();
    assert(e.root.querySelector('table.mde-rendered-table'), 'the grid did not return');
    assertEqual(domText(e.root), source);
  });

  test('CommonMark autolinks render as links without changing their source', () => {
    const e = makeEditor();
    const source = '<https://example.dev> and <hello@example.dev>';
    e.setMarkdown(source);

    assertEqual(e.root.querySelectorAll('.mde-link-text').length, 2);
    assertEqual(e.root.querySelectorAll('.mde-conceal').length, 4);
    assertEqual(domText(e.root), source);
  });

  test('Command or Control click requests link navigation without changing source', () => {
    const e = makeEditor();
    const source = '[docs](https://example.dev/docs)';
    e.setMarkdown(source);
    e.root.focus();
    e.setSelectionRange({ start: 2, end: 2 });
    let opened = null;
    e.addEventListener('linkopen', (event) => {
      opened = event.detail.destination;
    });
    e.onClick(new MouseEvent('click', { ctrlKey: true, cancelable: true }));
    assertEqual(opened, 'https://example.dev/docs');
    assertEqual(e.markdown, source);
  });

  test('setext headings use their parsed level and conceal the underline', () => {
    const e = makeEditor();
    e.setMarkdown('Heading\n-------\n');

    assert(e.root.querySelector('.mde-heading.mde-h2'), 'setext heading did not render as h2');
    const underline = [...e.root.querySelectorAll('.mde-conceal')].find(
      (el) => el.textContent === '-------'
    );
    assert(underline, 'setext underline was not concealed');
  });

  test('block quote markers project as rails without changing their source', () => {
    const e = makeEditor();
    const source = '> quoted\n> > nested\n';
    e.setMarkdown(source);

    const quotes = [...e.root.querySelectorAll('.mde-quote')];
    assertEqual(quotes.length, 3);
    assertEqual(quotes.map((quote) => quote.textContent).join(''), '>>>');
    assertEqual(getComputedStyle(quotes[0]).color, 'rgba(0, 0, 0, 0)');
    assertEqual(getComputedStyle(quotes[0], '::after').content, '\"\"');
    assertEqual(domText(e.root), source);
    assertEqual(e.markdown, source);
  });

  test('thematic breaks and code scaffolding project without changing source', () => {
    const e = makeEditor();
    const source = '---\n\n    indented\n\n```swift\nfenced\n```\n';
    e.setMarkdown(source);

    const rule = e.root.querySelector('.mde-rule');
    assert(rule, 'thematic break did not reach its projection');
    assertEqual(getComputedStyle(rule).color, 'rgba(0, 0, 0, 0)');
    assertEqual(getComputedStyle(rule, '::after').content, '\"\"');
    const concealed = [...e.root.querySelectorAll('.mde-conceal')].map((item) => item.textContent);
    assert(concealed.includes('    '), 'indented code scaffolding stayed visible');
    assert(concealed.includes('```swift\n'), 'opening fence stayed visible');
    assert(concealed.includes('```'), 'closing fence stayed visible');
    assertEqual(domText(e.root), source);
    assertEqual(e.markdown, source);
  });

  test('every CommonMark help spelling reaches the browser renderer', () => {
    const e = makeEditor();
    const cases = [
      ['*italic*', '.mde-emphasis'],
      ['_italic_', '.mde-emphasis'],
      ['**bold**', '.mde-strong'],
      ['__bold__', '.mde-strong'],
      ['## heading\n', '.mde-heading.mde-h2'],
      ['heading\n-------\n', '.mde-heading.mde-h2'],
      ['[label](https://example.dev)', '.mde-link-text'],
      ['[label][id]\n\n[id]: /path\n', '.mde-link-text'],
      ['> quoted\n', '.mde-quote'],
      ['* item\n', '.mde-list-unordered'],
      ['- item\n', '.mde-list-unordered'],
      ['+ item\n', '.mde-list-unordered'],
      ['1. item\n', '.mde-list-ordered'],
      ['1) item\n', '.mde-list-ordered'],
      ['---\n', '.mde-rule'],
      ['***\n', '.mde-rule'],
      ['* * *\n', '.mde-rule'],
      ['`code`', '.mde-code-inline'],
      ['```\ncode\n```\n', '.mde-code-block'],
      ['    code\n', '.mde-code-block'],
    ];
    for (const [source, selector] of cases) {
      e.setMarkdown(source);
      assert(e.root.querySelector(selector), `${JSON.stringify(source)} did not render ${selector}`);
      assertEqual(domText(e.root), source, `${JSON.stringify(source)} changed its source`);
    }

    for (const source of ['![alt](chart.png)', '![alt][image]\n\n[image]: chart.png\n']) {
      e.setMarkdown(source);
      assert(e.decorations.some((item) => item.role === Role.Image), 'image missed the widget path');
      assert(e.root.querySelector('.mde-widget'), 'image did not reach the browser widget renderer');
      assertEqual(domText(e.root), source);
    }
  });

  test('raw HTML is visibly source, not ordinary prose', () => {
    const e = makeEditor();
    const source = 'Press <kbd>Enter</kbd>.';
    e.setMarkdown(source);
    assertEqual(e.root.querySelectorAll('.mde-html').length, 2);
    assertEqual(domText(e.root), source);
  });

  // ---- widgets ------------------------------------------------------------

  test('an inline widget renders a view and conceals its source', () => {
    const e = makeEditor({
      widgetProvider: {
        makeWidget: ({ roleName, source }) => {
          if (roleName !== 'mention') return null;
          const el = document.createElement('span');
          el.textContent = source;
          return el;
        },
      },
    });
    e.setMarkdown('ping @gabe now');
    const widget = e.root.querySelector('.mde-widget');
    assert(widget, 'no widget rendered');
    assertEqual(domText(e.root), 'ping @gabe now', 'the widget view leaked into the text');
  });

  test('a block widget draws once, not once per line', () => {
    let calls = 0;
    const e = makeEditor({
      widgetProvider: {
        makeWidget: ({ roleName }) => {
          if (roleName !== 'callout') return null;
          calls++;
          const el = document.createElement('div');
          el.textContent = 'callout';
          return el;
        },
      },
    });
    e.setMarkdown('```callout warning\nline one\nline two\n```\n');
    assertEqual(calls, 1, 'the host was asked to draw the block more than once');
    assertEqual(
      domText(e.root),
      '```callout warning\nline one\nline two\n```\n',
      'the block widget disturbed the source'
    );
  });

  test('a fence argument reaches the host as a payload', () => {
    let seen = null;
    const e = makeEditor({
      widgetProvider: {
        makeWidget: ({ roleName, payload }) => {
          if (roleName === 'callout') seen = payload;
          return null;
        },
      },
    });
    e.setMarkdown('```callout warning\nbody\n```\n');
    assertEqual(seen, 'warning');
  });

  test('a widget does not capture clicks, so the caret can reach its source', () => {
    const e = makeEditor({
      widgetProvider: {
        makeWidget: ({ roleName }) => {
          if (roleName !== 'mention') return null;
          const el = document.createElement('span');
          el.textContent = 'chip';
          return el;
        },
      },
    });
    e.setMarkdown('ping @gabe now');
    const view = e.root.querySelector('.mde-widget-view');
    assert(view, 'no widget view');
    // Regression guard: a contenteditable=false element swallows the click, and the
    // widget then has no way to be edited at all.
    assertEqual(getComputedStyle(view).pointerEvents, 'none');
  });

  test('a widget can opt back into handling its own clicks', () => {
    const e = makeEditor({
      widgetProvider: {
        makeWidget: () => document.createElement('button'),
        widgetWantsPointerEvents: () => true,
      },
    });
    e.setMarkdown('ping @gabe now');
    const view = e.root.querySelector('.mde-widget-view');
    assertEqual(getComputedStyle(view).pointerEvents, 'auto');
  });

  test('putting the caret in a widget reveals its source', () => {
    const e = makeEditor({
      widgetProvider: {
        makeWidget: () => document.createElement('span'),
      },
    });
    e.setMarkdown('ping @gabe now');
    assertEqual(
      e.decorations.find((d) => d.start === 5).kind,
      Kind.InlineWidget,
      'should start collapsed'
    );

    e.root.focus();
    e.setSelectionRange({ start: 7, end: 7 }); // inside "@gabe"
    e.onSelectionChange();
    assertEqual(
      e.decorations.find((d) => d.start === 5).kind,
      Kind.Style,
      'the caret in the widget’s source must reveal it for editing'
    );
  });

  test('a widget wrapper is a real box, not a one-line inline span', () => {
    const e = makeEditor({
      widgetProvider: {
        makeWidget: ({ roleName }) => {
          if (roleName !== 'callout') return null;
          const el = document.createElement('div');
          el.style.height = '120px';
          return el;
        },
      },
    });
    e.setMarkdown('```callout warning\nbody\n```\n');
    const wrap = e.root.querySelector('.mde-widget');
    assert(wrap, 'no widget');
    // Regression guard: as a plain inline span the wrapper's hit box is one line tall
    // however tall its content is, so clicks in the middle of a widget miss it entirely
    // and land on whatever text is nearest.
    assert(
      getComputedStyle(wrap).display !== 'inline',
      'the wrapper must be a block-ish box or it cannot be clicked'
    );
    assert(wrap.getBoundingClientRect().height > 100, 'the wrapper should cover its content');
  });

  test('clicking a widget puts the caret at the start of its source', () => {
    const e = makeEditor({
      widgetProvider: {
        makeWidget: ({ roleName }) => {
          if (roleName !== 'callout') return null;
          const el = document.createElement('div');
          el.style.height = '120px';
          return el;
        },
      },
    });
    e.setMarkdown('intro\n\n```callout warning\nbody\n```\n\ntail\n');

    const wrap = e.root.querySelector('.mde-widget');
    const key = wrap.getAttribute('data-mde-key');
    const d = [...e.applier.live.values()].find((x) => String(x.key) === key);
    assert(d, 'no decoration for the widget');

    // Dispatched on the wrapper rather than resolved through `elementFromPoint`: the
    // two properties that matter are tested separately and deterministically — that
    // the wrapper is a real hit target (the test above), and that a click on it lands
    // the caret in the source (here). Going through real hit testing would make this
    // pass or fail on the window's size.
    const box = wrap.getBoundingClientRect();
    wrap.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      })
    );

    // Without this the browser maps the click to the nearest real text geometry — the
    // line *below* the widget, since the source itself is concealed to a hairline.
    assertEqual(e.selectionRange(), { start: d.start, end: d.start });
    assertEqual(
      e.decorations.find((x) => x.start === d.start).kind,
      Kind.Style,
      'clicking a widget should reveal its source'
    );
  });

  // ---- references ---------------------------------------------------------

  test('a reference reaches the resolver and resolves once', async () => {
    /** @type {string[]} */
    const requested = [];
    const e = makeEditor({
      resourceResolver: {
        resolve: async ({ reference }) => {
          requested.push(reference);
          const el = document.createElement('span');
          el.textContent = 'loaded';
          return { state: 'ready', view: el };
        },
        reservedSize: () => ({ width: 100, height: 60 }),
      },
    });
    e.setMarkdown('![a](same.png) and ![b](same.png)');

    assertEqual(requested, ['same.png'], 'the cache should collapse the second use');
    // The document still holds only the path.
    assertEqual(e.markdown, '![a](same.png) and ![b](same.png)');

    await new Promise((r) => setTimeout(r, 30));
    assert(
      e.root.textContent.includes('loaded'),
      'the resolved view was never painted in'
    );
    assertEqual(
      domText(e.root),
      '![a](same.png) and ![b](same.png)',
      'the resolved view leaked into the document text'
    );
  });

  test('destroy cancels a late resource repaint before the engine is freed', async () => {
    let release;
    const engine = core.newEngine(encodeManifest(manifestSpec));
    const host = document.createElement('div');
    document.getElementById('sandbox').replaceChildren(host);
    const e = trackedEditor(host, engine, {
      resourceResolver: {
        resolve: () => new Promise((resolve) => { release = resolve; }),
        reservedSize: () => ({ width: 100, height: 60 }),
      },
    });
    e.setMarkdown('![a](late.png)');

    const failures = [];
    const onUnhandled = (event) => {
      failures.push(event.reason);
      event.preventDefault();
    };
    addEventListener('unhandledrejection', onUnhandled);
    e.destroy();
    engine.free();

    const view = document.createElement('span');
    view.textContent = 'too late';
    release({ state: 'ready', view });
    await new Promise((resolve) => setTimeout(resolve, 20));
    removeEventListener('unhandledrejection', onUnhandled);

    assertEqual(failures.length, 0, 'late resolution touched a freed engine');
    assertEqual(host.childNodes.length, 0, 'late resolution repainted a destroyed host');
  });

  test('a missing resolver degrades instead of throwing', () => {
    const e = makeEditor();
    e.setMarkdown('![a](x.png)');
    assert(e.root.querySelector('.mde-resource-failed'), 'expected a failure placeholder');
  });

  // ---- editing and undo ---------------------------------------------------

  test('typing through the browser keeps the model and DOM in step', async () => {
    const e = makeEditor();
    e.setMarkdown('hello **world** end');
    e.root.focus();
    e.setSelectionRange({ start: 13, end: 13 });
    await userEvent.keyboard('ly');

    assertEqual(e.markdown, 'hello **worldly** end');
    assertEqual(domText(e.root), e.markdown, 'DOM diverged from the model after typing');
    assert(
      e.decorations.some(
        (d) => d.role === Role.Strong && e.markdown.slice(d.start, d.end) === 'worldly'
      ),
      'the bold run did not grow with the text'
    );
  });

  test('a typing run undoes as one step and redoes', async () => {
    const e = makeEditor();
    const source = 'hello **world** end';
    e.setMarkdown(source);
    e.root.focus();
    e.setSelectionRange({ start: 13, end: 13 });
    await userEvent.keyboard('ly');

    assert(e.canUndo, 'nothing recorded to undo');
    e.undo();
    assertEqual(e.markdown, source);
    assertEqual(domText(e.root), source, 'DOM diverged from the model after undo');

    assert(e.canRedo);
    e.redo();
    assertEqual(e.markdown, 'hello **worldly** end');
  });

  test('a command fenced by boundaries undoes in one step', () => {
    const e = makeEditor();
    e.setMarkdown('word');
    e.closeUndoGroup();
    e.replaceRange(0, 4, '**word**');
    e.closeUndoGroup();
    assertEqual(e.markdown, '**word**');

    e.undo();
    assertEqual(e.markdown, 'word', 'both markers should come off together');
  });

  test('toggling a task rewrites the source and undoes', () => {
    const e = makeEditor();
    e.setMarkdown('- [ ] a task\n');
    const checkbox = e.decorations.find((d) => d.role === Role.TaskCheckbox);
    assert(checkbox, 'no checkbox decoration');
    e.toggleTask(checkbox);
    assertEqual(e.markdown, '- [x] a task\n');
    e.undo();
    assertEqual(e.markdown, '- [ ] a task\n');

    e.setMarkdown('- [X] already checked\n');
    const uppercase = e.decorations.find((d) => d.role === Role.TaskCheckbox);
    assert(uppercase, 'no uppercase checkbox decoration');
    e.toggleTask(uppercase);
    assertEqual(e.markdown, '- [ ] already checked\n');
  });

  test('lists project bullets and checkboxes while keeping exact editable source', () => {
    const e = makeEditor();
    const source = '* star\n  - nested dash\n    + nested plus\n1. ordered\n2) parenthesized\n- [ ] open\n- [x] done\n';
    e.setMarkdown(source);

    assertEqual(domText(e.root), source);
    assertEqual(e.root.querySelectorAll('.mde-list-unordered').length, 3);
    assertEqual(e.root.querySelectorAll('.mde-list-ordered').length, 2);
    assert(e.root.querySelector('.mde-list-depth-3'), 'nested marker lost its depth');
    const tasks = [...e.root.querySelectorAll('.mde-task-projected')];
    assertEqual(tasks.length, 2);
    assert(!tasks[0].classList.contains('mde-task-checked'));
    assert(tasks[1].classList.contains('mde-task-checked'));

    const open = source.indexOf('[ ]');
    e.root.focus();
    e.setSelectionRange({ start: open + 1, end: open + 1 });
    e.onSelectionChange();
    assertEqual(domText(e.root), source);
    assertEqual(
      [...e.root.querySelectorAll('.mde-task-projected')].length,
      1,
      'the selected checkbox did not reveal its Markdown source',
    );
  });

  test('undo restores the caret to where the edit began', () => {
    const e = makeEditor();
    e.setMarkdown('abc');
    e.root.focus();
    e.setSelectionRange({ start: 3, end: 3 });
    e.onSelectionChange();
    e.replaceRange(3, 3, 'def');
    e.setSelectionRange({ start: 0, end: 0 });
    e.onSelectionChange();

    e.undo();
    assertEqual(e.selectionRange(), { start: 3, end: 3 });
  });

  test('inserting a newline splits lines without disturbing the rest', () => {
    const e = makeEditor();
    e.setMarkdown('one\n**two**\nthree');
    const before = e.decorations.length;
    e.replaceRange(3, 3, '\nX');
    assertEqual(e.markdown, 'one\nX\n**two**\nthree');
    assertEqual(domText(e.root), e.markdown);
    assertEqual(e.decorations.length, before, 'decoration count changed unexpectedly');
  });

  test('UTF-16 offsets survive emoji and CJK', () => {
    const e = makeEditor();
    const source = '😀 **b** 日本';
    e.setMarkdown(source);
    const strong = e.decorations.find((d) => d.role === Role.Strong);
    assertEqual(source.slice(strong.start, strong.end), 'b');
    assertEqual(domText(e.root), source);
  });

  // ---- bounds --------------------------------------------------------------
  //
  // The renderer is where a bad offset actually crashes: every range is used to slice a
  // string and to place a DOM range. These push it past what any person would type.

  test('a document that is one enormous line', () => {
    const e = makeEditor();
    e.setMarkdown('word '.repeat(20000));
    assertEqual(domText(e.root), e.markdown, 'DOM diverged on a single huge line');
  });

  test('a pathological line stays one editable node while decorations remain exact', () => {
    const e = makeEditor();
    const source = 'word **strong** @same résumé 日本語 🎉 '.repeat(1700);
    e.setMarkdown(source);
    const before = e.decorations.length;
    const line = e.root.querySelector('.mde-line-pathological');
    assert(line, 'the hostile line expanded into styled run DOM');
    assertEqual(line.childNodes.length, 1);
    e.replaceRange(source.length / 2, source.length / 2, 'x');
    assertEqual(domText(e.root), e.markdown);
    assert(e.decorations.length >= before - 2, 'the compact host lost the core model');
    assertEqual(e.root.querySelector('.mde-line-pathological')?.childNodes.length, 1);
  });

  test('thousands of unclosed markers do not break rendering', () => {
    for (const text of ['*'.repeat(5000), '['.repeat(5000), '`'.repeat(5000)]) {
      const e = makeEditor();
      e.setMarkdown(text);
      assertEqual(domText(e.root), text, 'DOM diverged on unclosed markers');
    }
  });

  test('adversarial unicode round-trips through the DOM', () => {
    for (const text of [
      '😀'.repeat(2000),
      'a\u0301'.repeat(2000),
      '\u202Ereversed\u202C **bold**',
      '\u200B'.repeat(2000),
      '\uFFFCobject replacement **x**',
    ]) {
      const e = makeEditor();
      e.setMarkdown(text);
      assertEqual(e.markdown, text, 'the model changed');
      assertEqual(domText(e.root), text, 'the DOM diverged');
    }
  });

  test('an empty document and a lone newline are editable', () => {
    for (const text of ['', '\n', '\n\n\n', ' ']) {
      const e = makeEditor();
      e.setMarkdown(text);
      assertEqual(domText(e.root), text);
      e.replaceRange(text.length, text.length, 'x');
      assertEqual(e.markdown, text + 'x');
      assertEqual(domText(e.root), e.markdown, 'DOM diverged after editing');
    }
  });

  test('a bounded session saves and restores source and selection', () => {
    const e = makeEditor();
    const session = new MarkdownSession(e, { maxDocuments: 2 });
    session.open('one', 'first note');
    e.replaceRange(5, 5, ' edited');
    session.open('two', 'second note');
    session.open('three', 'third note');

    assertEqual(session.openDocumentIds, ['two', 'three']);
    assertEqual(session.switchTo('one'), false, 'the oldest inactive document was not evicted');
    assertEqual(session.switchTo('two'), true);
    assertEqual(e.markdown, 'second note');
    assertEqual(session.snapshot('three').markdown, 'third note');
  });

  test('warm session projections are separately bounded and remain editable', () => {
    const e = makeEditor();
    const session = new MarkdownSession(e, { maxDocuments: 5, maxWarmDocuments: 2 });
    const note = (label) => `# ${label}\n\n` + '**journal** paragraph\n'.repeat(3000);
    session.open('one', note('one'));
    session.open('two', note('two'));
    session.open('three', note('three'));
    assertEqual(session.warmDocumentIds, ['one', 'two']);
    session.switchTo('two');
    e.replaceRange(0, 0, 'x');
    assert(e.markdown.startsWith('x# two'));
    session.switchTo('three');
    session.switchTo('two');
    assert(e.markdown.startsWith('x# two'), 'warm switching restored stale source');
    assert(session.warmDocumentIds.length <= 2);
  });

  test('commands are pure, selection-aware, and undo as one step', () => {
    assertEqual(markdownCommand('bold', 'hello', { start: 0, end: 5 }), {
      start: 0, end: 5, text: '**hello**', selection: { start: 2, end: 7 },
    });
    const e = makeEditor();
    e.setMarkdown('hello');
    e.root.focus();
    e.setSelectionRange({ start: 0, end: 5 });
    assert(executeMarkdownCommand(e, 'bold'));
    assertEqual(e.markdown, '**hello**');
    e.undo();
    assertEqual(e.markdown, 'hello');
  });

  test('block commands transform every selected line', () => {
    assertEqual(markdownCommand('ordered-list', 'one\ntwo', { start: 0, end: 7 }).text,
      '1. one\n2. two');
    assertEqual(markdownCommand('task-list', 'one\ntwo', { start: 0, end: 7 }).text,
      '- [ ] one\n- [ ] two');
  });

  test('a programmatic edit is valid before the first setMarkdown call', () => {
    const e = makeEditor();
    e.replaceRange(0, 0, 'first\nedit');
    assertEqual(e.markdown, 'first\nedit');
    assertEqual(domText(e.root), e.markdown);
  });

  test('an edit storm keeps the DOM and the model identical', () => {
    const e = makeEditor();
    e.setMarkdown('');
    const fragments = ['# h\n\n', '**b** ', '`c` ', '@x ', '[[w]] ', '\n\n', '- i\n'];
    let seed = 12345;
    for (let step = 0; step < 400; step++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const at = seed % (e.markdown.length + 1);
      const frag = fragments[(seed >> 8) % fragments.length];
      e.replaceRange(at, at, frag);
      if (domText(e.root) !== e.markdown) {
        throw new Error(`DOM diverged at step ${step}`);
      }
    }
  });

  test('deleting the whole document and undoing restores it exactly', () => {
    const e = makeEditor();
    const source = '# Title\n\n**bold** and @mention\n\ntail\n';
    e.setMarkdown(source);
    e.replaceRange(0, source.length, '');
    assertEqual(e.markdown, '');
    assertEqual(domText(e.root), '');

    e.undo();
    assertEqual(e.markdown, source);
    assertEqual(domText(e.root), source, 'DOM diverged after undoing a full delete');
  });

  test('invalid programmatic edits are atomic and leave both mirrors usable', () => {
    const e = makeEditor();
    const source = 'A😀B\n';
    e.setMarkdown(source);
    const invalid = [
      [-1, 0],
      [3, 2],
      [0, source.length + 1],
      [1.5, 2],
      [2, 2], // between the emoji's UTF-16 surrogate pair
    ];
    for (const [start, end] of invalid) {
      let rejected = false;
      try {
        e.replaceRange(start, end, 'x');
      } catch (error) {
        rejected = error instanceof RangeError;
      }
      assert(rejected, `invalid range ${start}..${end} was accepted`);
      assertEqual(e.markdown, source);
      assertEqual(domText(e.root), source);
    }

    e.replaceRange(3, 4, 'C');
    assertEqual(e.markdown, 'A😀C\n');
    assertEqual(domText(e.root), e.markdown);
  });

  test('selection can be placed at every offset of a hostile document', () => {
    const e = makeEditor();
    const source = '😀**bold**日本\n\n```callout x\nbody\n```\n\n@who [[link]]\n';
    e.setMarkdown(source);
    e.root.focus();
    for (let at = 0; at <= source.length; at++) {
      e.setSelectionRange({ start: at, end: at });
      e.onSelectionChange();
    }
    assertEqual(domText(e.root), source, 'DOM diverged while moving the caret');
  });

  test('a large document renders and stays consistent', () => {
    const e = makeEditor();
    const source = '# Section\n\nSome **bold** and @who text.\n\n'.repeat(1500);
    e.setMarkdown(source);
    assertEqual(domText(e.root), source, 'DOM diverged on a large document');
    // And an edit in the middle still lands correctly.
    const at = Math.floor(source.length / 2);
    e.replaceRange(at, at, 'Z');
    assertEqual(domText(e.root), e.markdown);
  });

  test('a large-document edit splits only the locally changed line model', () => {
    const e = makeEditor();
    const source = 'line content\n'.repeat(10_000);
    e.setMarkdown(source);
    const firstLine = e.lineEls[0];
    const distantLine = e.lineEls[9_000];
    const at = source.length - 3;

    e.replaceRange(at, at, 'Z');

    assert(e.lineEls[0] === firstLine, 'an edit near EOF rebuilt the untouched prefix');
    assert(e.lineEls[9_000] === distantLine, 'a distant untouched line was rebuilt');
    assertEqual(e.lines.length, 10_001);
    assertEqual(e.lineStarts[10_000], e.markdown.length);
    assertEqual(domText(e.root), e.markdown);
  });

  test('a large suffix crosses wasm as one compact shift', () => {
    const e = makeEditor();
    const source = Array.from({ length: 500 }, (_, i) => `**item ${i}**\n\n`).join('');
    e.setMarkdown(source);
    const edit = e.engine.edit.bind(e.engine);
    let observed;
    e.engine.edit = (...args) => {
      observed = edit(...args);
      return observed;
    };

    e.replaceRange(0, 0, 'x');

    assertEqual(observed.shifted.length, 1);
    assertEqual(observed.shifted[0].delta, 1);
    assert(observed.moved.length < 8, 'the suffix expanded back into individual moves');
    assertEqual(domText(e.root), e.markdown);
  });

  test('a large deletion crosses wasm as a negative compact shift', () => {
    const e = makeEditor();
    const source = `x${Array.from({ length: 500 }, (_, i) => `**item ${i}**\n\n`).join('')}`;
    e.setMarkdown(source);
    const edit = e.engine.edit.bind(e.engine);
    let observed;
    e.engine.edit = (...args) => {
      observed = edit(...args);
      return observed;
    };

    e.replaceRange(0, 1, '');

    assertEqual(observed.shifted.length, 1);
    assertEqual(observed.shifted[0].delta, -1);
    assert(observed.moved.length < 8, 'the deletion expanded back into individual moves');
    assertEqual(domText(e.root), e.markdown);
  });

  test('an explicit move overrides a compact suffix shift', () => {
    const e = makeEditor();
    e.setMarkdown('**first**\n\n**second**\n');
    const decorations = e.decorations.filter((d) => d.role === Role.Strong);
    const first = decorations[0];
    const second = decorations[1];
    const firstStart = first.start;
    const secondStart = second.start;
    const secondEnd = second.end;

    e.applier.ingest({
      removed: [],
      added: [],
      shifted: [{ start: firstStart, delta: 3 }],
      moved: [{ key: second.key, start: secondStart, end: secondEnd }],
    });

    assertEqual(e.applier.live.get(first.key).start, firstStart + 3);
    assertEqual(e.applier.live.get(second.key).start, secondStart);
    assertEqual(e.applier.live.get(second.key).end, secondEnd);
  });

  test('large documents are grouped into viewport-contained layout regions', () => {
    const e = makeEditor();
    const source = 'line with **formatting**\n'.repeat(10_000);
    e.setMarkdown(source);

    assert(e.chunkEls.length > 100, 'the document was left as one unbounded layout tree');
    assert(
      e.chunkEls.every((chunk) => getComputedStyle(chunk).contentVisibility === 'auto'),
      'an offscreen group is not eligible for browser layout/paint skipping',
    );
    assert(
      e.chunkEls.every((chunk) => chunk.childElementCount <= 64),
      'an initial containment group exceeds its bounded line count',
    );
    assertEqual(domText(e.root), source, 'containment changed the editable source');

    const firstChunk = e.chunkEls[0];
    const distantChunk = e.chunkEls[100];
    e.replaceRange(source.length - 3, source.length - 3, 'Z');
    assert(e.chunkEls[0] === firstChunk, 'a local edit rebuilt the first layout group');
    assert(e.chunkEls[100] === distantChunk, 'a local edit rebuilt a distant layout group');
  });

  test('large-document compact chunks preserve source and hydrate for selection', async () => {
    const e = makeEditor();
    const source = Array.from({ length: 5000 }, (_, index) => `line ${index} **bold**`).join('\n');
    e.setMarkdown(source);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const compact = e.root.querySelectorAll('.mde-chunk-virtual');
    assert(compact.length > 60, 'distant chunks were still fully materialized');
    assertEqual(domText(e.root), source, 'virtualization removed source text');
    assert(
      e.root.querySelectorAll('*').length < 1500,
      'compact rendering retained the full styled DOM',
    );

    const target = source.indexOf('line 4000') + 5;
    e.root.focus();
    e.setSelectionRange({ start: target, end: target + 4 });
    assertEqual(e.selectionRange(), { start: target, end: target + 4 });
    const chunk = e.chunkEls[Math.floor(e.lineIndexAt(target, e.lineStarts) / 64)];
    assert(!chunk.classList.contains('mde-chunk-virtual'), 'selected source did not hydrate');
    assertEqual(domText(e.root), source, 'hydration changed the Markdown projection');
  });

  test('plain source does not allocate redundant run wrappers', () => {
    const e = makeEditor();
    e.setMarkdown('plain source\nnext line');

    assertEqual(e.root.querySelectorAll('.mde-run').length, 0);
    assertEqual(domText(e.root), e.markdown);
  });

  test('native typing stays at the caret inside a contained large document', async () => {
    const e = makeEditor();
    const source = 'line content\n'.repeat(1_000);
    e.root.style.cssText = 'display:block;max-height:240px;overflow:auto';
    e.setMarkdown(source);
    e.root.scrollTop = e.root.scrollHeight;
    e.root.focus();
    const at = source.length - 2;
    e.setSelectionRange({ start: at, end: at });

    await userEvent.keyboard('Z');

    assertEqual(e.markdown, source.slice(0, at) + 'Z' + source.slice(at));
    assert(e.activeChunk?.classList.contains('mde-viewport-active'));
    assertEqual(domText(e.root), e.markdown);
  });

  test('selection repaint near EOF reuses the large document line index', () => {
    const e = makeEditor();
    const source = 'ordinary text\n'.repeat(10_000);
    e.setMarkdown(source);
    const lines = e.lines;
    const starts = e.lineStarts;
    const at = source.length - 2;

    e.applyPatch(e.engine.setSelection({ start: at, end: at }), null, null);

    assert(e.lines === lines, 'a selection-only repaint split the entire document again');
    assert(e.lineStarts === starts, 'a selection-only repaint rebuilt every line offset');
    assertEqual(e.lineIndexAt(at, starts), 9_999);
    assertEqual(domText(e.root), source);
  });

  test('a widget view is built once and reused across re-renders', () => {
    let calls = 0;
    const e = makeEditor({
      widgetProvider: {
        makeWidget: ({ roleName }) => {
          if (roleName !== 'mention') return null;
          calls++;
          const el = document.createElement('span');
          el.textContent = 'chip';
          return el;
        },
      },
    });
    e.setMarkdown('hello @gabe there\n');
    assertEqual(calls, 1, 'the first render should build the view');

    // Type on the same line, several times. The mention's own source never changes, so
    // its key is stable and the host must not be asked to draw it again.
    for (const ch of 'abcd') {
      e.replaceRange(5, 5, ch);
    }
    assertEqual(calls, 1, 'the widget view was rebuilt on an unrelated edit');
    assertEqual(domText(e.root), e.markdown, 'reusing the view disturbed the text');
    assert(e.root.querySelector('.mde-widget-view span'), 'the reused view left the DOM');
  });

  test('editing a widget\'s own source rebuilds its view', () => {
    let calls = 0;
    const e = makeEditor({
      widgetProvider: {
        makeWidget: ({ roleName, source }) => {
          if (roleName !== 'mention') return null;
          calls++;
          const el = document.createElement('span');
          el.textContent = source;
          return el;
        },
      },
    });
    e.setMarkdown('hi @gabe\n');
    assertEqual(calls, 1);
    // Extend the mention: different source, so a different key, so a new view.
    e.replaceRange(8, 8, 'x');
    assertEqual(e.markdown, 'hi @gabex\n');
    assertEqual(calls, 2, 'the widget view went stale rather than rebuilding');
    assertEqual(
      e.root.querySelector('.mde-widget-view span').textContent,
      '@gabex',
      'the cached view survived a source change'
    );
  });

  test('the widget cache does not grow without bound', () => {
    const e = makeEditor({
      widgetProvider: {
        makeWidget: ({ roleName, source }) => {
          if (roleName !== 'mention') return null;
          const el = document.createElement('span');
          el.textContent = source;
          return el;
        },
      },
    });
    let source = '';
    for (let i = 0; i < 900; i++) source += `line @user${i} here\n`;
    e.setMarkdown(source);
    assert(
      e.applier.widgetViews.size <= e.applier.widgetCacheLimit,
      `cache held ${e.applier.widgetViews.size} views, over the limit`
    );
    assertEqual(
      e.applier.widgetViews.size,
      e.applier.widgetOrder.length,
      'the cache map and its eviction order disagree'
    );
    assertEqual(domText(e.root), source, 'eviction disturbed the document');
  });

  test('a resolved resource size is remembered and reused for the next reservation', async () => {
    const sizes = [];
    const resolver = {
      reservedSize: () => {
        sizes.push('guessed');
        return { width: 40, height: 40 };
      },
      resolve: async () => {
        const el = document.createElement('span');
        el.setAttribute('width', '300');
        el.setAttribute('height', '120');
        return { state: 'ready', view: el };
      },
    };
    const e = makeEditor({ resourceResolver: resolver });
    e.setMarkdown('![a](photo.png)\n');
    await Promise.resolve();
    await Promise.resolve();

    assertEqual(
      JSON.stringify(e.resourceSizes),
      JSON.stringify({ 'photo.png': { width: 300, height: 120 } }),
      'the resolved size was not remembered'
    );

    // A second document holding the same asset must not have to guess again.
    sizes.length = 0;
    e.setMarkdown('![a](photo.png)\n');
    assertEqual(sizes.length, 0, 'the resolver was asked to guess a size it already knew');
  });

  test('a stale resource completion cannot overwrite the same path after reset', async () => {
    const pending = [];
    const resolved = [];
    const cache = new ResourceCache(
      {
        resolve: () => new Promise((deliver) => pending.push(deliver)),
        reservedSize: () => ({ width: 40, height: 20 }),
      },
      (reference) => resolved.push(reference)
    );
    const request = {
      reference: 'same.png', roleName: 'image', source: '![x](same.png)',
    };

    cache.view(request);
    cache.reset();
    cache.view(request);
    const stale = document.createElement('span');
    stale.dataset.version = 'stale';
    pending[0]({ state: 'ready', view: stale });
    await Promise.resolve();
    await Promise.resolve();

    assertEqual(cache.states.get('same.png')?.state, 'loading');
    assertEqual(resolved, [], 'the stale document triggered a repaint');

    const current = document.createElement('span');
    current.dataset.version = 'current';
    pending[1]({ state: 'ready', view: current });
    await Promise.resolve();
    await Promise.resolve();

    assertEqual(cache.view(request)?.dataset.version, 'current');
    assertEqual(resolved, ['same.png']);
  });

  test('replacing a media-heavy document aborts every outstanding load', async () => {
    const signals = [];
    const cache = new ResourceCache(
      {
        resolve: ({ signal }) => {
          signals.push(signal);
          return new Promise(() => {});
        },
        reservedSize: () => ({ width: 160, height: 90 }),
      },
      () => {},
    );
    for (let index = 0; index < 320; index++) {
      cache.view({
        reference: `asset-${index}.jpg`,
        roleName: 'image',
        source: `![${index}](asset-${index}.jpg)`,
      });
    }
    cache.reset();

    assertEqual(signals.length, 6, 'the scheduler started more than its concurrency limit');
    assert(signals.every((signal) => signal.aborted), 'a replaced document kept media work alive');
    assertEqual(cache.states.size, 0);
  });

  test('background suspension cancels speculative media and resumes on demand', async () => {
    const signals = [];
    const cache = new ResourceCache(
      {
        resolve: ({ signal }) => {
          signals.push(signal);
          return new Promise(() => {});
        },
        reservedSize: () => ({ width: 160, height: 90 }),
      },
      () => {},
      { maxConcurrent: 2 },
    );
    const request = {
      reference: 'background.jpg', roleName: 'image', source: '![x](background.jpg)',
    };
    cache.view(request);
    cache.suspend();
    assert(signals[0].aborted, 'backgrounding kept a decode alive');
    cache.view(request);
    assertEqual(signals.length, 1, 'a suspended cache started new work');

    cache.resume();
    cache.view(request);
    assertEqual(signals.length, 2, 'resuming did not restart visible media');
  });

  test('editor background transitions preserve exact source', async () => {
    const e = makeEditor();
    e.setMarkdown('# Day 1\n\nA **journal** entry.\n');
    e.suspend();
    assert(e.root.hasAttribute('data-mde-suspended'));
    e.resume();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    assertEqual(e.markdown, '# Day 1\n\nA **journal** entry.\n');
    assert(!e.root.hasAttribute('data-mde-suspended'));
  });

  test('viewport scheduling probes logarithmically many chunks', async () => {
    const e = makeEditor();
    const source = Array.from({ length: 64 * 512 }, (_, index) => `line ${index}`).join('\n');
    e.root.style.cssText = 'display:block;width:600px;height:400px;overflow:auto';
    e.setMarkdown(source);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const before = e.viewportLayoutProbeCount;
    const hydratedBefore = e.viewportHydratedChunkVisitCount;
    e.root.scrollTop = e.root.scrollHeight;
    e.root.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const probes = e.viewportLayoutProbeCount - before;
    const hydratedVisits = e.viewportHydratedChunkVisitCount - hydratedBefore;
    assert(probes <= 40, `scroll read ${probes} chunk bounds for ${e.chunkEls.length} chunks`);
    assert(hydratedVisits <= 12,
      `scroll visited ${hydratedVisits} hydrated chunks for ${e.chunkEls.length} total chunks`);
    const hydrated = e.chunkEls.filter(
      (chunk) => !chunk.classList.contains('mde-chunk-virtual'),
    ).length;
    assert(hydrated <= 4, `scroll retained ${hydrated} hydrated chunks`);
    assertEqual(e.markdown, source);
  });

  test('resource scheduling is bounded and drains in priority order', async () => {
    const started = [];
    const pending = new Map();
    const cache = new ResourceCache(
      {
        resolve: ({ reference }) => new Promise((deliver) => {
          started.push(reference);
          pending.set(reference, deliver);
        }),
        reservedSize: () => ({ width: 160, height: 90 }),
      },
      () => {},
      { maxConcurrent: 2 },
    );
    for (let index = 0; index < 5; index++) {
      cache.view({
        reference: `asset-${index}.jpg`,
        roleName: 'image',
        source: `![${index}](asset-${index}.jpg)`,
      });
    }
    cache.prioritize(['asset-4.jpg']);
    assertEqual(started, ['asset-0.jpg', 'asset-1.jpg', 'asset-4.jpg', 'asset-2.jpg']);
    assertEqual(cache.peakConcurrent, 2);

    pending.get('asset-4.jpg')({ state: 'failed', message: 'expected' });
    await Promise.resolve();
    await Promise.resolve();
    assertEqual(started, ['asset-0.jpg', 'asset-1.jpg', 'asset-4.jpg', 'asset-2.jpg', 'asset-3.jpg']);

    for (const reference of ['asset-2.jpg', 'asset-3.jpg']) {
      pending.get(reference)?.({ state: 'failed', message: 'expected' });
      await Promise.resolve();
      await Promise.resolve();
    }
    assertEqual(started.length, 5);
    assertEqual(cache.active.size, 0);
  });

  test('resolved web media views obey decoded-byte budgets and dispose on eviction', async () => {
    const disposed = [];
    const cache = new ResourceCache(
      {
        async resolve({ reference }) {
          const view = document.createElement('img');
          view.width = 1024;
          view.height = 1024;
          return {
            state: 'ready', view, memoryCostBytes: 4 * 1024 * 1024,
            dispose: () => disposed.push(reference),
          };
        },
        reservedSize: () => ({ width: 512, height: 512 }),
      },
      () => {},
    );
    cache.maxReadyViews = 100;
    cache.maxReadyViewMemoryBytes = 9 * 1024 * 1024;
    for (let index = 0; index < 4; index++) {
      cache.view({ reference: `large-${index}.jpg`, roleName: 'image', source: '' });
    }
    while (cache.active.size > 0 || cache.pending.length > 0) {
      await Promise.resolve();
      await Promise.resolve();
    }
    assertEqual(cache.readyViewCount, 2, `memory=${cache.readyViewMemoryBytes}`);
    assertEqual(cache.readyViewMemoryBytes, 8 * 1024 * 1024);
    assertEqual(disposed.length, 2);
    cache.reset();
    assertEqual(disposed.length, 4);
  });

  test('estimated media bytes bound concurrent browser decodes', async () => {
    const pending = new Map();
    const cache = new ResourceCache({
      estimatedMemoryCostBytes: () => 4 * 1024 * 1024,
      resolve: ({ reference }) => new Promise((resolve) => pending.set(reference, resolve)),
      reservedSize: () => ({ width: 320, height: 180 }),
    }, () => {}, { maxConcurrent: 6 });
    cache.maxInFlightMemoryBytes = 9 * 1024 * 1024;
    for (let index = 0; index < 6; index++) {
      cache.view({ reference: `large-${index}.jpg`, roleName: 'image', source: '' });
    }
    assertEqual(cache.active.size, 2);
    assertEqual(cache.peakInFlightMemoryBytes, 8 * 1024 * 1024);
    pending.get('large-0.jpg')({ state: 'failed', message: 'expected' });
    await Promise.resolve();
    await Promise.resolve();
    assertEqual(cache.active.size, 2);
    assertEqual(cache.pending.length, 3);
  });

  test('browser resource resolvers can publish a progressive preview', async () => {
    let finish;
    const resolved = [];
    const cache = new ResourceCache({
      resolve: ({ publishPreview }) => new Promise((resolve) => {
        const preview = document.createElement('img');
        preview.dataset.quality = 'preview';
        publishPreview({ state: 'ready', view: preview, memoryCostBytes: 64 * 1024 });
        finish = resolve;
      }),
      reservedSize: () => ({ width: 320, height: 180 }),
    }, (reference) => resolved.push(reference));
    const request = { reference: 'photo.jpg', roleName: 'image', source: '' };
    cache.view(request);
    await Promise.resolve();
    assertEqual(cache.view(request)?.dataset.quality, 'preview');
    const final = document.createElement('img');
    final.dataset.quality = 'final';
    finish({ state: 'ready', view: final, memoryCostBytes: 1024 * 1024 });
    await Promise.resolve();
    await Promise.resolve();
    assertEqual(cache.view(request)?.dataset.quality, 'final');
    assertEqual(resolved, ['photo.jpg', 'photo.jpg']);
  });

  test('resolved web media views are retained within a viewport-sized LRU', async () => {
    const cache = new ResourceCache(
      {
        async resolve({ reference }) {
          const view = document.createElement('img');
          view.dataset.reference = reference;
          view.width = 320;
          view.height = 180;
          return { state: 'ready', view };
        },
        reservedSize: () => ({ width: 320, height: 180 }),
      },
      () => {},
    );
    cache.maxReadyViews = 12;
    for (let index = 0; index < 100; index++) {
      cache.view({
        reference: `photo-${index}.jpg`, roleName: 'image',
        source: `![${index}](photo-${index}.jpg)`,
      });
    }
    while (cache.active.size > 0 || cache.pending.length > 0) {
      await Promise.resolve();
      await Promise.resolve();
    }
    assertEqual(cache.readyViewCount, 12);
    assertEqual(cache.known.size, 100, 'evicting views discarded remembered geometry');
  });

  test('hundreds of resources reuse duplicates and isolate failures', async () => {
    let requested = 0;
    const cache = new ResourceCache(
      {
        async resolve({ reference }) {
          requested++;
          if (reference.endsWith('-13.jpg')) throw new Error('decode failed');
          const view = document.createElement('img');
          view.width = 160;
          view.height = 90;
          return { state: 'ready', view };
        },
        reservedSize: () => ({ width: 160, height: 90 }),
      },
      () => {},
    );
    for (let index = 0; index < 640; index++) {
      const unique = index % 320;
      cache.view({
        reference: `asset-${unique}.jpg`,
        roleName: 'image',
        source: `![${index}](asset-${unique}.jpg)`,
      });
    }
    while (cache.active.size > 0 || cache.pending.length > 0) {
      await Promise.resolve();
      await Promise.resolve();
    }

    assertEqual(requested, 320, 'duplicate references started duplicate loads');
    assertEqual(cache.readyViewCount, 32);
    assertEqual(cache.known.size, 319);
    assertEqual(cache.states.get('asset-13.jpg')?.state, 'failed');
    assertEqual(cache.states.get('asset-319.jpg')?.state, 'ready');
  });

  test('resource reference lookup stays indexed and follows edits', () => {
    const e = makeEditor();
    const source = Array.from({ length: 600 }, (_, index) => `![${index}](asset-${index}.png)`)
      .join('\n') + '\n';
    e.setMarkdown(source);

    const originalPayload = e.engine.payload.bind(e.engine);
    let payloadCalls = 0;
    e.engine.payload = (key) => {
      payloadCalls++;
      return originalPayload(key);
    };
    const target = e.applier.rangesReferencing('asset-599.png');
    assertEqual(target.length, 1);
    assertEqual(payloadCalls, 0, 'lookup fell back to scanning payloads');

    const at = e.markdown.lastIndexOf('asset-599.png');
    e.replaceRange(at, at + 'asset-599.png'.length, 'renamed.png');
    payloadCalls = 0;
    assertEqual(e.applier.rangesReferencing('asset-599.png'), []);
    assertEqual(e.applier.rangesReferencing('renamed.png').length, 1);
    assertEqual(payloadCalls, 0, 'edited lookup fell back to scanning payloads');
  });

  test('remembered sizes can be seeded from a previous session', () => {
    let guessed = 0;
    const e = makeEditor({
      resourceResolver: {
        reservedSize: () => {
          guessed++;
          return { width: 40, height: 40 };
        },
        resolve: () => new Promise(() => {}),
      },
    });
    e.resourceSizes = { 'photo.png': { width: 300, height: 120 } };
    e.setMarkdown('![a](photo.png)\n');
    assertEqual(guessed, 0, 'a seeded size was ignored');
    // Junk must not be trusted into the cache.
    e.resourceSizes = { bad: { width: 0, height: 0 } };
    assertEqual(e.resourceSizes.bad, undefined, 'a zero size was remembered');
  });

  test('a block widget takes up no more room than the view it draws', () => {
    const e = makeEditor({
      widgetProvider: {
        makeWidget: ({ roleName }) => {
          if (roleName !== 'callout') return null;
          const el = document.createElement('div');
          el.style.height = '40px';
          el.textContent = 'callout';
          return el;
        },
      },
    });
    e.setMarkdown('before\n\n```callout warning\nline one\nline two\n```\n\nafter\n');

    const lines = [...e.root.querySelectorAll('.mde-line')];
    const withWidget = lines.filter((l) => l.querySelector('.mde-widget-block'));
    assertEqual(withWidget.length, 4, 'expected the fence to span four lines');

    // Only the line that draws the widget may occupy space. The rest carry nothing but
    // concealed source, and concealing shrinks glyphs without collapsing the line box —
    // so without an explicit collapse these render as full-height empty bands.
    const [drawn, ...rest] = withWidget;
    for (const [i, l] of rest.entries()) {
      assertEqual(
        Math.round(l.getBoundingClientRect().height),
        0,
        `continuation line ${i + 1} still occupies vertical space`
      );
    }

    // And the drawn line must not be taller than the view plus its own margins: an
    // inline concealed run sitting after a block-level view generates an anonymous line
    // box sized by the widget's strut, which is invisible but very much there.
    const view = drawn.querySelector('.mde-widget-view');
    const drawnH = drawn.getBoundingClientRect().height;
    const viewH = view.getBoundingClientRect().height;
    assert(viewH > 0, 'the widget view did not lay out at all');
    assert(
      drawnH - viewH < 12,
      `the widget line is ${Math.round(drawnH - viewH)}px taller than the view it draws`
    );

    assertEqual(
      domText(e.root),
      'before\n\n```callout warning\nline one\nline two\n```\n\nafter\n',
      'collapsing the continuation lines changed the document text'
    );
  });

  // ---- extensions (DESIGN §5.3) -------------------------------------------

  test('a plugin receives events and owns an automatically namespaced layer', () => {
    const e = makeEditor();
    let changes = 0;
    let cleaned = 0;
    let retainedContext;
    const plugin = definePlugin({
      name: 'test.marker',
      setup(context) {
        retainedContext = context;
        const role = context.internRole('plugin-marker');
        const update = () => {
          changes++;
          context.setLayer('marks', [{ start: 0, end: 5, role }]);
        };
        context.on('change', update);
        return () => { cleaned++; };
      },
    });

    e.installPlugin(plugin);
    e.setMarkdown('hello plugin');
    assertEqual(changes, 1);
    assertEqual(e.installedPlugins, ['test.marker']);
    assert(e.decorations.some((d) => d.role === e.internRole('plugin-marker')));

    assert(e.removePlugin('test.marker'));
    assertEqual(cleaned, 1);
    assert(!e.decorations.some((d) => d.role === e.internRole('plugin-marker')));
    retainedContext.setLayer('late', [{ start: 0, end: 5, role: e.internRole('plugin-marker') }]);
    assert(!e.decorations.some((d) => d.layer > 0), 'a stale plugin context stayed active');
    e.setMarkdown('hello again');
    assertEqual(changes, 1, 'the removed plugin still received editor events');
  });

  test('a failed plugin setup rolls back listeners, layers, and its reserved name', () => {
    const e = makeEditor();
    e.setMarkdown('hello');
    let changes = 0;
    const panel = document.createElement('div');
    const broken = definePlugin({
      name: 'test.broken',
      setup(context) {
        const role = context.internRole('broken-marker');
        context.on('change', () => { changes++; });
        context.onRoot('keydown', () => { changes++; });
        context.showPresentation('partial', { element: panel, anchor: 'editor' });
        context.setLayer('partial', [{ start: 0, end: 5, role }]);
        throw new Error('setup failed');
      },
    });
    expect(() => e.installPlugin(broken)).toThrow(/setup failed/);
    assertEqual(e.installedPlugins, []);
    assert(!panel.isConnected, 'failed setup leaked a presentation');
    assert(!e.decorations.some((d) => d.role === e.internRole('broken-marker')));
    e.setMarkdown('again');
    e.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    assertEqual(changes, 0);
  });

  test('destroy cleans up plugins exactly once and duplicate names are rejected', () => {
    const e = makeEditor();
    let cleaned = 0;
    const plugin = definePlugin({ name: 'test.lifecycle', setup: () => () => { cleaned++; } });
    e.installPlugin(plugin);
    expect(() => e.installPlugin(plugin)).toThrow(/already installed/);
    e.destroy();
    e.destroy();
    assertEqual(cleaned, 1);
  });

  test('plugins own floating canvas views and keyboard commands without changing source', async () => {
    const e = makeEditor();
    e.setMarkdown('hello @ga');
    e.root.focus();
    e.setSelectionRange({ start: 9, end: 9 });
    let dismissed = 0;
    const panel = document.createElement('div');
    panel.textContent = 'Gabe';
    panel.style.cssText = 'width:120px;height:40px';
    e.installPlugin(definePlugin({
      name: 'test.presentation',
      setup(context) {
        context.registerCommand('open', {
          title: 'Open picker',
          key: 'o', primary: true,
          handler: () => context.showPresentation('picker', {
            element: panel, anchor: 'selection', onDismiss: () => { dismissed++; },
          }),
        });
      },
    }));

    e.root.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'o', metaKey: true, bubbles: true, cancelable: true,
    }));
    assert(panel.isConnected, 'the command did not mount its presentation');
    assert(panel.hasAttribute(IGNORE_ATTR), 'the floating view was not source-ignored');
    assertEqual(domText(e.root), 'hello @ga');
    assertEqual(e.markdown, 'hello @ga');
    assert(Number.parseFloat(panel.style.top) > 0, 'the selection presentation was not positioned');

    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await Promise.resolve();
    assert(!panel.isConnected, 'Escape did not dismiss the presentation');
    assertEqual(dismissed, 1);
  });

  test('presentation handles update, place, dismiss outside, and restore focus', async () => {
    const e = makeEditor();
    e.root.focus();
    const first = document.createElement('div');
    first.style.cssText = 'width:140px;height:44px';
    const second = document.createElement('div');
    second.style.cssText = 'width:160px;height:48px';
    let handle;
    let reason = null;
    e.installPlugin(definePlugin({
      name: 'test.presentation-handle',
      setup(context) {
        handle = context.showPresentation('panel', {
          element: first,
          anchor: 'selection',
          placement: 'above',
          dismissOnOutsidePointer: true,
          onDismiss: (value) => { reason = value; },
        });
      },
    }));
    assertEqual(first.dataset.mdePlacement, 'above');
    handle.update({ element: second, offset: 14 });
    assert(!first.isConnected, 'presentation update left its old element mounted');
    assert(second.isConnected, 'presentation update did not mount its replacement');
    handle.reposition();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await Promise.resolve();
    assert(!second.isConnected, 'outside pointer did not dismiss the presentation');
    assertEqual(reason, 'outside-pointer');
    assert(document.activeElement === e.root);
  });

  test('modal presentations trap focus and respect a custom portal container', async () => {
    const e = makeEditor();
    e.root.focus();
    const portal = document.createElement('div');
    document.body.appendChild(portal);
    const dialog = document.createElement('div');
    const first = document.createElement('button');
    first.textContent = 'First';
    const last = document.createElement('button');
    last.textContent = 'Last';
    dialog.append(first, last);
    e.installPlugin(definePlugin({
      name: 'test.focus-trap',
      setup(context) {
        context.showPresentation('dialog', {
          element: dialog,
          anchor: 'viewport',
          container: portal,
          initialFocus: first,
        });
      },
    }));
    await new Promise(requestAnimationFrame);
    assertEqual(dialog.parentElement, portal);
    assert(document.activeElement === first);
    last.focus();
    globalThis.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    }));
    assert(document.activeElement === first);
    e.removePlugin('test.focus-trap');
    portal.remove();
  });

  test('replaced presentation handles are inert and receive a replacement reason', () => {
    const e = makeEditor();
    const first = document.createElement('div');
    const second = document.createElement('div');
    const staleElement = document.createElement('div');
    let stale;
    let replacementReason;
    e.installPlugin(definePlugin({
      name: 'test.stale-presentation',
      setup(context) {
        stale = context.showPresentation('panel', {
          element: first, onDismiss: (reason) => { replacementReason = reason; },
        });
        context.showPresentation('panel', { element: second });
      },
    }));
    assertEqual(replacementReason, 'replaced');
    stale.update({ element: staleElement });
    stale.reposition();
    stale.dismiss();
    assert(second.isConnected, 'a stale handle mutated the replacement presentation');
    assert(!staleElement.isConnected);
  });

  test('a replacement callback can present again without orphaning either replacement', () => {
    const e = makeEditor();
    const first = document.createElement('div');
    const second = document.createElement('div');
    const final = document.createElement('div');
    e.installPlugin(definePlugin({
      name: 'test.reentrant-presentation',
      setup(context) {
        context.showPresentation('panel', {
          element: first,
          onDismiss: (reason) => {
            if (reason === 'replaced') context.showPresentation('panel', { element: final });
          },
        });
        context.showPresentation('panel', { element: second });
      },
    }));
    assert(final.isConnected, 'the callback-owned replacement did not win');
    assert(!first.isConnected && !second.isConnected, 'replacement leaked an orphaned view');
    assertEqual(document.querySelectorAll('[data-mde-plugin-presentation]').length, 1);
  });

  test('removing a plugin tears down its presentations and root listeners', () => {
    const e = makeEditor();
    const panel = document.createElement('div');
    let keys = 0;
    e.installPlugin(definePlugin({
      name: 'test.presentation-cleanup',
      setup(context) {
        context.onRoot('keydown', () => { keys++; });
        context.showPresentation('modal', { element: panel, anchor: 'viewport' });
      },
    }));
    assert(panel.isConnected);
    assertEqual(panel.getAttribute('role'), 'dialog');
    assertEqual(panel.getAttribute('aria-modal'), 'true');
    e.removePlugin('test.presentation-cleanup');
    assert(!panel.isConnected, 'plugin removal leaked a floating view');
    e.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    assertEqual(keys, 0, 'plugin removal leaked a root listener');
  });

  test('registering the same local command replaces its previous handler', () => {
    const e = makeEditor();
    let oldRuns = 0;
    let newRuns = 0;
    e.installPlugin(definePlugin({
      name: 'test.command-replacement',
      setup(context) {
        context.registerCommand('open', {
          title: 'Open old',
          key: 'o', primary: true, handler: () => { oldRuns++; },
        });
        context.registerCommand('open', {
          title: 'Open new',
          key: 'o', primary: true, handler: () => { newRuns++; },
        });
      },
    }));
    e.root.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'o', metaKey: true, bubbles: true, cancelable: true,
    }));
    assertEqual(oldRuns, 0);
    assertEqual(newRuns, 1);
  });

  test('commands are discoverable, stateful, executable, and resolve conflicts deterministically', () => {
    const e = makeEditor();
    let firstRuns = 0;
    let secondRuns = 0;
    let secondEnabled = true;
    let secondHandle;
    const conflicts = [];
    e.addEventListener('commandconflict', (event) => conflicts.push(event.detail));
    e.installPlugin(definePlugin({
      name: 'test.commands-one',
      setup(context) {
        context.registerCommand('open', {
          title: 'Open first', key: 'k', primary: true, category: 'Journal',
          handler: () => { firstRuns++; },
        });
      },
    }));
    e.installPlugin(definePlugin({
      name: 'test.commands-two',
      setup(context) {
        secondHandle = context.registerCommand('open', {
          title: 'Open second', key: 'k', primary: true,
          enabled: () => secondEnabled,
          checked: () => true,
          handler: () => { secondRuns++; },
        });
      },
    }));
    assertEqual(e.listCommands().map((command) => command.title), ['Open first', 'Open second']);
    assertEqual(e.listCommands()[1].checked, true);
    e.root.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k', metaKey: true, bubbles: true, cancelable: true,
    }));
    assertEqual(firstRuns, 0);
    assertEqual(secondRuns, 1);
    assertEqual(conflicts.length, 1);
    assertEqual(conflicts[0].winner, secondHandle.id);

    secondEnabled = false;
    secondHandle.update({ title: 'Open second disabled' });
    e.root.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k', metaKey: true, bubbles: true, cancelable: true,
    }));
    assertEqual(firstRuns, 1);
    assertEqual(secondRuns, 1);
    assertEqual(e.listCommands()[1].enabled, false);
    secondHandle.unregister();
    assertEqual(e.listCommands().length, 1);
    assert(e.executeCommand(e.listCommands()[0].id));
    assertEqual(firstRuns, 2);
  });

  test('the mention example autocompletes through the public presentation API', async () => {
    const e = makeEditor();
    e.installPlugin(mentionAutocomplete({
      candidates: [
        { handle: 'gabe', label: 'Gabriel' },
        { handle: 'grace', label: 'Grace' },
      ],
    }));
    e.setMarkdown('Hello @ga');
    e.root.focus();
    e.setSelectionRange({ start: 9, end: 9 });
    e.dispatchEvent(new CustomEvent('selectionchange', {
      detail: { range: { start: 9, end: 9 } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const menu = document.querySelector('.mde-composer-menu');
    assert(menu, 'typing @ did not show mention suggestions');
    assertEqual(menu.querySelectorAll('[role="option"]').length, 2);
    e.root.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }));
    assertEqual(e.markdown, 'Hello @gabe ');
    assertEqual(domText(e.root), 'Hello @gabe ');
    assert(!menu.isConnected, 'choosing a mention left its menu mounted');
  });

  test('suggestions are async latest-wins, cached, grouped, and IME-safe', async () => {
    const e = makeEditor();
    const requests = [];
    let resolveFirst;
    let providerRuns = 0;
    e.installPlugin(suggestionPlugin({
      name: 'test.suggestions',
      triggers: [{ trigger: '@' }],
      loadingLabel: 'Loading',
      provider: ({ query, signal }) => {
        providerRuns++;
        requests.push({ query, signal });
        if (query === 'a') return new Promise((resolve) => { resolveFirst = resolve; });
        return [{ id: query, label: query, group: 'People', insertText: `@${query}` }];
      },
    }));
    const move = (markdown) => {
      e.setMarkdown(markdown);
      e.root.focus();
      e.setSelectionRange({ start: markdown.length, end: markdown.length });
      e.dispatchEvent(new CustomEvent('selectionchange', {
        detail: { range: { start: markdown.length, end: markdown.length } },
      }));
    };
    move('@a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    move('@ab');
    await new Promise((resolve) => setTimeout(resolve, 5));
    resolveFirst([{ id: 'stale', label: 'Stale' }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(requests[0].signal.aborted, 'superseded provider was not aborted');
    assertEqual(document.querySelector('[role="option"]')?.textContent, 'ab');
    assert(document.querySelector('.mde-suggestion-group'), 'group heading was not rendered');

    move('plain');
    move('@ab');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEqual(providerRuns, 2, 'cached query reran its provider');

    e.root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    move('@composing');
    assert(!document.querySelector('.mde-suggestion-menu'), 'IME composition opened suggestions');
    e.root.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert(document.querySelector('.mde-suggestion-menu'), 'composition completion did not resume');
  });

  test('async suggestion selection keeps its signal live and reports failures', async () => {
    const e = makeEditor();
    let abortedDuringSelection;
    let diagnostic;
    e.addEventListener('pluginerror', (event) => { diagnostic = event.detail; });
    e.installPlugin(suggestionPlugin({
      name: 'test.selection-failure',
      triggers: [{ trigger: '@' }],
      provider: () => [{
        id: 'gabe', label: 'Gabe',
        async select(request) {
          await Promise.resolve();
          abortedDuringSelection = request.signal.aborted;
          throw new Error('selection failed');
        },
      }],
    }));
    e.setMarkdown('@ga');
    e.root.focus();
    e.setSelectionRange({ start: 3, end: 3 });
    e.dispatchEvent(new CustomEvent('selectionchange', { detail: { range: e.selectionRange() } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    e.root.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEqual(abortedDuringSelection, false);
    assertEqual(diagnostic.task, 'suggestion-selection');
    assert(!document.querySelector('.mde-suggestion-menu'));
  });

  test('tags, wiki links, and slash commands share the suggestion engine', async () => {
    const e = makeEditor();
    let commandRuns = 0;
    e.installPlugin(definePlugin({
      name: 'test.command-source',
      setup(context) {
        context.registerCommand('daily', {
          title: 'Insert daily heading', category: 'Journal', keywords: ['today'],
          handler: () => { commandRuns++; },
        });
      },
    }));
    e.installPlugin(tagAutocomplete({ items: [{ id: 'travel', label: 'Travel' }] }));
    e.installPlugin(wikilinkAutocomplete({ items: [{ id: 'one', label: 'Day One' }] }));
    e.installPlugin(slashCommandMenu());
    const choose = async (source) => {
      e.setMarkdown(source);
      e.root.focus();
      e.setSelectionRange({ start: source.length, end: source.length });
      e.dispatchEvent(new CustomEvent('selectionchange', { detail: { range: e.selectionRange() } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      e.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    };
    await choose('#tra');
    assertEqual(e.markdown, '#travel ');
    await choose('See [[Day');
    assertEqual(e.markdown, 'See [[Day One]] ');
    await choose('/daily');
    assertEqual(e.markdown, '');
    assertEqual(commandRuns, 1);
  });

  test('template and find/replace plugins execute through discoverable commands', () => {
    const e = makeEditor();
    e.setMarkdown('day day');
    e.installPlugin(templatePicker([{ id: 'daily', title: 'Daily', markdown: '# Daily\n' }]));
    e.installPlugin(findAndReplace());
    const find = e.listCommands().find((command) => command.title === 'Find and replace');
    assert(find && e.executeCommand(find.id));
    const form = document.querySelector('.mde-composer-dialog');
    const [needle, replacement] = form.querySelectorAll('input');
    needle.value = 'day';
    replacement.value = 'night';
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    assertEqual(e.markdown, 'night night');
    assertEqual(form.querySelector('output').textContent, '2 replacements');
  });

  test('the link editor updates the containing link instead of nesting markdown', () => {
    const e = makeEditor();
    e.setMarkdown('Read [the entry](journal/day-one) today.');
    e.root.focus();
    e.setSelectionRange({ start: 10, end: 10 });
    e.installPlugin(linkEditor());
    const command = e.listCommands().find((item) => item.title === 'Add or edit link');
    assert(command && e.executeCommand(command.id));
    const form = document.querySelector('.mde-composer-dialog');
    assertEqual(form.querySelector('h2').textContent, 'Edit link');
    const [label, destination] = form.querySelectorAll('input');
    assertEqual(label.value, 'the entry');
    assertEqual(destination.value, 'journal/day-one');
    label.value = 'today';
    destination.value = 'journal/today';
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    assertEqual(e.markdown, 'Read [today](journal/today) today.');
  });

  test('journal attachments import dropped files with preview, progress, and durable replacement', async () => {
    const e = makeEditor();
    e.root.focus();
    e.setSelectionRange({ start: 0, end: 0 });
    let release;
    const imported = new Promise((resolve) => { release = resolve; });
    e.installPlugin(journalAttachments({
      importFile: async (_file, { reportProgress }) => {
        reportProgress(0.5);
        await imported;
        return { reference: 'journal/photo.jpg', alt: 'A quiet morning' };
      },
    }));
    const file = new File(['image'], 'morning.jpg', { type: 'image/jpeg' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    e.root.dispatchEvent(new DragEvent('drop', {
      dataTransfer: transfer, bubbles: true, cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(e.markdown.includes('blob:'), 'local preview was not inserted immediately');
    assertEqual(document.querySelector('progress')?.value, 0.5);
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assertEqual(e.markdown, '![A quiet morning](journal/photo.jpg)');
    assert(!document.querySelector('.mde-upload-panel'), 'finished import left progress UI mounted');
  });

  test('cancelling a journal import aborts work and removes its temporary reference', async () => {
    const e = makeEditor();
    e.root.focus();
    e.setSelectionRange({ start: 0, end: 0 });
    let signal;
    e.installPlugin(journalAttachments({
      importFile: (_file, context) => {
        signal = context.signal;
        return new Promise(() => {});
      },
    }));
    const transfer = new DataTransfer();
    transfer.items.add(new File(['voice'], 'note.m4a', { type: 'audio/mp4' }));
    e.root.dispatchEvent(new DragEvent('drop', {
      dataTransfer: transfer, bubbles: true, cancelable: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.querySelector('.mde-upload-row button').click();
    assert(signal.aborted);
    assertEqual(e.markdown, '');
    assert(!document.querySelector('.mde-upload-panel'));
  });

  test('the attachment example inserts image, video, and link markdown from Command-O', () => {
    const e = makeEditor();
    e.setMarkdown('Journal: ');
    e.root.focus();
    e.setSelectionRange({ start: 9, end: 9 });
    e.installPlugin(attachmentComposer());
    e.root.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'o', metaKey: true, bubbles: true, cancelable: true,
    }));
    const form = document.querySelector('.mde-composer-dialog');
    assert(form, 'Command-O did not show the attachment composer');
    const [reference, label] = form.querySelectorAll('input');
    reference.value = 'photos/day-one.jpg';
    label.value = 'Day one';
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    assertEqual(e.markdown, 'Journal: ![Day one](photos/day-one.jpg)');
    assert(!form.isConnected, 'submitting left the attachment composer mounted');
  });

  test('plugin analysis is latest-wins and cannot apply after removal', async () => {
    const e = makeEditor();
    const applied = [];
    const diagnostics = [];
    e.addEventListener('plugindiagnostic', (event) => diagnostics.push(event.detail));
    const plugin = definePlugin({
      name: 'test.analysis',
      setup(context) {
        context.on('change', () => {
          context.scheduleAnalysis(
            'words',
            async ({ markdown, signal }) => {
              await new Promise((resolve) => setTimeout(resolve, 5));
              return signal.aborted ? 'aborted' : markdown;
            },
            (markdown) => applied.push(markdown),
            { delayMs: 10 },
          );
        });
      },
    });

    e.installPlugin(plugin);
    e.setMarkdown('first snapshot');
    e.setMarkdown('latest snapshot');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assertEqual(applied, ['latest snapshot']);
    assert(diagnostics.some((diagnostic) => diagnostic.cancelled));
    assert(diagnostics.some((diagnostic) => !diagnostic.cancelled));

    e.setMarkdown('must never apply');
    e.removePlugin(plugin.name);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assertEqual(applied, ['latest snapshot']);
  });

  test('capability plugins transact atomically and expose semantic nodes without legacy access', () => {
    const e = makeEditor();
    e.setMarkdown('one ![photo](journal/a.jpg) three');
    e.installPlugin(definePlugin({
      name: 'test.capabilities',
      requires: { apiVersion: 1, capabilities: ['document', 'selection', 'semantics', 'state'] },
      setup(context) {
        const images = context.semantics.query({ roles: ['image'] });
        assertEqual(images.length, 1);
        assertEqual(images[0].payload, 'journal/a.jpg');
        void context.state.set('images', images.length);
        context.document.transact({
          edits: [
            { start: 0, end: 3, text: 'ONE' },
            { start: context.document.length - 5, end: context.document.length, text: 'THREE' },
          ],
          selection: { start: 3, end: 3 },
          metadata: { label: 'Two edits' },
        });
      },
    }));
    assertEqual(e.markdown, 'ONE ![photo](journal/a.jpg) THREE');
    assertEqual(e.pluginCompatibility, [{ name: 'test.capabilities', usedLegacyEditor: false }]);
    assert(e.undo(), 'transaction should create one undo step');
    assertEqual(e.markdown, 'one ![photo](journal/a.jpg) three');
  });

  test('input rules and transfer handlers are priority ordered and lifecycle scoped', async () => {
    const e = makeEditor();
    e.root.focus();
    e.setSelectionRange({ start: 0, end: 0 });
    const routed = [];
    e.installPlugin(definePlugin({
      name: 'test.routes',
      requires: { apiVersion: 1, capabilities: ['input-rules', 'transfers'] },
      setup(context) {
        context.inputRules.register('emdash', {
          match: ({ data }) => data === '--',
          apply: ({ selection }) => selection && ({
            edits: [{ ...selection, text: '—' }],
            selection: { start: selection.start + 1, end: selection.start + 1 },
          }),
        });
        context.transfers.register('low', {
          priority: 1, accepts: (payload) => payload.kind === 'host',
          handle: () => { routed.push('low'); return true; },
        });
        context.transfers.register('high', {
          priority: 10, accepts: (payload) => payload.kind === 'host',
          handle: () => { routed.push('high'); return true; },
        });
      },
    }));
    e.root.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertText', data: '--', bubbles: true, cancelable: true,
    }));
    assertEqual(e.markdown, '—');
    assert(await e.routeTransfer({ kind: 'host', value: { url: 'asset://1' } }));
    assertEqual(routed, ['high']);
    e.removePlugin('test.routes');
    assertEqual(await e.routeTransfer({ kind: 'host', value: null }), false);
  });

  test('backlinks and media gallery examples use only public capabilities', async () => {
    const e = makeEditor();
    e.setMarkdown('See [[Daily note]].\n\n![Morning](journal/morning.jpg)');
    e.installPlugin(backlinks({ resolve: async (title) => ({ title }) }));
    let activated = null;
    e.installPlugin(mediaGallery({ onActivate: (reference) => { activated = reference; } }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert(e.decorations.some((item) => e.engine.roleName(item.role) === 'backlink'));
    const gallery = e.listCommands().find((command) => command.name === 'show');
    assert(gallery && e.executeCommand(gallery.id));
    const item = document.querySelector('.mde-media-gallery button');
    assert(item, 'gallery did not render semantic images');
    item.click();
    assertEqual(activated, 'journal/morning.jpg');
    assert(e.pluginCompatibility.every((plugin) => !plugin.usedLegacyEditor));
  });

  test('resource contributions are priority routed and removed with their plugin', async () => {
    const e = makeEditor();
    const requested = [];
    e.installPlugin(definePlugin({
      name: 'test.resources',
      requires: { apiVersion: 1, capabilities: ['resources'] },
      setup(context) {
        context.resources.register('assets', {
          priority: 10,
          accepts: ({ reference }) => reference.startsWith('plugin://'),
          resolver: {
            reservedSize: () => ({ width: 80, height: 60 }),
            async resolve({ reference }) {
              requested.push(reference);
              const view = document.createElement('span');
              view.textContent = 'plugin asset';
              return { state: 'ready', view };
            },
          },
        });
      },
    }));
    e.setMarkdown('![asset](plugin://photo)');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEqual(requested, ['plugin://photo']);
    e.removePlugin('test.resources');
    assertEqual(e.pluginCompatibility, []);
  });

  test('plugin analysis reports explicit budget overruns', async () => {
    const e = makeEditor();
    let diagnostic;
    e.addEventListener('plugindiagnostic', (event) => { diagnostic = event.detail; });
    e.installPlugin(definePlugin({
      name: 'test.slow-analysis',
      setup(context) {
        context.scheduleAnalysis(
          'slow',
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 12));
            return true;
          },
          () => {},
          { budgetMs: 1 },
        );
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEqual(diagnostic.plugin, 'test.slow-analysis');
    assertEqual(diagnostic.task, 'slow');
    assertEqual(diagnostic.overBudget, true);
    assert(diagnostic.durationMs >= diagnostic.budgetMs);
  });

  test('the published compatibility helper verifies source and layer cleanup', async () => {
    const e = makeEditor();
    const plugin = definePlugin({
      name: 'test.compatibility-helper',
      setup(context) {
        const role = context.internRole('compatibility-mark');
        context.setLayer('probe', [{ start: 0, end: 4, role }]);
      },
    });
    const report = await checkPluginCompatibility(e, plugin);
    assertEqual(report, {
      name: plugin.name,
      installed: true,
      removed: true,
      sourcePreserved: true,
      contributedLayerDecorations: 1,
      cleanupRemovedLayers: true,
      usedLegacyEditor: false,
      diagnostics: [],
    });
  });

  test('typewriter mode focuses the caret\'s paragraph and dims the rest', () => {
    const e = makeEditor();
    e.setMarkdown('first para\n\nsecond para\n\nthird para\n');
    e.root.focus();
    const at = e.markdown.indexOf('second');
    e.setSelectionRange({ start: at + 2, end: at + 2 });

    const mode = new TypewriterMode(e);
    mode.enable();

    const focus = e.root.querySelectorAll('.mde-typewriter-focus');
    assertEqual(focus.length, 1, 'exactly one focused paragraph line');
    assertEqual(focus[0].textContent, 'second para\n');
    assert(e.root.classList.contains('mde-typewriter-active'), 'the other lines should be dimmed');
    assertEqual(domText(e.root), e.markdown, 'the extension changed the document text');
  });

  test('typewriter mode cannot loop on a multi-line paragraph', () => {
    const e = makeEditor();
    e.setMarkdown('first line\nsecond line\n\nnext paragraph\n');
    e.root.focus();
    const at = e.markdown.indexOf('second') + 3;
    e.setSelectionRange({ start: at, end: at });

    const mode = new TypewriterMode(e);
    mode.enable();

    const focus = [...e.root.querySelectorAll('.mde-typewriter-focus')];
    assertEqual(focus.length, 2, 'both lines in the paragraph should stay focused');
    assertEqual(focus.map((line) => line.textContent).join(''), 'first line\nsecond line\n');
  });

  test('a layer outranks the parse so a dim can beat a heading', () => {
    const e = makeEditor();
    e.setMarkdown('# Heading\n\nbody\n');
    e.root.focus();
    const at = e.markdown.indexOf('body');
    e.setSelectionRange({ start: at, end: at });
    const dimRole = e.internRole('test-dim');
    e.setLayer('test-layer', [{ start: 0, end: 9, role: dimRole }]);
    const dim = e.decorations.find((d) => d.role === dimRole);
    const heading = e.decorations.find((d) => d.layer === 0 && d.start === 0);
    assert(dim, 'no dim span');
    assert(dim.layer > 0, 'a host layer must sit above the parse');
    assert(!heading || heading.layer === 0, 'parsed decorations stay at layer 0');
  });

  test('turning an extension off removes everything it added', () => {
    const e = makeEditor();
    e.setMarkdown('first para\n\nsecond para\n');
    e.root.focus();
    e.setSelectionRange({ start: 0, end: 0 });

    const mode = new TypewriterMode(e);
    mode.enable();
    assert(e.root.classList.contains('mde-typewriter-active'));
    assert(e.root.querySelector('.mde-typewriter-focus'));
    mode.disable();
    assert(!e.root.classList.contains('mde-typewriter-active'));
    assert(!e.root.querySelector('.mde-typewriter-focus'));
    assertEqual(domText(e.root), e.markdown);
  });

  test('parts of speech tags words without disturbing the document', () => {
    const e = makeEditor();
    const source = 'The quick brown fox jumps over the lazy dog.\n';
    e.setMarkdown(source);

    const pos = new PartsOfSpeech(e);
    pos.enable();

    const tagged = e.decorations.filter((d) => Object.values(pos.roles).includes(d.role));
    assert(tagged.length > 3, `expected several tagged words, got ${tagged.length}`);
    // Every span must land on a word, not on whitespace or punctuation.
    for (const d of tagged) {
      const word = source.slice(d.start, d.end);
      assert(/^[A-Za-z][A-Za-z'-]*$/.test(word), `span covered ${JSON.stringify(word)}`);
    }
    assertEqual(domText(e.root), source, 'tagging changed the document text');
  });

  test('a layer composes with the parse rather than replacing it', () => {
    const e = makeEditor();
    e.setMarkdown('some **bold** words\n');
    const pos = new PartsOfSpeech(e);
    pos.enable();

    // The word inside the emphasis still carries the parsed `strong` styling as well as
    // whatever the tagger said about it — the two are separate decorations over the same
    // characters, not competitors.
    const at = e.markdown.indexOf('bold');
    const covering = e.decorations.filter((d) => d.start <= at && d.end > at);
    assert(
      covering.some((d) => d.layer === 0),
      'the parsed decoration should survive the layer'
    );
    assert(
      covering.some((d) => d.layer > 0),
      'the layer should apply over the same characters'
    );
  });

  test('the web tagger is a heuristic, and its closed classes are not tagged', () => {
    // Documenting the limitation rather than pretending it is a real tagger: function
    // words are left alone, and the suffix rules are what carry the rest.
    assertEqual(tagWord('the'), null);
    assertEqual(tagWord('and'), null);
    assertEqual(tagWord('quickly'), 'adverb');
    assertEqual(tagWord('running'), 'verb');
    assertEqual(tagWord('happiness'), 'noun');
  });

  // ---- browsable history (DESIGN §9) --------------------------------------

  test('the timeline lists revisions and keeps undone ones visible', () => {
    const e = makeEditor();
    e.setMarkdown('start\n');
    // Spaced past the coalescing window so these stay separate revisions.
    e.replaceRange(5, 5, ' one');
    e.closeUndoGroup();
    e.replaceRange(9, 9, ' two');
    e.closeUndoGroup();

    assertEqual(e.revisions.length, 2);
    assertEqual(e.historyPosition, 2);

    e.undo();
    assertEqual(e.revisions.length, 2, 'undoing must not erase the branch');
    assertEqual(e.historyPosition, 1, 'only the position moves');
  });

  test('jumping lands exactly where stepping would', () => {
    const e = makeEditor();
    e.setMarkdown('start\n');
    const states = ['start\n'];
    for (const word of [' one', ' two', ' three']) {
      e.replaceRange(e.markdown.length, e.markdown.length, word);
      e.closeUndoGroup();
      states.push(e.markdown);
    }

    for (const target of [0, 3, 1, 2, 0]) {
      if (target !== e.historyPosition) e.jumpTo(target);
      assertEqual(e.markdown, states[target], `landing on ${target}`);
      assertEqual(domText(e.root), e.markdown, 'the DOM diverged after a jump');
      assertEqual(e.historyPosition, target);
    }
  });

  test('a revision says what it did', () => {
    const e = makeEditor();
    e.setMarkdown('hello world\n');
    e.replaceRange(5, 11, '');
    e.closeUndoGroup();

    const last = e.revisions[e.revisions.length - 1];
    assertEqual(last.removed, 6);
    assertEqual(last.inserted, 0);
    assert(typeof last.atMs === 'number', 'a revision needs a timestamp to be listed');
  });

  test('blurring a revealed editor does not steal focus back', () => {
    const e = makeEditor();
    e.setMarkdown('hello **world** end');
    e.root.focus();
    e.setSelectionRange({ start: 10, end: 10 }); // inside "world" → markers reveal
    e.onSelectionChange();

    // Focus something else, exactly as a click into another input would. The blur
    // handler collapses the reveal, which re-renders the caret's line — and restoring
    // the pre-blur selection there re-focuses the contenteditable, bouncing focus
    // straight back out of the input. A page with two editors could never move the
    // caret from the first to the second.
    const input = document.createElement('input');
    document.getElementById('sandbox').appendChild(input);
    input.focus();
    e.applyPatch(e.engine.setSelection(null)); // what the blur listener does

    assertEqual(
      document.activeElement === input,
      true,
      'the editor stole focus back from the input'
    );
    // And the collapse itself still happened.
    assertEqual(e.decorations.find((d) => d.start === 6).kind, Kind.Conceal);
    input.remove();
  });

  // ---- newline input (the Enter cascade) ----------------------------------

  test('Enter is intercepted and inserted as a real newline', async () => {
    const e = makeEditor();
    e.setMarkdown('hello\n');
    e.root.focus();
    e.setSelectionRange({ start: 5, end: 5 });

    // A real keyboard fires cancelable `beforeinput` with insertParagraph. Chrome's
    // plaintext-only default for it is NOT plain text: at the end of the document it
    // inserts a <div><br></div> with empty text content — invisible to the tree walk —
    // and wraps existing line elements inside it. The editor must take over instead.
    await userEvent.keyboard('{Enter}');

    assertEqual(e.markdown, 'hello\n\n');
    assertEqual(domText(e.root), 'hello\n\n', 'DOM and mirror agree after Enter');
    assertEqual(e.selectionRange(), { start: 6, end: 6 }, 'caret sits after the newline');
  });

  test('typing after an intercepted Enter does not cascade', async () => {
    const e = makeEditor();
    e.setMarkdown('what is up?\n');
    e.root.focus();
    e.setSelectionRange({ start: 11, end: 11 });

    await userEvent.keyboard('{Enter}');
    // The characters after Enter — the exact gesture that used to fossilise one copy
    // of the line per keypress.
    await userEvent.keyboard('what');

    assertEqual(e.markdown, 'what is up?\nwhat\n');
    assertEqual(domText(e.root), e.markdown, 'no fossil copies of the line');
  });

  test('multiline insertText is normalised through the engine, CRLF included', () => {
    const e = makeEditor();
    e.setMarkdown('ab\n');
    e.root.focus();
    e.setSelectionRange({ start: 1, end: 1 });

    const event = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: 'x\r\ny',
      bubbles: true,
      cancelable: true,
    });
    e.root.dispatchEvent(event);

    assertEqual(event.defaultPrevented, true);
    assertEqual(e.markdown, 'ax\nyb\n', 'CRLF became a plain newline');
    assertEqual(domText(e.root), e.markdown);
  });

  test('single-line insertText stays with the browser', () => {
    const e = makeEditor();
    e.setMarkdown('ab\n');
    const event = new InputEvent('beforeinput', {
      inputType: 'insertText', data: 'x', bubbles: true, cancelable: true,
    });
    e.root.dispatchEvent(event);
    assertEqual(event.defaultPrevented, false, 'plain characters are not intercepted');
  });

  test('an IME composition commit preserves Unicode and undo grouping', () => {
    const e = makeEditor();
    e.setMarkdown('Journal: []\n');
    e.root.focus();
    e.setSelectionRange({ start: 10, end: 10 });
    e.root.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    // Browsers own the interim composition DOM. Recreate the committed mutation then
    // route the resulting input through the same common-prefix/suffix reconciliation.
    const line = e.lineEls[0];
    line.textContent = 'Journal: [日本語👩🏽‍💻]\n';
    e.root.dispatchEvent(new CompositionEvent('compositionend', { data: '日本語👩🏽‍💻' }));
    e.root.dispatchEvent(new InputEvent('input', {
      inputType: 'insertCompositionText', data: '日本語👩🏽‍💻', bubbles: true,
    }));

    assertEqual(e.markdown, 'Journal: [日本語👩🏽‍💻]\n');
    assertEqual(domText(e.root), e.markdown);
    e.undo();
    assertEqual(e.markdown, 'Journal: []\n', 'one IME commit was split across undo steps');
  });

  test('multiline drop is normalized through one engine edit', () => {
    const e = makeEditor();
    e.setMarkdown('before after\n');
    e.root.focus();
    e.setSelectionRange({ start: 7, end: 7 });
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'photo caption\r\nsecond line');
    const event = new InputEvent('beforeinput', {
      inputType: 'insertFromDrop', dataTransfer: transfer, bubbles: true, cancelable: true,
    });
    // WebKit ignores `dataTransfer` in the synthetic InputEvent constructor even
    // though real beforeinput drop events expose it. Install the same read-only value
    // so this tests the editor path instead of the browser's test-construction quirk.
    if (!event.dataTransfer) Object.defineProperty(event, 'dataTransfer', { value: transfer });
    e.root.dispatchEvent(event);

    assertEqual(event.defaultPrevented, true);
    assertEqual(e.markdown, 'before photo caption\nsecond lineafter\n');
    e.undo();
    assertEqual(e.markdown, 'before after\n');
  });

  test('a browser-mangled DOM is renormalised instead of diverging', () => {
    const e = makeEditor();
    e.setMarkdown('alpha\nbeta\n');
    e.root.focus();
    e.setSelectionRange({ start: 10, end: 10 });

    // Replay what Chrome actually does when an un-intercepted Enter gets through:
    // wrap the trailing line element in a fresh <div> with a <br>, contributing no
    // text. The walk sees no change, but the DOM shape no longer matches lineEls.
    const wrapper = document.createElement('div');
    const last = e.lineEls[e.lineEls.length - 1];
    last.parentElement.replaceChild(wrapper, last);
    wrapper.append(last, document.createElement('br'));
    e.root.dispatchEvent(new InputEvent('input', { bubbles: true }));

    assert(e.domIsCanonical(), 'the mangled shape should have been rebuilt canonically');
    assertEqual(e.markdown, 'alpha\nbeta\n', 'the text was never in question');
    assertEqual(domText(e.root), e.markdown);
  });

  test('Enter works with the caret at an element boundary, not just in a text node', () => {
    const e = makeEditor();
    e.setMarkdown('tail\n');
    e.root.focus();

    // Click below the last line and the browser anchors the caret at (root, childCount)
    // — an element boundary. The old mapping read that as "no selection", so intercepted
    // Enter silently did nothing exactly where typing usually starts: the end.
    const sel = getSelection();
    const r = document.createRange();
    r.setStart(e.root, e.root.childNodes.length);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);

    assertEqual(e.selectionRange(), { start: 5, end: 5 }, 'element anchor maps to the end');
    e.root.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertParagraph', bubbles: true, cancelable: true,
    }));
    assertEqual(e.markdown, 'tail\n\n', 'the Enter must not be dropped');
    assertEqual(domText(e.root), e.markdown);
  });

  test('a worker-prepared document is source-first, atomic, and editable after activation', async () => {
    const e = makeEditor();
    const source = '# Prepared\n\n' + 'Line with **bold**, @gabe, and 日本語 🎉.\n'.repeat(4_000);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const prepared = prepareDocument(source, {
      wasm: '/dist/mde.wasm', manifest: encodeManifest(manifestSpec),
    });

    const opening = e.setMarkdownProgressively(source, gate.then(() => prepared));
    assertEqual(e.markdown, source);
    assertEqual(domText(e.root), source);
    assertEqual(e.root.contentEditable, 'false');
    assertEqual(e.root.getAttribute('aria-busy'), 'true');
    release();
    assertEqual(await opening, true);
    assertEqual(e.root.contentEditable, 'plaintext-only');
    assertEqual(e.root.hasAttribute('aria-busy'), false);
    assertEqual(domText(e.root), source);
    assert(e.decorations.length > 10_000, 'prepared decorations were not restored');

    const at = source.indexOf('bold');
    e.replaceRange(at, at, 'x');
    assertEqual(e.markdown, source.slice(0, at) + 'x' + source.slice(at));
    assertEqual(domText(e.root), e.markdown);
  });

  test('a superseded progressive open cannot replace the newer document', async () => {
    const e = makeEditor();
    let release;
    const stale = new Promise((resolve) => { release = resolve; });
    const opening = e.setMarkdownProgressively('old', stale);
    e.setMarkdown('new');
    release({ markdown: 'old', snapshot: new Uint8Array(), durationMs: 0 });
    assertEqual(await opening, false);
    assertEqual(e.markdown, 'new');
    assertEqual(domText(e.root), 'new');
  });
