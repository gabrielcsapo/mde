import { useEffect } from 'react';

import { GROUPS } from '../docs/nav.js';
import { Link, useRoute } from '../lib/router.jsx';

/**
 * The persistent navigation: every page, in reading order, grouped.
 *
 * Nothing collapses. Eighteen entries fit in a column on any screen tall enough to read
 * on, and a reader evaluating a library benefits far more from seeing the whole shape of
 * the documentation at once than from a tidier list they have to open twice to search
 * with their eyes.
 *
 * Below `lg` the same markup becomes a drawer over the page. It is the same component
 * because it is the same navigation — a second mobile-only list is how the two fall out
 * of step.
 */
export default function Sidebar({ open, onNavigate }) {
  const route = useRoute();

  // Escape closes the drawer, which is the only state this component has.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onNavigate();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open, onNavigate]);

  return (
    <>
      {open ? <div className="nav-scrim lg:hidden" onClick={onNavigate} /> : null}
      <nav
        id="sidebar"
        className={`sidebar${open ? ' is-open' : ''}`}
        aria-label="Documentation"
      >
        <div className="sidebar-inner">
          {GROUPS.map((group) => (
            <div className="nav-group" key={group.id}>
              <p className="nav-group-title">{group.title}</p>
              <ul>
                {group.pages.map((page) => {
                  const current = route.path === page.path;
                  return (
                    <li key={page.path}>
                      <Link
                        to={page.path}
                        className="nav-link"
                        aria-current={current ? 'page' : undefined}
                        onClick={onNavigate}
                      >
                        {page.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          <p className="nav-foot">
            Every claim on this site comes from <code>DESIGN.md</code> or from the source it
            describes.
          </p>
        </div>
      </nav>
    </>
  );
}
