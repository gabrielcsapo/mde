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

// Per keystroke, on an M2. Straight from DESIGN.md — nothing here is estimated on the
// project's behalf, and the two `~` figures are marked approximate there too.
const KEYSTROKE = [
  ['10 KB', '1.3 ms', '0.21 ms', '6.2×'],
  ['100 KB', '18.0 ms', '1.99 ms', '9.0×'],
  ['500 KB', '~52 ms', '10.3 ms', '~5.0×'],
  ['1 MB', '137 ms', '22.9 ms', '6.0×'],
  ['5 MB', '~3 460 ms', '132 ms', '~26×'],
];

// The profile at 100 KB. Bar widths are each stage's share of the largest stage, so the
// column reads as a comparison between rows rather than as a second copy of the share.
const PROFILE = [
  ['parse', '0.14', '1%', 2.4],
  ['decoration build', '5.8', '41%', 100],
  ['FFI + patch marshalling', '2.6', '18%', 43.9],
  ['emit (reveal + UTF-16)', '1.3', '9%', 22],
  ['diff', '0.35', '2%', 4.9],
  ['attribute application in the renderer', '0.03', '0.2%', 0.5],
];

const PLUGIN_SCALE = [
  ['0', '0.10 ms'], ['1', '0.10 ms'], ['10', '0.10 ms'], ['50', '0.10 ms'],
];

export default function Performance() {
  return (
    <>
      <H2 id="measured">Performance budgets and measurement</H2>
      <Lede>
        The original argument was that parsing is nearly free and the real cost is renderer
        mutation. Measurement said the first half is right and the second half is backwards by two
        orders of magnitude — it had silently equated <em>parsing</em> with reparse + decorate + key
        + diff + emit + marshal, which is 63× larger.
      </Lede>

      <TableFrame className="mt-8 max-w-[860px]">
        <thead>
          <tr>
            <th>Stage, at 100 KB</th>
            <th>ms</th>
            <th>Share</th>
            <th className="bar-cell" />
          </tr>
        </thead>
        <tbody>
          {PROFILE.map(([stage, ms, share, width]) => (
            <tr key={stage}>
              <td>{stage}</td>
              <td>{ms}</td>
              <td>{share}</td>
              <td className="bar-cell">
                <i className="bar" style={{ width: `${width}%` }} />
              </td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Note>
        Renderer mutation is the cheapest thing in the loop. That is not an accident — it is the{' '}
        <Link to="/docs/concepts/decorations">moved-does-not-repaint rule</Link> and disjoint dirty ranges
        doing their job.
      </Note>

      <H2 id="results">M2 edit-latency results</H2>
      <TableFrame className="mt-6 max-w-[860px]">
        <thead>
          <tr>
            <th>Document</th>
            <th>Before</th>
            <th>Now</th>
            <th>Speedup</th>
          </tr>
        </thead>
        <tbody>
          {KEYSTROKE.map(([doc, before, now, gain]) => (
            <tr key={doc}>
              <td>{doc}</td>
              <td className="before">{before}</td>
              <td className="now">{now}</td>
              <td className="gain">{gain}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Note>500 KB now fits inside a 60 fps frame at the core level, against ~120 KB before.</Note>

      <H2 id="plugin-scale">Cost of optional features</H2>
      <Lede>
        Every performance run installs 0, 1, 10, and 50 capability-only plugins and measures
        steady-state edits. The 50-plugin web p95 is currently 0.10 ms with a 20 ms gate; AppKit
        runs the same matrix with a 25 ms gate. Install and teardown are budgeted separately.
      </Lede>
      <TableFrame className="mt-6 max-w-[520px]">
        <thead><tr><th>Installed plugins</th><th>Edit p95, web</th></tr></thead>
        <tbody>{PLUGIN_SCALE.map(([count, value]) => (
          <tr key={count}><td>{count}</td><td className="now">{value}</td></tr>
        ))}</tbody>
      </TableFrame>

      <H2 id="three-changes">Implemented optimizations</H2>
      <Clauses>
        <Clause title="Reparse only the region an edit could change">
          A scan finds offsets where a top-level block provably begins — after a blank line, at
          column zero, outside any fence or directive — and only the span between the enclosing
          boundaries is rebuilt and spliced in place. Anything the scan cannot vouch for falls back
          to a full reparse; that fallback is what makes the optimization safe to have.
        </Clause>
        <Clause title="A prefilter before every inline rule">
          <code>regex-lite</code> has no literal prescan, so <code>@[a-zA-Z0-9_-]+</code> walked
          every byte of every text run looking for an <code>@</code> that was not there — 3.5 ms on
          100 KB of prose with zero matches, 26× the parse itself. One memchr-shaped check first.
        </Clause>
        <Clause title="A hash built for 64-bit keys">
          Decoration keys are already well-mixed hashes, so running them through SipHash again was
          pure overhead. A multiply-xorshift costing a few instructions cut diffing by ~36% at 1 MB.
        </Clause>
        <Clause title="Keys reassigned in document order">
          Which is what makes an incremental result <em>byte-identical</em> to a full reparse rather
          than merely similar. A test checks exactly that, over every insert and delete position in
          a hostile document, every structural character, and 2000 random edits.
        </Clause>
      </Clauses>

      <H2 id="dirty-ranges">Pathological 1,844 ms edit</H2>
      <p>
        Dirty ranges are a set, not a bounding box. Editing a node changes how many byte-identical
        siblings precede its twin elsewhere in the document, which changes that twin’s key and puts
        a removal half a document away from the caret. Unioning the two covered everything between:
        one keystroke measured at <strong>1844 ms instead of 0.33 ms</strong>, and it could fire at
        any document size. Both renderers now repaint disjoint ranges, with a test pinned to it.
      </p>

      <Aside tone="note" title="Discarded viewport-window optimization">
        An earlier version limited decoration to a window around the viewport above 256 KB.
        Measurement killed it. Because it could not compose with the incremental splice, turning it
        on <em>disabled</em> the optimization actually doing the work — 13.2 ms against 17.3 ms at
        500 KB, 28.2 against 42.0 at 1 MB, 141 against 151 at 5 MB, every one of them worse. It
        could not help the case it was designed for either: the viewport necessarily arrives{' '}
        <em>after</em> the document does, so the cold open it was meant to bound had already
        happened. It is recorded because “obvious safety valve, measured, found to be a
        pessimisation” is worth more than the code was.
      </Aside>

      <SeeAlso
        links={[
          {
            to: '/docs/internals/architecture',
            title: 'Architecture',
            note: 'why a full reparse was the starting point',
          },
          {
            to: '/docs/extend/manifest',
            title: 'The extension manifest',
            note: 'where the prefilter comes from, and when it is refused',
          },
          {
            to: '/docs/internals/status',
            title: 'Status and open questions',
            note: 'the document shape that still degrades',
          },
        ]}
      />
    </>
  );
}
