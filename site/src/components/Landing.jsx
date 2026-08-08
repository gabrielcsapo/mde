import { lazy, Suspense } from 'react';

import Hero from './Hero.jsx';
import { Link } from '../lib/router.jsx';

const LiveEditor = lazy(() => import('./LiveEditor.jsx'));

// The front door has one job: make the promise clear and let visitors verify it. The
// documentation explains the architecture; this page earns the next click.

const CTA =
  'inline-flex items-center rounded-[9px] border px-5 py-2.5 text-[0.95rem] font-[550] no-underline';

export default function Landing() {
  return (
    <>
      <main className="mx-auto max-w-[1080px] px-6 pb-10" id="main">
        <div className="landing-intro pt-[clamp(48px,9vh,102px)]">
          <Hero />
          <div className="mt-[28px] flex flex-wrap gap-3">
            <a
              className={`${CTA} border-accent bg-accent text-surface hover:border-accent-hi hover:bg-accent-hi`}
              href="#live-editor"
            >
              Try the editor ↓
            </a>
            <Link className={`${CTA} border-rule text-text hover:border-accent hover:text-accent`} to="/overview">
              Read the docs →
            </Link>
          </div>
          <p className="landing-platforms">
            Vanilla JS <span aria-hidden="true">·</span> React{' '}
            <span aria-hidden="true">·</span> iOS <span aria-hidden="true">·</span> macOS{' '}
            <span aria-hidden="true">·</span> one Rust core
          </p>
        </div>

        <section className="landing-proof" id="live-editor" aria-labelledby="live-editor-title">
          <div className="landing-proof-copy">
            <p className="eyebrow">The real editor, running below</p>
            <h2 id="live-editor-title">Click a styled word. The syntax comes back.</h2>
            <p className="lede" id="landing-editor-prompt">
              Move the caret away and it disappears again. Try a checkbox, edit the text,
              or switch between the framework-free and React integrations.
            </p>
          </div>
          <Suspense fallback={<div className="editor-loading">Loading the editor…</div>}>
            <LiveEditor historyInitiallyOpen={false} descriptionId="landing-editor-prompt" />
          </Suspense>
          <p className="landing-proof-more">
            <Link to="/try">Explore revisions, extensions, and widgets →</Link>
          </p>
        </section>

      </main>
    </>
  );
}
