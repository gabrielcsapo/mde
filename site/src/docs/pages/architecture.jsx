import { Clause, Clauses, Footnote, H2, Lede, Note, SeeAlso } from '../../components/Doc.jsx';
import Diagram from '../../components/Diagram.jsx';
import { Link } from '../../lib/router.jsx';

export default function Architecture() {
  return (
    <>
      <H2 id="flow">The loop</H2>
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

      <H2 id="platform-owns-buffer">Why the platform owns the buffer</H2>
      <p>
        <code>NSTextStorage</code> and the browser’s DOM both insist on owning their text. Fighting
        that is how editors lose native IME, autocorrect and selection handles — the exact things
        that make webview editors feel wrong on iOS. So the core keeps a <em>mirror</em> rope,
        updated from the same edit deltas the platform already applied.
      </p>
      <Note>
        Mirror drift is the one catastrophic failure mode. Every edit carries the resulting document
        length and the core asserts agreement; on mismatch it requests a full resync rather than
        emitting wrong decorations. Both hosts implement that recovery, and the Swift test suite
        drives the FFI against a stand-in buffer specifically to catch drift there rather than as a
        corrupted document on a device.
      </Note>

      <H2 id="reparse">Why a full reparse was ever acceptable</H2>
      <p>
        Markdown is aggressively non-local. One <code>```</code> fence, one list marker, one link
        reference definition can restructure every block below it, and incremental parsers for
        markdown are a well-known tarpit. Nothing here depends on incrementality for correctness —
        it is an optimization behind a fixed interface, and{' '}
        <Link to="/internals/performance">it was profiled before it was written</Link>.
      </p>

      <H2 id="undo">Undo is the one flow that travels the other way</H2>
      <p>
        The core owns the history, because the platform undo manager sees keystrokes rather than
        structure. Renderers install an inert undo manager, and an undo travels core → platform: the
        core returns edits, the host applies them to its own buffer and does not report them back.{' '}
        <Link to="/concepts/history">History and undo</Link> covers the whole of it, including the
        browsable timeline.
      </p>

      <H2 id="consequences">What falls out of the split</H2>
      <Clauses>
        <Clause title="Renderers cannot disagree about semantics">
          Everything that decides what a decoration <em>means</em> lives in one shared applier on
          Apple, and the web host is written against the same golden corpus. When a renderer
          disagrees with a snapshot, the renderer is wrong.
        </Clause>
        <Clause title="Concealing shrinks, it does not remove">
          A 0.01pt hairline glyph on Apple, <code>font-size: 0.01px</code> on the web. The character
          count stays 1:1 with the source, which keeps every offset in the system honest — and is
          why the core snaps selection endpoints out of concealed ranges.
        </Clause>
        <Clause title="The web layer is ours, not a framework">
          CodeMirror 6 sits <em>above</em> the browser’s text engine with its own decoration and
          transaction model. Building against it and TextKit 2 would translate one protocol into two
          foreign vocabularies and let the semantics drift apart.
        </Clause>
        <Clause title="A patch is the only thing renderers consume">
          Removed keys, added decorations, moved ranges. No renderer ever sees a parse tree, and
          none of them can be made to care about markdown.
        </Clause>
      </Clauses>

      <SeeAlso
        links={[
          {
            to: '/internals/performance',
            title: 'Performance',
            note: 'where the per-keystroke time actually goes',
          },
          {
            to: '/reference/ffi',
            title: 'C ABI and wasm exports',
            note: 'the boundary in the middle of that diagram',
          },
          { to: '/internals/testing', title: 'Testing', note: 'how the three are kept honest' },
        ]}
      />
    </>
  );
}
