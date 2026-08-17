import { afterEach, beforeAll, expect, test } from 'vitest';
import { MarkdownEditor, encodeManifest, loadCore } from '../dist/index.js';

/* global __MDE_PERF_LIFECYCLE__, __MDE_LIFECYCLE_BUDGETS__ */

let core;
beforeAll(async () => { core = await loadCore('/dist/mde.wasm'); });
afterEach(() => { document.body.replaceChildren(); });

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function multiDayJournal(days = 365) {
  const entries = [];
  for (let day = 1; day <= days; day++) {
    const media = day % 7 === 0
      ? `\n![Week ${Math.ceil(day / 7)}](journal/photo-${day}.jpg)\n`
      : day % 11 === 0
        ? `\n![Voice note ${day}](journal/audio-${day}.m4a)\n`
        : day % 17 === 0 ? `\n![Moment ${day}](journal/video-${day}.mp4)\n` : '';
    entries.push(`## 2026-${String(Math.ceil(day / 28)).padStart(2, '0')}-${String((day - 1) % 28 + 1).padStart(2, '0')}

Today included **focused work**, a [saved reference](https://example.dev/day/${day}), and a few searchable observations. ${'Ordinary journal prose keeps the workload representative. '.repeat(8)}
${media}
- [${day % 3 === 0 ? 'x' : ' '}] daily reflection
- energy: ${day % 5}
`);
  }
  return `# One year journal\n\n${entries.join('\n\n')}\n`;
}

test.runIf(__MDE_PERF_LIFECYCLE__)('repeated editor lifecycle stays bounded', async () => {
  const source = multiDayJournal();
  const heapBefore = performance.memory?.usedJSHeapSize ?? null;
  let maxOperation = 0;
  let maxFrameGap = 0;
  let maxBackgroundTransition = 0;
  let maxModeTransition = 0;
  let previousFrame = performance.now();

  for (let cycle = 0; cycle < 30; cycle++) {
    const host = document.createElement('div');
    host.style.cssText = 'width:720px;height:480px;overflow:auto';
    document.body.appendChild(host);
    const engine = core.newEngine(encodeManifest({}));
    const editor = new MarkdownEditor(host, engine, {
      resourceResolver: {
        reservedSize: ({ reference }) => reference.endsWith('.m4a')
          ? ({ width: 560, height: 56 }) : ({ width: 560, height: 315 }),
        async resolve({ reference, signal }) {
          if (signal.aborted) return { state: 'failed', message: 'backgrounded' };
          const view = document.createElement(reference.endsWith('.jpg') ? 'img' : 'div');
          view.setAttribute('width', '560');
          view.setAttribute('height', reference.endsWith('.m4a') ? '56' : '315');
          return { state: 'ready', view };
        },
      },
    });
    let started = performance.now();
    editor.setMarkdown(source);
    const editAt = Math.floor(source.length / 2);
    editor.replaceRange(editAt, editAt, 'x');
    host.scrollTop = host.scrollHeight;
    maxOperation = Math.max(maxOperation, performance.now() - started);
    started = performance.now();
    for (let transition = 0; transition < 3; transition++) {
      editor.suspend();
      editor.resume();
    }
    maxBackgroundTransition = Math.max(
      maxBackgroundTransition, (performance.now() - started) / 3,
    );
    started = performance.now();
    for (let transition = 0; transition < 3; transition++) {
      editor.interactionMode = 'view';
      editor.interactionMode = 'edit';
    }
    maxModeTransition = Math.max(maxModeTransition, (performance.now() - started) / 6);
    expect(editor.markdown).toBe(source.slice(0, editAt) + 'x' + source.slice(editAt));
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
  const report = {
    maxOperation, maxFrameGap, maxBackgroundTransition, maxModeTransition, heapGrowth,
    retainedNodes: document.body.children.length,
  };
  await fetch('/__mde_perf_lifecycle_report', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report, null, 2),
  });
  expect(maxOperation).toBeLessThanOrEqual(__MDE_LIFECYCLE_BUDGETS__.maxOperation);
  expect(maxFrameGap).toBeLessThanOrEqual(__MDE_LIFECYCLE_BUDGETS__.maxFrameGap);
  expect(maxBackgroundTransition).toBeLessThanOrEqual(
    __MDE_LIFECYCLE_BUDGETS__.maxBackgroundTransition,
  );
  expect(maxModeTransition).toBeLessThanOrEqual(__MDE_LIFECYCLE_BUDGETS__.maxModeTransition);
  expect(heapGrowth).toBeLessThanOrEqual(__MDE_LIFECYCLE_BUDGETS__.heapGrowth);
  expect(report.retainedNodes).toBe(0);
}, 60_000);
