import Hero from './Hero.jsx';
import { Link } from '../lib/router.jsx';

const PRINCIPLES = [
  {
    label: 'Shared meaning',
    title: 'One parser, not three approximations.',
    body: 'Rust owns parsing, reveal behavior, extensions, and undo. Web and Swift consume the same decisions.',
  },
  {
    label: 'Native input',
    title: 'The platform still owns the caret.',
    body: 'Contenteditable and TextKit 2 keep IME, selection, spellcheck, and accessibility where they belong.',
  },
  {
    label: 'Portable source',
    title: 'Your document stays Markdown.',
    body: 'The rendered experience is a decoration layer. Underneath it is an ordinary string you can take anywhere.',
  },
];

export default function Landing() {
  return (
    <main className="landing" id="main">
      <section className="landing-hero">
        <Hero />
      </section>

      <section className="landing-principles" aria-labelledby="principles-title">
        <div className="landing-principles-head">
          <p className="eyebrow">Cross-platform by construction</p>
          <h2 id="principles-title">The renderer changes. The editing contract doesn’t.</h2>
        </div>
        <div className="landing-principle-grid">
          {PRINCIPLES.map((principle) => (
            <article className="landing-principle" key={principle.label}>
              <p>{principle.label}</p>
              <h3>{principle.title}</h3>
              <span>{principle.body}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-capture-proof" aria-labelledby="capture-proof-title">
        <div className="landing-capture-head">
          <p className="eyebrow">CommonMark + custom syntax</p>
          <h2 id="capture-proof-title">The screenshots are the product.</h2>
          <p>
            These are generated from the production docs build with a fixed Markdown document. The
            same capture includes headings, emphasis, links, quotes, tasks, tables, mentions,
            wikilinks, and a host-rendered callout.
          </p>
        </div>
        <div className="landing-web-captures">
          <figure>
            <img src="/assets/web-js.png" alt="The JS editor rendering CommonMark and custom syntax." />
            <figcaption><strong>JS</strong> · <code>@mde/web</code></figcaption>
          </figure>
          <figure>
            <img src="/assets/web-react.png" alt="The React editor rendering the same CommonMark and custom syntax." />
            <figcaption><strong>React</strong> · <code>@mde/react</code></figcaption>
          </figure>
        </div>
        <p className="landing-capture-command">
          Regenerate both with <code>pnpm capture:web</code>.
        </p>
      </section>

      <section className="landing-next" aria-labelledby="landing-next-title">
        <p className="eyebrow">Start here</p>
        <h2 id="landing-next-title">Build the same Markdown experience into every app.</h2>
        <p>
          Follow the architecture from Rust decorations to the web and Swift renderers, or open the
          full editor inside the documentation when you want to test the interaction yourself.
        </p>
        <div className="landing-next-actions">
          <Link to="/overview">Read the overview →</Link>
          <Link to="/install">Install and embed</Link>
          <Link to="/try">Open the live editor</Link>
        </div>
      </section>
    </main>
  );
}
