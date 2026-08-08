// Hand-drawn SVG rather than a diagramming library: it is one fixed picture, it has to
// take its colours from the page's tokens in both themes (which the `dg-*` classes in
// site.css do), and a library would ship a renderer to draw ten rectangles.

export default function Diagram() {
  return (
    <div
      className="diagram mt-10 rounded-2xl border border-rule-soft bg-paper-2 px-3 py-4 sm:px-5 sm:py-6"
      role="img"
      aria-label="Edits and selection flow from the platform text view into the Rust core, which parses, decorates, assigns stable keys and diffs, returning a patch of removed, added and moved decorations to the iOS, macOS and web renderers."
    >
      <svg viewBox="0 0 720 470" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker
            id="ar"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path className="dg-arrow" d="M0 0 L8 4 L0 8 z" />
          </marker>
        </defs>

        <text className="dg-edge" x="360" y="14" textAnchor="middle">
          keystroke · paste · IME commit
        </text>
        <path className="dg-line" d="M360 22 V 44" markerEnd="url(#ar)" />

        <rect className="dg-box" x="120" y="50" width="480" height="58" rx="10" />
        <text className="dg-title" x="360" y="76" textAnchor="middle">
          Platform input — owns the buffer
        </text>
        <text className="dg-sub" x="360" y="94" textAnchor="middle">
          UITextView · NSTextView · contenteditable
        </text>

        <path className="dg-line" d="M360 108 V 156" markerEnd="url(#ar)" />
        <text className="dg-edge" x="372" y="126">
          Edit &#123; range, text &#125;
        </text>
        <text className="dg-edge" x="372" y="142">
          Selection &#123; anchor, head &#125;
        </text>

        <rect className="dg-box dg-core" x="120" y="162" width="480" height="86" rx="10" />
        <text className="dg-title" x="360" y="188" textAnchor="middle">
          Rust core
        </text>
        <text className="dg-sub" x="360" y="208" textAnchor="middle">
          rope mirror → parse → decorate → key → diff
        </text>
        <text className="dg-sub" x="360" y="228" textAnchor="middle">
          reveal policy · widget identity · undo history
        </text>

        <path className="dg-line" d="M360 248 V 312" />
        <text className="dg-edge" x="372" y="270">
          Patch &#123; removed[], added[], moved[] &#125;
        </text>
        <text className="dg-edge" x="372" y="286">
          offsets in UTF-16 code units
        </text>

        <path className="dg-line" d="M110 312 H 610" />
        <path className="dg-line" d="M110 312 V 334" markerEnd="url(#ar)" />
        <path className="dg-line" d="M360 312 V 334" markerEnd="url(#ar)" />
        <path className="dg-line" d="M610 312 V 334" markerEnd="url(#ar)" />

        <rect className="dg-box" x="0" y="340" width="220" height="72" rx="10" />
        <text className="dg-title" x="110" y="366" textAnchor="middle">
          iOS
        </text>
        <text className="dg-sub" x="110" y="384" textAnchor="middle">
          TextKit 2 attrs
        </text>
        <text className="dg-sub" x="110" y="400" textAnchor="middle">
          + attachments
        </text>

        <rect className="dg-box" x="250" y="340" width="220" height="72" rx="10" />
        <text className="dg-title" x="360" y="366" textAnchor="middle">
          macOS
        </text>
        <text className="dg-sub" x="360" y="384" textAnchor="middle">
          TextKit 2 attrs
        </text>
        <text className="dg-sub" x="360" y="400" textAnchor="middle">
          + attachments
        </text>

        <rect className="dg-box" x="500" y="340" width="220" height="72" rx="10" />
        <text className="dg-title" x="610" y="366" textAnchor="middle">
          web
        </text>
        <text className="dg-sub" x="610" y="384" textAnchor="middle">
          DOM spans
        </text>
        <text className="dg-sub" x="610" y="400" textAnchor="middle">
          + replaced elements
        </text>

        <text className="dg-edge" x="360" y="440" textAnchor="middle">
          one C ABI · #[repr(C)] decorations read straight out of Swift and wasm memory
        </text>
        <text className="dg-edge" x="360" y="458" textAnchor="middle">
          no JSON, no per-keystroke allocation churn in the host
        </text>
      </svg>
    </div>
  );
}
