// Web renderer tests.
//
// These run in a real browser rather than under a DOM shim, deliberately: every hard
// bug in this layer — contenteditable behaviour, selection restore, CSS precedence on
// concealed runs — only exists in a real engine. Open web/test/index.html, or drive it
// headlessly and read `window.__results`.

import {
  IGNORE_ATTR,
  Kind,
  MarkdownEditor,
  Role,
  diffText,
  encodeManifest,
  loadCore,
} from '../dist/index.js';
// Deliberately imported from `../extensions/`, not `../src/`: these are not part of the
// editor, and testing them here is the check that they never needed to be.
import { TypewriterMode } from '../dist/extensions/typewriter.js';
import { PartsOfSpeech, tagWord } from '../dist/extensions/parts-of-speech.js';

/** @type {{name: string, ok: boolean, detail?: string}[]} */
const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error?.message ?? error) });
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error?.message ?? error) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed');
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message ?? 'not equal'}: got ${a}, want ${e}`);
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

export async function run() {
  const core = await loadCore('../dist/mde.wasm');

  /** @param {object} [options] */
  function makeEditor(options = {}) {
    const host = document.createElement('div');
    document.getElementById('sandbox').replaceChildren(host);
    const engine = core.newEngine(encodeManifest(manifestSpec));
    return new MarkdownEditor(host, engine, options);
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
    const e = new MarkdownEditor(host, engine);

    assertEqual(e.root.getAttribute('aria-label'), 'Release notes');
    assertEqual(e.root.getAttribute('spellcheck'), 'false');
  });

  test('destroy detaches listeners before a host is reused', () => {
    const host = document.createElement('div');
    document.getElementById('sandbox').replaceChildren(host);
    const old = new MarkdownEditor(host, core.newEngine(encodeManifest(manifestSpec)));
    old.setMarkdown('old');
    old.destroy();

    const current = new MarkdownEditor(host, core.newEngine(encodeManifest(manifestSpec)));
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

  await asyncTest('a GFM table resolves nested images as semantic HTML without changing source', async () => {
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

  test('CommonMark autolinks render as links without changing their source', () => {
    const e = makeEditor();
    const source = '<https://example.dev> and <hello@example.dev>';
    e.setMarkdown(source);

    assertEqual(e.root.querySelectorAll('.mde-link-text').length, 2);
    assertEqual(e.root.querySelectorAll('.mde-conceal').length, 4);
    assertEqual(domText(e.root), source);
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

  await asyncTest('a reference reaches the resolver and resolves once', async () => {
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

  await asyncTest('destroy cancels a late resource repaint before the engine is freed', async () => {
    let release;
    const engine = core.newEngine(encodeManifest(manifestSpec));
    const host = document.createElement('div');
    document.getElementById('sandbox').replaceChildren(host);
    const e = new MarkdownEditor(host, engine, {
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

  test('typing through the browser keeps the model and DOM in step', () => {
    const e = makeEditor();
    e.setMarkdown('hello **world** end');
    e.root.focus();
    e.setSelectionRange({ start: 13, end: 13 });
    document.execCommand('insertText', false, 'ly');

    assertEqual(e.markdown, 'hello **worldly** end');
    assertEqual(domText(e.root), e.markdown, 'DOM diverged from the model after typing');
    assert(
      e.decorations.some(
        (d) => d.role === Role.Strong && e.markdown.slice(d.start, d.end) === 'worldly'
      ),
      'the bold run did not grow with the text'
    );
  });

  test('a typing run undoes as one step and redoes', () => {
    const e = makeEditor();
    const source = 'hello **world** end';
    e.setMarkdown(source);
    e.root.focus();
    e.setSelectionRange({ start: 13, end: 13 });
    document.execCommand('insertText', false, 'ly');

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

  await asyncTest('a resolved resource size is remembered and reused for the next reservation', async () => {
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

  test('typewriter mode focuses the caret\'s paragraph and dims the rest', () => {
    const e = makeEditor();
    e.setMarkdown('first para\n\nsecond para\n\nthird para\n');
    e.root.focus();
    const at = e.markdown.indexOf('second');
    e.setSelectionRange({ start: at + 2, end: at + 2 });

    const mode = new TypewriterMode(e);
    mode.enable();

    const focus = e.decorations.filter((d) => d.role === mode.focusRole);
    const dim = e.decorations.filter((d) => d.role === mode.dimRole);
    assertEqual(focus.length, 1, 'exactly one focused paragraph');
    assertEqual(
      e.markdown.slice(focus[0].start, focus[0].end),
      'second para',
      'the focus band should be the paragraph holding the caret'
    );
    assert(dim.length > 0, 'everything else should be dimmed');
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

    const focus = e.decorations.filter((d) => d.role === mode.focusRole);
    assertEqual(focus.length, 1, 'the multi-line paragraph should be one focus band');
    assertEqual(
      e.markdown.slice(focus[0].start, focus[0].end),
      'first line\nsecond line',
      'the scan should reach the start of the paragraph and terminate'
    );
  });

  test('a layer outranks the parse so a dim can beat a heading', () => {
    const e = makeEditor();
    e.setMarkdown('# Heading\n\nbody\n');
    e.root.focus();
    const at = e.markdown.indexOf('body');
    e.setSelectionRange({ start: at, end: at });
    const mode = new TypewriterMode(e);
    mode.enable();

    const dim = e.decorations.find((d) => d.role === mode.dimRole);
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

    const before = e.decorations.length;
    const mode = new TypewriterMode(e);
    mode.enable();
    assert(e.decorations.length > before, 'enabling should add decorations');
    mode.disable();
    assertEqual(e.decorations.length, before, 'disabling should leave no trace');
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

  test('Enter is intercepted and inserted as a real newline', () => {
    const e = makeEditor();
    e.setMarkdown('hello\n');
    e.root.focus();
    e.setSelectionRange({ start: 5, end: 5 });

    // A real keyboard fires cancelable `beforeinput` with insertParagraph. Chrome's
    // plaintext-only default for it is NOT plain text: at the end of the document it
    // inserts a <div><br></div> with empty text content — invisible to the tree walk —
    // and wraps existing line elements inside it. The editor must take over instead.
    const event = new InputEvent('beforeinput', {
      inputType: 'insertParagraph',
      bubbles: true,
      cancelable: true,
    });
    e.root.dispatchEvent(event);

    assertEqual(event.defaultPrevented, true, 'the browser must not act on Enter');
    assertEqual(e.markdown, 'hello\n\n');
    assertEqual(domText(e.root), 'hello\n\n', 'DOM and mirror agree after Enter');
    assertEqual(e.selectionRange(), { start: 6, end: 6 }, 'caret sits after the newline');
  });

  test('typing after an intercepted Enter does not cascade', () => {
    const e = makeEditor();
    e.setMarkdown('what is up?\n');
    e.root.focus();
    e.setSelectionRange({ start: 11, end: 11 });

    e.root.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'insertParagraph', bubbles: true, cancelable: true,
    }));
    // The characters after Enter — the exact gesture that used to fossilise one copy
    // of the line per keypress.
    for (const ch of 'what') {
      const sel = e.selectionRange();
      e.replaceRange(sel.start, sel.end, ch);
    }

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
    e.root.replaceChild(wrapper, last);
    wrapper.append(last, document.createElement('br'));
    e.root.dispatchEvent(new InputEvent('input', { bubbles: true }));

    assert(
      [...e.root.children].every((c, i) => c === e.lineEls[i]),
      'the mangled shape should have been rebuilt to canonical line elements'
    );
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

  return results;
}
