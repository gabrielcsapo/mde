import { definePlugin } from '../src/plugins.js';
import type { EditorPlugin, EditorPluginContext } from '../src/plugins.js';
import type { SelectionRange } from '../src/core.js';

export interface TemplateItem {
  id: string;
  title: string;
  markdown: string;
  detail?: string;
}

function replaceSelection(
  context: EditorPluginContext,
  range: SelectionRange,
  before: string,
  after = before,
): void {
  const source = context.editor.markdown.slice(range.start, range.end);
  const replacement = `${before}${source}${after}`;
  context.editor.replaceRange(range.start, range.end, replacement);
  const start = range.start + before.length;
  context.editor.setSelectionRange({ start, end: start + source.length });
}

/** A compact formatting bar anchored to non-empty selections. */
export function floatingSelectionToolbar(): EditorPlugin {
  return definePlugin({
    name: 'mde.examples.selection-toolbar',
    setup(context) {
      let visible = false;
      const update = () => {
        const range = context.editor.selectionRange();
        if (!range || range.start === range.end) {
          if (visible) context.dismissPresentation('toolbar');
          visible = false;
          return;
        }
        const toolbar = document.createElement('div');
        toolbar.className = 'mde-floating-toolbar';
        toolbar.setAttribute('role', 'toolbar');
        toolbar.setAttribute('aria-label', 'Text formatting');
        const action = (label: string, before: string, after = before) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = label;
          button.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            replaceSelection(context, range, before, after);
          });
          toolbar.appendChild(button);
        };
        action('Bold', '**');
        action('Italic', '*');
        action('Code', '`');
        action('Link', '[', '](https://)');
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
  const currentSelection = context.editor.selectionRange() ?? {
    start: context.editor.markdown.length,
    end: context.editor.markdown.length,
  };
  const existing = inlineLinkAtSelection(context.editor.markdown, currentSelection);
  const selection = existing?.range ?? currentSelection;
  const selected = existing?.label
    ?? context.editor.markdown.slice(selection.start, selection.end);
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
    context.editor.replaceRange(selection.start, selection.end, markdown);
    const caret = selection.start + markdown.length;
    context.editor.setSelectionRange({ start: caret, end: caret });
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
function inlineLinkAtSelection(markdown: string, selection: SelectionRange): InlineLink | null {
  const links = /\[(?:\\.|[^\]\\])*\]\((?:\\.|[^)\\\n])*\)/g;
  for (const match of markdown.matchAll(links)) {
    const start = match.index;
    const end = start + match[0].length;
    if (markdown[start - 1] === '!' || selection.start < start || selection.end > end) continue;
    const divider = match[0].indexOf('](');
    if (divider < 1) continue;
    return {
      range: { start, end },
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
          const range = context.editor.selectionRange() ?? {
            start: context.editor.markdown.length,
            end: context.editor.markdown.length,
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
              context.editor.replaceRange(range.start, range.end, template.markdown);
              const caret = range.start + template.markdown.length;
              context.editor.setSelectionRange({ start: caret, end: caret });
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
            const source = context.editor.markdown;
            const count = source.split(find.value).length - 1;
            if (count > 0) context.editor.replaceRange(0, source.length, source.split(find.value).join(replacement.value));
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
            context.editor.replaceRange(image.start, image.end, markdown);
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
  const caret = context.editor.selectionRange()?.start ?? -1;
  const expression = /!\[([^\]]*)\]\(([^)]+)\)/gu;
  for (const match of context.editor.markdown.matchAll(expression)) {
    const start = match.index;
    const end = start + match[0].length;
    if (caret >= start && caret <= end) {
      return { start, end, alt: match[1], destination: match[2] };
    }
  }
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
