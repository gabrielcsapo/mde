import { Aside, H2, Lede, Note, SeeAlso, TableFrame } from '../../components/Doc.jsx';

const SUPPORT = [
  ['Headings', 'Rendered inline', 'ATX and Setext levels; markers reveal at the caret.'],
  ['Emphasis and strong', 'Rendered inline', 'Nested CommonMark delimiter rules come from Rust.'],
  ['Inline and block code', 'Rendered inline', 'Fence and indentation scaffolding returns when the caret enters the block.'],
  ['Links and autolinks', 'Rendered inline', 'Command/Ctrl-click on desktop; long press on iOS.'],
  ['Images', 'Resolved widget', 'Inline, reference-style, table-only, and mixed table cells use the host resolver.'],
  ['Block quotes and lists', 'Native projection', 'Quote rails, bullets, counters, and nesting preserve the exact source markers.'],
  ['Task lists', 'Interactive source', 'Lowercase and uppercase checked markers toggle as one undo step.'],
  ['Thematic breaks', 'Native projection', 'A visual divider keeps the exact marker string underneath.'],
  ['GFM tables', 'Native projection', 'Semantic HTML on web and a native grid on Apple, driven by Rust cell ranges.'],
  ['Strikethrough', 'Rendered inline', 'The deliberately enabled GFM inline extension.'],
  ['Raw HTML', 'Preserved source', 'Never executed or injected into the host view.'],
  ['Escapes and entities', 'Preserved source', 'Exact characters remain visible; there is no decoded preview model.'],
  ['Soft and hard breaks', 'Preserved source', 'Native newlines remain the document; trailing break syntax is not replaced.'],
  ['Reference definitions', 'Preserved source', 'Used by Rust to resolve links and images, but never hidden as a side model.'],
];

const NOT_ENABLED = [
  'Footnotes',
  'GFM alert block quotes',
  'Math',
  'Heading attributes',
  'YAML or +++ front matter',
  'Definition lists',
  'Smart punctuation',
];

export default function MarkdownSupport() {
  return (
    <>
      <H2 id="contract">Markdown support, without an asterisk</H2>
      <Lede>
        The parser follows CommonMark and deliberately enables GFM tables, task lists, and
        strikethrough. “Supported” does not always mean “turned into a preview”: this editor keeps
        one editable source string, so the table below says exactly what each construct becomes.
      </Lede>

      <TableFrame className="mt-6">
        <thead>
          <tr>
            <th>Construct</th>
            <th>Presentation</th>
            <th className="desc">Contract</th>
          </tr>
        </thead>
        <tbody>
          {SUPPORT.map(([construct, presentation, contract]) => (
            <tr key={construct}>
              <td className="role">{construct}</td>
              <td>{presentation}</td>
              <td className="desc">{contract}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>

      <H2 id="not-enabled">Deliberately not enabled</H2>
      <Lede>
        These are popular dialect features, but they are not part of the current document contract.
        Their syntax stays ordinary text unless a host implements a portable custom extension.
      </Lede>
      <ul>
        {NOT_ENABLED.map((feature) => <li key={feature}>{feature}</li>)}
      </ul>
      <Aside tone="caution" title="Raw HTML is never a web escape hatch">
        HTML is highlighted source on every platform. The web renderer does not inject it into the
        DOM, which keeps the same document safe and visually consistent on iOS and macOS.
      </Aside>
      <Note>
        Parsing conformance and presentation fidelity are separate promises. The core owns the
        former; this matrix documents the latter.
      </Note>
      <SeeAlso links={[
        { to: '/reference/roles', title: 'Roles and CSS classes', note: 'the decoration vocabulary behind this matrix' },
        { to: '/internals/testing', title: 'Testing', note: 'CommonMark fixtures and cross-platform renderer checks' },
      ]} />
    </>
  );
}
