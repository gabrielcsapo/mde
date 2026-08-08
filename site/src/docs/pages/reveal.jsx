import { Aside, H2, Lede, Note, SeeAlso, TableFrame } from '../../components/Doc.jsx';
import { Link } from '../../lib/router.jsx';

const REVEALS = [
  ['Never', 'never — pure decoration'],
  ['CaretInNode', 'the selection intersects the decorated node'],
  ['CaretInLine', 'the selection touches any line the node occupies'],
  ['CaretInBlock', 'the selection is anywhere in the enclosing block'],
];

export default function Reveal() {
  return (
    <>
      <H2 id="policy">Four policies, decided in the core</H2>
      <Lede>
        The “show me the <code>**</code> while I am editing this word” behaviour lives in the core,
        not in renderer code, so it is identical on every platform and tunable per extension. A
        manifest entry names one of these; a built-in construct has one chosen for it.
      </Lede>
      <TableFrame className="mt-6 max-w-[760px]">
        <thead>
          <tr>
            <th>Reveal</th>
            <th className="desc">Concealed range reopens when</th>
          </tr>
        </thead>
        <tbody>
          {REVEALS.map(([name, when]) => (
            <tr key={name}>
              <td className="role">{name}</td>
              <td className="desc">{when}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Note>
        Intersection is inclusive at both endpoints: a caret resting immediately before or after a
        node reveals it, which is what makes arrowing into <code>**bold**</code> feel continuous
        rather than stepping through an invisible gap.
      </Note>

      <H2 id="collapse">Revealing does not delete the decoration</H2>
      <p>
        It collapses the hiding primitive — <code>Conceal</code>, <code>InlineWidget</code>,{' '}
        <code>BlockWidget</code> — to <code>Style</code>, keeping the same key and the same role. So
        the theme still dims the markers rather than dumping them out at full weight, and the
        renderer sees <em>one coherent identity</em> across the transition instead of a teardown
        followed by an unrelated construction.
      </p>

      <H2 id="selection-is-input">A selection change produces a patch</H2>
      <Lede>
        This is the consequence worth naming, because it decides an API shape:{' '}
        <code>set_selection</code> is a first-class core entry point, not a renderer concern.
      </Lede>
      <p>
        Moving the caret is not a display detail the renderer can handle locally — it changes which
        decorations are hiding and which are showing, which is a decoration diff like any other. On
        every platform, the caret moving goes into the core and a patch comes back out.
      </p>

      <H2 id="unfocused">Unfocused is a distinct state, not a caret at 0</H2>
      <p>
        The core’s selection is an <em>optional</em>, and renderers pass nothing on blur. Without
        that, a freshly opened document has an implicit caret at offset 0, which reveals the first
        heading’s <code>#</code> before the reader has touched anything — the document opens
        looking like it has already been edited.
      </p>
      <Note>
        A resync (<code>reset</code>) preserves focus. Only an explicit blur clears it.
      </Note>

      <H2 id="snapping">Concealed ranges are never independently selectable</H2>
      <p>
        A concealed marker is still a real character with a real offset — both renderers hide it by
        shrinking it to a hairline rather than removing it, so the character count stays 1:1 with
        the source and every offset in the system stays honest. The cost is that a selection
        endpoint could land inside a range that has no visible width, which would give the user an
        invisible caret. So the core snaps endpoints outward to the node boundary.
      </p>

      <Aside tone="note" title="Escape collapses without moving">
        Pressing <kbd>Escape</kbd> inside a revealed node collapses it back to its decorated form
        and leaves the caret after the node — a way out that does not require arrowing past the
        markers you just made visible.
      </Aside>

      <SeeAlso
        links={[
          {
            to: '/concepts/widgets',
            title: 'Widgets and references',
            note: 'what reveal means when the node is drawn by the host',
          },
          {
            to: '/extend/manifest',
            title: 'The extension manifest',
            note: 'where an extension declares which policy it wants',
          },
          { to: '/try', title: 'Try it', note: 'arrow into a bold word and watch' },
        ]}
      />
    </>
  );
}
