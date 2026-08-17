import { Aside, H2, Lede, Note, SeeAlso, TableFrame } from '../../components/Doc.jsx';
import SourceFigure from '../../components/SourceFigure.jsx';
import CaptureMatrix from '../../components/CaptureMatrix.jsx';
import { Link } from '../../lib/router.jsx';
import { tag } from '../../lib/highlight.js';

const golden = tag('bash', `UPDATE_GOLDEN=1 cargo test -p mde-core --test golden`);
const all = tag('bash', `./scripts/test.sh   # Rust, both Swift suites, and the browser suite`);
const captures = tag('bash', `pnpm capture:cross-platform   # 13 scenarios × 4 renderers`);
const performance = tag('bash', `./scripts/test-performance.sh   # edit matrix + budgets`);

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
    'web/test/editor.browser.test.js',
    'Vitest Browser Mode drives Chromium, Firefox, and WebKit: contenteditable behaviour, selection restore, CSS precedence, focus, and hit-testing all use real browser engines.',
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
      <p>
        A separate CommonMark contract suite carries selected upstream specification cases that are
        especially easy for a renderer to mishandle — tabs after markers, legal indentation,
        escaped constructs, nested inline nodes, and lazy block-quote continuation. Pulldown owns
        parsing conformance; these fixtures pin the decoration ranges every host consumes.
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
        This is not a convenience. The web half runs through Vitest Browser Mode with Playwright
        in Chromium, Firefox, and WebKit, so selection, layout, focus and input stay native while
        every case gets isolated reporting and reproducible automation. While the suite needed a human to
        open a page, it grew a test that passed when written and failed on re-run because it
        depended on the window’s size.{' '}
        <strong>Nothing that is not in <code>test.sh</code> will stay honest.</strong>
      </p>
      <Note>
        The editor remains dependency-free at runtime. Vitest, Playwright, TypeScript and Vite are
        development-only tooling and are not included in <code>@mde/web</code>’s published runtime.
        On a fresh machine, run <code>pnpm --dir web run test:install-browser</code> once to install
        Playwright’s browser builds.
      </Note>

      <H2 id="visual-captures">Reproduce the cross-platform screenshot matrix</H2>
      <p>
        These are captures of the real renderers, not HTML mockups. Focused fixtures cover every
        CommonMark help category, the deliberately source-preserved forms, rich tables and
        resources, host extensions, plugin-rendered HTML, plugin canvas UI, live syntax reveal, and selected table
        source across JS, React, iOS, and macOS. Keeping each scenario short makes every feature
        visible at phone height and makes platform differences easy to spot.
      </p>
      <CaptureMatrix />
      <SourceFigure className="mt-6" path="from the repository root" lang="bash" code={captures} />
      <Aside tone="note" title="Capture review is part of the renderer contract">
        When the shared fixture gains a new content case, its renderer assertions and all four
        captures must be updated in the same change. The change is complete only after the suites
        pass, the capture command succeeds, and all four images have been visually reviewed.
      </Aside>

      <H2 id="performance-matrix">One edit contract, every client</H2>
      <p>
        The performance suite runs the same Rust-generated 10 KB, 100 KB, 500 KB, and 1 MB
        documents through JS, React, UIKit, AppKit, and the core. At the beginning, middle, and
        end it inserts and deletes a character, replaces a word, inserts a structural newline,
        pastes 1 KB, and deletes 1 KB. A sustained 100-edit session follows. Every case asserts
        the exact resulting Markdown before its latency can count as a pass.
      </p>
      <SourceFigure className="mt-6" path="from the repository root" lang="bash" code={performance} />

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
