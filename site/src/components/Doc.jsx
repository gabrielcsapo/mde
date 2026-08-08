// The shapes a documentation page is made of.
//
// Everything here was a copy-pasted class attribute at some point; naming them is the
// one place React genuinely improves on hand-written markup, because a shape is now
// stated once instead of nine times.
//
// Two rules the rest of the site depends on:
//
//   * `H2` and `H3` take a literal string `id`. That id is the deep link, the table of
//     contents entry, and the anchor the search index points at — see
//     `vite.config.js`, which reads these files as text to build that index.
//   * Nothing here scrolls the page or reads the route. A heading is a heading.

import { Link } from '../lib/router.jsx';

/**
 * A section heading, its anchor, and the deep link into it.
 *
 * The `#` control is a real link rather than a click handler, so it can be copied,
 * middle-clicked and opened in a new tab like any other address on the page.
 */
export function H2({ id, children }) {
  return (
    <h2 className="doc-h2" id={id}>
      {children}
      <a className="anchor" href={`#${id}`} aria-label="Link to this section">
        #
      </a>
    </h2>
  );
}

export function H3({ id, children }) {
  return (
    <h3 className="doc-h3" id={id}>
      {children}
      <a className="anchor" href={`#${id}`} aria-label="Link to this section">
        #
      </a>
    </h3>
  );
}

/** The paragraph that qualifies a statement: muted, one measure wide. */
export function Lede({ className = '', children }) {
  return <p className={`lede ${className}`}>{children}</p>;
}

/** The small print that follows a table or a figure. */
export function Note({ className = '', children }) {
  return <p className={`note max-w-measure ${className}`}>{children}</p>;
}

/** Emphasis inside a lede, which is muted — this lifts the phrase back to full ink. */
export function Lift({ children }) {
  return <strong className="font-semibold text-text">{children}</strong>;
}

/**
 * Not cards. Each item is a clause under a hairline — they are peers in a list, and a
 * box around each would claim a hierarchy that is not there.
 */
export function Clauses({ className = '', children }) {
  return (
    <div
      className={`mt-8 grid max-w-[980px] grid-cols-1 gap-x-14 gap-y-7 md:grid-cols-2 ${className}`}
    >
      {children}
    </div>
  );
}

export function Clause({ title, children }) {
  return (
    <div className="border-t border-rule pt-4">
      <h4 className="mb-2 text-balance">{title}</h4>
      <p className="text-[0.925rem] leading-[1.62] text-muted">{children}</p>
    </div>
  );
}

/** A table that may be wider than its column at phone width, so it scrolls in place. */
export function TableFrame({ className = '', children }) {
  return (
    <div className={`overflow-x-auto border-t border-rule ${className}`}>
      <table className="data">{children}</table>
    </div>
  );
}

/** The small print that follows a figure, wider than a `Note`. */
export function Footnote({ className = '', children }) {
  return <p className={`mt-3 max-w-[900px] text-[0.83rem] text-faint ${className}`}>{children}</p>;
}

/**
 * An aside. `tone` picks the accent: `note` for a consequence worth pulling out,
 * `caution` for something that will bite, `next` for work that does not exist yet.
 */
export function Aside({ tone = 'note', title, children }) {
  return (
    <aside className={`aside aside-${tone}`}>
      {title ? <p className="aside-title">{title}</p> : null}
      <div className="aside-body">{children}</div>
    </aside>
  );
}

/** A numbered procedure. The numbers are content, so they are a real ordered list. */
export function Steps({ children }) {
  return <ol className="steps">{children}</ol>;
}

export function Step({ title, children }) {
  return (
    <li>
      <p className="step-title">{title}</p>
      {children}
    </li>
  );
}

/**
 * Where to go next when a page ends on a thread it does not follow. Written out rather
 * than generated: the interesting links are rarely the neighbouring pages, which the
 * pager already offers.
 *
 * @param {{links: {to: string, title: string, note: string}[]}} props
 */
export function SeeAlso({ links }) {
  return (
    <div className="see-also">
      <p className="eyebrow">See also</p>
      <ul>
        {links.map((link) => (
          <li key={link.to}>
            <Link to={link.to}>{link.title}</Link>
            <span> — {link.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A definition list of terms and one-line meanings, for short reference blocks. */
export function Defs({ items }) {
  return (
    <dl className="defs">
      {items.map(([term, meaning]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{meaning}</dd>
        </div>
      ))}
    </dl>
  );
}
