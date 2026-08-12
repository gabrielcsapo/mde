import type { MarkdownEditor } from './editor.js';
import type { SelectionRange } from './core.js';

export type MarkdownCommand =
  | 'bold' | 'italic' | 'code' | 'link'
  | 'heading' | 'bullet-list' | 'ordered-list' | 'task-list' | 'quote';

export interface CommandResult {
  start: number;
  end: number;
  text: string;
  selection: SelectionRange;
}

/** Pure source transformation shared by menus, shortcuts, toolbars, and tests. */
export function markdownCommand(
  command: MarkdownCommand,
  markdown: string,
  selection: SelectionRange,
): CommandResult {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  const selected = markdown.slice(start, end);
  const wrap = (open: string, close = open, placeholder = 'text'): CommandResult => {
    const body = selected || placeholder;
    return {
      start, end, text: open + body + close,
      selection: selected
        ? { start: start + open.length, end: end + open.length }
        : { start: start + open.length, end: start + open.length + body.length },
    };
  };
  if (command === 'bold') return wrap('**');
  if (command === 'italic') return wrap('*');
  if (command === 'code') return wrap('`', '`', 'code');
  if (command === 'link') return wrap('[', '](https://)', 'label');

  const lineStart = markdown.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const lineEndCandidate = markdown.indexOf('\n', end);
  const lineEnd = lineEndCandidate < 0 ? markdown.length : lineEndCandidate;
  const lines = markdown.slice(lineStart, lineEnd).split('\n');
  const prefix = command === 'heading' ? '# '
    : command === 'bullet-list' ? '- '
      : command === 'task-list' ? '- [ ] '
        : command === 'quote' ? '> '
          : null;
  const transformed = lines.map((line, index) =>
    command === 'ordered-list' ? `${index + 1}. ${line}` : `${prefix}${line}`,
  ).join('\n');
  const addedToFirst = command === 'ordered-list' ? 3 : prefix!.length;
  return {
    start: lineStart,
    end: lineEnd,
    text: transformed,
    selection: { start: start + addedToFirst, end: end + transformed.length - (lineEnd - lineStart) },
  };
}

export function executeMarkdownCommand(
  editor: MarkdownEditor,
  command: MarkdownCommand,
  selection = editor.selectionRange(),
): boolean {
  if (!selection) return false;
  const result = markdownCommand(command, editor.markdown, selection);
  editor.closeUndoGroup();
  editor.replaceRange(result.start, result.end, result.text);
  editor.closeUndoGroup();
  editor.setSelectionRange(result.selection);
  return true;
}
