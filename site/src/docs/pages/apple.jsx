import { Aside, H2, H3, Lede, Note, SeeAlso, TableFrame } from '../../components/Doc.jsx';
import Gallery from '../../components/Gallery.jsx';
import { Link } from '../../lib/router.jsx';

const PRIMITIVES = [
  ['Style', 'NSAttributedString attributes from Theme'],
  ['Conceal', '0.01pt font and a clear colour'],
  [
    'InlineWidget / BlockWidget',
    'control glyph geometry plus viewport-managed native view overlays',
  ],
  ['Gutter', 'the marker character, themed'],
  ['Hit', 'tap-tested against the live decorations'],
];

export default function Apple() {
  return (
    <>
      <H2 id="shared">Shared decoration applier for UIKit and AppKit</H2>
      <Lede>
        iOS is a <code>UITextView</code> and macOS an <code>NSTextView</code>, both on TextKit 1’s
        incremental layout manager and both called <code>MarkdownTextView</code>. Everything that
        decides what a decoration{' '}
        <em>means</em> — reveal resolution, paint ordering, conceal, widget substitution, the
        moved-does-not-repaint rule, hit testing — lives in <code>DecorationApplier</code>, which
        has no UIKit or AppKit in it and is shared verbatim.
      </Lede>
      <p>
        The two text views hold only platform-specific behavior: first-responder handling, gesture
        versus <code>mouseDown</code>, and the inert undo manager. Type divergence between UIKit and
        AppKit is absorbed by aliases in <code>Platform.swift</code>. Sharing the applier keeps
        atomic selection, reveal, and decoration behavior identical on both Apple platforms.
      </p>

      <H2 id="primitives">How each primitive is drawn</H2>
      <TableFrame className="mt-6">
        <thead>
          <tr>
            <th>Primitive</th>
            <th className="desc">How it is drawn</th>
          </tr>
        </thead>
        <tbody>
          {PRIMITIVES.map(([name, how]) => (
            <tr key={name}>
              <td className="role">{name}</td>
              <td className="desc">{how}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>

      <H2 id="attachments">Native widgets without changing the Markdown storage</H2>
      <p>
        Each widget’s first source character becomes a length-preserving control glyph. TextKit
        reserves geometry from <code>WidgetAttachment</code>, while the editor keeps native views
        only around the viewport and positions them over those glyphs. The backing character is
        still the original Markdown — no <code>U+FFFC</code> is written into the document.
      </p>
      <Note>
        Geometry is strictly length-preserving. A multi-line block widget conceals its remaining
        characters; a 0.01pt newline contributes almost no height, so only the overlay’s reserved
        height shows. Selection, copy and paste continue to address exact source offsets.
      </Note>

      <H2 id="conceal">Concealing by shrinking, not by removing</H2>
      <p>
        A hairline font keeps the character count 1:1 with the source, which is what keeps every
        offset in the system honest. Line height is the max over the line, so shrinking a heading’s{' '}
        <code>#</code> does not shrink the heading. The cost is that concealed characters remain
        selectable — which is exactly why{' '}
        <Link to="/docs/concepts/reveal">the core snaps selection endpoints out of concealed ranges</Link>
        .
      </p>

      <H2 id="traps">UIKit input configuration</H2>
      <Aside tone="caution" title="Both of these present as “the editor accepts no input at all”">
        <p>
          A <code>UITapGestureRecognizer</code> added for <code>Hit</code> testing wins gesture
          arbitration and stops <code>UITextView</code>’s own text interaction from ever firing — so
          the view never becomes first responder. It needs{' '}
          <code>cancelsTouchesInView = false</code> <em>and</em> a delegate permitting simultaneous
          recognition; neither alone is enough.
        </p>
        <p>
          Separately, overriding <code>prepare(withInvocationTarget:)</code> on the replacement undo
          manager makes UIKit invoke text mutations on the undo manager instead of on the text view,
          swallowing every keystroke. Refusing to <em>perform</em> undo is sufficient; the
          registrations can pile up harmlessly.
        </p>
      </Aside>

      <H2 id="widget-sizing">Widget sizing with frames and Auto Layout</H2>
      <p>
        Measuring only with <code>systemLayoutSizeFitting</code> reports zero for such a view, which
        clamped a resolved image to one point and rendered it as an invisible gap. Related:
        projection can run before the text container has a width, so resolution must wait for a
        real one — and asking for a <em>size</em> has to start the load, or a resource skipped for
        want of a width is never requested again.
      </p>

      <H3 id="moves">Moves must not repaint</H3>
      <p>
        <code>NSTextStorage</code> carries attributes along with characters, so a decoration that
        only shifted is already correct on screen. Including <code>moved</code> in the repaint region
        drags it to the end of the document on every keystroke — O(document) per character instead
        of O(paragraph). Only <code>added</code>, <code>removed</code> and the edited range are
        dirty, and they are a set rather than a bounding box.
      </p>

      <H2 id="plugin-ui">Native and SwiftUI plugin UI</H2>
      <p>
        Plugin presentations are ordinary sibling <code>NSView</code> or <code>UIView</code> trees,
        positioned against the selection, editor, or viewport with safe-area collision. Their
        handles update, reposition, and dismiss them. <code>showSwiftUIPresentation</code> wraps a
        SwiftUI view in the same lifecycle without making SwiftUI a dependency of the renderer.
      </p>

      <H2 id="gallery">The reference apps</H2>
      <Lede>
        Both apps are real: a UIKit app in the simulator and an AppKit app on the desktop, each
        using the shared package and the same extension manifest as the web demo.
      </Lede>
      <Gallery />
      <Note>
        The examples show native TextKit rendering, including selection, syntax reveal, tables,
        widgets, and extension content.
      </Note>

      <SeeAlso
        links={[
          {
            to: '/docs/platforms/web',
            title: 'Web',
            note: 'the same primitives against contenteditable',
          },
          {
            to: '/docs/reference/swift',
            title: 'Swift API',
            note: 'MarkdownTextView, MarkdownEngine and the host protocols',
          },
          {
            to: '/docs/install',
            title: 'Install and embed',
            note: 'the Swift package, and building the XCFramework',
          },
        ]}
      />
    </>
  );
}
