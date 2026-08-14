import { definePlugin } from '../src/plugins.js';
import type { EditorPlugin, EditorPluginContext } from '../src/plugins.js';
import type { SelectionRange } from '../src/core.js';
import { filterSuggestions, suggestionPlugin } from './suggestions.js';
import type { SuggestionProvider } from './suggestions.js';

export interface MentionCandidate {
  handle: string;
  label?: string;
  detail?: string;
}

export interface MentionPluginOptions {
  candidates?: readonly MentionCandidate[];
  provider?: (
    query: string,
    signal: AbortSignal,
  ) => readonly MentionCandidate[] | Promise<readonly MentionCandidate[]>;
  maximumResults?: number;
  debounceMs?: number;
}

/** A complete `@` autocomplete example built only on the public plugin surface. */
export function mentionAutocomplete(options: MentionPluginOptions = {}): EditorPlugin {
  return suggestionPlugin({
    name: 'mde.examples.mentions',
    triggers: [{ trigger: '@' }],
    maximumResults: options.maximumResults ?? 6,
    debounceMs: options.debounceMs,
    ariaLabel: 'Mention suggestions',
    loadingLabel: options.provider ? 'Searching people…' : undefined,
    provider: async ({ query, signal }) => {
      const candidates = options.provider
        ? await options.provider(query, signal)
        : (options.candidates ?? []);
      return filterSuggestions(candidates.map((candidate) => ({
        id: candidate.handle,
        label: candidate.label ?? `@${candidate.handle}`,
        detail: candidate.detail ?? `@${candidate.handle}`,
        keywords: [candidate.handle],
        insertText: `@${candidate.handle}`,
        suffix: ' ',
      })), query, options.maximumResults ?? 6);
    },
  });
}

export interface NamedSuggestion {
  id: string;
  label: string;
  detail?: string;
  keywords?: readonly string[];
}

export interface NamedSuggestionOptions {
  items?: readonly NamedSuggestion[];
  provider?: SuggestionProvider;
  maximumResults?: number;
  debounceMs?: number;
}

/** `#topic` autocomplete for journal tags. */
export function tagAutocomplete(options: NamedSuggestionOptions = {}): EditorPlugin {
  return suggestionPlugin({
    name: 'mde.examples.tags',
    triggers: [{ trigger: '#' }],
    maximumResults: options.maximumResults ?? 8,
    debounceMs: options.debounceMs,
    ariaLabel: 'Tag suggestions',
    provider: options.provider ?? (({ query }) => filterSuggestions(
      (options.items ?? []).map((item) => ({
        ...item,
        insertText: `#${item.id}`,
        suffix: ' ',
      })),
      query,
      options.maximumResults ?? 8,
    )),
  });
}

/** `[[Note title]]` autocomplete for linking journal entries. */
export function wikilinkAutocomplete(options: NamedSuggestionOptions = {}): EditorPlugin {
  return suggestionPlugin({
    name: 'mde.examples.wikilinks',
    triggers: [{ trigger: '[[', boundary: false, allowSpaces: true }],
    maximumResults: options.maximumResults ?? 8,
    debounceMs: options.debounceMs,
    ariaLabel: 'Note suggestions',
    provider: options.provider ?? (({ query }) => filterSuggestions(
      (options.items ?? []).map((item) => ({
        ...item,
        insertText: `[[${item.label}]]`,
        suffix: ' ',
      })),
      query,
      options.maximumResults ?? 8,
    )),
  });
}

/** A line-leading `/` menu populated from the editor's central command registry. */
export function slashCommandMenu(): EditorPlugin {
  return suggestionPlugin({
    name: 'mde.examples.slash-menu',
    triggers: [{
      trigger: '/',
      match(markdownBeforeCaret, caret) {
        const lineStart = markdownBeforeCaret.lastIndexOf('\n') + 1;
        const source = markdownBeforeCaret.slice(lineStart);
        if (!source.startsWith('/') || /\s/u.test(source.slice(1))) return null;
        return {
          trigger: '/',
          query: source.slice(1),
          range: { start: lineStart, end: caret },
        };
      },
    }],
    maximumResults: 12,
    ariaLabel: 'Editor commands',
    emptyLabel: 'No matching commands',
    provider: ({ query, commands, document, selection, range }) => filterSuggestions(
      commands.list()
        .filter((command) => command.enabled && command.plugin !== 'mde.examples.slash-menu')
        .map((command) => ({
          id: command.id,
          label: command.title,
          detail: command.category ?? command.plugin,
          group: command.category ?? 'Commands',
          keywords: command.keywords,
          select: () => {
            document.transact({ edits: [{ ...range, text: '' }], selection: { start: range.start, end: range.start } });
            selection.set({ start: range.start, end: range.start });
            commands.execute(command.id);
          },
        })),
      query,
      12,
    ),
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
        insertion = context.selection.range ?? {
          start: context.document.length,
          end: context.document.length,
        };
        const panel = attachmentPanel(context, insertion, options);
        context.showPresentation('composer', {
          element: panel,
          anchor: 'viewport',
          modal: true,
          onDismiss: () => {
            // Escape/Cancel returns to the captured insertion point. A successful
            // submit focuses the editor and places its own post-insert caret first.
            if (document.activeElement !== context.view.root) {
              context.view.focus();
              context.selection.set(insertion);
            }
          },
        });
        requestAnimationFrame(() => panel.querySelector<HTMLInputElement>('input')?.focus());
      };
      context.registerCommand('open', {
        title: 'Add attachment',
        category: 'Insert',
        keywords: ['image', 'video', 'audio', 'file', 'media'],
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
    context.view.focus();
    const caret = insertion.start + markdown.length;
    context.document.transact({
      edits: [{ ...insertion, text: markdown }],
      selection: { start: caret, end: caret },
      metadata: { label: 'Insert attachment', origin: context.name },
    });
    options.onInsert?.(type, destination);
    context.dismissPresentation('composer');
  });
  return form;
}
