import { Aside, H2, Lede, Note, SeeAlso, TableFrame } from '../../components/Doc.jsx';
import { Link } from '../../lib/router.jsx';

const SEQUENCE = [
  ['Rust core: rope, parse, decorate, key, diff, golden corpus', 'done'],
  ['Undo/redo owned by the core', 'done'],
  ['iOS renderer on incremental TextKit', 'done'],
  ['Reference app shell', 'done'],
  ['Resource references with async resolution', 'done'],
  ['macOS renderer sharing the Swift package', 'done'],
  ['Web renderer over contenteditable', 'done'],
  ['Performance: incremental reparse, prefilter, fast hashing', 'done'],
  ['Commands and descriptor-driven toolbars', 'done'],
  ['Bounded multi-document sessions', 'done'],
  ['Progressive image, video, and audio delivery', 'done'],
  ['Plugin-owned commands and floating canvas UI', 'done'],
  ['Async suggestion engine and command palette foundation', 'done'],
  ['Journal attachment import with preview, progress, and cancellation', 'done'],
  ['React and SwiftUI plugin presentation helpers', 'done'],
];

const OPEN = [
  [
    'A document with no newlines at all',
    'A minified paste has no region boundaries, so every keystroke in it is a full reparse. There is no smaller unit to fall back to, and real prose always has them; accepted rather than fixed. The web host re-renders whole lines, so the same case degrades to O(line) there.',
  ],
  [
    'Older Firefox',
    'contenteditable="plaintext-only" is well supported in Chrome and Safari but only landed in Firefox recently. A fallback intercepting beforeinput would be needed.',
  ],
  [
    'Gutters under soft wrap',
    'Soft-wrap interaction with Gutter depth on deeply nested quotes is unspecified. Gutters are currently drawn as the themed marker character rather than as true margin content.',
  ],
];

const CLOSED = [
  [
    'Host-drawn widget views rebuilt on every re-layout',
    'They are cached by decoration key on every host, which is safe because keys are stable across edits: a key changes exactly when its node’s own source changes, so the cache invalidates itself and there is no staleness rule to get wrong. Bounded at 256 views, evicting entries that are no longer live first.',
  ],
  [
    'reservedSize is a guess, so a wrong guess shifts the document',
    'Resolved sizes are measured and kept, and exposed as resourceSizes. A host that persists them turns “shifts once per launch” into “shifts once per asset, ever”. The guess is still the fallback for a reference nobody has seen.',
  ],
];

export default function Status() {
  return (
    <>
      <H2 id="where">Implemented capabilities</H2>
      <Lede>
        The core is complete, with undo and resource references. All three renderers run against it,
        each with a reference app. Runtime extensions now cover host decoration layers,
        background analysis, discoverable commands, generic suggestions, journal imports, and floating canvas UI without adding presentation state
        to the markdown model.
      </Lede>
      <TableFrame className="mt-6">
        <thead>
          <tr>
            <th className="desc">Step</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {SEQUENCE.map(([step, state]) => (
            <tr key={step}>
              <td className="desc">{step}</td>
              <td className={state === 'done' ? 'now' : 'before'}>{state}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Note>
        The <Link to="/docs/try">browser demo</Link> uses the published commands, sessions, media
        pipeline, and plugin presentation APIs documented here.
      </Note>

      <H2 id="open">Open questions</H2>
      <Lede>
        These cases have documented limitations or need a platform-specific fallback.
      </Lede>
      <div className="qa">
        {OPEN.map(([title, body]) => (
          <div key={title}>
            <h3>{title}</h3>
            <p>{body}</p>
          </div>
        ))}
      </div>

      <H2 id="closed">Closed</H2>
      <Lede>
        Resolved performance and resource-management questions, with the implemented behavior.
      </Lede>
      <div className="qa qa-closed">
        {CLOSED.map(([title, body]) => (
          <div key={title}>
            <h3>{title}</h3>
            <p>{body}</p>
          </div>
        ))}
      </div>

      <Aside tone="note" title="Discarded viewport-window optimization">
        Limiting decoration to a window around the viewport above 256 KB was an obvious safety
        valve. Measured, it was worse at every document size tested, and could not help the case it
        was designed for.{' '}
        <Link to="/docs/internals/performance">The numbers are on the performance page.</Link>
      </Aside>

      <SeeAlso
        links={[
          {
            to: '/docs/internals/testing',
            title: 'Testing',
            note: 'parser, renderer, visual, and performance coverage',
          },
          { to: '/', title: 'Overview', note: 'back to the start' },
        ]}
      />
    </>
  );
}
