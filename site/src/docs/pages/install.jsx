import { Aside, Defs, H2, H3, Lede, Note, SeeAlso, Step, Steps } from '../../components/Doc.jsx';
import SourceFigure from '../../components/SourceFigure.jsx';
import { Link } from '../../lib/router.jsx';
import {
  buildBash,
  installReact,
  installWeb,
  mountHtml,
  mountJs,
  mountSwift,
  packageSwift,
  reactBasicJsx,
} from '../../lib/snippets.js';

export default function Install() {
  return (
    <>
      <H2 id="choose">Choose your integration</H2>
      <Lede>
        Start with one renderer and a host element. <code>@mdink/web</code> is the direct browser
        integration, <code>@mdink/react</code> owns the same editor lifecycle for React, and
        <code>MDEditorUI</code> gives UIKit and AppKit the same Swift surface.
      </Lede>
      <Defs
        items={[
          ['Web', '@mdink/web — framework-free ESM, theme CSS, and the WebAssembly core'],
          [
            'React',
            '@mdink/react — a thin lifecycle adapter over @mdink/web; React stays a peer dependency',
          ],
          [
            'iOS and macOS',
            'MDEditorUI — MarkdownTextView backed by UITextView or NSTextView',
          ],
        ]}
      />

      <H2 id="web">Web in five minutes</H2>
      <SourceFigure className="mt-6" path="terminal" lang="bash" code={installWeb} />
      <Steps>
        <Step title="Install the renderer">
          Add <code>@mdink/web</code> with your package manager. Its Wasm core, declarations, and
          theme ship in the same package.
        </Step>
        <Step title="Give it an empty element">
          The editor owns that element’s children and turns it into the native{' '}
          <code>contenteditable</code> surface.
        </Step>
        <Step title="Load the core and set Markdown">
          Import the Wasm file as an asset URL, create one engine for the document, and pass it to
          <code>MarkdownEditor</code>.
        </Step>
      </Steps>
      <SourceFigure className="mt-8" path="index.html" lang="html" code={mountHtml} />
      <SourceFigure className="mt-5" path="boot.js" lang="javascript" code={mountJs} />
      <Note>
        This is a complete starter: it does not assume a manifest, widget provider, resource
        resolver, or save function. Add those only when your document introduces custom syntax or
        external resources.
      </Note>

      <H3 id="web-shipping">What reaches production</H3>
      <p>
        Your bundler emits the tree-shaken ESM, <code>theme.css</code>, and{' '}
        <code>mde.wasm</code>. Passing the imported Wasm URL to <code>loadCore</code> keeps the
        JavaScript and core independently cacheable. Call <code>editor.destroy()</code> when the
        host element is removed so its document-level selection listener is released.
      </p>

      <H2 id="react">React in five minutes</H2>
      <SourceFigure className="mt-6" path="terminal" lang="bash" code={installReact} />
      <p>
        Import the same theme and Wasm asset, then render the adapter. The component is
        intentionally uncontrolled: <code>defaultValue</code> opens the document and{' '}
        <code>onChange</code> reports edits without replacing the live DOM buffer on every
        keystroke.
      </p>
      <SourceFigure className="mt-6" path="Editor.jsx" lang="javascript" code={reactBasicJsx} />
      <Note>
        The adapter cleans up correctly under React StrictMode and preserves its editor instance
        across ordinary component renders. The <Link to="/docs/embed/react">React guide</Link>{' '}
        covers refs, commands, external value synchronization, and history.
      </Note>

      <H2 id="apple">Swift in five minutes</H2>
      <Lede>
        Add this repository as a Swift package and select <code>MDEditorUI</code>. During local
        development, add the <code>apple/</code> directory as a local package dependency; tagged
        releases use the repository URL.
      </Lede>
      <Steps>
        <Step title="Add the package">
          In Xcode choose <strong>File → Add Package Dependencies…</strong>. For a checkout, choose{' '}
          <strong>Add Local…</strong> and select <code>apple/</code>.
        </Step>
        <Step title="Choose MDEditorUI">
          Add the <code>MDEditorUI</code> product to your iOS or macOS target. Import{' '}
          <code>MDECore</code> separately only when you need the lower-level engine values.
        </Step>
        <Step title="Create the native text view">
          The same <code>MarkdownTextView</code> name resolves to a <code>UITextView</code> on iOS
          and an <code>NSTextView</code> on macOS.
        </Step>
      </Steps>
      <SourceFigure className="mt-8" path="Package.swift" lang="swift" code={packageSwift} />
      <SourceFigure className="mt-5" path="EditorViewController.swift" lang="swift" code={mountSwift} />
      <Defs
        items={[
          ['Platform floor', 'iOS 17+ and macOS 14+'],
          ['MDECore', 'the engine and stable value types'],
          ['MDEditorUI', 'MarkdownTextView, Theme, widgets, sessions, and commands'],
          ['MDEHost', 'optional reference implementations for extensions and resources'],
        ]}
      />
      <Aside tone="note" title="Remote Swift releases need one repository setting">
        <p>
          SwiftPM requires an immutable HTTPS release-asset URL and checksum for the Rust
          XCFramework. The source package works locally now; the public URL becomes usable after
          this checkout is connected to its final GitHub repository and the first tagged
          XCFramework is attached. The release checklist records the exact handoff.
        </p>
      </Aside>

      <H2 id="build-the-core">Build everything from source</H2>
      <p>
        Contributors can build both renderers from the shared Rust workspace. The web script
        compiles Wasm and all npm packages; the Apple script cross-compiles macOS, iOS device, and
        iOS simulator slices into one XCFramework.
      </p>
      <SourceFigure className="mt-6" path="from the repository root" lang="bash" code={buildBash} />

      <H2 id="persisting-sizes">Persist resource sizes</H2>
      <p>
        Both platforms expose <code>resourceSizes</code>: dimensions of references that already
        resolved, keyed by the reference itself. Save them with the document and restore them when
        it opens. The editor can then reserve the correct geometry before an image or other
        resource finishes loading.
      </p>

      <SeeAlso
        links={[
          {
            to: '/docs/extend/manifest',
            title: 'The extension manifest',
            note: 'declare custom block and inline syntax only when you need it',
          },
          {
            to: '/docs/reference/web',
            title: 'Web API',
            note: 'the complete browser surface after the five-minute starter',
          },
          {
            to: '/docs/reference/swift',
            title: 'Swift API',
            note: 'MarkdownEngine, MarkdownTextView, and the host protocols',
          },
        ]}
      />
    </>
  );
}
