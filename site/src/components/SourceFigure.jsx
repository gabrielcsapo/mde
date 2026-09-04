import { useEffect, useMemo, useRef, useState } from 'react';
import { tag } from '../lib/highlight.js';

/**
 * A source panel: the file it came from, the language, a copy control, and the code.
 *
 * `code` may be a token list built ahead of time or a source string to tokenize here.
 * Accepting both keeps authored documentation examples simple without weakening the
 * older generated-snippet path.
 *
 * The copy button lived in the script rather than the markup on the previous version,
 * so a page without JavaScript would not show a control that could not work. That
 * distinction is gone here — the page *is* JavaScript now — so it is plain markup.
 *
 * @param {{path: string, lang: string, className?: string,
 *          code: string|import('../lib/highlight.js').Token[]}} props
 */
export default function SourceFigure({ path, lang, className = '', code }) {
  const pre = useRef(null);
  const [label, setLabel] = useState('Copy');
  const done = label === 'Copied';
  const tokens = useMemo(
    () => (Array.isArray(code) ? code : tag(lang, String(code ?? ''))),
    [code, lang],
  );

  // One timer, cleared on unmount and restarted by each click.
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(pre.current.textContent);
      setLabel('Copied');
    } catch {
      // Clipboard blocked: select the code so the visitor can copy it themselves, and
      // say so rather than claiming success.
      const range = document.createRange();
      range.selectNodeContents(pre.current);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      setLabel('Selected');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setLabel('Copy'), 1600);
  }

  return (
    <figure className={`src ${className}`}>
      <figcaption>
        <span className="path">{path}</span>
        <span className="lang">{lang}</span>
        <button
          type="button"
          className="copy"
          title="Copy this snippet"
          data-done={done ? '1' : undefined}
          onClick={copy}
        >
          {label}
        </button>
      </figcaption>
      <pre ref={pre}>
        <code>
          {tokens.map((token, i) =>
            token.cls ? (
              <span className={token.cls} key={i}>
                {token.text}
              </span>
            ) : (
              token.text
            )
          )}
        </code>
      </pre>
    </figure>
  );
}
