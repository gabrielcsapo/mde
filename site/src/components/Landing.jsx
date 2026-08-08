import Footer from './Footer.jsx';
import Hero from './Hero.jsx';
import { Link } from '../lib/router.jsx';

// The front door. One idea per band, in the order a visitor decides in: the claim
// (hero), proof it is real (try it), what adopting it costs (the split), where to go
// next. Everything below the hero links into the documentation rather than repeating
// it — the landing page's job is to make one sentence believable, not to be a summary.

// Utility bundles used more than once. Tailwind has no opinion on repetition, but a
// class string that appears three times is one decision, and should read as one.
const CTA =
  'inline-flex items-center rounded-[9px] border px-5 py-2.5 text-[0.95rem] font-[550] no-underline';
const BAND = 'mt-[38px] border-t border-rule-soft pt-11 pb-1.5';
const H2 = 'mt-0 mb-3 text-[1.45rem] tracking-[-0.015em]';
const SPLIT_TITLE = 'mb-2 mt-0 text-[0.78rem] uppercase tracking-[0.09em] text-faint';
const SPLIT_LIST = 'm-0 grid list-disc gap-[7px] pl-[18px] text-muted';

const PATHS = [
  {
    to: '/try',
    label: 'Type in it',
    body: 'The real editor, running the real wasm core — with the revision timeline open and two extensions on toggles.',
  },
  {
    to: '/install',
    label: 'Put it in an app',
    body: 'Vendor the repo, mount the view. Three imports on the web; a Swift package and a text view on Apple.',
  },
  {
    to: '/overview',
    label: 'Read the docs',
    body: 'Front to back if you like — every page ends with the next one, from the principles to the open questions.',
  },
];

const OWNS = [
  'parsing, decoration, and reveal-as-you-type',
  'undo, redo and the browsable revision timeline',
  'widget identity — an image never reloads because you typed elsewhere',
  'your custom syntax, from a declarative manifest',
  'runtime decoration layers for features no parser could find',
];

const BRINGS = [
  'storage and sync — the document is a plain string, do anything with it',
  'views for your widgets (a callout card, a mention chip)',
  'resolution for references — the file holds a path, never bytes',
  'chrome: toolbar, buttons, panels, in your UI toolkit',
];

export default function Landing() {
  return (
    <>
      <main className="mx-auto max-w-[1080px] px-6 pb-10" id="main">
        <div className="pt-[clamp(48px,9vh,110px)] pb-[26px]">
          <Hero />
          <div className="mt-[30px] flex flex-wrap gap-3">
            <Link className={`${CTA} border-accent bg-accent text-surface hover:border-accent-hi hover:bg-accent-hi`} to="/try">
              Try it live →
            </Link>
            <Link className={`${CTA} border-rule text-text hover:border-accent hover:text-accent`} to="/install">
              Install
            </Link>
          </div>
        </div>

        <section className={BAND} aria-label="Where to start">
          <div className="cards">
            {PATHS.map((path) => (
              <Link className="card" key={path.to} to={path.to}>
                <span className="card-title">{path.label}</span>
                <span className="card-body">{path.body}</span>
                <span className="card-go">→</span>
              </Link>
            ))}
          </div>
        </section>

        <section className={BAND} aria-label="What you get and what you bring">
          <h2 className={H2}>What you get, what you bring</h2>
          <p className="lede">
            The split is the same on every platform, so an integration can be sized in one
            glance: the library decides everything about the text, and asks the host for
            everything about the app.
          </p>
          <div className="mt-[22px] grid gap-[26px] min-[641px]:grid-cols-2">
            <div>
              <h3 className={SPLIT_TITLE}>The library owns</h3>
              <ul className={SPLIT_LIST}>
                {OWNS.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className={SPLIT_TITLE}>Your app brings</h3>
              <ul className={SPLIT_LIST}>
                {BRINGS.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className={BAND} aria-label="Not a WYSIWYG">
          <h2 className={H2}>Explicitly not a WYSIWYG</h2>
          <p className="lede">
            A WYSIWYG owns a document model and emits markdown as an export format; this owns
            nothing. The buffer <em>is</em> the source, and every feature is a range plus a
            primitive plus a role over that string. Files stay portable, three platforms
            cannot drift, and “show me the markers while I am editing this word” is{' '}
            <Link to="/concepts/reveal">a policy in one place</Link> rather than three piles
            of renderer code.
          </p>
        </section>

        {/* Inside the container on purpose. The footer carries no width or padding of
            its own — on doc pages the padded column provides them, so out here it would
            run flush to the viewport edge. */}
        <Footer />
      </main>
    </>
  );
}
