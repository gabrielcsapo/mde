import { lazy, Suspense, useState } from 'react';

import VanillaEditor from './VanillaEditor.jsx';

const ReactEditor = lazy(() => import('./ReactEditor.jsx'));

const VARIANTS = [
  { id: 'vanilla', label: 'JS', detail: '@mde/web' },
  { id: 'react', label: 'React', detail: '@mde/react' },
];

export default function LiveEditor({ historyInitiallyOpen, descriptionId = 'things-to-try' }) {
  const [variant, setVariant] = useState('vanilla');

  const moveTab = (event, current) => {
    const index = VARIANTS.findIndex((item) => item.id === current);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % VARIANTS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + VARIANTS.length) % VARIANTS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = VARIANTS.length - 1;
    else return;
    event.preventDefault();
    const id = VARIANTS[next].id;
    setVariant(id);
    requestAnimationFrame(() => document.getElementById(`editor-variant-${id}`)?.focus());
  };

  return (
    <section className="editor-demo mt-[30px]" aria-label="Editor integration examples">
      <div className="editor-variants" role="tablist" aria-label="Integration">
        <span className="editor-variants-label">Integration</span>
        {VARIANTS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`editor-variant-${item.id}`}
            className="editor-variant"
            aria-selected={variant === item.id}
            aria-controls="editor-variant-panel"
            tabIndex={variant === item.id ? 0 : -1}
            onClick={() => setVariant(item.id)}
            onKeyDown={(event) => moveTab(event, item.id)}
          >
            <span>{item.label}</span>
            <code>{item.detail}</code>
          </button>
        ))}
      </div>
      <div
        id="editor-variant-panel"
        role="tabpanel"
        aria-labelledby={`editor-variant-${variant}`}
      >
        {variant === 'vanilla' ? (
          <VanillaEditor
            historyInitiallyOpen={historyInitiallyOpen}
            descriptionId={descriptionId}
          />
        ) : (
          <Suspense fallback={<div className="editor-loading">Loading the React adapter…</div>}>
            <ReactEditor
              historyInitiallyOpen={historyInitiallyOpen}
              descriptionId={descriptionId}
            />
          </Suspense>
        )}
      </div>
    </section>
  );
}
