import { definePlugin } from '../src/plugins.js';
import type {
  EditorPlugin,
  EditorPluginContext,
  PluginPresentationHandle,
} from '../src/plugins.js';
import type { SelectionRange } from '../src/core.js';
import type { PluginDocumentCapability, PluginSelectionCapability } from '@mde/plugin-sdk';
import type { PluginCommandsCapability } from '../src/plugins.js';

export interface SuggestionMatch {
  trigger: string;
  query: string;
  range: SelectionRange;
}

export interface SuggestionRequest extends SuggestionMatch {
  markdown: string;
  signal: AbortSignal;
  document: PluginDocumentCapability;
  selection: PluginSelectionCapability;
  commands: PluginCommandsCapability;
}

export interface SuggestionItem {
  id: string;
  label: string;
  detail?: string;
  group?: string;
  keywords?: readonly string[];
  insertText?: string;
  suffix?: string;
  avatar?: string;
  disabled?: boolean;
  select?: (request: SuggestionRequest) => void | Promise<void>;
}

export interface SuggestionTrigger {
  trigger: string;
  /** Require whitespace or the start of the document before the trigger. Defaults true. */
  boundary?: boolean;
  /** Permit spaces in the query. */
  allowSpaces?: boolean;
  /** Override matching entirely for syntax such as a line-only slash command. */
  match?: (markdownBeforeCaret: string, caret: number) => SuggestionMatch | null;
}

export type SuggestionProvider = (
  request: SuggestionRequest,
) => readonly SuggestionItem[] | Promise<readonly SuggestionItem[]>;

export interface SuggestionPluginOptions {
  name: string;
  triggers: readonly SuggestionTrigger[];
  provider: SuggestionProvider;
  maximumResults?: number;
  debounceMs?: number;
  cache?: boolean;
  loadingLabel?: string;
  emptyLabel?: string;
  ariaLabel?: string;
  renderItem?: (item: SuggestionItem, selected: boolean) => Node;
}

interface ActiveSuggestions {
  request: SuggestionRequest;
  results: SuggestionItem[];
  index: number;
}

/** A small deterministic fuzzy score suitable for local command and journal indexes. */
export function fuzzyScore(query: string, candidate: string): number | null {
  const needle = query.toLocaleLowerCase();
  const haystack = candidate.toLocaleLowerCase();
  if (!needle) return 0;
  const exact = haystack.indexOf(needle);
  if (exact >= 0) return exact * 0.01 + (haystack.length - needle.length) * 0.001;
  let at = 0;
  let score = 0;
  let previous = -2;
  for (const character of needle) {
    const found = haystack.indexOf(character, at);
    if (found < 0) return null;
    score += found === previous + 1 ? 0.1 : 1 + found * 0.05;
    previous = found;
    at = found + 1;
  }
  return score + (haystack.length - needle.length) * 0.01;
}

export function filterSuggestions(
  items: readonly SuggestionItem[],
  query: string,
  maximumResults = 8,
): SuggestionItem[] {
  return items
    .map((item, order) => {
      const text = [item.label, item.detail, ...(item.keywords ?? [])].filter(Boolean).join(' ');
      return { item, order, score: fuzzyScore(query, text) };
    })
    .filter((entry): entry is { item: SuggestionItem; order: number; score: number } =>
      entry.score !== null
    )
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, Math.max(1, maximumResults))
    .map((entry) => entry.item);
}

export function staticSuggestionProvider(
  items: readonly SuggestionItem[],
  maximumResults = 8,
): SuggestionProvider {
  return ({ query }) => filterSuggestions(items, query, maximumResults);
}

/**
 * Cross-framework autocomplete with async latest-wins providers, IME safety, caching,
 * grouped results, and accessible keyboard navigation.
 */
