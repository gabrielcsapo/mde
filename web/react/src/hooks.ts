import { useCallback, useRef, useState } from 'react';

/**
 * A typed ref for `<MarkdownEditor ref={…} />`. Sugar over `useRef(null)`, but it is the
 * one place TypeScript users would otherwise have to name the handle type by hand.
 *
 * @returns {{current: import('../types').MarkdownEditorHandle|null}}
 */
export function useMarkdownEditorRef() {
  return useRef(null);
}

const IDLE = Object.freeze({ canUndo: false, canRedo: false, position: 0, count: 0 });

/**
 * History state as React state.
 *
 * The editor owns the history (DESIGN §9), so the only honest way to render a disabled
 * Undo button — or a timeline panel — is to be told when it changes. This is push, not
 * poll: the component emits `onHistoryChange` only when one of the four scalars actually
 * moves, so a toolbar re-renders on the transitions and not on every keystroke. A run of
 * typing coalesces into one revision, so `count` does not move either.
 *
 * `position` and `count` are the pair a history panel wants: `handle.getRevisions()` for
 * the labels, `handle.jumpTo(n)` to travel.
 *
 * ```jsx
 * const [history, onHistoryChange] = useEditorHistory();
 * <MarkdownEditor ref={ref} onHistoryChange={onHistoryChange} />
 * <button disabled={!history.canUndo} onClick={() => ref.current.undo()}>Undo</button>
 * ```
 *
 * @returns {[import('../types').HistoryState, (next: import('../types').HistoryState) => void]}
 */
export function useEditorHistory() {
  const [state, setState] = useState(IDLE);
  const onHistoryChange = useCallback((next) => {
    setState((prev) =>
      prev.canUndo === next.canUndo &&
      prev.canRedo === next.canRedo &&
      prev.position === next.position &&
      prev.count === next.count
        ? prev
        : next
    );
  }, []);
  return [state, onHistoryChange];
}
