import { Aside, Clause, Clauses, H2, Lede, Note } from '../../components/Doc.jsx';
import { Link } from '../../lib/router.jsx';

const PRINCIPLES = [
  [
    'The text is the truth',
    'Every feature is expressible as decorations over a markdown string. If a feature requires a side model, it is out of scope.',
  ],
  [
    'One brain, three faces',
    'Parsing, extension semantics, reveal policy and widget identity are decided once, in Rust. Renderers apply; they do not decide.',
  ],
  [
    'The system text engine owns input',
    'Native IME, autocorrect, spellcheck, selection handles and accessibility come from TextKit and from the browser. We never reimplement a caret.',
  ],
  [
    'Correctness first, incrementality later',
    'Nothing may depend on incremental parsing for correctness. It is a profiling-driven optimization behind a fixed interface.',
  ],
  [
    'Files stay portable',
    'Every construct degrades to something a stock CommonMark renderer displays harmlessly.',
  ],
];

const PATHS = [
  {
    to: '/try',
    label: 'Type in it',
    body: 'The editor itself, running the real wasm core, with two extensions wired to toolbar toggles.',
  },
  {
    to: '/install',
    label: 'Put it in an app',
    body: 'Build the core, mount the view. Three imports on the web; a Swift package and a text view on Apple.',
  },
  {
    to: '/concepts/decorations',
    label: 'Understand the protocol',
    body: 'Six primitives, open roles and a patch. Everything else on this site is a consequence of it.',
  },
];

export default function Overview() {
  return (
    <>
      <H2 id="what-it-is">A text editor with a decoration layer</H2>
      <Lede>
        Explicitly not a WYSIWYG. A WYSIWYG owns a document model and emits markdown as an export
        format; this owns nothing. The buffer <em>is</em> the source, and every feature is a range
        plus a primitive plus a role over that string.
      </Lede>
      <p>
        That single constraint is what makes the rest fall out: files stay portable, three platforms
        cannot drift, and “show me the markers while I am editing this word” becomes{' '}
        <Link to="/concepts/reveal">a policy in one place</Link> rather than three piles of renderer
        code.
      </p>

      <H2 id="start">Where to start</H2>
      <nav className="doc-routes" aria-label="Choose a starting point">
        {PATHS.map((path) => (
          <Link className="doc-route" key={path.to} to={path.to}>
            <span className="doc-route-title">{path.label}</span>
            <span className="doc-route-body">{path.body}</span>
            <span className="doc-route-go" aria-hidden="true">→</span>
          </Link>
        ))}
      </nav>
      <Note>
        Or read it front to back: every page ends with the next one, and the whole site is one
        sequence from here to <Link to="/internals/status">the open questions</Link>.
      </Note>

      <H2 id="principles">Five principles</H2>
      <Lede>
        These are the load-bearing ones. Everything on this site that looks like a rule is one of
        them applied to a specific problem.
      </Lede>
      <Clauses>
        {PRINCIPLES.map(([title, body]) => (
          <Clause key={title} title={title}>
            {body}
          </Clause>
        ))}
      </Clauses>

      <H2 id="status">Where the project is</H2>
      <p>
        The core is complete, with undo and resource references. All three renderers — iOS, macOS
        and web — run against it, each with a reference app. What is left, and what is known to be
        unresolved rather than quietly hoped about, is on{' '}
        <Link to="/internals/status">Status and open questions</Link>.
      </p>

      <Aside tone="note" title="What this site is">
        The documentation of a design document. Every factual claim here — the primitives, the
        reveal table, the millisecond figures, the things that were tried and thrown away — comes
        from <code>DESIGN.md</code> or from the source it describes. Nothing is estimated on the
        project’s behalf.
      </Aside>
    </>
  );
}
