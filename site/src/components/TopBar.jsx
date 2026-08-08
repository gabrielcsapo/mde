import { Link } from '../lib/router.jsx';
import { useTheme } from '../hooks/useTheme.js';
import { PAGES } from '../docs/nav.js';

/**
 * The one bar across the top: identity on the left, the two controls that apply to every
 * page on the right, and — below `sm` — the button that opens the navigation.
 *
 * Section links used to live here. They belong in the sidebar now: this is a full
 * documentation set rather than one long page, and a short row cannot describe it.
 */
export default function TopBar({ page, onOpenSearch, onOpenNav, navOpen }) {
  const theme = useTheme();
  const pageIndex = page ? PAGES.findIndex((item) => item.path === page.path) : -1;
  const progress = pageIndex >= 0 ? ((pageIndex + 1) / PAGES.length) * 100 : 0;

  return (
    <header
      className="topbar sticky top-0 z-30 border-b border-rule-soft"
      style={{ '--reading-progress': `${progress}%` }}
    >
      <div className="mx-auto flex h-[54px] w-full items-center gap-3 px-4 sm:px-6">
        <button
          type="button"
          className="nav-toggle lg:hidden"
          aria-expanded={navOpen}
          aria-controls="sidebar"
          onClick={onOpenNav}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d={navOpen ? 'M6 6l12 12M18 6L6 18' : 'M4 7h16M4 12h16M4 17h16'} />
          </svg>
          <span className="sr-only">{navOpen ? 'Close navigation' : 'Open navigation'}</span>
        </button>

        <Link
          className="flex items-baseline gap-[9px] font-mono text-[0.9rem] font-semibold tracking-[-0.01em] whitespace-nowrap text-text no-underline"
          to="/"
        >
          mde
          <em className="font-sans text-[0.78rem] font-normal tracking-normal not-italic text-faint max-[560px]:hidden">
            markdown editor
          </em>
        </Link>

        <Link
          className="docs-label"
          aria-label="Documentation overview"
          to="/overview"
        >
          Docs
        </Link>

        {page ? (
          <span className="page-count" aria-label={`Page ${pageIndex + 1} of ${PAGES.length}`}>
            {String(pageIndex + 1).padStart(2, '0')}
            <i>/</i>
            {String(PAGES.length).padStart(2, '0')}
          </span>
        ) : null}

        {/* Not an input. It opens the palette, which is where typing actually happens —
            an input here would need its own results popover and its own focus rules for
            no gain. */}
        <button
          type="button"
          className="search-trigger ml-auto"
          aria-label="Search documentation"
          onClick={onOpenSearch}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="6.4" />
            <path d="M15.8 15.8 21 21" />
          </svg>
          <span className="label">Search</span>
          <kbd>⌘K</kbd>
        </button>

        <button
          className="theme-toggle inline-flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-transparent p-0 text-muted transition-colors hover:bg-rule-soft hover:text-text"
          type="button"
          aria-label="Switch colour theme"
          title={theme.description}
          onClick={theme.toggle}
        >
          {/* Both icons are always in the DOM; the stylesheet shows whichever matches the
              resolved theme, so the swap needs no JavaScript and cannot lag the pre-paint
              script in index.html. */}
          <svg
            className="i-sun size-[15px]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="4.2" />
            <path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" />
          </svg>
          <svg
            className="i-moon size-[15px]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z" />
          </svg>
        </button>
      </div>
      {page ? <div className="reading-progress" aria-hidden="true" /> : null}
    </header>
  );
}
