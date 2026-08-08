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
  ['Typewriter (focus)', 'web/extensions/typewriter.js', 'apple/Sources/MDEHost/TypewriterMode.swift'],
  [
    'Parts of speech',
    'web/extensions/parts-of-speech.js',
    'apple/Sources/MDEHost/PartsOfSpeech.swift',
  ],
];

export default function Showcase() {
  return (
    <>
      <H2 id="the-claim">The claim, and how to check it</H2>
      <Lede>
        Two features ship against the layer API and are deliberately <em>not</em> part of the
        editor: typewriter mode, which dims everything but the paragraph under the caret, and
        parts-of-speech highlighting, which tints nouns, verbs, adjectives and adverbs.
      </Lede>
      <p>
        Neither required a change to the core, the applier, or any of the three renderers. Both are
        toggles in the toolbar of <Link to="/try">the editor on this site</Link>, and both exist
        twice — once in JavaScript, once in Swift — against the same three calls.
      </p>
      <p>
        They were chosen because they are the two things a markdown parser can never do. One depends
        on where the caret is, which is not in the document. The other depends on{' '}
        <em>language</em>, which is not in the document either and never will be.
      </p>

      <H2 id="what-they-cost">What adding them cost</H2>
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
        And on this site, one object each in <code>site/src/lib/toolbar.js</code>. The toolbar is a
        list of descriptors rather than markup, so a capability that arrives as an extension arrives
        as a button — the page does not have to learn anything new about it.
      </Note>
      <SourceFigure className="mt-6" path="site/src/lib/toolbar.js" lang="javascript" code={toolbarJs} />

      <H2 id="typewriter">Typewriter mode</H2>
      <Lede>
        Watch the caret, find the paragraph around it, push two roles: one for that paragraph, one
        for everything else. The theme decides what focus and dim look like.
      </Lede>
      <SourceFigure className="mt-6" path="web/extensions/typewriter.js" lang="javascript" code={typewriterJs} />
      <p className="mt-6">
        Two details in there are the interesting ones. A blank line is the paragraph boundary,
        matching how the core segments blocks — falling back to the single line would make the mode
        flicker paragraph-by-paragraph as the caret crosses a soft wrap, which reads as noise rather
        than as focus. And no caret means an <em>empty</em> layer rather than a dim over everything:
        dimming an entire document because the editor lost focus would be a strange thing to look
        at.
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

      <H3 id="web-tagger">On the web: a heuristic, and labelled as one</H3>
      <p>
        The browser has no <code>NLTagger</code>, and the alternative to a heuristic is shipping a
        real tagger — a model, a dictionary, megabytes — into a documentation page to demonstrate
        plumbing. So the web build uses a closed-class word list plus suffix rules.{' '}
        <strong>It is meaningfully worse than the Apple one</strong>, and it will be wrong on
        genuinely ambiguous words: it tags <em>book</em> in “book a flight” as a noun.
      </p>
      <SourceFigure className="mt-5" path="web/extensions/parts-of-speech.js" lang="javascript" code={posWebJs} />
      <Footnote>
        The point being demonstrated is the plumbing, not the linguistics — that a feature this far
        outside markdown can drive the editor’s decoration pipeline without the editor knowing it
        exists. Saying so is cheaper than being quietly wrong about it.
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
          { to: '/try', title: 'Try it', note: 'both toggles, on the real editor' },
          {
            to: '/extend/layers',
            title: 'Host decoration layers',
            note: 'the API underneath, in full',
          },
          {
            to: '/reference/roles',
            title: 'Roles and CSS classes',
            note: 'how a role invented at runtime gets styled',
          },
        ]}
      />
    </>
  );
}
