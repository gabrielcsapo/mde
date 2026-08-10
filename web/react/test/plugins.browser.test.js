import { createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test } from 'vitest';

import { MarkdownEditor, definePlugin } from '../dist/index.js';

const mounted = [];

afterEach(() => {
  for (const { root, host } of mounted.reverse()) {
    root.unmount();
    host.remove();
  }
  mounted.length = 0;
});

function mount(element) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(element);
  mounted.push({ root, host });
  return { root, host };
}

async function until(predicate, message) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  throw new Error(message);
}

test('the React plugins prop installs, replaces, and cleans runtime plugins', async () => {
  const ref = createRef();
  let setups = 0;
  let cleanups = 0;
  const plugin = definePlugin({
    name: 'test.react-lifecycle',
    setup(context) {
      setups++;
      const role = context.internRole('react-plugin-mark');
      context.setLayer('mark', [{ start: 0, end: 5, role }]);
      return () => { cleanups++; };
    },
  });

  const { root } = mount(createElement(MarkdownEditor, {
    ref,
    defaultValue: 'hello from React',
    plugins: [plugin],
  }));
  await until(() => ref.current?.isReady(), 'React editor never became ready');
  expect(setups).toBe(1);
  expect(ref.current.getInstalledPlugins()).toEqual(['test.react-lifecycle']);
  expect(ref.current.getDecorations().some((item) => item.layer > 0)).toBe(true);

  root.render(createElement(MarkdownEditor, {
    ref,
    defaultValue: 'hello from React',
    plugins: [],
  }));
  await until(() => cleanups === 1, 'removed React plugin was not cleaned up');
  expect(ref.current.getInstalledPlugins()).toEqual([]);
  expect(ref.current.getDecorations().some((item) => item.layer > 0)).toBe(false);
});

test('React composes plugin syntax before constructing the engine', async () => {
  const ref = createRef();
  const plugin = definePlugin({
    name: 'test.react-manifest',
    manifest: {
      inlines: [{
        name: 'react-mention',
        syntax: { kind: 'pattern', regex: '@[a-z]+' },
        render: 'style',
      }],
    },
    setup() {},
  });

  mount(createElement(MarkdownEditor, {
    ref,
    defaultValue: 'Ping @react now',
    plugins: [plugin],
  }));
  await until(() => ref.current?.isReady(), 'React editor never became ready');
  const engine = ref.current.getEngine();
  expect(ref.current.getDecorations().some(
    (decoration) => engine.roleName(decoration.role) === 'react-mention',
  )).toBe(true);
});
