import { createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test } from 'vitest';

import {
  MarkdownEditor,
  createReactPresentation,
  definePlugin,
  useEditorCommands,
  usePluginPresentation,
} from '../dist/index.js';

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

test('React plugin presentations stay outside its subtree and clean up on removal', async () => {
  const ref = createRef();
  const panel = document.createElement('div');
  panel.textContent = 'Mention suggestions';
  const plugin = definePlugin({
    name: 'test.react-presentation',
    setup(context) {
      context.showPresentation('mentions', { element: panel, anchor: 'editor' });
    },
  });
  const { root, host } = mount(createElement(MarkdownEditor, {
    ref, defaultValue: 'Hello @ga', plugins: [plugin],
  }));
  await until(() => ref.current?.isReady(), 'React editor never became ready');
  expect(panel.isConnected).toBe(true);
  expect(host.contains(panel)).toBe(false);
  expect(ref.current.getMarkdown()).toBe('Hello @ga');

  root.render(createElement(MarkdownEditor, {
    ref, defaultValue: 'Hello @ga', plugins: [],
  }));
  await until(() => !panel.isConnected, 'React plugin presentation leaked after removal');
});

test('React presentation helper owns a portal root and supports live rendering', async () => {
  const ref = createRef();
  let presentation;
  const plugin = definePlugin({
    name: 'test.react-portal-helper',
    setup(context) {
      presentation = createReactPresentation(
        context,
        'palette',
        createElement('button', null, 'First command'),
        { anchor: 'viewport', className: 'react-plugin-palette' },
      );
    },
  });
  mount(createElement(MarkdownEditor, {
    ref, defaultValue: 'Commands', plugins: [plugin],
  }));
  await until(() => ref.current?.isReady(), 'React editor never became ready');
  await until(() => presentation?.element.textContent === 'First command', 'portal did not render');
  expect(presentation.element.className).toBe('react-plugin-palette');
  presentation.render(createElement('button', null, 'Updated command'));
  await until(() => presentation.element.textContent === 'Updated command', 'portal did not update');
  presentation.update({ className: undefined });
  expect(presentation.element.className).toBe('');
  expect(ref.current.getMarkdown()).toBe('Commands');
  ref.current.removePlugin(plugin.name);
  await until(() => !presentation.element.isConnected, 'portal leaked after plugin removal');
});

test('React handle exposes discoverable plugin commands', async () => {
  const ref = createRef();
  const seen = [];
  const plugin = definePlugin({
    name: 'test.react-commands',
    setup(context) {
      context.registerCommand('palette', {
        title: 'Open palette', category: 'Editor', handler: () => { seen.push('run'); },
      });
    },
  });
  mount(createElement(MarkdownEditor, {
    ref, defaultValue: 'Commands', plugins: [plugin],
  }));
  await until(() => ref.current?.isReady(), 'React editor never became ready');
  expect(ref.current.getCommands().map((command) => command.title)).toEqual(['Open palette']);
  expect(ref.current.executeCommand(ref.current.getCommands()[0].id)).toBe(true);
  expect(seen).toEqual(['run']);
});

test('React changes interaction mode without remounting or losing source', async () => {
  const ref = createRef();
  const seen = [];
  const props = {
    ref,
    defaultValue: 'Read [the docs](https://example.dev)',
    onModeChange: (mode) => seen.push(mode),
  };
  const { root } = mount(createElement(MarkdownEditor, {
    ...props,
    interactionMode: 'view',
  }));
  await until(() => ref.current?.isReady(), 'React editor never became ready');
  expect(ref.current.getInteractionMode()).toBe('view');
  expect(ref.current.getElement().getAttribute('contenteditable')).toBe('false');

  root.render(createElement(MarkdownEditor, { ...props, interactionMode: 'edit' }));
  await until(() => ref.current.getInteractionMode() === 'edit', 'mode prop stayed stale');
  expect(ref.current.getMarkdown()).toBe(props.defaultValue);
  expect(seen).toContain('edit');

  ref.current.setInteractionMode('view');
  expect(ref.current.getInteractionMode()).toBe('view');
  expect(seen).toContain('view');
});

test('React command hook receives the live registry', async () => {
  const ref = createRef();
  const plugin = definePlugin({
    name: 'test.react-command-hook',
    setup(context) {
      context.registerCommand('insert', { title: 'Insert photo', handler() {} });
    },
  });
  function Probe() {
    const [commands, onCommandsChange] = useEditorCommands();
    return createElement('div', null,
      createElement(MarkdownEditor, {
        ref, defaultValue: '', plugins: [plugin], onCommandsChange,
      }),
      createElement('output', { 'data-command-count': commands.length }, commands.map((x) => x.title).join(',')),
    );
  }
  const { host } = mount(createElement(Probe));
  await until(() => host.querySelector('output')?.textContent === 'Insert photo', 'command hook stayed stale');
});

test('React presentation hook renders, updates, returns its handle, and cleans up', async () => {
  let currentHandle = null;
  let activeOptions = null;
  const context = {
    showPresentation(name, options) {
      activeOptions = options;
      document.body.appendChild(options.element);
      return {
        id: name,
        update(next) { activeOptions = { ...activeOptions, ...next }; },
        reposition() {},
        dismiss(reason = 'programmatic') {
          activeOptions.element.remove();
          activeOptions.onDismiss?.(reason);
        },
      };
    },
  };
  function Presentation({ label }) {
    currentHandle = usePluginPresentation(
      context, 'hook-panel', createElement('span', null, label), { anchor: 'editor' },
    );
    return null;
  }
  const { root } = mount(createElement(Presentation, { label: 'First' }));
  await until(() => document.body.textContent.includes('First'), 'hook presentation did not mount');
  await until(() => currentHandle !== null, 'hook did not return its mounted handle');
  root.render(createElement(Presentation, { label: 'Updated' }));
  await until(() => currentHandle.element.textContent === 'Updated', 'hook presentation did not update');
  root.render(null);
  await until(() => !currentHandle.element.isConnected, 'hook presentation leaked after unmount');
});

test('controlled acknowledgement does not roll back an accepted local edit', async () => {
  const ref = createRef();
  const seen = [];
  const { root } = mount(createElement(MarkdownEditor, {
    ref,
    value: 'hello',
    onChange: (markdown) => seen.push(markdown),
  }));
  await until(() => ref.current?.isReady(), 'React editor never became ready');
  ref.current.replaceRange(5, 5, '!');
  expect(ref.current.getMarkdown()).toBe('hello!');

  // A concurrent parent can commit its previous value once before the state update
  // carrying the acknowledgement lands. The editor must not visibly rewind.
  root.render(createElement(MarkdownEditor, {
    ref,
    value: 'hello',
    onChange: (markdown) => seen.push(markdown),
  }));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(ref.current.getMarkdown()).toBe('hello!');

  root.render(createElement(MarkdownEditor, { ref, value: 'hello!' }));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(ref.current.getMarkdown()).toBe('hello!');
  expect(seen).toContain('hello!');
});

test('an external controlled update is applied before the next paint', async () => {
  const ref = createRef();
  const { root } = mount(createElement(MarkdownEditor, { ref, value: 'before' }));
  await until(() => ref.current?.isReady(), 'React editor never became ready');

  root.render(createElement(MarkdownEditor, { ref, value: 'after **update**' }));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(ref.current.getMarkdown()).toBe('after **update**');
});
