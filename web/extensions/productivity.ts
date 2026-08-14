import { definePlugin } from '../src/plugins.js';
import type { EditorPlugin, EditorPluginContext } from '../src/plugins.js';
import type { SelectionRange } from '../src/core.js';

export interface TextTransformCommand {
  name: string;
  title: string;
  before: string;
  after?: string;
  key?: string;
  primary?: boolean;
}

/** Generic formatting plugin factory; products supply data, not editor wiring. */
export function textTransformCommands(
  name: string,
  transforms: readonly TextTransformCommand[],
): EditorPlugin {
  return definePlugin({
    name,
    requires: { apiVersion: 1, capabilities: ['document', 'selection', 'commands'] },
    setup(context) {
      for (const transform of transforms) {
        context.commands.register(transform.name, {
          title: transform.title, category: 'Formatting', key: transform.key,
          primary: transform.primary,
          enabled: () => context.selection.range != null,
          handler: () => {
            const range = context.selection.range;
            if (!range) return false;
            replaceSelection(context, range, transform.before, transform.after);
          },
        });
      }
    },
  });
}

export interface TemplateItem {
  id: string;
  title: string;
  markdown: string;
  detail?: string;
}

export interface ContextualTextAction {
  label: string;
  before: string;
  after?: string;
}

function replaceSelection(
  context: EditorPluginContext,
  range: SelectionRange,
  before: string,
  after = before,
): void {
  const source = context.document.slice(range);
  const replacement = `${before}${source}${after}`;
  const start = range.start + before.length;
  context.document.transact({
    edits: [{ ...range, text: replacement }],
    selection: { start, end: start + source.length },
    metadata: { label: 'Format selection', origin: context.name },
  });
}

/** A compact formatting bar anchored to non-empty selections. */
export function floatingSelectionToolbar(actions: readonly ContextualTextAction[] = [
  { label: 'Bold', before: '**' },
  { label: 'Italic', before: '*' },
  { label: 'Code', before: '`' },
  { label: 'Link', before: '[', after: '](https://)' },
]): EditorPlugin {
  return definePlugin({
    name: 'mde.examples.selection-toolbar',
    setup(context) {
      let visible = false;
      const update = () => {
        const range = context.selection.range;
        if (!range || range.start === range.end) {
          if (visible) context.dismissPresentation('toolbar');
          visible = false;
          return;
        }
        const toolbar = document.createElement('div');
        toolbar.className = 'mde-floating-toolbar';
        toolbar.setAttribute('role', 'toolbar');
        toolbar.setAttribute('aria-label', 'Text formatting');
        const addAction = (label: string, before: string, after = before) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = label;
          button.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            replaceSelection(context, range, before, after);
          });
          toolbar.appendChild(button);
        };
        for (const action of actions) addAction(
          action.label, action.before, action.after ?? action.before,
        );
        context.showPresentation('toolbar', {
          element: toolbar,
          anchor: 'selection',
          placement: 'above',
          offset: 6,
          dismissOnOutsidePointer: false,
          restoreFocus: false,
        });
        visible = true;
      };
      context.on('selectionchange', update);
      context.on('change', update);
      return () => context.dismissPresentation('toolbar');
    },
  });
}

/** Command-K link editor that preserves the selected label. */
export function linkEditor(): EditorPlugin {
  return definePlugin({
    name: 'mde.examples.link-editor',
    setup(context) {
      context.registerCommand('open', {
        title: 'Add or edit link',
        category: 'Formatting',
        keywords: ['url', 'hyperlink'],
        key: 'k',
        primary: true,
        handler: () => openLinkEditor(context),
      });
    },
  });
}

function openLinkEditor(context: EditorPluginContext): void {
  const currentSelection = context.selection.range ?? {
    start: context.document.length,
    end: context.document.length,
  };
  const linkNode = context.semantics.query({ roles: ['link'], range: currentSelection, intersects: false })[0];
  const existing = linkNode
    ? inlineLinkAtSelection(linkNode.source, { start: 0, end: linkNode.source.length }, linkNode.start)
    : inlineLinkAtSelection(context.document.markdown, currentSelection);
  const selection = existing?.range ?? currentSelection;
  const selected = existing?.label
    ?? context.document.slice(selection);
  const form = dialog(existing ? 'Edit link' : 'Add a link');
  const label = input('Link text', selected || 'link');
  const destination = input('URL', existing?.destination ?? 'https://');
  const actions = dialogActions(context, 'link');
  const submit = button('Insert', 'submit');
  actions.appendChild(submit);
  form.append(label, destination, actions);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const markdown = `[${escapeLabel(label.value)}](${destination.value.trim()})`;
    const caret = selection.start + markdown.length;
    context.document.transact({
      edits: [{ ...selection, text: markdown }],
      selection: { start: caret, end: caret },
      metadata: { label: existing ? 'Edit link' : 'Add link', origin: context.name },
    });
    context.dismissPresentation('link');
  });
  context.showPresentation('link', {
    element: form,
    anchor: 'selection',
    modal: true,
    dismissOnOutsidePointer: true,
    initialFocus: destination,
  });
}

interface InlineLink {
  range: SelectionRange;
  label: string;
  destination: string;
}

/** Find a plain inline link containing the caret/selection without treating images as links. */
function inlineLinkAtSelection(markdown: string, selection: SelectionRange, offset = 0): InlineLink | null {
  const links = /\[(?:\\.|[^\]\\])*\]\((?:\\.|[^)\\\n])*\)/g;
  for (const match of markdown.matchAll(links)) {
    const start = match.index;
    const end = start + match[0].length;
    if (markdown[start - 1] === '!' || selection.start < start || selection.end > end) continue;
    const divider = match[0].indexOf('](');
    if (divider < 1) continue;
    return {
      range: { start: start + offset, end: end + offset },
      label: match[0].slice(1, divider).replace(/\\([\\\]])/g, '$1'),
      destination: match[0].slice(divider + 2, -1).replace(/\\([\\)])/g, '$1'),
    };
  }
  return null;
}

