import {
  Aside,
  Clause,
  Clauses,
  Footnote,
  H2,
  H3,
  Lede,
  Note,
  SeeAlso,
  TableFrame,
} from '../../components/Doc.jsx';
import SourceFigure from '../../components/SourceFigure.jsx';
import { Link } from '../../lib/router.jsx';
import { historyApi, historyJs, historySwift } from '../../lib/snippets.js';

const REVISION_FIELDS = [
  ['index', 'u32', 'Position in the timeline. Jumping here means “the document immediately after this revision was applied”.'],
  ['atMs', 'u64', 'When it happened, in milliseconds from the same monotonic clock that drives coalescing.'],
  ['inserted', 'u32', 'UTF-16 code units added.'],
  ['removed', 'u32', 'UTF-16 code units removed.'],
  ['at', 'u32', 'Where in the document it landed.'],
  ['kind', 'enum', 'insert · delete · replace — which side was non-empty.'],
];

export default function History() {
  return (
    <>
      <H2 id="core-owns-it">History state in the core</H2>
      <Lede>
        The platform undo manager sees keystrokes, not structure. Undoing a bold-toggle through it
        would come back as two unrelated character deletions, and <code>UITextView</code>’s manager
        cannot be taught otherwise.
      </Lede>
      <p>
        So the renderers install an inert undo manager and the log lives in Rust, next to the code
        that knows what a markdown edit <em>was</em>. That is also what makes undo behave
        identically on all three platforms rather than three times approximately.
      </p>
      <p>
        <code>Text::apply</code> returns the inverse of every batch it applies, so a revision is
        just <em>(redo edits, undo edits, selection before, selection after)</em>.
      </p>

      <H2 id="flow-inverts">Undo flow from core to platform</H2>
      <p>
        Edits normally travel platform → core: the buffer changes, the core is told, a patch comes
        back. An undo goes the other way. The core returns edits, the host applies them to its own
        buffer, and — this is the part that matters — <strong>does not report them back</strong>.
        They are already in the history; reporting them would record them a second time.
      </p>
      <Note>
        Both hosts apply the returned edits back to front, so earlier offsets stay valid while later
        ones are still pending. This is the same ordering rule the core uses internally.
      </Note>

      <H2 id="coalescing">Typing and deletion coalescing</H2>
      <Lede>
        A forward typing run and a backspace run, both within 700 ms and both positionally adjacent.
        Everything else starts a new revision.
      </Lede>
      <p>
        Those two are the only unambiguous cases. A newline ends a run — a paragraph break is where
        a person expects undo to stop — and <code>boundary()</code> forces a revision explicitly, so
        a formatting command never merges into the typing around it. That is why the{' '}
        <Link to="/docs/try">demo’s Bold button</Link> comes off in one step rather than as two marker
        deletions.
      </p>
      <Aside tone="caution" title="A resync clears the history">
        After a desync the recorded offsets describe a document that never existed on the platform
        side, and replaying them would corrupt the buffer. <code>reset()</code> therefore throws the
        log away — which is also why <code>setMarkdown</code> does.
      </Aside>

      <H2 id="timeline">Browsable revision timeline</H2>
      <Lede>
        Undo and redo are the one-step view of a history that can be listed and navigated. Three
        calls, on every platform.
      </Lede>
      <SourceFigure className="mt-6" path="the history API" lang="text" code={historyApi} />

      <H3 id="revision">What a revision reports</H3>
      <TableFrame className="mt-5">
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th className="desc">Meaning</th>
          </tr>
        </thead>
        <tbody>
          {REVISION_FIELDS.map(([field, type, meaning]) => (
            <tr key={field}>
              <td className="role">{field}</td>
              <td>{type}</td>
              <td className="desc">{meaning}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Footnote>
        The summary is deliberately coarse. The core knows which characters moved, not what the
        person meant — a label that guesses at intent (“renamed the heading”) is worse than one that
        states what happened.
      </Footnote>

      <H2 id="decisions">Timeline behavior</H2>
      <Clauses>
        <Clause title="Undone revisions stay in the list">
          They are not deleted when you step back, only un-applied. A history you can browse has to
          show the branch you stepped back from, or there is nothing to step forward <em>to</em>. An
          edit made from a rewound point still discards that branch, exactly as it does for redo.
        </Clause>
        <Clause title="jumpTo returns one edit, not a chain">
          Each step’s edits are in the coordinates of the document as it was at that step, so
          replaying fifty of them makes the host reconstruct every intermediate state in exactly the
          right order — and a host that gets it subtly wrong desyncs silently. Diffing the start and
          end text instead yields a single replacement that is correct however the host applies it,
          and collapses a fifty-revision jump into one splice.
        </Clause>
        <Clause title="The diff is UTF-16 and never splits a surrogate pair">
          The same rule as every other offset that crosses the boundary. A jump that cut an emoji in
          half would be a desync with extra steps.
        </Clause>
        <Clause title="historyPosition is a count, not an index">
          It is how many revisions are applied, so <code>0</code> is the document before anything
          happened and <code>revisions.length</code> is the newest state. Jumping to a revision’s{' '}
          <code>index + 1</code> lands just after it.
        </Clause>
      </Clauses>

      <H2 id="using-it">Using it</H2>
      <SourceFigure className="mt-6" path="web" lang="javascript" code={historyJs} />
      <SourceFigure className="mt-5" path="iOS and macOS" lang="swift" code={historySwift} />
      <Note>
        On the web the properties are <code>editor.revisions</code>,{' '}
        <code>editor.historyPosition</code> and <code>editor.jumpTo(n)</code>; on Apple they are{' '}
        <code>revisions</code>, <code>historyPosition</code> and <code>jump(to:)</code>. Both return
        the same coarse summary, because both read the same struct out of the same core.
      </Note>

      <SeeAlso
        links={[
          {
            to: '/docs/reference/web',
            title: 'Web API',
            note: 'the history properties in context',
          },
          {
            to: '/docs/reference/swift',
            title: 'Swift API',
            note: 'Revision, RevisionKind and jump(to:)',
          },
          {
            to: '/docs/internals/architecture',
            title: 'Architecture',
            note: 'why the platform owns the buffer in the first place',
          },
        ]}
      />
    </>
  );
}
