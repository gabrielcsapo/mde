import { Suspense, useEffect, useState } from 'react';

import DocPage from './components/DocPage.jsx';
import Landing from './components/Landing.jsx';
import Footer from './components/Footer.jsx';
import Search, { useSearchHotkeys } from './components/Search.jsx';
import Sidebar from './components/Sidebar.jsx';
import Toc from './components/Toc.jsx';
import TopBar from './components/TopBar.jsx';

import { pageAt } from './docs/nav.js';
import { ROUTES } from './docs/routes.jsx';
import { Link, RouterProvider, useRoute, useScrollToRoute } from './lib/router.jsx';

export default function App() {
  return (
    <RouterProvider>
      <Shell />
    </RouterProvider>
  );
}

function Shell() {
  const route = useRoute();
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  useScrollToRoute(route);
  useSearchHotkeys(searchOpen, setSearchOpen);

  // A navigation closes the drawer; leaving it open over the page you just asked for is
  // the classic mobile-menu bug.
  useEffect(() => setNavOpen(false), [route.path]);

  // The title is how a browser tab, a bookmark and a shared link describe the page, so
  // it has to follow the route rather than describing the site once.
  const page = pageAt(route.path);
  const isLanding = route.path === '/';
  useEffect(() => {
    document.title = isLanding
      ? 'mde — cross-platform Markdown for web and Swift'
      : page
        ? `${page.title} · mde`
        : 'Not found · mde';
  }, [page, isLanding]);

  const Page = ROUTES[route.path];

  // The landing is the one page without the documentation chrome: no sidebar, no table
  // of contents — a front door, not a chapter.
  if (isLanding) {
    return (
      <>
        <TopBar
          page={page}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenNav={() => setNavOpen((v) => !v)}
          navOpen={navOpen}
        />
        <Landing />
        <Search open={searchOpen} onClose={() => setSearchOpen(false)} />
      </>
    );
  }

  return (
    <>
      <TopBar
        page={page}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenNav={() => setNavOpen((v) => !v)}
        navOpen={navOpen}
      />

      <div className="shell">
        <Sidebar open={navOpen} onNavigate={() => setNavOpen(false)} />

        {/* `doc-column`, not `doc`: the editor's own chrome already owns `.doc` for the
            document-name slot in its toolbar, and a two-meaning class name is a bug
            waiting for whichever one is styled second. */}
        <main className="doc-column" id="main">
          {Page && page ? (
            <DocPage page={page}>
              <Suspense fallback={<RoutePending />}>
                <Page />
              </Suspense>
            </DocPage>
          ) : (
            <NotFound path={route.path} />
          )}
          <Footer />
        </main>

        <Toc />
      </div>

      <Search open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}

function RoutePending() {
  return (
    <div className="route-pending" role="status">
      <span />
      Loading the live editor…
    </div>
  );
}

/**
 * Deep links are a promise, so a broken one has to say what happened rather than
 * silently redirecting somewhere plausible.
 */
function NotFound({ path }) {
  return (
    <div className="doc-head">
      <p className="eyebrow">404</p>
      <h1>No page at that address</h1>
      <p className="lede doc-summary">
        Nothing is published at <code>{path}</code>. The navigation on the left lists every page;{' '}
        <kbd>⌘K</kbd> searches all of them.
      </p>
      <p className="mt-6">
        <Link to="/overview">Back to the overview →</Link>
      </p>
    </div>
  );
}
