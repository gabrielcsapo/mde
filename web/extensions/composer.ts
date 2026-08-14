import { definePlugin } from '../src/plugins.js';
import type { EditorPlugin, EditorPluginContext } from '../src/plugins.js';
import type { SelectionRange } from '../src/core.js';

export interface MentionCandidate {
  handle: string;
  label?: string;
  detail?: string;
}

export interface MentionPluginOptions {
  candidates: readonly MentionCandidate[];
  maximumResults?: number;
}

/** A complete `@` autocomplete example built only on the public plugin surface. */
export function mentionAutocomplete(options: MentionPluginOptions): EditorPlugin {
  return definePlugin({
    name: 'mde.examples.mentions',
    setup(context) {
      let active: { range: SelectionRange; results: MentionCandidate[]; index: number } | null = null;

      const choose = (candidate: MentionCandidate) => {
        if (!active) return;
        const range = active.range;
        // A delimiter finishes the trigger so the selectionchange caused by restoring
        // the caret cannot immediately reopen the same menu.
        const replacement = `@${candidate.handle} `;
        context.editor.root.focus();
        context.editor.replaceRange(range.start, range.end, replacement);
        const caret = range.start + replacement.length;
        context.editor.setSelectionRange({ start: caret, end: caret });
        active = null;
        context.dismissPresentation('suggestions');
      };

      const render = () => {
        if (!active) return;
        const menu = document.createElement('div');
        menu.className = 'mde-composer-menu';
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-label', 'Mention suggestions');
        for (const [index, candidate] of active.results.entries()) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'mde-composer-option';
          button.setAttribute('role', 'option');
          button.setAttribute('aria-selected', String(index === active.index));
          button.tabIndex = -1;
          const title = document.createElement('strong');
          title.textContent = candidate.label ?? `@${candidate.handle}`;
          const detail = document.createElement('span');
          detail.textContent = candidate.detail ?? `@${candidate.handle}`;
          button.append(title, detail);
          button.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            choose(candidate);
          });
          menu.appendChild(button);
        }
        context.showPresentation('suggestions', {
          element: menu,
          anchor: 'selection',
          onDismiss: () => { active = null; },
        });
      };

      const update = () => {
        const selection = context.editor.selectionRange();
        if (!selection || selection.start !== selection.end) {
          active = null;
          context.dismissPresentation('suggestions');
          return;
        }
        const before = context.editor.markdown.slice(0, selection.start);
        const match = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(before);
        if (!match) {
          active = null;
          context.dismissPresentation('suggestions');
          return;
        }
        const query = match[1].toLocaleLowerCase();
        const results = options.candidates.filter((candidate) =>
          candidate.handle.toLocaleLowerCase().startsWith(query)
          || candidate.label?.toLocaleLowerCase().includes(query)
        ).slice(0, Math.max(1, options.maximumResults ?? 6));
        if (results.length === 0) {
          active = null;
          context.dismissPresentation('suggestions');
          return;
        }
        active = {
          range: { start: selection.start - query.length - 1, end: selection.start },
          results,
          index: Math.min(active?.index ?? 0, results.length - 1),
        };
        render();
      };

      context.on('change', update);
      context.on('selectionchange', update);
      context.onRoot('keydown', (event) => {
        if (!active) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          active.index = (active.index + direction + active.results.length) % active.results.length;
          render();
        } else if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          choose(active.results[active.index]);
        }
      });
    },
  });
}

export interface AttachmentComposerOptions {
  commandKey?: string;
  onInsert?: (kind: 'image' | 'video' | 'link', reference: string) => void;
}

/** Command-O image/video/link composer demonstrating a viewport presentation. */
export function attachmentComposer(options: AttachmentComposerOptions = {}): EditorPlugin {
  return definePlugin({
    name: 'mde.examples.attachments',
    setup(context) {
      let insertion: SelectionRange = { start: 0, end: 0 };
      const open = () => {
        insertion = context.editor.selectionRange() ?? {
          start: context.editor.markdown.length,
          end: context.editor.markdown.length,
        };
        const panel = attachmentPanel(context, insertion, options);
        context.showPresentation('composer', {
          element: panel,
          anchor: 'viewport',
          modal: true,
          onDismiss: () => {
            // Escape/Cancel returns to the captured insertion point. A successful
            // submit focuses the editor and places its own post-insert caret first.
            if (document.activeElement !== context.editor.root) {
              context.editor.root.focus();
              context.editor.setSelectionRange(insertion);
            }
          },
        });
        requestAnimationFrame(() => panel.querySelector<HTMLInputElement>('input')?.focus());
      };
      context.registerCommand('open', {
        key: options.commandKey ?? 'o',
        primary: true,
        handler: open,
      });
    },
  });
}

function attachmentPanel(
  context: EditorPluginContext,
  insertion: SelectionRange,
  options: AttachmentComposerOptions,
): HTMLElement {
  const form = document.createElement('form');
  form.className = 'mde-composer-dialog';
  form.setAttribute('aria-labelledby', 'mde-composer-title');
  const title = document.createElement('h2');
  title.id = 'mde-composer-title';
  title.textContent = 'Add to your note';
  const kind = document.createElement('select');
  kind.setAttribute('aria-label', 'Attachment type');
  for (const [value, label] of [['image', 'Image'], ['video', 'Video'], ['link', 'Link']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    kind.appendChild(option);
  }
  const reference = document.createElement('input');
  reference.required = true;
  reference.placeholder = 'URL or asset path';
  reference.setAttribute('aria-label', 'URL or asset path');
  const label = document.createElement('input');
  label.placeholder = 'Label or alt text';
  label.setAttribute('aria-label', 'Label or alt text');
  const actions = document.createElement('div');
  actions.className = 'mde-composer-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => context.dismissPresentation('composer'));
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Insert';
  actions.append(cancel, submit);
  form.append(title, kind, reference, label, actions);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const type = kind.value as 'image' | 'video' | 'link';
    const destination = reference.value.trim();
    if (!destination) return;
    const text = label.value.trim() || (type === 'link' ? 'link' : type);
    const markdown = type === 'link'
      ? `[${text}](${destination})`
      : `![${text}](${destination})`;
    context.editor.root.focus();
    context.editor.replaceRange(insertion.start, insertion.end, markdown);
    const caret = insertion.start + markdown.length;
    context.editor.setSelectionRange({ start: caret, end: caret });
    options.onInsert?.(type, destination);
    context.dismissPresentation('composer');
  });
  return form;
}
