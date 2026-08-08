import { Aside, Footnote, H2, H3, Lede, Note, SeeAlso, TableFrame } from '../../components/Doc.jsx';
import SourceFigure from '../../components/SourceFigure.jsx';
import { Link } from '../../lib/router.jsx';
import { mdeH, mdeStructsH, wasmReadJs } from '../../lib/snippets.js';

const STATUS = [
  ['MDE_OK', '0', 'nothing to do'],
  ['MDE_DESYNC', '1', 'the mirror and the host buffer disagree — recover with a reset'],
  ['MDE_OUT_OF_BOUNDS', '2', 'a range that is not in the document'],
  ['MDE_BAD_ARGUMENT', '3', 'a malformed call'],
];

const WASM_EXPORTS = [
  ['mde_input_reserve(len)', 'returns a pointer the host writes its argument bytes into'],
  ['mde_engine_new()', 'reads the binary manifest out of the input buffer'],
  ['mde_reset · mde_edit · mde_set_selection · mde_clear_selection', 'return a status code'],
  ['mde_patch_ptr() · mde_patch_len()', 'where the flattened patch landed'],
  ['mde_scratch_ptr()', 'short strings returned by value — role names, payloads, revisions'],
  ['mde_rewind_ptr() · mde_rewind_len()', 'the flattened undo/redo result'],
];

export default function RefFfi() {
  return (
    <>
      <H2 id="one-abi">One C ABI, two consumers</H2>
      <Lede>
        Apple ships a static library via a Swift package wrapping an XCFramework. The web ships{' '}
        <code>wasm32-unknown-unknown</code> with a hand-written binding —{' '}
        <code>wasm-bindgen</code> is unnecessary given a flat struct interface, and would add glue
        codegen and a wrapper object allocated per keystroke.
      </Lede>
      <SourceFigure className="mt-6" path="apple/include/mde.h" lang="c" code={mdeH} />
      <Note>
        Returned pointers are engine-owned and invalidated by the next call on that engine. Copy
        what you need before calling again — both bindings do.
      </Note>

      <H2 id="structs">The structs that cross</H2>
      <SourceFigure className="mt-6" path="apple/include/mde.h" lang="c" code={mdeStructsH} />
      <Footnote>
        Swift reads <code>added</code> as an <code>UnsafeBufferPointer&lt;MdeDecoration&gt;</code>;
        wasm reads the same 24 bytes out of linear memory with a <code>DataView</code>. No JSON, and
        no per-keystroke allocation churn in the host. The layout is guarded from both sides —{' '}
        <code>decoration_is_ffi_sized</code> in the Rust tests and{' '}
        <code>layoutMatchesTheRustSide</code> in the Swift ones.
      </Footnote>

      <H2 id="status">Status codes</H2>
      <TableFrame className="mt-6 max-w-[760px]">
        <thead>
          <tr>
            <th>Constant</th>
            <th>Value</th>
            <th className="desc">Meaning</th>
          </tr>
        </thead>
        <tbody>
          {STATUS.map(([name, value, meaning]) => (
            <tr key={name}>
              <td className="role">{name}</td>
              <td>{value}</td>
              <td className="desc">{meaning}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Note>
        <code>MDE_DESYNC</code> is the one that matters. Every edit carries the resulting document
        length and the core asserts agreement; on mismatch it asks for a full resync rather than
        emitting decorations computed from a document that never existed.
      </Note>

      <H2 id="wasm">The wasm side is the same protocol, without pointers</H2>
      <Lede>
        JavaScript cannot pass a struct pointer, so the wasm build inverts the argument passing: the
        host writes its arguments into a reserved input buffer, calls a function that takes only the
        engine handle, and reads the result out of linear memory.
      </Lede>
      <TableFrame className="mt-6">
        <thead>
          <tr>
            <th className="desc">Export</th>
            <th className="desc">Role</th>
          </tr>
        </thead>
        <tbody>
          {WASM_EXPORTS.map(([name, role]) => (
            <tr key={name}>
              <td className="desc">
                <code>{name}</code>
              </td>
              <td className="desc">{role}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>

      <H3 id="reading-a-patch">Reading a patch</H3>
      <SourceFigure className="mt-5" path="web/src/core.js" lang="javascript" code={wasmReadJs} />
      <Aside tone="caution" title="Never cache the memory buffer">
        Growth detaches it. <code>Core.memory</code> is a getter that builds a fresh{' '}
        <code>DataView</code> every time for exactly this reason.
      </Aside>

      <H2 id="history-exports">History</H2>
      <p>
        The browsable timeline crosses the same way:{' '}
        <code>mde_history_position</code>, <code>mde_revisions</code> and{' '}
        <code>mde_jump_to</code>, with the revision list written as a packed array the host reads
        without allocating. <Link to="/concepts/history">History and undo</Link> covers what the
        fields mean.
      </p>

      <SeeAlso
        links={[
          {
            to: '/concepts/decorations',
            title: 'The decoration protocol',
            note: 'what these fields mean',
          },
          { to: '/reference/web', title: 'Web API', note: 'the binding written against this' },
          { to: '/reference/swift', title: 'Swift API', note: 'the other one' },
        ]}
      />
    </>
  );
}
