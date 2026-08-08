import { useEffect, useState } from 'react';

import { useRoute } from '../lib/router.jsx';

/**
 * "On this page", read from the page itself.
 *
 * The headings are already in the DOM with the ids that are already the deep links, so
 * asking the document is both the least code and the only version that cannot disagree
 * with what the reader can see. A declared list per page would be a second copy of every
 * heading, kept in step by hand.
 */
export default function Toc() {
  const route = useRoute();
  const [items, setItems] = useState([]);
  const [active, setActive] = useState(null);

  useEffect(() => {
    // One turn late: the new page has been committed, but a component that renders its
    // headings after an effect of its own has had its turn too.
    const timer = setTimeout(() => {
      const root = document.getElementById('doc-content');
      if (!root) return setItems([]);
      const found = [...root.querySelectorAll('h2[id], h3[id]')].map((el) => ({
        id: el.id,
        // The trailing `#` is the anchor control, not part of the heading.
        text: el.textContent.replace(/#$/, '').trim(),
        level: Number(el.tagName[1]),
      }));
      setItems(found);
      setActive(found[0]?.id ?? null);
    }, 0);
    return () => clearTimeout(timer);
  }, [route.path]);

  useEffect(() => {
    if (items.length === 0) return;

    // Offset tops rather than an IntersectionObserver: several headings are on screen at
    // once on a short section, and "the last heading you passed" is the answer a reader
    // expects. An observer would have to reconstruct exactly this from its entries.
    //
    // Throttled by timestamp rather than by `requestAnimationFrame`, which never fires
    // in a backgrounded tab — the highlight would then be frozen wherever it happened to
    // be when the tab was hidden.
    let last = 0;
    const update = () => {
      last = Date.now();
      const line = 130;
      let current = items[0]?.id ?? null;
      for (const item of items) {
        const el = document.getElementById(item.id);
        if (el && el.getBoundingClientRect().top <= line) current = item.id;
      }
      // At the bottom of the page the final heading wins, however short its section is.
      if (innerHeight + scrollY >= document.body.scrollHeight - 4) current = items.at(-1).id;
      setActive(current);
    };

    let timer = 0;
    const schedule = () => {
      clearTimeout(timer);
      const wait = Math.max(0, 90 - (Date.now() - last));
      timer = setTimeout(update, wait);
    };

    addEventListener('scroll', schedule, { passive: true });
    addEventListener('resize', schedule);
    update();
    return () => {
      clearTimeout(timer);
      removeEventListener('scroll', schedule);
      removeEventListener('resize', schedule);
    };
  }, [items]);

  if (items.length < 2) return <div className="toc" aria-hidden="true" />;

  return (
    <div className="toc">
      <div className="toc-inner">
        <p className="toc-title">On this page</p>
        <ul>
          {items.map((item) => (
            <li key={item.id} data-level={item.level}>
              <a href={`#${item.id}`} aria-current={active === item.id ? 'true' : undefined}>
                {item.text}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
