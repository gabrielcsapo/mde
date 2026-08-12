import { Aside, Defs, H2, H3, Lede, Note, SeeAlso, Step, Steps } from '../../components/Doc.jsx';
import SourceFigure from '../../components/SourceFigure.jsx';
import { Link } from '../../lib/router.jsx';
import {
  buildBash,
  mountHtml,
  mountJs,
  mountSwift,
  packageSwift,
} from '../../lib/snippets.js';

export default function Install() {
  return (
    <>
      <H2 id="get-the-code">Get the code</H2>
      <Lede>
        The packages are currently consumed from the repository rather than a registry. The web
        renderer builds as <code>@mde/web</code>, React stays in the optional{' '}
        <code>@mde/react</code> adapter, and the Apple side remains a local Swift package. One
        checkout serves all three.
      </Lede>
      <Defs
        items={[
          [
            'For the web',
            '@mde/web: about 46 KB of ESM, a separate ~360 KB wasm asset, CSS, declarations, and optional extension entry points',
          ],
          [
            'For iOS and macOS',
            'apple/ as a SwiftPM dependency, plus the XCFramework that build-rust.sh drops inside it',
          ],
          [
            'To build the core yourself',
            'a Rust toolchain with the wasm32-unknown-unknown target (web) and the three Apple targets; rustup target add handles both',
          ],
          [
            'For React',
            '@mde/react: a separate adapter build with React, React DOM, and @mde/web left external',
          ],
        ]}
      />

      <H2 id="build-the-core">Build the core</H2>
      <Lede>
        Both distributions come out of the same Rust workspace: a{' '}
        <code>wasm32-unknown-unknown</code> module for the web, and a static library packaged as an
        XCFramework for Apple. Each has one script.
      </Lede>
      <SourceFigure path="from the repository root" lang="bash" code={buildBash} />
      <Note>
        <code>build-rust.sh</code> cross-compiles three slices — <code>aarch64-apple-darwin</code>,{' '}
        <code>aarch64-apple-ios</code> and <code>aarch64-apple-ios-sim</code> — and packages them
        with <code>xcodebuild -create-xcframework</code>, so SwiftPM links the right one
        automatically.
      </Note>

      <H2 id="web">Embed it on the web</H2>
      <Lede>
        <code>web/</code> is TypeScript built as a framework-free ESM library. Vite keeps the Rust
        module as a separate asset, so JavaScript can be parsed and cached independently; React is
        not present unless you install the adapter.
      </Lede>

      <Steps>
        <Step title="Build @mde/web and install it in your app">
          <code>./scripts/build-web.sh</code> compiles Rust, the framework-free TypeScript package,
          and the React adapter. In this repository the docs link both from the pnpm workspace.
        </Step>
        <Step title="Give the editor an element and the theme stylesheet">
          The editor takes over the element completely: it sets <code>contenteditable</code>, owns
          the children, and expects nothing inside it.
        </Step>
        <Step title="Load the core, make an engine, mount the editor">
          One engine per document. The editor does not own it — you may hand the same engine to
          another view.
        </Step>
      </Steps>

      <SourceFigure className="mt-8" path="index.html" lang="html" code={mountHtml} />
      <SourceFigure className="mt-5" path="boot.js" lang="javascript" code={mountJs} />

      <Note>
        <code>widgetProvider</code> and <code>resourceResolver</code> are both optional. Without
        them a document still renders completely — extension ranges simply stay styled text and
        images stay their markdown source. See{' '}
        <Link to="/concepts/widgets">Widgets and references</Link> for what each one is for.
      </Note>

      <H3 id="web-shipping">What you ship</H3>
      <p>
        Three things reach production: the tree-shaken ESM, <code>theme.css</code>, and{' '}
        <code>mde.wasm</code>. Import the wasm as an asset URL and pass it to{' '}
        <code>loadCore</code>; Vite emits it with a content hash. The editor makes no network
        requests of its own beyond loading that core: resolving an image reference is your{' '}
        <code>resourceResolver</code>’s decision, not the library’s.
      </p>

      <H3 id="web-unmounting">Unmounting</H3>
      <p>
        Call <code>editor.destroy()</code>. Listeners on the host element die with the element, but
        the editor also listens for <code>selectionchange</code> on <code>document</code>, which
        outlives it — an editor that is never destroyed stays subscribed forever, reacting to a
        document it no longer renders. This is not hypothetical in React: under{' '}
        <code>StrictMode</code> a component mounts twice on purpose.
      </p>

      <H2 id="apple">Embed it on iOS and macOS</H2>
      <Lede>
        Add <code>apple/</code> as a Swift package. It builds three products; a host app usually
        wants the first two and can read the third as an example.
      </Lede>
      <SourceFigure path="Package.swift" lang="swift" code={packageSwift} />
      <SourceFigure className="mt-5" path="EditorViewController.swift" lang="swift" code={mountSwift} />

      <Defs
        items={[
          ['iOS 17+, macOS 14+', 'the platform floor the package declares — incremental TextKit throughout'],
          [
            'MarkdownTextView',
            'a UITextView on iOS and an NSTextView on macOS, with the same name and the same public surface',
          ],
          [
            'Theme',
            'maps roles to attributes; heading sizes derive from bodyFont, so Dynamic Type still applies',
          ],
          [
            'markdownDelegate',
            'observe taps, changes and selection without taking the UITextViewDelegate slot the view needs for itself',
          ],
        ]}
      />

      <Aside tone="caution" title="Two things a host has to get right">
        <p>
          <code>widgetProvider</code> and <code>resourceResolver</code> are held{' '}
          <strong>strongly</strong>. They are services the editor owns, not delegates — hosts
          naturally write <code>editor.resourceResolver = DiskResourceResolver(root: …)</code>, and
          a weak reference would deallocate before the first paint and render everything as “no
          resolver”. Neither may retain the editor.
        </p>
        <p>
          A manifest that fails to parse falls back to no extensions rather than trapping. Check it
          with <code>MarkdownEngine(manifest:)</code> at startup if you would rather fail loudly.
        </p>
      </Aside>

      <H2 id="persisting-sizes">Persist resource sizes</H2>
      <p>
        Both platforms expose <code>resourceSizes</code>: the dimensions of every reference that has
        already resolved, keyed by the reference itself. Save them on the way out and set them back
        on the way in. Without it, <code>reservedSize</code> is a guess and the document shifts once
        per launch when an asset lands; with it, that shift happens at most once per asset, ever.
      </p>

      <SeeAlso
        links={[
          {
            to: '/extend/manifest',
            title: 'The extension manifest',
            note: 'the block and inline types your host declares',
          },
          {
            to: '/reference/web',
            title: 'Web API',
            note: 'every entry point in core.ts and editor.ts',
          },
          {
            to: '/reference/swift',
            title: 'Swift API',
            note: 'MarkdownEngine, MarkdownTextView and the two host protocols',
          },
        ]}
      />
    </>
  );
}
