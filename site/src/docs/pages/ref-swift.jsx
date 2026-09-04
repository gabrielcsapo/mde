import Api from '../../components/Api.jsx';
import { Note, SeeAlso } from '../../components/Doc.jsx';
import { SWIFT_API } from '../../lib/api.js';

export default function RefSwift() {
  return (
    <>
      <Note className="ref-preamble">
        Three products: <code>MDECore</code> (the engine and its value types),{' '}
        <code>MDEditorUI</code> (the text views, the applier, the theme) and <code>MDEHost</code>{' '}
        (the reference host — manifest, widgets, resolver, and both showcase extensions). iOS 17 and
        macOS 14 are the floor. Every range is an <code>NSRange</code> in UTF-16 code units.
      </Note>

      <Api groups={SWIFT_API} />

      <SeeAlso
        links={[
          {
            to: '/docs/platforms/apple',
            title: 'iOS and macOS',
            note: 'what these types do to TextKit',
          },
          {
            to: '/docs/reference/ffi',
            title: 'C ABI and wasm exports',
            note: 'the header this wraps',
          },
          {
            to: '/docs/install',
            title: 'Install and embed',
            note: 'adding the package and building the XCFramework',
          },
        ]}
      />
    </>
  );
}
