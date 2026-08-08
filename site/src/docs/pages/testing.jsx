import { Aside, H2, Lede, Note, SeeAlso, TableFrame } from '../../components/Doc.jsx';
import SourceFigure from '../../components/SourceFigure.jsx';
import { Link } from '../../lib/router.jsx';
import { tag } from '../../lib/highlight.js';

const golden = tag('bash', `UPDATE_GOLDEN=1 cargo test -p mde-core --test golden`);
const all = tag('bash', `./scripts/test.sh   # Rust, both Swift suites, and the browser suite`);
const captures = tag(
  'bash',
  `pnpm capture:cross-platform   # JS, React, UIKit, and AppKit from one fixture`
);

const SUITES = [
  [
    'Golden corpus',
    'crates/mde-core, tests/corpus/*.md',
    'A case, optionally with an inline manifest and a ‸ caret marker; the .snap neighbour is the expected decoration set, rendered with source slices inline so a diff is readable.',
  ],
  [
    'MDECoreTests',
    'apple/, swift test',
    'Drives the FFI wrapper against a MirrorBuffer standing in for NSTextStorage, so mirror drift is caught here rather than as a corrupted document on a device.',
  ],
  [
    'MDEditorUITests',
    'apple/, swift test',
    'Drives the real AppKit NSTextView in an offscreen window and asserts on its native table grid, nested inline content and reveal behaviour.',
  ],
  [
    'UIKit renderer',
    'scripts/test-ios-renderer.sh',
    'Launches the real reference app in an iPhone simulator and checks the native grid, source preservation, bold, links, code, images, and reveal/restore.',
  ],
  [
    'Web suite',
    'web/test/index.html',
    'Runs in a real browser on purpose: contenteditable behaviour, selection restore, CSS precedence on concealed runs, hit-testing a widget.',
  ],
];

export default function Testing() {
  return (
    <>
      <H2 id="corpus">The corpus is the contract</H2>
      <Lede>
        The core is a pure function of text, selection and registry, so a snapshot pins observable
        behaviour completely. Each case in <code>tests/corpus/</code> has a <code>.snap</code>{' '}
        neighbour holding the expected decoration set.
      </Lede>
      <p>
        A case may carry an inline extension manifest and a <code>‸</code> marker for the caret,
        which is stripped before parsing — so <Link to="/concepts/reveal">reveal behaviour</Link> is
        snapshotted too, not just the parse.
      </p>
      <SourceFigure className="mt-6" path="regenerating the snapshots" lang="bash" code={golden} />
      <Aside tone="note" title="When a renderer disagrees with a snapshot, the renderer is wrong">
        That is the whole point of writing three renderers against one corpus. It is also why the
        decoration protocol is the thing the tests describe, rather than any particular platform’s
        drawing.
      </Aside>

      <H2 id="suites">Five suites</H2>
      <TableFrame className="mt-6">
        <thead>
          <tr>
            <th className="desc">Suite</th>
            <th className="desc">Where</th>
            <th className="desc">What it pins</th>
          </tr>
        </thead>
        <tbody>
          {SUITES.map(([name, where, what]) => (
            <tr key={name}>
              <td className="desc">{name}</td>
              <td className="desc">
                <code>{where}</code>
              </td>
              <td className="desc">{what}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Note>
        The AppKit suite asserts on rendering, not on intentions: a heading larger than body text,{' '}
        <code>**</code> collapsed to a hairline, only the caret’s own node revealed, substitution
        length-preserving, undo restoring storage <em>and</em> decorations.
      </Note>

      <H2 id="one-command">All of them, one command</H2>
      <SourceFigure className="mt-6" path="from the repository root" lang="bash" code={all} />
      <p className="mt-6">
        This is not a convenience. The web half runs through headless Chrome over the DevTools
        protocol, with Node serving the files itself so caching cannot hand the browser a stale
        module. While the web suite needed a human to open a page, it grew a test that passed when
        it was written and failed on re-run, because it depended on the window’s size.{' '}
        <strong>Nothing that is not in <code>test.sh</code> will stay honest.</strong>
      </p>
      <Note>
        The browser suite has no npm dependencies either — the same rule as the editor itself. Only
        this site has a <code>package.json</code>.
      </Note>

      <H2 id="visual-captures">Reproduce all four platform screenshots</H2>
      <p>
        The JS, React, iOS, and macOS images are captures of the real renderers, not HTML mockups.
        One command loads <code>fixtures/cross-platform.md</code> in all four hosts and writes the
        resulting images to <code>site/assets/</code>.
      </p>
      <SourceFigure className="mt-6" path="from the repository root" lang="bash" code={captures} />
      <Aside tone="note" title="Capture review is part of the renderer contract">
        When the shared fixture gains a new content case, its renderer assertions and all four
        captures must be updated in the same change. The change is complete only after the suites
        pass, the capture command succeeds, and all four images have been visually reviewed.
      </Aside>

      <SeeAlso
        links={[
          {
            to: '/internals/performance',
            title: 'Performance',
            note: 'the tests that pin the optimizations, including byte-identical incremental output',
          },
          {
            to: '/platforms/web',
            title: 'Web',
            note: 'the bugs that only exist in a real engine',
          },
        ]}
      />
    </>
  );
}
