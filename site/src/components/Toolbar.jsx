/**
 * Renders a descriptor list. It knows no button ids: `enabled` and `pressed` are
 * re-evaluated on every render, and the editor re-renders this component whenever the
 * document or the selection changes, so a new entry in the array is a new button with
 * working state and nothing else to wire.
 *
 * Buttons exist before the core does, disabled, so the bar does not reflow when the
 * wasm arrives.
 *
 * The editor arrives as `getEditor()` rather than as a prop. It is a live imperative
 * object holding decorations whose keys are `u64`s, and React's development render
 * logging deep-serializes changed props — which throws on a BigInt and would report as
 * an uncaught error on every keystroke. Reaching for it through a stable callback keeps
 * it out of the prop diff entirely; `ready` is what actually changes.
 *
 * @param {{descriptors: import('../lib/toolbar.js').ToolDescriptor[],
 *          getEditor: () => any, ready: boolean, onRun: () => void}} props
 */
export default function Toolbar({ descriptors, getEditor, ready, onRun }) {
  const editor = ready ? getEditor() : null;

  return (
    <div className="tools" id="toolbar">
      {descriptors.map((d) => (
        <button
          key={d.id}
          id={d.id}
          type="button"
          className="tool"
          title={d.title ?? d.label}
          disabled={!editor || (d.enabled ? !d.enabled(editor) : false)}
          aria-pressed={d.pressed ? String(!!(editor && d.pressed(editor))) : undefined}
          onClick={() => {
            const ed = getEditor();
            if (!ed) return;
            d.run(ed);
            onRun();
          }}
        >
          {d.label}
        </button>
      ))}
    </div>
  );
}
