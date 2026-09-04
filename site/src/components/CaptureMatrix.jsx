import { withBase } from '../lib/base.js';

const SCENARIOS = [
  ['core', 'CommonMark essentials'],
  ['commonmark-inline', 'Inline CommonMark'],
  ['commonmark-media', 'Links and images'],
  ['commonmark-blocks', 'Block structure'],
  ['commonmark-source', 'Portable source forms'],
  ['lists', 'Native list markers'],
  ['tables', 'Rich tables and resources'],
  ['extensions', 'Host-defined syntax'],
  ['custom-html', 'Plugin-rendered HTML'],
  ['composer', 'Mention suggestions'],
  ['commands', 'Discoverable command menu'],
  ['editing', 'Live syntax reveal'],
  ['table-editing', 'Selected table source'],
];

const PLATFORMS = [
  ['js', 'JS'],
  ['react', 'React'],
  ['ios', 'iOS'],
  ['macos', 'macOS'],
];

export default function CaptureMatrix({ scenario = null }) {
  const rows = scenario ? SCENARIOS.filter(([id]) => id === scenario) : SCENARIOS;
  return (
    <div className="capture-matrix">
      {rows.map(([id, title]) => (
        <section className="capture-matrix-scenario" key={id} aria-labelledby={`capture-${id}`}>
          <h3 id={`capture-${id}`}>{title}</h3>
          <div className="capture-matrix-grid">
            {PLATFORMS.map(([platform, label]) => (
              <figure key={platform}>
                <img
                  src={withBase(`/assets/capture-${id}-${platform}.png`)}
                  alt={`${label} rendering the shared ${title.toLowerCase()} test document.`}
                  loading={scenario ? 'eager' : 'lazy'}
                />
                <figcaption>{label}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
