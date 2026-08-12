// Browser performance regression gates. These intentionally run against the built
// package in real Chromium: DOM construction, layout containment, WASM calls, and the
// extension layer are the costs a user actually feels.

import { afterEach, beforeAll, expect, test } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/theme.css';
import { MarkdownEditor, encodeManifest, loadCore } from '../dist/index.js';
import {
  MarkdownEditor as ReactMarkdownEditor,
  preloadCore as preloadReactCore,
} from '../react/dist/index.js';
import { TypewriterMode } from '../dist/extensions/typewriter.js';

/* global __MDE_PERF__, __MDE_PERF_BUDGETS__ */

const manifest = encodeManifest({
  blocks: [{
    name: 'callout',
    syntax: { kind: 'fence', info: 'callout' },
    render: 'block_widget',
    reveal: 'caret_in_block',
  }],
  inlines: [{
    name: 'mention',
    syntax: { kind: 'pattern', regex: '@[a-zA-Z0-9_-]+' },
    render: 'inline_widget',
    reveal: 'caret_in_node',
  }],
});

let core;
const live = [];

beforeAll(async () => {
  core = await loadCore('/dist/mde.wasm');
});

afterEach(() => {
  for (const { editor, engine } of live.splice(0).reverse()) {
    editor.destroy();
    engine.free();
  }
  document.body.replaceChildren();
});

function documentOfAtLeast(bytes) {
  const block =
    '## Renderer performance\n\n' +
    'The **shared core** keeps *editing* fast with `code`, [links](https://example.dev), ' +
    '@reviewer, and multilingual text — résumé 日本語 🎉.\n\n' +
    '- [ ] profile the viewport\n- [x] preserve the source\n\n';
  return block.repeat(Math.ceil(bytes / block.length)).slice(0, bytes);
}

function makeEditor(options = {}) {
  const host = document.createElement('div');
  host.style.cssText = 'display:block;width:720px;height:480px;overflow:auto';
  document.body.appendChild(host);
  const engine = core.newEngine(manifest);
  const editor = new MarkdownEditor(host, engine, options);
  live.push({ editor, engine });
  return editor;
}

function journalMediaDocument() {
  const entries = [];
  const append = (kind, count, extension) => {
    for (let index = 0; index < count; index++) {
      entries.push(
        `### ${kind} ${index + 1}\n\n` +
        `A journal paragraph around ${kind.toLowerCase()} ${index + 1}, with **context**, ` +
        `a [reference](https://example.dev/${kind.toLowerCase()}/${index + 1}), and a timestamp.\n\n` +
        `![${kind} ${index + 1}](journal/${kind.toLowerCase()}-${index + 1}.${extension})\n`,
      );
    }
  };
  append('Photo', 48, 'jpg');
  append('Video', 8, 'mp4');
  append('Audio', 16, 'm4a');
  return `# Media journal\n\n${entries.join('\n')}\nClosing reflection.\n`;
}

function journalMediaResolver() {
  const requested = [];
  return {
    requested,
    async resolve({ reference }) {
      requested.push(reference);
      const extension = reference.split('.').pop();
      let view;
      if (extension === 'mp4') {
        view = document.createElement('video');
        view.controls = true;
        view.preload = 'metadata';
        view.width = 640;
        view.height = 360;
        view.dataset.mediaKind = 'video';
      } else if (extension === 'm4a') {
        view = document.createElement('audio');
        view.controls = true;
        view.preload = 'metadata';
        view.setAttribute('width', '480');
        view.setAttribute('height', '54');
        view.dataset.mediaKind = 'audio';
      } else {
        view = document.createElement('img');
        view.alt = reference;
        view.width = 640;
        view.height = 360;
        view.dataset.mediaKind = 'image';
      }
      return { state: 'ready', view };
    },
    reservedSize({ reference }) {
      if (reference.endsWith('.m4a')) return { width: 480, height: 54 };
      return { width: 640, height: 360 };
    },
  };
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function timed(body) {
  const started = performance.now();
  body();
  return performance.now() - started;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, quantile) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length - 1) * quantile)];
}

function timedEdits(editor, start, count) {
  const samples = [];
  let at = start;
  for (let index = 0; index < count; index++) {
    samples.push(timed(() => editor.replaceRange(at, at, 'x')));
    at++;
  }
  return samples;
}

function coldLoad(source, repetitions) {
  const samples = [];
  for (let index = 0; index < repetitions; index++) {
    const editor = makeEditor();
    samples.push(timed(() => editor.setMarkdown(source)));
    const entry = live.pop();
    entry.editor.destroy();
    entry.engine.free();
    document.body.replaceChildren();
  }
  return median(samples);
}

