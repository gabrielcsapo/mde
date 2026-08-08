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
import { hostJs, resolverJs } from '../../lib/snippets.js';

const SEMANTICS = [
  ['arrow key into a widget', 'select the widget as a unit; do not enter it'],
  ['arrow again', 'step past it to the adjacent text position'],
  ['typing while selected', "replace the widget's entire source range"],
  ['Backspace while selected', 'delete the source range'],
  ['Backspace at the position just after', 'select the widget; a second press deletes'],
  ['Enter while a block widget is selected', 'insert an empty line after it'],
  ['Escape inside a revealed node', 'collapse to decorated form, caret after the node'],
  ['drag-select across a widget', 'include its whole source range; never partial'],
  ['find/replace', 'operates on source text; matches inside widgets reveal them'],
  ['tap on a widget', 'place the caret in its source, which reveals it for editing'],
  [
    'tap on a widget that declares itself interactive',
    "the host's view handles it; the host must offer a way back to the source",
  ],
  ['tap on a Hit range', "deliver to the host's handler, do not move the caret"],
];

const PAYLOADS = [
  ['![alt](assets/q3.png)', 'assets/q3.png'],
  ['[text](docs/spec.pdf)', 'docs/spec.pdf'],
  ['```callout warning', 'warning'],
  [':::chart … :::', 'the block body'],
  ['[[the roadmap]]', 'the roadmap'],
];

export default function Widgets() {
  return (
    <>
      <H2 id="atomic">Widgets are atomic</H2>
      <Lede>
        This table is the specification all three renderers implement identically. Divergence here
        is the highest-risk failure mode in the project, which is why the Apple renderers share the
        code that decides it and the web host is written against the same corpus.
      </Lede>
      <TableFrame className="mt-6">
        <thead>
          <tr>
            <th className="desc">Interaction</th>
            <th className="desc">Required behaviour</th>
          </tr>
        </thead>
        <tbody>
          {SEMANTICS.map(([interaction, behavior]) => (
            <tr key={interaction}>
              <td className="desc">{interaction}</td>
              <td className="desc">{behavior}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>

      <H2 id="taps-fall-through">A widget’s view must not take taps unless its host opts in</H2>
      <p>
        This was originally specified the other way round — deliver the tap to the{' '}
        <code>Hit</code> handler and do not move the caret — and it made every widget uneditable.
        The view swallowed the tap before the text engine saw it, the caret could never land in the
        source, so the reveal policy never fired. A callout, an image and a mention chip were all
        dead to the touch.
      </p>
      <p>
        The default has to be that taps fall through, or the editor’s central promise — put the
        caret in any node and its syntax comes back — is simply false for widgets. Hosts turn it on
        per role, for widgets with real controls of their own, and those must offer a way back to
        the source.
      </p>

      <H2 id="provider">What the host draws</H2>
      <Lede>
        The core resolves syntax, ranges, capture groups, reveal state and identity. The host only
        draws. One provider per platform: DOM on the web, <code>UIView</code> / <code>NSView</code>{' '}
        on Apple.
      </Lede>
      <SourceFigure path="web/demo/host.js" lang="javascript" code={hostJs} />
      <Footnote>
        Returning <code>null</code> falls through to the resource resolver, and failing that leaves
        the range as ordinary styled text — so a host that draws nothing still renders a complete,
        editable document.
      </Footnote>

      <H2 id="references">References, not content</H2>
      <Lede>
        A decoration can carry a <strong>payload</strong>: text the parser already resolved, which a
        renderer would otherwise have to re-derive by reparsing markdown in three languages.
      </Lede>
      <TableFrame className="mt-6 max-w-[720px]">
        <thead>
          <tr>
            <th>Construct</th>
            <th className="desc">Payload</th>
          </tr>
        </thead>
        <tbody>
          {PAYLOADS.map(([construct, payload]) => (
            <tr key={construct}>
              <td className="role">{construct}</td>
              <td className="desc">{payload}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <p className="mt-6">
        For anything whose content lives outside the document — images, video, documents, remote
        assets — <strong>the payload is a reference and nothing else</strong>. A 26-character path
        is the whole point of building on markdown; inlining bytes as base64 would make notes
        enormous, destroy diffs, and stop every other markdown tool from reading them.
      </p>

      <H3 id="resolution">Resolution is asynchronous by assumption</H3>
      <SourceFigure className="mt-5" path="web/demo/host.js" lang="javascript" code={resolverJs} />
      <p className="mt-5">
        The resolver returns <em>loading</em>, the editor reserves <code>reservedSize</code> so the
        document does not jump, and delivery later repaints{' '}
        <strong>only the nodes pointing at that reference</strong> — one slow image never
        re-lays-out the document.
      </p>
      <Note>
        Results cache by <em>reference</em>, not by decoration key. The key changes whenever the
        node’s source is edited, but <code>![a](x.png)</code> and <code>![b](x.png)</code> are the
        same asset and should load once.
      </Note>

      <Aside tone="caution" title="reservedSize is a guess exactly once">
        Resolved sizes are measured and kept, and both platforms expose them as{' '}
        <code>resourceSizes</code>. A host that persists them and seeds them on open turns “the
        document shifts once per launch” into “once per asset, ever”. The guess remains the fallback
        for a reference nobody has seen.
      </Aside>

      <SeeAlso
        links={[
          {
            to: '/extend/manifest',
            title: 'The extension manifest',
            note: 'how a construct becomes a widget in the first place',
          },
          {
            to: '/platforms/apple',
            title: 'iOS and macOS',
            note: 'what drawing one costs on TextKit 2',
          },
          {
            to: '/platforms/web',
            title: 'Web',
            note: 'why a widget wrapper has to be a real box',
          },
        ]}
      />
    </>
  );
}
