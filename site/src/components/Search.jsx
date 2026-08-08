import { useEffect, useMemo, useRef, useState } from 'react';

import { navigate } from '../lib/router.jsx';
import { search } from '../lib/search.js';

/**
 * The search palette.
 *
 * Deliberately modal and keyboard-first: on a documentation site search is a way of
 * navigating, not a page of its own, so it opens over what you are reading and returns
 * you to it. `⌘K` opens it, `/` opens it when you are not already typing somewhere,
 * arrows move, Enter goes, Escape leaves.
 *
 * Results are sections, so Enter lands on a heading rather than at the top of a long
 * page — see `lib/search.js` for what is indexed and how it is weighted.
 */
export default function Search({ open, onClose }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef(null);
  const list = useRef(null);

  const results = useMemo(() => (query.trim() ? search(query) : []), [query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    // The dialog has just been committed; focusing in the same tick works because the
    // element is already in the document by the time this effect runs.
    input.current?.focus();
  }, [open]);

  useEffect(() => setActive(0), [query]);

  // Keep the highlighted row in view without scrolling the page behind the dialog.
  useEffect(() => {
    if (!open) return;
    const el = list.current?.querySelector('[data-active="1"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open, results.length]);

  useEffect(() => {
    if (!open) return;
    // The page behind must not scroll while the palette is up.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  const go = (result) => {
    onClose();
    navigate(result.hash ? `${result.path}#${result.hash}` : result.path);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
      return;
    }
    if (event.key === 'Enter' && results[active]) {
      event.preventDefault();
      go(results[active]);
    }
  };

  return (
    <div
      className="search-scrim"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="search-panel" role="dialog" aria-modal="true" aria-label="Search the documentation">
        <div className="search-field">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="6.4" />
            <path d="M15.8 15.8 21 21" />
          </svg>
          <input
            ref={input}
            type="search"
            value={query}
            placeholder="Search the documentation"
            aria-label="Search the documentation"
            autoComplete="off"
            spellCheck="false"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd>esc</kbd>
        </div>

        <div className="search-results" ref={list}>
          {query.trim() && results.length === 0 ? (
            <p className="search-empty">
              Nothing matches “{query.trim()}”. Try a symbol name — <code>setLayer</code>,{' '}
              <code>reservedSize</code> — or a concept, like <em>conceal</em> or <em>reveal</em>.
            </p>
          ) : null}

          {!query.trim() ? (
            <p className="search-empty">
              Search titles, prose and every documented symbol. <kbd>↑</kbd> <kbd>↓</kbd> to move,{' '}
              <kbd>↵</kbd> to open.
            </p>
          ) : null}

          {results.map((result, i) => (
            <button
              key={`${result.path}#${result.hash}-${result.title}-${i}`}
              type="button"
              className="search-hit"
              data-active={i === active ? '1' : undefined}
              onMouseMove={() => setActive(i)}
              onClick={() => go(result)}
            >
              <span className="hit-crumb">
                {result.group} <i>/</i> {result.page}
                {result.kind === 'symbol' ? <em className="hit-kind">symbol</em> : null}
              </span>
              <span className="hit-title">{result.title}</span>
              <span className="hit-snippet">
                {result.snippet.map((part, j) =>
                  part.hit ? <mark key={j}>{part.text}</mark> : <span key={j}>{part.text}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Opens the palette from anywhere: `⌘K`, `Ctrl+K`, or `/` when the reader is not already
 * typing into something. Returns nothing — it drives the `open` state it is given.
 */
export function useSearchHotkeys(open, setOpen) {
  useEffect(() => {
    const onKey = (event) => {
      const key = event.key.toLowerCase();
      if (key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen(true);
        return;
      }
      if (open || event.key !== '/') return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLElement &&
        (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
      // `/` is a character in the document being edited on the Try it page; the editor
      // must always win it.
      if (typing) return;
      event.preventDefault();
      setOpen(true);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open, setOpen]);
}
