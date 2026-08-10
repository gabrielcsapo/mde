// Browser performance regression gates. These intentionally run against the built
// package in real Chromium: DOM construction, layout containment, WASM calls, and the
// extension layer are the costs a user actually feels.

import { afterEach, beforeAll, expect, test } from 'vitest';
import '../src/theme.css';
import { MarkdownEditor, encodeManifest, loadCore } from '../dist/index.js';
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

function makeEditor() {
  const host = document.createElement('div');
  host.style.cssText = 'display:block;width:720px;height:480px;overflow:auto';
  document.body.appendChild(host);
  const engine = core.newEngine(manifest);
  const editor = new MarkdownEditor(host, engine);
  live.push({ editor, engine });
  return editor;
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
  const giantParagraphEdit = timedEdits(giantEditor, Math.floor(giantSource.length / 2), 1)[0];
  const scroll1MB = await new Promise((resolve) => {
    const started = performance.now();
    editor1MB.root.scrollTop = editor1MB.root.scrollHeight;
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)));
  });
  const domNodes1MB = editor1MB.root.querySelectorAll('*').length;
  const usedHeap1MB = (/** @type {any} */ (performance)).memory?.usedJSHeapSize ?? null;

  const report = {
    load100KB, load1MB, edit100KB, edit1MB, layer1MB, typewriter100KB, scroll1MB, domNodes1MB,
    chunks1MB: editor1MB.chunkEls.length,
    editTop1MB: { p50: median(editTop1MB), p95: percentile(editTop1MB, 0.95) },
    editMiddle1MB: { p50: median(editMiddle1MB), p95: percentile(editMiddle1MB, 0.95) },
    editEnd1MB: { p50: median(editEnd1MB), p95: percentile(editEnd1MB, 0.95) },
    sustained100KB: { p50: median(endurance), p95: percentile(endurance, 0.95) },
    giantParagraphEdit,
    usedHeap1MB,
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
  expect(scroll1MB, '1 MB two-frame scroll').toBeLessThanOrEqual(__MDE_PERF_BUDGETS__.scroll1MB);
  expect(domNodes1MB, '1 MB DOM element count').toBeLessThanOrEqual(
    __MDE_PERF_BUDGETS__.maxDomNodes1MB,
  );
  expect(editor1MB.chunkEls.length).toBeGreaterThan(100);
  expect(editor1MB.markdown).toContain('xxxxx');
});
