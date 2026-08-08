import { Link } from '../lib/router.jsx';

const CAPTURES = [
  {
    className: 'hero-capture-web',
    src: '/assets/web-js.png',
    label: 'JS · @mde/web',
    alt: 'The real JavaScript editor rendering CommonMark and custom extension syntax.',
  },
  {
    className: 'hero-capture-macos',
    src: '/assets/macos-editor.png',
    label: 'Swift · macOS',
    alt: 'The real macOS editor rendering the shared Markdown document.',
  },
  {
    className: 'hero-capture-ios',
    src: '/assets/ios-widgets.png',
    label: 'Swift · iOS',
    alt: 'The real iOS editor rendering CommonMark and host-defined widgets.',
  },
];

/** The front page thesis: one source and one interpretation, rendered natively three ways. */
export default function Hero() {
  return (
    <header className="hero">
      <div className="hero-copy">
        <p className="eyebrow">Rust-powered · Web + Swift</p>
        <h1 className="hero-title">
          One{' '}
          <span className="hero-node">
            <span className="hero-marker" aria-hidden="true">**</span>
            Markdown
            <span className="hero-marker" aria-hidden="true">**</span>
          </span>{' '}
          file.
          <span className="hero-title-accent">Every screen.</span>
        </h1>
        <p className="lede hero-summary">
          A cross-platform Markdown editor with one shared core and native-feeling surfaces for the
          web, iOS, and macOS. Same syntax. Same behavior. No private document format.
        </p>

        <div className="hero-actions">
          <Link className="hero-action hero-action-primary" to="/overview">
            Explore the architecture
            <span aria-hidden="true">→</span>
          </Link>
          <Link className="hero-action hero-action-secondary" to="/try">
            Try it in the docs
          </Link>
        </div>

        <ul className="hero-platform-list" aria-label="Supported integrations">
          <li>JS</li>
          <li>React</li>
          <li>Swift</li>
        </ul>
      </div>

      <figure className="hero-captures">
        {CAPTURES.map((capture) => (
          <div className={`hero-capture ${capture.className}`} key={capture.label}>
            <img src={capture.src} alt={capture.alt} />
            <span>{capture.label}</span>
          </div>
        ))}
        <figcaption>Actual captures from the Web, AppKit, and UIKit reference apps.</figcaption>
      </figure>
    </header>
  );
}
