/**
 * The revision timeline as a panel (DESIGN §9): every revision — including ones that
 * have been undone — with the current position marked, click to land anywhere.
 * Undo and redo are the two-button view of the same thing.
 *
 * The editor arrives as `getEditor()`, never as a prop, for the same BigInt reason as
 * `Toolbar.jsx`. Everything shown is read fresh on each render; the parent re-renders
 * this component whenever the document changes.
 */
export default function HistoryPanel({ getEditor, onJump }) {
  const editor = getEditor();
  if (!editor) return null;

  const position = editor.historyPosition;
  const revisions = editor.revisions;

  // The engine's clock is monotonic (`performance.now()` on the web) because it exists
  // for undo coalescing, so a wall-clock rendering would show 1970. Age is what a
  // person wants from a history panel anyway.
  const age = (atMs) => {
    const ms = Math.max(0, performance.now() - atMs);
    if (ms < 5_000) return 'just now';
    if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    return `${Math.round(ms / 3_600_000)}h ago`;
  };

  const describe = (rev) =>
    rev.kind === 0
      ? `Added ${rev.inserted} characters`
      : rev.kind === 1
        ? `Removed ${rev.removed} characters`
        : `Replaced ${rev.removed} with ${rev.inserted} characters`;

  const jump = (target) => {
    // Position p means "the document immediately after revision p−1".
    getEditor()?.jumpTo(target);
    onJump();
  };

  const entry = (target, label, when) => (
    <button
      key={target}
      type="button"
      className="history-entry"
      aria-current={position === target}
      onClick={() => jump(target)}
    >
      <span>{label}</span>
      {when ? <span className="history-when">{when}</span> : null}
    </button>
  );

  return (
    <div className="history-panel" role="listbox" aria-label="Revision history">
      {entry(0, 'Opened document', null)}
      {revisions.map((rev) => entry(rev.index + 1, describe(rev), age(rev.atMs)))}
    </div>
  );
}
