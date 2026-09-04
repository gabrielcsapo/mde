import { Aside, Clause, Clauses, H2, Lede, Note } from '../../components/Doc.jsx';
import { Link } from '../../lib/router.jsx';

const PRINCIPLES = [
  [
    'Markdown remains the source',
    'Every rendered feature maps to a range in the Markdown string, so edits never require conversion from a private document model.',
  ],
  [
    'Behavior stays consistent',
    'The Rust core defines parsing, extension semantics, syntax reveal, and widget identity for every renderer.',
  ],
  [
    'The system text engine owns input',
    'Native IME, autocorrect, spellcheck, selection handles and accessibility come from TextKit and from the browser. We never reimplement a caret.',
  ],
  [
    'Incremental work preserves correctness',
    'Incremental parsing changes how much work is performed, not the resulting decorations.',
  ],
  [
    'Files stay portable',
    'Every construct degrades to something a stock CommonMark renderer displays harmlessly.',
  ],
];

const PATHS = [
  {
    to: '/docs/try',
    label: 'Open the editor',
    body: 'Try the JS or React integration with tables, media, custom syntax, and plugin tools.',
  },
  {
    to: '/docs/install',
    label: 'Add it to an app',
    body: 'Install the web package or Swift package and mount the native editor view.',
  },
  {
    to: '/docs/concepts/decorations',
    label: 'Understand the protocol',
    body: 'Learn how ranges, rendering primitives, roles, and patches define the renderer contract.',
  },
];

export default function Overview() {
  return (
    <>
      <H2 id="what-it-is">A text editor with a decoration layer</H2>
      <Lede>
        The editable buffer is the Markdown source. Decorations add typography, controls, and
        widgets without replacing it with a private document model.
      </Lede>
      <p>
        Files remain portable, while the shared core keeps parsing and editing behavior consistent
        across JS, React, iOS, and macOS. A{' '}
        <Link to="/docs/concepts/reveal">shared reveal policy</Link> controls when syntax appears around
        the selection.
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
      <Note>Each page links to the next topic and to related reference material.</Note>

      <H2 id="principles">Five principles</H2>
      <Lede>
        These constraints keep documents portable and interactions consistent across platforms.
      </Lede>
      <Clauses>
        {PRINCIPLES.map(([title, body]) => (
          <Clause key={title} title={title}>
            {body}
          </Clause>
        ))}
      </Clauses>

      <H2 id="status">Implementation status</H2>
      <p>
        The core is complete, with undo and resource references. All three renderers — iOS, macOS
        and web — run against it, each with a reference app. What is left, and what is known to be
        still in progress is listed on{' '}
        <Link to="/docs/internals/status">Status and open questions</Link>.
      </p>

      <Aside tone="note" title="Verified documentation">
        API signatures, renderer behavior, and performance results are generated from or checked
        against the implementation and its tests.
      </Aside>
    </>
  );
}
