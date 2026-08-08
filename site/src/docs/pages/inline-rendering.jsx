import {
  Aside,
  Clause,
  Clauses,
  H2,
  Lede,
  Note,
  SeeAlso,
  TableFrame,
} from '../../components/Doc.jsx';
import { Link } from '../../lib/router.jsx';

const DEGRADES = [
  ['```callout', 'a code block — visible, harmless, lossless'],
  [':::chart', 'a paragraph of literal text'],
  ['@mention', 'plain text'],
  ['[[wikilink]]', 'plain text'],
];

export default function InlineRendering() {
  return (
    <>
      <H2 id="the-text-is-the-truth">The text is the truth</H2>
      <Lede>
        There is no rich document model, no serializer, and no lossy round-trip. The buffer holds
        markdown, the caret moves through markdown, and what you see is that same string with
        attributes over it.
      </Lede>
      <p>
        This is a stronger claim than “markdown support”. A WYSIWYG editor owns a document model and
        treats markdown as an import and export format, which is why round-tripping a document
        through one reorders emphasis markers, rewrites list bullets and loses anything it did not
        model. Here there is nothing to round-trip: the file on disk is the state in memory.
      </p>
      <p>
        The rule that keeps it that way is a constraint on features, not a description of one:{' '}
        <strong>if a feature requires a side model, it is out of scope</strong>. Every capability
        has to be expressible as a range, a{' '}
        <Link to="/concepts/decorations">drawing primitive</Link> and a role over the string.
      </p>

      <H2 id="what-that-buys">What that constraint buys</H2>
      <Clauses>
        <Clause title="Three renderers cannot drift">
          Parsing, extension semantics, reveal policy and widget identity are decided once, in Rust.
          The renderers apply decisions; they do not make them. Two of the three share their
          decoration applier verbatim.
        </Clause>
        <Clause title="Any bug is a recording">
          The core never mutates text. It is a pure function of the edit stream, the selection and
          the registry — so a bug reduces to a recorded edit log plus a manifest, which is also{' '}
          <Link to="/internals/testing">the golden test format</Link>.
        </Clause>
        <Clause title="Input stays native">
          The platform text engine owns the buffer, so IME, autocorrect, spellcheck, selection
          handles and accessibility are the system’s. We never reimplement a caret — that is exactly
          what makes webview editors feel wrong on iOS.
        </Clause>
        <Clause title="Files stay yours">
          Every construct degrades under a stock CommonMark renderer, so a note written here is
          still a note everywhere else.
        </Clause>
      </Clauses>

      <H2 id="portability">Portability is a design rule, not a hope</H2>
      <Lede>
        Extensions are chosen so that a document containing them stays readable in tools that have
        never heard of them.
      </Lede>
      <TableFrame className="mt-6 max-w-[720px]">
        <thead>
          <tr>
            <th>Construct</th>
            <th className="desc">Seen elsewhere as</th>
          </tr>
        </thead>
        <tbody>
          {DEGRADES.map(([construct, seen]) => (
            <tr key={construct}>
              <td className="role">{construct}</td>
              <td className="desc">{seen}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Note>
        Fenced blocks are the preferred form: CommonMark already parses them, so they cost the core
        nothing and no outside tool can corrupt them. Directive syntax needs a custom block scanner
        and exists for hosts that want the lighter visual weight.
      </Note>

      <H2 id="references">A reference, never the bytes</H2>
      <p>
        The same rule decides what a document may contain. <code>![a chart](assets/q3.png)</code> is
        twenty-six characters that name an image; inlining the image as base64 would make notes
        enormous, destroy diffs, and stop every other markdown tool from reading them. Turning a
        reference into something displayable is the host’s job — see{' '}
        <Link to="/concepts/widgets">Widgets and references</Link>.
      </p>

      <Aside tone="note" title="The one thing it is not">
        This is not a preview pane, and it is not a two-column editor. There is one view, it is
        editable everywhere, and the syntax is always one caret movement away.
      </Aside>

      <SeeAlso
        links={[
          {
            to: '/concepts/decorations',
            title: 'The decoration protocol',
            note: 'the six primitives every feature has to fit into',
          },
          {
            to: '/try',
            title: 'Try it',
            note: 'the claim, running',
          },
        ]}
      />
    </>
  );
}
