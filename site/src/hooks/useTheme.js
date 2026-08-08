import { useCallback, useEffect, useState } from 'react';

const KEY = 'mde.site.theme';

/**
 * The system setting is the default and stays the default; the toggle only records a
 * deliberate override. The inline script in `index.html` re-applies a stored override
 * before first paint, so the page never flashes the other theme — which is also why
 * the override lives on `document.documentElement.dataset.theme` rather than in React
 * state that would only exist after hydration.
 *
 * @returns {{resolved: 'light'|'dark', description: string, toggle: () => void}}
 */
export function useTheme() {
  const [resolved, setResolved] = useState(currentTheme);

  // A change to the system setting only matters while there is no explicit override,
  // but recomputing unconditionally is correct in both cases and cheaper to read.
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setResolved(currentTheme());
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  const toggle = useCallback(() => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private mode, or storage disabled. Not worth failing a colour change over.
    }
    setResolved(next);
  }, []);

  return {
    resolved,
    description: `Switch to the ${resolved === 'dark' ? 'light' : 'dark'} theme`,
    toggle,
  };
}

/** @returns {'light'|'dark'} */
function currentTheme() {
  const override = document.documentElement.dataset.theme;
  if (override === 'light' || override === 'dark') return override;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
