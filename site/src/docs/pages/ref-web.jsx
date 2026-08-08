import Api from '../../components/Api.jsx';
import { Note, SeeAlso } from '../../components/Doc.jsx';
import { WEB_API } from '../../lib/api.js';

export default function RefWeb() {
  return (
    <>
      <Note className="ref-preamble">
        Plain ES modules with JSDoc types rather than TypeScript: the wasm boundary is a
        hand-written flat struct layout, so a compiler would add a build step without adding safety
        where it matters. Editors still get full type information from the JSDoc. Every offset below
        is a UTF-16 code unit.
      </Note>

      <Api groups={WEB_API} />

      <SeeAlso
        links={[
          {
            to: '/embed/react',
            title: 'React',
            note: 'the adapter over this surface, and what it changes',
          },
          {
            to: '/reference/ffi',
            title: 'C ABI and wasm exports',
            note: 'the layer below — what these methods actually read',
          },
          {
            to: '/reference/roles',
            title: 'Roles and CSS classes',
            note: 'the role ids these report, and the classes they become',
          },
        ]}
      />
    </>
  );
}
