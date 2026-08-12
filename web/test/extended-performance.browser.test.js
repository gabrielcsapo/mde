import { afterEach, expect, test } from 'vitest';
import { encodeManifest, loadCore, MarkdownEditor, prepareDocument } from '../dist/index.js';

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

  // A realistic multi-year journal is mostly prose with occasional structure. Keep
  // the historical dense-markup corpus above as the worst-case renderer gate, and use
  // this separate 5 MB shape to price the user-facing progressive-open path.
  const journalBlock =
    '## Journal checkpoint\n\n' +
    'A long searchable journal paragraph with ordinary prose, reflections, locations, and notes. '
      .repeat(12) +
    '\n\n**summary** [source](https://example.dev)\n\n';
  const journalSource = journalBlock
    .repeat(Math.ceil(5 * 1024 * 1024 / journalBlock.length))
    .slice(0, 5 * 1024 * 1024);
  const progressiveHost = document.createElement('div');
  progressiveHost.style.cssText = 'width:720px;height:480px;overflow:auto';
  document.body.appendChild(progressiveHost);
  const progressiveEngine = core.newEngine(encodeManifest({}));
  const progressiveEditor = new MarkdownEditor(progressiveHost, progressiveEngine);
  live.push({ editor: progressiveEditor, engine: progressiveEngine });
  const prepareStarted = performance.now();
  const preparedPromise = prepareDocument(journalSource, { wasm: '/dist/mde.wasm' });
  const progressiveOpen = progressiveEditor.setMarkdownProgressively(journalSource, preparedPromise);
  const sourceVisible = performance.now() - prepareStarted;
  const mainThreadProbeStarted = performance.now();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const mainThreadProbe = performance.now() - mainThreadProbeStarted;
  await progressiveOpen;
  const prepared = await preparedPromise;
  const progressiveReady = performance.now() - prepareStarted;
  const progressiveNodes = progressiveHost.querySelectorAll('*').length;
  const progressiveEditStarted = performance.now();
  progressiveEditor.replaceRange(
    Math.floor(journalSource.length / 2), Math.floor(journalSource.length / 2), 'y',
  );
  const progressiveEdit = performance.now() - progressiveEditStarted;
  const progressiveSource = journalSource.slice(0, journalSource.length / 2)
    + 'y' + journalSource.slice(journalSource.length / 2);

  const report = {
    load, edit, teardown, nodes, sourceVisible, mainThreadProbe,
    progressiveReady, progressiveNodes, progressiveEdit,
    progressiveSnapshotBytes: prepared.snapshot.byteLength,
  };
  console.log(`MDE_WEB_EXTENDED ${JSON.stringify(report)}`);
  await fetch('/__mde_perf_extended_report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report, null, 2),
  });
  expect(editor.markdown).toBe(source.slice(0, source.length / 2) + 'x' + source.slice(source.length / 2));
  expect(load).toBeLessThanOrEqual(__MDE_EXTENDED_BUDGETS__.load5MB);
  expect(edit).toBeLessThanOrEqual(__MDE_EXTENDED_BUDGETS__.edit5MB);
  expect(teardown).toBeLessThanOrEqual(__MDE_EXTENDED_BUDGETS__.teardown5MB);
  expect(nodes).toBeLessThanOrEqual(__MDE_EXTENDED_BUDGETS__.maxNodes5MB);
  expect(sourceVisible).toBeLessThanOrEqual(__MDE_EXTENDED_BUDGETS__.sourceVisible5MB);
  expect(mainThreadProbe).toBeLessThanOrEqual(__MDE_EXTENDED_BUDGETS__.mainThreadProbe5MB);
  expect(progressiveReady).toBeLessThanOrEqual(__MDE_EXTENDED_BUDGETS__.progressiveReady5MB);
  expect(progressiveEdit).toBeLessThanOrEqual(__MDE_EXTENDED_BUDGETS__.edit5MB);
  expect(progressiveNodes).toBeLessThanOrEqual(__MDE_EXTENDED_BUDGETS__.maxNodes5MB);
  expect(progressiveEditor.markdown).toBe(progressiveSource);
}, 30_000);