export function suggestionPlugin(options: SuggestionPluginOptions): EditorPlugin {
  return definePlugin({
    name: options.name,
    setup(context) {
      let active: ActiveSuggestions | null = null;
      let presentation: PluginPresentationHandle | null = null;
      let menu: HTMLElement | null = null;
      let requestController: AbortController | null = null;
      let requestKey: string | null = null;
      let suppressedKey: string | null = null;
      let timer: number | null = null;
      let sequence = 0;
      let composing = false;
      const cache = new Map<string, SuggestionItem[]>();
      const previousActiveDescendant = context.view.getActiveDescendant();

      const restoreActiveDescendant = () => {
        if (previousActiveDescendant === null) {
          context.view.setActiveDescendant(null);
        } else {
          context.view.setActiveDescendant(previousActiveDescendant);
        }
      };

      const close = () => {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        requestController?.abort();
        requestController = null;
        requestKey = null;
        active = null;
        presentation?.dismiss();
        presentation = null;
        menu = null;
        restoreActiveDescendant();
      };

      const ensureMenu = () => {
        if (menu) return menu;
        menu = document.createElement('div');
        menu.className = 'mde-composer-menu mde-suggestion-menu';
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-label', options.ariaLabel ?? 'Suggestions');
        presentation = context.showPresentation('suggestions', {
          element: menu,
          anchor: 'selection',
          placement: 'auto',
          dismissOnOutsidePointer: true,
          onDismiss: (reason) => {
            if (reason !== 'replaced' && requestKey !== null) suppressedKey = requestKey;
            active = null;
            presentation = null;
            menu = null;
            requestController?.abort();
            requestController = null;
            requestKey = null;
            restoreActiveDescendant();
          },
        });
        return menu;
      };

      const renderStatus = (label: string, state: string) => {
        const root = ensureMenu();
        root.replaceChildren();
        const status = document.createElement('div');
        status.className = 'mde-suggestion-status';
        status.dataset.state = state;
        status.setAttribute('role', 'status');
        status.textContent = label;
        root.appendChild(status);
        presentation?.reposition();
      };

      const choose = async (item: SuggestionItem) => {
        if (!active || item.disabled) return;
        const request = active.request;
        suppressedKey = requestKey;
        // Make repeated Enter/Tab inert while an asynchronous selection commits, but
        // keep the request signal alive until that callback finishes.
        active = null;
        try {
          context.view.focus();
          if (item.select) {
            await item.select(request);
          } else {
            const replacement = `${item.insertText ?? item.label}${item.suffix ?? ' '}`;
            const caret = request.range.start + replacement.length;
            context.document.transact({
              edits: [{ ...request.range, text: replacement }],
              selection: { start: caret, end: caret },
              metadata: { label: 'Accept suggestion', origin: context.name },
            });
          }
        } catch (error) {
          context.view.reportError('suggestion-selection', error);
        } finally {
          close();
        }
      };

      const render = () => {
        if (!active) return;
        const root = ensureMenu();
        root.replaceChildren();
        let lastGroup: string | undefined;
        active.results.forEach((item, index) => {
          if (item.group && item.group !== lastGroup) {
            const group = document.createElement('div');
            group.className = 'mde-suggestion-group';
            group.setAttribute('role', 'presentation');
            group.textContent = item.group;
            root.appendChild(group);
            lastGroup = item.group;
          }
          const option = document.createElement('button');
          option.type = 'button';
          option.className = 'mde-composer-option mde-suggestion-option';
          option.id = `mde-suggestion-${sequence}-${index}`;
          option.setAttribute('role', 'option');
          option.setAttribute('aria-selected', String(index === active?.index));
          option.disabled = item.disabled ?? false;
          option.tabIndex = -1;
          if (options.renderItem) {
            option.appendChild(options.renderItem(item, index === active.index));
          } else {
            if (item.avatar) {
              const avatar = document.createElement('img');
              avatar.className = 'mde-suggestion-avatar';
              avatar.src = item.avatar;
              avatar.alt = '';
              option.appendChild(avatar);
            }
            const copy = document.createElement('span');
            copy.className = 'mde-suggestion-copy';
            const title = document.createElement('strong');
            title.textContent = item.label;
            copy.appendChild(title);
            if (item.detail) {
              const detail = document.createElement('span');
              detail.textContent = item.detail;
              copy.appendChild(detail);
            }
            option.appendChild(copy);
          }
          option.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            void choose(item);
          });
          root.appendChild(option);
        });
        const selected = root.querySelector<HTMLElement>('[aria-selected="true"]');
        if (selected) context.view.setActiveDescendant(selected.id);
        presentation?.reposition();
      };

      const publish = (request: SuggestionRequest, results: readonly SuggestionItem[]) => {
        if (request.signal.aborted) return;
        const limited = [...results].slice(0, Math.max(1, options.maximumResults ?? 8));
        if (limited.length === 0) {
          if (options.emptyLabel) renderStatus(options.emptyLabel, 'empty');
          else close();
          return;
        }
        active = { request, results: limited, index: 0 };
        render();
      };

      const update = () => {
        if (composing) return;
        const selection = context.selection.range;
        if (!selection || selection.start !== selection.end) {
          close();
          return;
        }
        const before = context.document.markdown.slice(0, selection.start);
        const match = matchSuggestion(options.triggers, before, selection.start);
        if (!match) {
          suppressedKey = null;
          close();
          return;
        }
        const key = `${match.trigger}\u0000${match.query.toLocaleLowerCase()}`;
        if (key === suppressedKey) return;
        suppressedKey = null;
        if (key === requestKey && requestController && !requestController.signal.aborted) {
          presentation?.reposition();
          return;
        }
        if (timer !== null) window.clearTimeout(timer);
        requestController?.abort();
        const controller = new AbortController();
        requestController = controller;
        requestKey = key;
        const request: SuggestionRequest = {
          ...match,
          markdown: context.document.markdown,
          signal: controller.signal,
          document: context.document,
          selection: context.selection,
          commands: context.commands,
        };
        const cached = options.cache === false ? undefined : cache.get(key);
        if (cached) {
          publish(request, cached);
          return;
        }
        if (options.loadingLabel) renderStatus(options.loadingLabel, 'loading');
        const current = ++sequence;
        timer = window.setTimeout(async () => {
          timer = null;
          try {
            const results = await options.provider(request);
            if (controller.signal.aborted || current !== sequence) return;
            const value = [...results];
            if (options.cache !== false) {
              cache.set(key, value);
              if (cache.size > 64) {
                const oldest = cache.keys().next().value;
                if (oldest !== undefined) cache.delete(oldest);
              }
            }
            publish(request, value);
          } catch (error) {
            if (!controller.signal.aborted) {
              context.view.reportError('suggestions', error);
              close();
            }
          }
        }, Math.max(0, options.debounceMs ?? 0));
      };

      context.on('change', update);
      context.on('selectionchange', update);
      context.onRoot('compositionstart', () => {
        composing = true;
        close();
      });
      context.onRoot('compositionend', () => {
        composing = false;
        queueMicrotask(update);
      });
      context.onRoot('keydown', (event) => {
        if (!active || event.isComposing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          active.index = (
            active.index + direction + active.results.length
          ) % active.results.length;
          if (options.renderItem) {
            render();
          } else if (menu) {
            const buttons = [...menu.querySelectorAll<HTMLElement>('[role="option"]')];
            buttons.forEach((option, index) => option.setAttribute(
              'aria-selected', String(index === active!.index),
            ));
            const selected = buttons[active.index];
            if (selected) context.view.setActiveDescendant(selected.id);
          }
        } else if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          void choose(active.results[active.index]);
        }
      });
      return close;
    },
  });
}

export function matchSuggestion(
  triggers: readonly SuggestionTrigger[],
  markdownBeforeCaret: string,
  caret: number,
): SuggestionMatch | null {
  let best: SuggestionMatch | null = null;
  for (const config of triggers) {
    const custom = config.match?.(markdownBeforeCaret, caret);
    if (custom && (!best || custom.range.start > best.range.start)) best = custom;
    if (config.match) continue;
    const start = markdownBeforeCaret.lastIndexOf(config.trigger);
    if (start < 0) continue;
    const preceding = start === 0 ? '' : markdownBeforeCaret[start - 1];
    if (config.boundary !== false && preceding && !/\s/u.test(preceding)) continue;
    const query = markdownBeforeCaret.slice(start + config.trigger.length);
    const pattern = config.allowSpaces
      ? /^[\p{L}\p{N}_\- ]*$/u
      : /^[\p{L}\p{N}_-]*$/u;
    if (!pattern.test(query)) continue;
    const match = { trigger: config.trigger, query, range: { start, end: caret } };
    if (!best || start > best.range.start) best = match;
  }
  return best;
}
