import { Link } from '../lib/router.jsx';
import { neighbours } from '../docs/nav.js';

/**
 * The frame every documentation page shares: where it sits, what it is called, what it
 * is for, and where to go next.
 *
 * The pager is the reason `nav.js` keeps one flat reading order. A reader who has just
 * understood the decoration protocol should be offered reveal policy, not returned to a
 * menu — and the fact that "next" always exists until the last page is what makes the
 * site claim to be a document rather than a pile of pages.
 */
export default function DocPage({ page, children }) {
  const { previous, next } = neighbours(page.path);

  return (
    <>
      {/* The overview supplies its own opening — a title reading "Overview" above a
          headline that already says what the thing is would be one heading too many. */}
      {page.hero ? null : (
        <header className="doc-head">
          <p className="eyebrow">{page.group.title}</p>
          <h1>{page.title}</h1>
          <p className="lede doc-summary">{page.summary}</p>
        </header>
      )}

      <div id="doc-content" className="doc-body">
        {children}
      </div>

      <nav className="pager" aria-label="Previous and next page">
        {previous ? (
          <Link className="pager-link pager-prev" to={previous.path}>
            <span className="pager-dir">← Previous</span>
            <span className="pager-title">{previous.title}</span>
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link className="pager-link pager-next" to={next.path}>
            <span className="pager-dir">Next →</span>
            <span className="pager-title">{next.title}</span>
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </>
  );
}