/** A host-provided set of reusable journal entry templates. */
export function templatePicker(templates: readonly TemplateItem[]): EditorPlugin {
  return definePlugin({
    name: 'mde.examples.templates',
    setup(context) {
      context.registerCommand('open', {
        title: 'Insert template',
        category: 'Insert',
        keywords: ['journal', 'daily', 'prompt'],
        handler: () => {
          const range = context.selection.range ?? {
            start: context.document.length,
            end: context.document.length,
          };
          const menu = document.createElement('div');
          menu.className = 'mde-composer-menu';
          menu.setAttribute('role', 'listbox');
          menu.setAttribute('aria-label', 'Templates');
          for (const template of templates) {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = 'mde-composer-option';
            option.textContent = template.title;
            if (template.detail) {
              const detail = document.createElement('span');
              detail.textContent = template.detail;
              option.appendChild(detail);
            }
            option.addEventListener('click', () => {
              const caret = range.start + template.markdown.length;
              context.document.transact({
                edits: [{ ...range, text: template.markdown }],
                selection: { start: caret, end: caret },
                metadata: { label: 'Insert template', origin: context.name },
              });
              context.dismissPresentation('templates');
            });
            menu.appendChild(option);
          }
          context.showPresentation('templates', {
            element: menu,
            anchor: 'selection',
            dismissOnOutsidePointer: true,
          });
        },
      });
    },
  });
}

/** Editor-scoped find/replace that never reaches into the rendered DOM. */
export function findAndReplace(): EditorPlugin {
  return definePlugin({
    name: 'mde.examples.find-replace',
    setup(context) {
      context.registerCommand('open', {
        title: 'Find and replace',
        category: 'Editing',
        keywords: ['search'],
        key: 'f',
        primary: true,
        shift: true,
        handler: () => {
          const form = dialog('Find and replace');
          const find = input('Find');
          const replacement = input('Replace with');
          const status = document.createElement('output');
          status.setAttribute('aria-live', 'polite');
          const actions = dialogActions(context, 'find-replace');
          const replace = button('Replace all', 'submit');
          actions.appendChild(replace);
          form.append(find, replacement, status, actions);
          form.addEventListener('submit', (event) => {
            event.preventDefault();
            if (!find.value) return;
            const source = context.document.markdown;
            const count = source.split(find.value).length - 1;
            if (count > 0) context.document.transact({
              edits: [{ start: 0, end: source.length, text: source.split(find.value).join(replacement.value) }],
              metadata: { label: 'Replace all', origin: context.name },
            });
            status.textContent = `${count} replacement${count === 1 ? '' : 's'}`;
          });
          context.showPresentation('find-replace', {
            element: form,
            anchor: 'viewport',
            modal: true,
            initialFocus: find,
          });
        },
      });
    },
  });
}

/** Edit the alt text of the image at the caret without touching its destination. */
export function imageAltEditor(): EditorPlugin {
  return definePlugin({
    name: 'mde.examples.image-alt',
    setup(context) {
      context.registerCommand('edit', {
        title: 'Edit image description',
        category: 'Media',
        keywords: ['alt', 'accessibility', 'caption'],
        enabled: () => imageAtSelection(context) !== null,
        handler: () => {
          const image = imageAtSelection(context);
          if (!image) return false;
          const form = dialog('Image description');
          const alt = input('Alt text', image.alt);
          const actions = dialogActions(context, 'image-alt');
          actions.appendChild(button('Save', 'submit'));
          form.append(alt, actions);
          form.addEventListener('submit', (event) => {
            event.preventDefault();
            const markdown = `![${escapeLabel(alt.value)}](${image.destination})`;
            context.document.transact({
              edits: [{ start: image.start, end: image.end, text: markdown }],
              metadata: { label: 'Edit image description', origin: context.name },
            });
            context.dismissPresentation('image-alt');
          });
          context.showPresentation('image-alt', {
            element: form,
            anchor: 'selection',
            modal: true,
            initialFocus: alt,
          });
        },
      });
    },
  });
}

function imageAtSelection(context: EditorPluginContext) {
  const caret = context.selection.range?.start ?? -1;
  const node = context.semantics.at(caret, ['image'])[0];
  if (!node) return null;
  const match = /^!\[([^\]]*)\]\(([^)]+)\)$/u.exec(node.source);
  if (match) return { start: node.start, end: node.end, alt: match[1], destination: match[2] };
  return null;
}

function dialog(titleText: string): HTMLFormElement {
  const form = document.createElement('form');
  form.className = 'mde-composer-dialog';
  const title = document.createElement('h2');
  title.textContent = titleText;
  form.appendChild(title);
  return form;
}

function input(label: string, value = ''): HTMLInputElement {
  const field = document.createElement('input');
  field.setAttribute('aria-label', label);
  field.placeholder = label;
  field.value = value;
  return field;
}

function button(label: string, type: 'button' | 'submit' = 'button'): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = type;
  control.textContent = label;
  return control;
}

function dialogActions(context: EditorPluginContext, name: string): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'mde-composer-actions';
  const cancel = button('Cancel');
  cancel.addEventListener('click', () => context.dismissPresentation(name));
  actions.appendChild(cancel);
  return actions;
}

function escapeLabel(value: string): string { return value.replaceAll(']', '\\]'); }
