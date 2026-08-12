import { afterEach, beforeAll, expect, test } from 'vitest';
import { MarkdownEditor, encodeManifest, loadCore } from '../dist/index.js';

/* global __MDE_PERF_LIFECYCLE__, __MDE_LIFECYCLE_BUDGETS__ */

let core;
beforeAll(async () => { core = await loadCore('/dist/mde.wasm'); });
afterEach(() => { document.body.replaceChildren(); });

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

test.runIf(__MDE_PERF_LIFECYCLE__)('repeated editor lifecycle stays bounded', async () => {
  const source = (
    '# Journal\n\n**Rendered** entry with [link](https://example.dev) and 日本語 🎉.\n\n'
  ).repeat(1400);
  const heapBefore = performance.memory?.usedJSHeapSize ?? null;
  let maxOperation = 0;
  let maxFrameGap = 0;
  let previousFrame = performance.now();

  for (let cycle = 0; cycle < 30; cycle++) {
    const host = document.createElement('div');
    host.style.cssText = 'width:720px;height:480px;overflow:auto';
    document.body.appendChild(host);
    const engine = core.newEngine(encodeManifest({}));
    const editor = new MarkdownEditor(host, engine);
    let started = performance.now();
    editor.setMarkdown(source);
    editor.replaceRange(source.length / 2, source.length / 2, 'x');
    host.scrollTop = host.scrollHeight;
    maxOperation = Math.max(maxOperation, performance.now() - started);
    await nextFrame();
    const now = performance.now();
    maxFrameGap = Math.max(maxFrameGap, now - previousFrame);
    previousFrame = now;
    editor.destroy();
    engine.free();
    host.remove();
  }
  await nextFrame();
  const heapAfter = performance.memory?.usedJSHeapSize ?? null;
  const heapGrowth = heapBefore === null || heapAfter === null
    ? 0 : Math.max(0, heapAfter - heapBefore);
  const report = { maxOperation, maxFrameGap, heapGrowth, retainedNodes: document.body.children.length };
  await fetch('/__mde_perf_lifecycle_report', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report, null, 2),
  });
  expect(maxOperation).toBeLessThanOrEqual(__MDE_LIFECYCLE_BUDGETS__.maxOperation);
  expect(maxFrameGap).toBeLessThanOrEqual(__MDE_LIFECYCLE_BUDGETS__.maxFrameGap);
  expect(heapGrowth).toBeLessThanOrEqual(__MDE_LIFECYCLE_BUDGETS__.heapGrowth);
  expect(report.retainedNodes).toBe(0);
}, 60_000);
