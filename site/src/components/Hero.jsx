/** The overview page's opening. The only page with one — it is the only front door. */
export default function Hero() {
  return (
    <header className="hero">
      <p className="eyebrow">A native-feeling Markdown editor for web and Swift</p>
      {/* The markers are real characters in the DOM, collapsed to nothing and brought
          back on attention — the same mechanic the editor uses, stated in the headline
          rather than described. `aria-hidden` keeps the sentence clean when read aloud.
          The `.node` span stays a direct child of the h1 so the signature animation can
          find it without adding presentation logic to the component. */}
      <h1 className="hero-title">
        Markdown that
        <br />
        <span className="node">
          <span className="mk" aria-hidden="true">
            **
          </span>
          gets out of your way
          <span className="mk" aria-hidden="true">
            **
          </span>
        </span>.
      </h1>

      <p className="lede hero-summary">
        Write in a clean, focused surface. Markdown syntax fades away until you edit it,
        then returns exactly where you need it. Underneath, your document is still plain
        Markdown — on the web, iOS, and macOS.
      </p>
    </header>
  );
}
