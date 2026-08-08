import { Lift } from './Doc.jsx';

// Key/value pairs on hairlines rather than a row of pills. A pill says "feature"; a
// readout says what the thing is, which is the honest claim here. The numbers come from
// DESIGN.md and are not restated anywhere else on the site except the performance page.
const READOUTS = [
  { term: 'Core', value: 'Rust' },
  { term: 'iOS & macOS', value: 'TextKit 2' },
  { term: 'Web', value: 'contenteditable' },
  { term: 'Keystroke at 100 KB', value: '1.99 ms', mono: true },
  { term: 'npm dependencies', value: '0', mono: true },
];

/** The overview page's opening. The only page with one — it is the only front door. */
export default function Hero() {
  return (
    <header className="hero">
      {/* The markers are real characters in the DOM, collapsed to nothing and brought
          back on attention — the same mechanic the editor uses, stated in the headline
          rather than described. `aria-hidden` keeps the sentence clean when read aloud.
          The two `.node` spans have to stay direct span children of the h1: the
          stylesheet staggers their one-shot with `.node:nth-of-type(2)`. */}
      <h1 className="hero-title">
        Markdown that{' '}
        <span className="node">
          <span className="mk" aria-hidden="true">
            **
          </span>
          renders itself
          <span className="mk" aria-hidden="true">
            **
          </span>
        </span>
        , <br className="max-[720px]:hidden" />
        and hands the{' '}
        <span className="node">
          <span className="mk" aria-hidden="true">
            *
          </span>
          syntax
          <span className="mk" aria-hidden="true">
            *
          </span>
        </span>{' '}
        back.
      </h1>

      <p className="lede max-w-[62ch] text-[clamp(1.04rem,1.5vw,1.15rem)]">
        A drop-in editor for iOS, macOS and the web. The document is always a{' '}
        <Lift>plain markdown string</Lift> — no rich document model, no serializer, no lossy
        round-trip. Syntax conceals while you are elsewhere and reopens the moment your caret
        enters the node. One Rust core decides what every decoration means; three native
        renderers draw it.
      </p>

      <dl className="readouts">
        {READOUTS.map(({ term, value, mono }) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd className={mono ? 'font-mono tabular-nums' : ''}>{value}</dd>
          </div>
        ))}
      </dl>
    </header>
  );
}
