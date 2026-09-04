import { Clause, Clauses, Footnote, H2, Lede, Note, SeeAlso } from '../../components/Doc.jsx';
import Diagram from '../../components/Diagram.jsx';
import { Link } from '../../lib/router.jsx';

export default function Architecture() {
  return (
    <>
      <H2 id="flow">Edit and render flow</H2>
      <Lede>
        A keystroke lands in the platform’s own text view, which already applied it. The core is
        told what changed, reparses, decorates, assigns keys and diffs, and hands back a patch. The
        renderer applies it.
      </Lede>
      <Diagram />
      <Footnote>
        The core never mutates text. It is a pure function of the edit stream, the selection and the
        registry — which is what makes it replayable, and what makes any bug reduce to a recorded
        edit log plus a manifest.
      </Footnote>

      <H2 id="platform-owns-buffer">Platform-owned text buffer</H2>
      <p>
        <code>NSTextStorage</code> and the browser’s DOM both insist on owning their text. Fighting
        that is how editors lose native IME, autocorrect and selection handles — the exact things
        that make webview editors feel wrong on iOS. So the core keeps a <em>mirror</em> rope,
        updated from the same edit deltas the platform already applied.
      </p>
      <Note>
        Every edit carries the resulting document length. If the platform buffer and core mirror
        disagree, the core requests a full resync instead of emitting decorations for the wrong
        offsets. Swift tests exercise the same recovery through the FFI.
      </Note>

      <H2 id="reparse">Full-reparse cost and limits</H2>
      <p>
        Markdown is aggressively non-local. One <code>```</code> fence, one list marker, one link
        reference definition can restructure every block below it, and incremental parsers for
        markdown are a well-known tarpit. Nothing here depends on incrementality for correctness —
        it is an optimization behind a fixed interface, and{' '}
        <Link to="/docs/internals/performance">it was profiled before it was written</Link>.
      </p>

      <H2 id="undo">Undo flow from core to platform</H2>
      <p>
        The core owns the history, because the platform undo manager sees keystrokes rather than
        structure. Renderers install an inert undo manager, and an undo travels core → platform: the
        core returns edits, the host applies them to its own buffer and does not report them back.{' '}
        <Link to="/docs/concepts/history">History and undo</Link> covers the whole of it, including the
        browsable timeline.
      </p>

      <H2 id="consequences">Responsibilities at each layer</H2>
      <Clauses>
        <Clause title="The core defines semantics">
          Everything that decides what a decoration <em>means</em> lives in one shared applier on
          Apple, and the web host is tested against the same golden corpus. A snapshot mismatch
          fails the corresponding renderer test.
        </Clause>
        <Clause title="Concealing shrinks, it does not remove">
          A 0.01pt hairline glyph on Apple, <code>font-size: 0.01px</code> on the web. The character
          count stays 1:1 with the source, so offsets continue to map directly to the buffer. The
          core snaps selection endpoints out of concealed ranges.
        </Clause>
        <Clause title="The web renderer uses contenteditable directly">
          CodeMirror 6 sits <em>above</em> the browser’s text engine with its own decoration and
          transaction model. Building against it and TextKit would translate one protocol into two
          separate decoration models with different selection and widget semantics.
        </Clause>
        <Clause title="A patch is the only thing renderers consume">
          A patch contains removed keys, added decorations, and moved ranges. Renderers do not
          receive parse trees or interpret Markdown.
        </Clause>
      </Clauses>

      <SeeAlso
        links={[
          {
            to: '/docs/internals/performance',
            title: 'Performance',
            note: 'measured latency and incremental work',
          },
          {
            to: '/docs/reference/ffi',
            title: 'C ABI and wasm exports',
            note: 'the boundary in the middle of that diagram',
          },
          { to: '/docs/internals/testing', title: 'Testing', note: 'cross-platform parser and renderer coverage' },
        ]}
      />
    </>
  );
}
