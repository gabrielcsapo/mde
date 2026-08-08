/** Sits at the foot of the content column, under the pager, on every page. */
export default function Footer() {
  return (
    <footer className="doc-footer">
      <span className="font-mono font-semibold text-text">mde</span>
      <span>Core complete, with undo and resource references.</span>
      <span>Three renderers, each with a reference app.</span>
      <span>
        Every suite, one command: <code>./scripts/test.sh</code>
      </span>
    </footer>
  );
}
