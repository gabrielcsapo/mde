import { afterEach, expect, test } from 'vitest';
import { encodeManifest, loadCore, MarkdownEditor } from '../dist/index.js';

/* global __MDE_PERF_EXTENDED__, __MDE_EXTENDED_BUDGETS__ */

const live = [];
afterEach(() => {
  for (const { editor, engine } of live.splice(0)) {
    editor.destroy();
    engine.free();
  }
  document.body.replaceChildren();
});

test.runIf(__MDE_PERF_EXTENDED__)('optional 5 MB browser profile', async () => {
  const core = await loadCore('/dist/mde.wasm');
  const block = '## Journal\n\n**Rendered** prose, [link](https://example.dev), résumé 日本語 🎉.\n\n';
  const source = block.repeat(Math.ceil(5 * 1024 * 1024 / block.length)).slice(0, 5 * 1024 * 1024);
  const host = document.createElement('div');
  host.style.cssText = 'width:720px;height:480px;overflow:auto';
  document.body.appendChild(host);
  const engine = core.newEngine(encodeManifest({}));
  const editor = new MarkdownEditor(host, engine);
  live.push({ editor, engine });

  let started = performance.now();
  editor.setMarkdown(source);
  const load = performance.now() - started;
  const nodes = host.querySelectorAll('*').length;
  started = performance.now();
  editor.replaceRange(Math.floor(source.length / 2), Math.floor(source.length / 2), 'x');
  const edit = performance.now() - started;
  started = performance.now();
  editor.destroy();
  engine.free();
  live.length = 0;
  const teardown = performance.now() - started;

  console.log(`MDE_WEB_EXTENDED ${JSON.stringify({ load, edit, teardown, nodes })}`);
  expect(editor.markdown).toBe(source.slice(0, source.length / 2) + 'x' + source.slice(source.length / 2));
  expect(load).toBeLessThanOrEqual(__MDE_EXTENDED_BUDGETS__.load5MB);
  expect(edit).toBeLessThanOrEqual(__MDE_EXTENDED_BUDGETS__.edit5MB);
  expect(teardown).toBeLessThanOrEqual(__MDE_EXTENDED_BUDGETS__.teardown5MB);
  expect(nodes).toBeLessThanOrEqual(__MDE_EXTENDED_BUDGETS__.maxNodes5MB);
}, 30_000);
