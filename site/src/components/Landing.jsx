import Hero from './Hero.jsx';
import CaptureMatrix from './CaptureMatrix.jsx';
import { Link } from '../lib/router.jsx';

const PRINCIPLES = [
  {
    label: '01 · Consistent Markdown',
    title: 'The same syntax produces the same decorations.',
    body: 'The Rust core defines parsing, syntax reveal, extensions, and undo for every integration.',
  },
  {
    label: '02 · Native editing',
    title: 'Each platform keeps its native input behavior.',
    body: 'Contenteditable and TextKit preserve native input, selection, spellcheck, and accessibility.',
  },
  {
    label: '03 · Portable files',
    title: 'Files remain plain Markdown.',
    body: 'Rendering never replaces the source with a private document format. Your text remains portable.',
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
          <p className="eyebrow">How it works</p>
          <h2 id="principles-title">One document. Consistent behavior on every platform.</h2>
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
          <p className="eyebrow">Cross-platform output</p>
          <h2 id="capture-proof-title">Compare the four production integrations.</h2>
          <p>
            Every image comes from a real reference app rendering the same Markdown document.
            Together they cover headings, emphasis, links, quotes, tasks, tables, mentions,
            wikilinks, and a host-rendered callout.
          </p>
        </div>
        <CaptureMatrix scenario="core" />
      </section>

      <section className="landing-next" aria-labelledby="landing-next-title">
        <p className="eyebrow">Install mdink</p>
        <h2 id="landing-next-title">Add the editor to your app.</h2>
        <p>
          Start with the package for your platform. The install guide continues from each line to a
          complete editor with no app-specific placeholders.
        </p>
        <div className="landing-install-grid" aria-label="Installation options">
          <Link className="landing-install-option" to="/docs/install#web">
            <span>Web</span>
            <code>pnpm add @mdink/web</code>
          </Link>
          <Link className="landing-install-option" to="/docs/install#react">
            <span>React</span>
            <code>pnpm add @mdink/react</code>
          </Link>
          <Link className="landing-install-option" to="/docs/install#apple">
            <span>Swift</span>
            <code>Add package → MDEditorUI</code>
          </Link>
        </div>
        <div className="landing-next-actions">
          <Link to="/docs/install">Open the install guide →</Link>
          <Link to="/docs/overview">Read the architecture</Link>
          <Link to="/docs/try">Open the live editor</Link>
        </div>
      </section>
    </main>
  );
}
