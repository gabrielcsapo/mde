import { Aside, H2, Lede, Note, SeeAlso } from '../../components/Doc.jsx';
import LiveEditor from '../../components/LiveEditor.jsx';
import { Link } from '../../lib/router.jsx';

const THINGS_TO_TRY = [
  <>
    Click inside a <strong className="font-semibold text-text">bold</strong> word — the{' '}
    <code>**</code> comes back, and arrowing out collapses it again.
  </>,
  <>
    Tap a checkbox. The <em>source line</em> is what changes: <code>- [ ]</code> becomes{' '}
    <code>- [x]</code>, as one undo step.
  </>,
  <>
    Click the table. Its semantic HTML view yields to the editable pipe syntax, then returns when
    the caret leaves the block.
  </>,
  <>
    Click the callout. The caret lands in its source and the fence reappears, because a widget is
    still editable text underneath.
  </>,
  <>
    Select a phrase and press <strong className="font-semibold text-text">Bold</strong>, then{' '}
    <strong className="font-semibold text-text">Undo</strong> — one step, not two marker deletions.
  </>,
  <>
    Turn on <strong className="font-semibold text-text">Typewriter</strong> and keep typing: the
    focus follows the paragraph under the caret.
  </>,
  <>
    Turn on <strong className="font-semibold text-text">Parts of speech</strong>. Nothing in that
    tint is in the markdown.
  </>,
  <>
    Type <code>@ga</code> and choose a person, or press <strong>Command-O</strong> (Control-O on
    Windows/Linux) to insert an image, video, or link. Both floating interfaces are plugins.
  </>,
];

export default function Try() {
  return (
    <>
      <LiveEditor />

      <ul className="hint" id="things-to-try">
        {THINGS_TO_TRY.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>

      <H2 id="what-is-running">What is actually running</H2>
      <Lede>
        Choose <strong>JS</strong> or <strong>React</strong> above. Both render the same Rust
        core and framework-free editor: the first mounts <code>@mde/web</code> directly, while the
        second lazy-loads the small <code>@mde/react</code> adapter.
      </Lede>
      <p>
        The extension manifest comes from <code>web/examples/vanilla/host.js</code> — the standalone
        framework-free example, shared with this page — so <code>@gabe</code>,{' '}
        <code>[[the roadmap]]</code>, the callout block and the chart directive are all declared
        data, not features of the editor. So is the widget drawing: the core says where a node
        starts and stops and what it means; the host decides what a mention looks like.
      </p>
      <Note>
        The two images resolve asynchronously through a <code>ResourceResolver</code>, with space
        reserved first — which is why the document does not jump when they land. The document holds{' '}
        <code>chart.png</code>, never the bytes.
      </Note>
      <p>
        This demo also installs the shipped composer examples in both integrations. Their menus
        render above the editor canvas rather than inside its contenteditable source, so opening,
        navigating, and dismissing them cannot add presentation text to the markdown.
      </p>

      <H2 id="toolbar">The toolbar is a list, not markup</H2>
      <p>
        Five capabilities, five objects in <code>site/src/lib/toolbar.js</code>. Each carries an id, a
        label, a <code>run</code>, and optionally an <code>enabled</code> or a <code>pressed</code>{' '}
        predicate; the component renders whatever the array holds and re-evaluates those predicates
        whenever the document or the selection changes. Nothing in the component knows any of the
        ids.
      </p>
      <p>
        <strong>View</strong> switches the same live renderer into a selectable, non-editable
        document: syntax stays rendered, links use a normal click, and embedded controls keep
        working. Switch it off to return to the source-first editing behavior.
      </p>
      <p>
        That matters for the last two buttons. <strong>Typewriter</strong> and{' '}
        <strong>Parts of speech</strong> are not editor features — they live in{' '}
        <code>web/extensions/</code>, they are written entirely against the public layer API, and
        adding each of them to this page cost exactly one object in that array.{' '}
        <Link to="/extend/showcase">That story has its own page.</Link>
      </p>

      <Aside tone="caution" title="If the editor does not appear">
        The wasm core needs a real origin, so a page opened over <code>file://</code> cannot
        instantiate it. Run <code>./scripts/serve-site.sh</code>, which builds{' '}
        <code>@mde/web</code>, its wasm asset, and the React adapter first.
      </Aside>

      <SeeAlso
        links={[
          {
            to: '/concepts/reveal',
            title: 'Reveal policy',
            note: 'why the markers come back when the caret arrives, and not before',
          },
          {
            to: '/platforms/web',
            title: 'Web platform notes',
            note: 'what it takes to make contenteditable behave like this',
          },
          {
            to: '/install',
            title: 'Install and embed',
            note: 'the same editor, in your own page',
          },
        ]}
      />
    </>
  );
}
