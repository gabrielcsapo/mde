import {
  Aside,
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
import { decorationRs, patchRs } from '../../lib/snippets.js';

const PRIMITIVES = [
  ['Style', 'text attributes', "apply the theme's attribute set for the role"],
  ['Conceal', 'hide syntax', 'zero-width the range; never selectable as text'],
  ['InlineWidget', 'replaced element in a line', 'participates in line layout, atomic'],
  ['BlockWidget', 'replaced element owning lines', 'full-width, atomic, its own line box'],
  ['Gutter', 'decoration outside the text run', 'leading margin content, does not shift text'],
  ['Hit', 'tappable region', 'no layout effect, gesture target only'],
];

export default function Decorations() {
  return (
    <>
      <H2 id="shape">A range, a primitive, a role</H2>
      <Lede>
        A decoration is a range plus one closed-set primitive plus an open-set role. Primitives are
        closed so three renderers implement a finite contract; roles are open strings, so themes and
        extensions extend without touching the protocol.
      </Lede>
      <SourceFigure
        className="mt-6"
        path="crates/mde-core/src/decoration.rs"
        lang="rust"
        code={decorationRs}
      />

      <H2 id="primitives">The six primitives</H2>
      <TableFrame className="mt-6">
        <thead>
          <tr>
            <th>Primitive</th>
            <th className="desc">Meaning</th>
            <th className="desc">Renderer contract</th>
          </tr>
        </thead>
        <tbody>
          {PRIMITIVES.map(([name, meaning, contract]) => (
            <tr key={name}>
              <td className="role">{name}</td>
              <td className="desc">{meaning}</td>
              <td className="desc">{contract}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Note>
        Six is the whole set. A feature that cannot be drawn as one of these is not a feature this
        editor can have — which is the point of the list being closed.
      </Note>

      <H2 id="roles">Roles are open strings</H2>
      <p>
        <code>heading.1</code>, <code>emphasis.strong</code>, <code>mention</code>. The core never
        interprets a role; it interns the name, hands back an id, and reports that id on every
        decoration. What the name <em>means</em> is entirely the theme’s business, which is what
        lets a manifest — or a{' '}
        <Link to="/extend/layers">host layer invented at runtime</Link> — introduce roles the core
        was never compiled with. The fourteen built-in ids are listed on{' '}
        <Link to="/reference/roles">Roles and CSS classes</Link>.
      </p>

      <H2 id="offsets">Offsets are UTF-16 code units</H2>
      <p>
        The core stores UTF-8 and works in byte offsets internally, but both consumers want UTF-16 —{' '}
        <code>NSTextStorage</code> is UTF-16, and JavaScript strings are UTF-16. Converting in each
        renderer would mean two chances to get emoji and CJK wrong.{' '}
        <strong>Every offset crossing the boundary is a UTF-16 code unit</strong>, converted once,
        in the core, on the way out.
      </p>

      <H2 id="identity">Widget identity excludes position</H2>
      <Lede>
        If a widget’s key changes, the renderer tears it down and rebuilds it. An image that reloads
        on every keystroke elsewhere in the document is a bug — and a naive index-based key causes
        exactly that, because inserting a line at the top shifts every index.
      </Lede>
      <pre className="key-formula">
        <code>key = hash(role, source_slice_of_node, disambiguator_among_identical_siblings)</code>
      </pre>
      <p>
        Position is deliberately excluded. Typing far away leaves the key untouched, so the widget
        survives as a <em>moved</em> entry rather than a rebuilt one. Typing <em>inside</em> the
        node’s source changes the key, which correctly rebuilds it.
      </p>
      <Aside tone="note" title="Except in a layer, where position is included on purpose">
        A widget that survives an edit must not be rebuilt, but a <em>styling</em> span that slides
        has to repaint both the range it left and the range it arrived at — and renderers are free
        to ignore <code>moved</code> entirely. Keying a layer span on position turns a move into a
        remove plus an add, which is exactly the repaint required.
      </Aside>

      <H2 id="patch">What the renderer receives</H2>
      <SourceFigure path="crates/mde-core/src/decoration.rs" lang="rust" code={patchRs} />
      <Footnote>
        A <code>moved</code> entry means position changed and identity did not. On Apple, attributes
        travel with characters in <code>NSTextStorage</code>, so a decoration that only shifted is
        already correct on screen; including <code>moved</code> in the repaint region drags the
        dirty range to the end of the document on every keystroke.
      </Footnote>

      <H3 id="dirty-ranges">Dirty ranges are a set, not a bounding box</H3>
      <p>
        Excluding <code>moved</code> is only half the rule. Editing a node changes how many
        byte-identical siblings precede its twin elsewhere, which changes that twin’s key and puts a
        removal half a document away from the caret. Unioning the two into one range covered
        everything between them: one keystroke measured at{' '}
        <strong>1844 ms instead of 0.33 ms</strong>, at any document size. Both renderers repaint
        disjoint ranges, and both have a test pinned to it.
      </p>

      <SeeAlso
        links={[
          {
            to: '/concepts/reveal',
            title: 'Reveal policy',
            note: 'the fourth field, and why a selection change produces a patch',
          },
          {
            to: '/reference/ffi',
            title: 'C ABI and wasm exports',
            note: 'the same structs, as bytes',
          },
        ]}
      />
    </>
  );
}
