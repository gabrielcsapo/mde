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
        <Link to="/concepts/decorations">decoration protocol</Link> was actually a protocol or just
        an internal shape: a feature invented years later, in a different language, should reach the
        screen through it unchanged.
      </p>

      <H2 id="load-bearing">Three details are load-bearing</H2>
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
        An extension is an object that watches the editor and pushes spans. It never touches the
        DOM, never asks how a line is laid out, and never reaches into the applier — the entire
        surface it uses is the three calls above plus the editor’s events.
      </Lede>
      <SourceFigure className="mt-6" path="web/extensions/typewriter.js" lang="javascript" code={typewriterJs} />
      <Note>
        <code>internRole</code> is called once, in the constructor. Role ids are stable for the life
        of an engine, so an extension holds onto its own rather than looking them up per keystroke.
      </Note>

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

      <H3 id="recompute-cost">Recomputing is cheaper than it looks</H3>
      <p>
        A layer is replaced wholesale, not patched — the host says what the layer is now, and the
        core diffs it against what the layer was. Because edits rebase existing spans, a host that
        coalesces its recompute to a short idle is invisible: the spans stay on their words in the
        meantime. The parts-of-speech extension waits 150 ms; nobody has ever seen it do so.
      </p>

      <Aside tone="note" title="What the layer API is not">
        It is not a plugin runtime. Nothing host-supplied executes inside the parser or on the
        per-keystroke path — the host computes spans on its own time, in its own language, and hands
        over a list. That is why the same API is safe on iOS, where a JIT is forbidden.
      </Aside>

      <SeeAlso
        links={[
          {
            to: '/extend/showcase',
            title: 'Two extensions, no editor changes',
            note: 'the same API, twice, in two languages',
          },
          {
            to: '/reference/web',
            title: 'Web API',
            note: 'setLayer, clearLayer, internRole',
          },
          {
            to: '/reference/swift',
            title: 'Swift API',
            note: 'the same three, on MarkdownTextView',
          },
        ]}
      />
    </>
  );
}
