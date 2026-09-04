import {
  Aside,
  Footnote,
  H2,
  H3,
  Lede,
  Note,
  SeeAlso,
  TableFrame,
} from '../../components/Doc.jsx';
import SourceFigure from '../../components/SourceFigure.jsx';
import { Link } from '../../lib/router.jsx';
import { posSwift, posWebJs, toolbarJs, typewriterJs } from '../../lib/snippets.js';

const COST = [
  ['the core', 'nothing', 'nothing'],
  ['the decoration applier', 'nothing', 'nothing'],
  ['the three renderers', 'nothing', 'nothing'],
  ['the editor’s theme', 'nothing — each extension supplies its own role styling', 'nothing'],
  [
    'the host',
    'one file in web/extensions/ and one in apple/Sources/MDEHost/',
    'the same, plus an NLTagger',
  ],
];

const WHERE = [
  ['Typewriter (focus)', 'web/extensions/typewriter.ts', 'apple/Sources/MDEHost/TypewriterMode.swift'],
  [
    'Parts of speech',
    'web/extensions/parts-of-speech.ts',
    'apple/Sources/MDEHost/PartsOfSpeech.swift',
  ],
];

export default function Showcase() {
  return (
    <>
      <H2 id="the-claim">Layer API examples</H2>
      <Lede>
        Typewriter mode dims text outside the active paragraph. Parts-of-speech highlighting tints
        nouns, verbs, adjectives, and adverbs. Both are optional extensions built with the public
        layer API.
      </Lede>
      <p>
        Both are available in <Link to="/docs/try">the browser demo</Link> and implemented in JavaScript
        and Swift with the same document, selection, and layer operations.
      </p>
      <p>
        Typewriter mode depends on the current selection, while parts-of-speech highlighting depends
        on language analysis. Neither state belongs in the Markdown document.
      </p>

      <H2 id="what-they-cost">Integration surface</H2>
      <TableFrame className="mt-6">
        <thead>
          <tr>
            <th className="desc">Changed in</th>
            <th className="desc">Typewriter</th>
            <th className="desc">Parts of speech</th>
          </tr>
        </thead>
        <tbody>
          {COST.map(([where, a, b]) => (
            <tr key={where}>
              <td className="desc">{where}</td>
              <td className="desc">{a}</td>
              <td className="desc">{b}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Note>
        Each extension also registers a descriptor in <code>site/src/lib/toolbar.js</code>. The
        toolbar renders registered capabilities without extension-specific component code.
      </Note>
      <SourceFigure className="mt-6" path="site/src/lib/toolbar.js" lang="javascript" code={toolbarJs} />

      <H2 id="typewriter">Typewriter mode</H2>
      <Lede>
        Watch the caret, find the paragraph around it, push two roles: one for that paragraph, one
        for everything else. The theme decides what focus and dim look like.
      </Lede>
      <SourceFigure className="mt-6" path="web/extensions/typewriter.ts" lang="typescript" code={typewriterJs} />
      <p className="mt-6">
        Blank lines define paragraph boundaries, matching the core’s block segmentation and avoiding
        changes when the caret crosses a soft wrap. When the editor has no selection, the extension
        clears its layer instead of dimming the entire document.
      </p>
      <Aside tone="note" title="The Apple version knows about headings">
        Its focus role carries a slightly larger font, and attributes apply in paint order — so a
        focus span laid flat over a heading would <em>shrink</em> the heading to body size, which
        reads as a bug rather than as focus. It skips the heading’s own range instead, which it can
        do because the editor already publishes what it decorated through{' '}
        <code>decorations</code>, and roles are just names.
      </Aside>

      <H2 id="parts-of-speech">Parts of speech</H2>
      <Lede>
        The more demanding of the two, because its decorations depend on language. It reads the
        document, decides what each word is, and pushes one span per tagged word — thousands of
        them, through the same diff that handles four emphasis markers.
      </Lede>

      <H3 id="apple-tagger">On Apple: the system tagger</H3>
      <p>
        <code>NLTagger</code> with the <code>.lexicalClass</code> scheme, enumerated by word. The
        ranges come back as <code>String.Index</code> pairs and convert to <code>NSRange</code>,
        which is UTF-16 — the units every boundary in this API speaks.
      </p>
      <SourceFigure className="mt-5" path="apple/Sources/MDEHost/PartsOfSpeech.swift" lang="swift" code={posSwift} />

      <H3 id="web-tagger">On the web: heuristic tagging</H3>
      <p>
        The browser has no <code>NLTagger</code>, and the alternative to a heuristic is shipping a
        real tagger — a model, a dictionary, megabytes — into a documentation page to demonstrate
        plumbing. So the web build uses a closed-class word list plus suffix rules.{' '}
        <strong>It is meaningfully worse than the Apple one</strong>, and it will be wrong on
        genuinely ambiguous words: it tags <em>book</em> in “book a flight” as a noun.
      </p>
      <SourceFigure className="mt-5" path="web/extensions/parts-of-speech.ts" lang="typescript" code={posWebJs} />
      <Footnote>
        This example demonstrates asynchronous language analysis through decoration layers. It is
        not intended as a production-quality linguistic model.
      </Footnote>

      <H2 id="where-they-live">Where they live</H2>
      <TableFrame className="mt-6">
        <thead>
          <tr>
            <th className="desc">Feature</th>
            <th className="desc">Web</th>
            <th className="desc">Apple</th>
          </tr>
        </thead>
        <tbody>
          {WHERE.map(([feature, web, apple]) => (
            <tr key={feature}>
              <td className="desc">{feature}</td>
              <td className="desc">
                <code>{web}</code>
              </td>
              <td className="desc">
                <code>{apple}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <Note>
        Note the directories: <code>web/extensions/</code>, not <code>web/src/</code>; and{' '}
        <code>MDEHost</code>, not <code>MDEditorUI</code>. Nothing in the editor imports either
        file, and the dependency arrow only points one way.
      </Note>

      <SeeAlso
        links={[
          { to: '/docs/try', title: 'Try it', note: 'use both extensions in the browser editor' },
          {
            to: '/docs/extend/layers',
            title: 'Host decoration layers',
            note: 'the API underneath, in full',
          },
          {
            to: '/docs/reference/roles',
            title: 'Roles and CSS classes',
            note: 'how a role invented at runtime gets styled',
          },
        ]}
      />
    </>
  );
}
