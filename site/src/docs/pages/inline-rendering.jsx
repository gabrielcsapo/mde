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
      <H2 id="the-text-is-the-truth">Markdown remains the editable source</H2>
      <Lede>
        There is no rich document model, no serializer, and no lossy round-trip. The buffer holds
        markdown, the caret moves through markdown, and what you see is that same string with
        attributes over it.
      </Lede>
      <p>
        The editor does not convert Markdown into a separate rich-text document. Exact emphasis
        markers, list bullets, extension syntax, and whitespace remain in the buffer and on disk.
      </p>
      <p>
        Every rendered capability is expressed as a range, a{' '}
        <Link to="/docs/concepts/decorations">drawing primitive</Link> and a role over the string.
      </p>

      <H2 id="what-that-buys">Benefits of source-first rendering</H2>
      <Clauses>
        <Clause title="Shared rendering semantics">
          Parsing, extension semantics, reveal policy and widget identity are decided once, in Rust.
          The renderers apply decisions; they do not make them. Two of the three share their
          decoration applier verbatim.
        </Clause>
        <Clause title="Reproducible edit behavior">
          The core never mutates text. It is a pure function of the edit stream, the selection and
          the registry — so a bug reduces to a recorded edit log plus a manifest, which is also{' '}
          <Link to="/docs/internals/testing">the golden test format</Link>.
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

      <H2 id="portability">Extension syntax remains portable</H2>
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

      <H2 id="references">Documents store media references</H2>
      <p>
        The same rule decides what a document may contain. <code>![a chart](assets/q3.png)</code> is
        twenty-six characters that name an image; inlining the image as base64 would make notes
        enormous, destroy diffs, and stop every other markdown tool from reading them. Turning a
        reference into something displayable is the host’s job — see{' '}
        <Link to="/docs/concepts/widgets">Widgets and references</Link>.
      </p>

      <Aside tone="note" title="One editable view">
        Rendered content and Markdown source share one view. Moving the caret into a node reveals
        its syntax for editing.
      </Aside>

      <SeeAlso
        links={[
          {
            to: '/docs/concepts/decorations',
            title: 'The decoration protocol',
            note: 'the six primitives every feature has to fit into',
          },
          {
            to: '/docs/try',
            title: 'Try it',
            note: 'edit rendered Markdown in the browser',
          },
        ]}
      />
    </>
  );
}
