import { Aside, Clause, Clauses, H2, H3, Lede, Note, SeeAlso } from '../../components/Doc.jsx';
import SourceFigure from '../../components/SourceFigure.jsx';
import { Link } from '../../lib/router.jsx';
import { extensionCss, layerApi, themeRolesSwift, typewriterJs } from '../../lib/snippets.js';

export default function Layers() {
  return (
    <>
      <H2 id="why">What a manifest cannot describe</H2>
      <Lede>
        The manifest is declarative, and that is its limit: it can only describe things that are{' '}
        <em>findable in the text</em> — a fence with this info string, a pattern that looks like
        this. Some features are not like that.
      </Lede>
      <p>
        Where the caret is. What a language tagger calls a word. Who commented on a range. None of
        it is in the markdown, and no parser will ever find it. A <strong>layer</strong> is
        decoration the host computes and hands over.
      </p>
      <SourceFigure className="mt-6" path="the layer API, on every platform" lang="text" code={layerApi} />
      <p className="mt-6">
        The spans then flow through machinery that already exists — identity, diffing,{' '}
        <code>moved</code>, painting, theming — so <strong>no renderer needed new code to draw
        them</strong>. That is the test of whether the{' '}
        <Link to="/docs/concepts/decorations">decoration protocol</Link> was actually a protocol or just
        an internal shape: a feature invented years later, in a different language, should reach the
        screen through it unchanged.
      </p>

      <H2 id="load-bearing">Layer ordering, identity, and rebasing</H2>
      <Clauses>
        <Clause title="Layers paint after the parse">
          <code>Decoration.layer</code> is <code>0</code> for anything derived from the markdown and
          higher for host layers, and the renderers break paint-order ties on it. Without that
          ordering a focus-mode dim cannot dim a heading, because two <code>Style</code> decorations
          of the same kind have no defined order. It occupies a byte that used to be explicit
          padding, so the ABI did not change.
        </Clause>
        <Clause title="Layer keys include position">
          Parsed keys deliberately exclude it. A widget that survives an edit must not be rebuilt;
          a styling span that slides must repaint both the range it left and the one it arrived at,
          and renderers are free to ignore <code>moved</code>. Keying on position turns a move into
          a remove plus an add — which is exactly the repaint required.
        </Clause>
        <Clause title="Edits rebase layers rather than dropping them">
          A span wholly after an edit shifts, one before it is untouched, and one the edit landed{' '}
          <em>inside</em> is dropped — nothing in the core can know what the host would now say
          about that text. Without this, highlighting visibly slides out of alignment with the words
          underneath it on every keystroke while the host catches up.
        </Clause>
        <Clause title="An empty layer is not no layer">
          <code>setLayer(name, [])</code> keeps the layer’s slot in the paint order;{' '}
          <code>clearLayer(name)</code> gives it up. Both are useful: a focus mode empties its layer
          when the editor loses focus, and gives it up when it is switched off.
        </Clause>
      </Clauses>

      <H2 id="writing-one">Writing one</H2>
      <Lede>
        A plugin gets a scoped context that watches the editor and pushes spans. It never touches
        the DOM, asks how a line is laid out, or reaches into the applier. Listeners and layers
        registered through that context are cleaned up as one unit.
      </Lede>
      <SourceFigure className="mt-6" path="search-plugin.ts" lang="typescript" code={typewriterJs} />
      <Note>
        Plugin names are unique per editor. Their local layer names are automatically qualified,
        so two packages can both call a layer <code>results</code> without overwriting each other.
        Duplicate names and partially failed installations are rejected and rolled back.
      </Note>

      <H3 id="background-analysis">Background analysis without stale results</H3>
      <p>
        Use <code>context.scheduleAnalysis</code> for linters, language tagging, comments, or
        anything else that scans the document. Tasks with the same local name coalesce. The web
        callback receives an <code>AbortSignal</code> suitable for a Worker request; Swift receives
        a cooperative cancellation token and runs analysis on a shared concurrent queue. Both
        capture an immutable source snapshot and refuse late results after a newer edit or plugin
        removal.
      </p>

      <H3 id="canvas-presentations">Plugins can own canvas UI and commands</H3>
      <p>
        A plugin is not limited to colored ranges. <code>showPresentation</code> mounts a
        lifecycle-owned view at the selection, editor edge, or viewport center;{' '}
        <code>registerCommand</code> adds a discoverable editor command with an optional shortcut;
        and web plugins can use <code>onRoot</code> for direct input events. The view is a sibling presentation—not part of
        the document DOM or TextKit storage—so its labels never leak into markdown, selection
        offsets, copy/paste, or undo.
      </p>
      <p>
        The shipped extensions are executable examples: mentions, tags, wiki links, slash commands,
        formatting, templates, find/replace, image descriptions, and a full journal media importer.
        The same plugin objects run through <code>@mdink/web</code> and <code>@mdink/react</code>; Swift
        supplies the equivalent shared host implementations for UIKit and AppKit. Removing a plugin removes its listeners, commands, background work,
        layers, and every floating view as one operation.
      </p>
      <p>
        Published compatibility helpers—<code>@mdink/web/plugin-testing</code> and{' '}
        <code>MarkdownPluginCompatibility.check</code>—exercise installation, source preservation,
        layer ownership, and teardown with no dependency on Vitest or XCTest.
      </p>

      <H3 id="swift-lifecycle">The same lifecycle in Swift</H3>
      <p>
        Implement <code>MarkdownPlugin</code>, receive a <code>MarkdownPluginContext</code>, then call{' '}
        <code>installPlugin</code> on either the UIKit or AppKit <code>MarkdownTextView</code>. The
        editor forwards document and selection changes directly; the app delegate no longer has to
        remember which callbacks every plugin needs. The context namespaces and removes layers in
        exactly the same way as the web API. A plugin can also publish a TOML manifest;{' '}
        <code>MarkdownTextView(plugins:)</code> composes that syntax before it installs the runtime
        objects.
      </p>

      <H3 id="bring-your-own-styling">An extension brings its own appearance</H3>
      <p>
        The editor’s theme knows what the <em>parser</em> produces and nothing else, so a feature
        invented at runtime has to supply the styling for the roles it invents. That is two lines of
        CSS on the web and a dictionary of attributes on Apple.
      </p>
      <SourceFigure className="mt-5" path="web/extensions/extensions.css" lang="css" code={extensionCss} />
      <SourceFigure
        className="mt-5"
        path="apple/Sources/MDEHost/TypewriterMode.swift"
        lang="swift"
        code={themeRolesSwift}
      />

      <H3 id="recompute-cost">Recomputing layer decorations</H3>
      <p>
        A layer is replaced wholesale, not patched — the host says what the layer is now, and the
        core diffs it against what the layer was. Because edits rebase existing spans, a host that
        coalesces its recompute to a short idle is invisible: the spans stay on their words in the
        meantime. The parts-of-speech extension uses the shared scheduler and waits 150 ms; nobody
        has ever seen it do so.
      </p>
      <p>
        Layer replacement also has its own fast path. Moving one span no longer re-emits the parsed
        document: at 1 MB the core fell from 13.89 ms to 0.0014 ms, and at 5 MB from 99.62 ms to
        0.0050 ms. The real 1 MB updates, including repaint, are 2.5 ms in Chromium and 3.1 ms in
        AppKit.
      </p>

      <Aside tone="note" title="What the layer API is not">
        The lifecycle is host-side, not executable code inside the parser. A plugin computes spans
        on its own time, in the platform’s own language, and hands over data. That keeps parser
        behaviour identical and remains safe on iOS, where a JIT is forbidden.
      </Aside>

      <SeeAlso
        links={[
          {
            to: '/docs/extend/plugins',
            title: 'Interactive plugins',
            note: 'commands, suggestions, popovers, and framework helpers',
          },
          {
            to: '/docs/extend/showcase',
            title: 'Two extensions, no editor changes',
            note: 'the same API, twice, in two languages',
          },
          {
            to: '/docs/reference/web',
            title: 'Web API',
            note: 'setLayer, clearLayer, internRole',
          },
          {
            to: '/docs/reference/swift',
            title: 'Swift API',
            note: 'the same three, on MarkdownTextView',
          },
        ]}
      />
    </>
  );
}
