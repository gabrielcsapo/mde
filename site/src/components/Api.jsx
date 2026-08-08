import { H2 } from './Doc.jsx';

/**
 * Renders `backticked` spans in a summary as code.
 *
 * The entries in `lib/api.js` are data, and the least awkward way to write "a sentence
 * with a symbol in it" as data is the way everyone already writes it. Given what this
 * site is documenting, prose that displays its own backticks would be a poor joke.
 *
 * @param {{text: string}} props
 */
function Ticks({ text }) {
  return text.split(/`([^`]+)`/).map((part, i) =>
    i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>
  );
}

/**
 * Renders the symbol groups from `lib/api.js`.
 *
 * One layout for every symbol, and it is a list rather than a table: a signature is the
 * widest thing on the page and a table column would either wrap it into soup or push the
 * whole row off a phone. Each entry is a block — signature, sentence, then only the
 * parts that exist.
 *
 * The `id` on each group is the same anchor the search index points at, so a result for
 * `setLayer` lands on the group that documents it.
 *
 * @param {{groups: import('../lib/api.js').SymbolGroup[]}} props
 */
export default function Api({ groups }) {
  return (
    <>
      {groups.map((group) => (
        <section key={group.id} className="api-group">
          <H2 id={group.id}>{group.title}</H2>
          <p className="api-file">{group.file}</p>
          <p className="lede">
            <Ticks text={group.intro} />
          </p>

          <div className="api-list">
            {group.symbols.map((symbol) => (
              <article key={symbol.name} className="api-symbol">
                <header>
                  <h3>{symbol.name}</h3>
                  <span className={`api-kind api-kind-${symbol.kind}`}>{symbol.kind}</span>
                </header>
                <pre className="api-signature">
                  <code>{symbol.signature}</code>
                </pre>
                <p className="api-summary">
                  <Ticks text={symbol.summary} />
                </p>

                {symbol.params ? (
                  <dl className="api-params">
                    {symbol.params.map(([name, meaning]) => (
                      <div key={name}>
                        <dt>{name}</dt>
                        <dd>
                          <Ticks text={meaning} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                {symbol.returns ? (
                  <p className="api-returns">
                    <span>Returns</span> <Ticks text={symbol.returns} />
                  </p>
                ) : null}

                {symbol.note ? (
                  <p className="api-note">
                    <Ticks text={symbol.note} />
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
