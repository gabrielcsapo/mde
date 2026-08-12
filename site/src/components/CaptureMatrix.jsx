const SCENARIOS = [
  ['core', 'CommonMark essentials'],
  ['tables', 'Rich tables and resources'],
  ['extensions', 'Host-defined syntax'],
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
                  src={`/assets/capture-${id}-${platform}.png`}
                  alt={`${label} rendering the ${title.toLowerCase()} fixture.`}
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
