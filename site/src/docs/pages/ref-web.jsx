import Api from '../../components/Api.jsx';
import { Note, SeeAlso } from '../../components/Doc.jsx';
import { WEB_API } from '../../lib/api.js';

export default function RefWeb() {
  return (
    <>
      <Note className="ref-preamble">
        TypeScript compiled to plain ES modules. The wasm boundary remains a hand-written flat
        struct layout, while plugin, manifest, editor, resource and widget contracts ship as
        declarations from the same source. Every offset below is a UTF-16 code unit.
      </Note>

      <Api groups={WEB_API} />

      <SeeAlso
        links={[
          {
            to: '/docs/embed/react',
            title: 'React',
            note: 'the adapter over this surface, and what it changes',
          },
          {
            to: '/docs/reference/ffi',
            title: 'C ABI and wasm exports',
            note: 'the layer below — what these methods actually read',
          },
          {
            to: '/docs/reference/roles',
            title: 'Roles and CSS classes',
            note: 'the role ids these report, and the classes they become',
          },
        ]}
      />
    </>
  );
}