test.skipIf(!__MDE_PERF__)('large-document browser budgets', async () => {
  const source100KB = documentOfAtLeast(100 * 1024);
  const source1MB = documentOfAtLeast(1024 * 1024);
  const load100KB = coldLoad(source100KB, 5);
  const load1MB = coldLoad(source1MB, 3);

  const editor100KB = makeEditor();
  editor100KB.setMarkdown(source100KB);
  const edit100KB = median(Array.from({ length: 7 }, (_, index) =>
    timed(() => editor100KB.replaceRange(source100KB.length - 20 + index, source100KB.length - 20 + index, 'x'))
  ));
  editor100KB.setSelectionRange({ start: source100KB.length / 2, end: source100KB.length / 2 });
  const typewriter = new TypewriterMode(editor100KB);
  const typewriter100KB = timed(() => typewriter.enable());
  typewriter.disable();

  const editor1MB = makeEditor();
  editor1MB.setMarkdown(source1MB);
  const editTop1MB = timedEdits(editor1MB, Math.floor(source1MB.length * 0.01), 5);
  const editMiddle1MB = timedEdits(editor1MB, Math.floor(source1MB.length * 0.50), 5);
  const editEnd1MB = timedEdits(editor1MB, Math.floor(source1MB.length * 0.99), 5);
  const edit1MB = median(editEnd1MB);

  const layerRole = editor1MB.internRole('strong');
  const layer1MB = median(Array.from({ length: 15 }, (_, index) => {
    const start = Math.floor(source1MB.length * (index % 2 === 0 ? 0.25 : 0.75));
    return timed(() => editor1MB.setLayer('performance-plugin', [
      { start, end: start + 5, role: layerRole },
    ]));
  }));
  editor1MB.clearLayer('performance-plugin');

  const endurance = timedEdits(editor100KB, Math.floor(editor100KB.markdown.length * 0.50), 100);
  const giantSource = 'word **strong** @same résumé 日本語 🎉 '.repeat(850);
  const giantEditor = makeEditor();
  giantEditor.setMarkdown(giantSource);
  const giantParagraphEdit = median(
    timedEdits(giantEditor, Math.floor(giantSource.length / 2), 5),
  );
  const scroll1MB = await new Promise((resolve) => {
    const started = performance.now();
    editor1MB.root.scrollTop = editor1MB.root.scrollHeight;
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)));
  });
  const domNodes1MB = editor1MB.root.querySelectorAll('*').length;
  const usedHeap1MB = (/** @type {any} */ (performance)).memory?.usedJSHeapSize ?? null;

  // Price the adapter itself with the shared WASM core already compiled. Network and
  // compilation are deployment costs; this measures React commit -> usable editor.
  await preloadReactCore('/dist/mde.wasm');
  const reactHost = document.createElement('div');
  document.body.appendChild(reactHost);
  const reactRoot = createRoot(reactHost);
  let markReactReady;
  const reactReady = new Promise((resolve) => { markReactReady = resolve; });
  const reactStarted = performance.now();
  reactRoot.render(createElement(ReactMarkdownEditor, {
    defaultValue: source100KB,
    wasm: '/dist/mde.wasm',
    onReady: markReactReady,
  }));
  await reactReady;
  await nextPaint();
  const reactMount100KB = performance.now() - reactStarted;
  reactRoot.unmount();
  reactHost.remove();

  const mediaSource = journalMediaDocument();
  const mediaResolver = journalMediaResolver();
  const mediaEditor = makeEditor({ resourceResolver: mediaResolver });
  const mediaStarted = performance.now();
  mediaEditor.setMarkdown(mediaSource);
  await nextPaint();
  const mediaReady = performance.now() - mediaStarted;
  const mediaCounts = {
    images: mediaEditor.root.querySelectorAll('[data-media-kind="image"]').length,
    videos: mediaEditor.root.querySelectorAll('[data-media-kind="video"]').length,
    audio: mediaEditor.root.querySelectorAll('[data-media-kind="audio"]').length,
  };
  const mediaNodes = mediaEditor.root.querySelectorAll('*').length;
  const mediaEditAt = mediaEditor.markdown.indexOf('Closing reflection');
  const mediaEdit = timed(() => mediaEditor.replaceRange(mediaEditAt, mediaEditAt, 'x'));
  const mediaScrollStarted = performance.now();
  mediaEditor.root.scrollTop = mediaEditor.root.scrollHeight;
  await nextPaint();
  const mediaScroll = performance.now() - mediaScrollStarted;

  const report = {
    load100KB, load1MB, edit100KB, edit1MB, layer1MB, typewriter100KB, scroll1MB, domNodes1MB,
    chunks1MB: editor1MB.chunkEls.length,
    editTop1MB: { p50: median(editTop1MB), p95: percentile(editTop1MB, 0.95) },
    editMiddle1MB: { p50: median(editMiddle1MB), p95: percentile(editMiddle1MB, 0.95) },
    editEnd1MB: { p50: median(editEnd1MB), p95: percentile(editEnd1MB, 0.95) },
    sustained100KB: { p50: median(endurance), p95: percentile(endurance, 0.95) },
    giantParagraphEdit,
    usedHeap1MB, reactMount100KB,
    mediaJournal: {
      ready: mediaReady,
      edit: mediaEdit,
      scroll: mediaScroll,
      nodes: mediaNodes,
      requested: mediaResolver.requested.length,
      ...mediaCounts,
    },
  };
  console.log(`MDE_WEB_PERFORMANCE ${JSON.stringify(report)}`);
  await fetch('/__mde_perf_report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report, null, 2),
  });

  expect(load100KB, '100 KB cold load').toBeLessThanOrEqual(__MDE_PERF_BUDGETS__.load100KB);
  expect(load1MB, '1 MB cold load').toBeLessThanOrEqual(__MDE_PERF_BUDGETS__.load1MB);
  expect(edit100KB, '100 KB local edit').toBeLessThanOrEqual(__MDE_PERF_BUDGETS__.edit100KB);
  expect(edit1MB, '1 MB local edit').toBeLessThanOrEqual(__MDE_PERF_BUDGETS__.edit1MB);
  expect(layer1MB, '1 MB one-span plugin layer').toBeLessThanOrEqual(
    __MDE_PERF_BUDGETS__.layer1MB,
  );
  expect(typewriter100KB, '100 KB typewriter enable').toBeLessThanOrEqual(
    __MDE_PERF_BUDGETS__.typewriter100KB,
  );
  expect(giantParagraphEdit, '32 KB giant Unicode paragraph edit').toBeLessThanOrEqual(
    __MDE_PERF_BUDGETS__.giantParagraph,
  );
  expect(scroll1MB, '1 MB two-frame scroll').toBeLessThanOrEqual(__MDE_PERF_BUDGETS__.scroll1MB);
  expect(domNodes1MB, '1 MB DOM element count').toBeLessThanOrEqual(
    __MDE_PERF_BUDGETS__.maxDomNodes1MB,
  );
  for (const [position, samples] of [
    ['near start', editTop1MB],
    ['middle', editMiddle1MB],
    ['near end', editEnd1MB],
  ]) {
    expect(percentile(samples, 0.95), `1 MB ${position} edit p95`).toBeLessThanOrEqual(
      __MDE_PERF_BUDGETS__.positionEditP95,
    );
  }
  expect(percentile(endurance, 0.95), '100 KB sustained edit p95').toBeLessThanOrEqual(
    __MDE_PERF_BUDGETS__.sustainedEditP95,
  );
  if (usedHeap1MB !== null) {
    expect(usedHeap1MB, '1 MB browser heap').toBeLessThanOrEqual(
      __MDE_PERF_BUDGETS__.maxHeap1MB,
    );
  }
  expect(reactMount100KB, 'React 100 KB warm-core mount').toBeLessThanOrEqual(
    __MDE_PERF_BUDGETS__.reactMount100KB,
  );
  expect(editor1MB.chunkEls.length).toBeGreaterThan(100);
  expect(editor1MB.markdown).toContain('xxxxx');
  expect(mediaReady, '72-resource journal through resolved media').toBeLessThanOrEqual(
    __MDE_PERF_BUDGETS__.mediaJournalReady,
  );
  expect(mediaEdit, 'local edit after 72 resolved media resources').toBeLessThanOrEqual(
    __MDE_PERF_BUDGETS__.mediaJournalEdit,
  );
  expect(mediaScroll, 'two-frame scroll through a media journal').toBeLessThanOrEqual(
    __MDE_PERF_BUDGETS__.mediaJournalScroll,
  );
  expect(mediaNodes, 'media-journal DOM element count').toBeLessThanOrEqual(
    __MDE_PERF_BUDGETS__.maxMediaJournalNodes,
  );
  expect(mediaResolver.requested).toHaveLength(72);
  expect(mediaCounts).toEqual({ images: 48, videos: 8, audio: 16 });
  expect(mediaEditor.markdown).toBe(mediaSource.replace('Closing reflection', 'xClosing reflection'));
});
