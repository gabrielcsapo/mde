// The web mirror of `apple/Sources/MDEHost` — the same manifest, the same widget
// drawing, the same resolver contract, so the three demos are genuinely comparable.

/** Two custom block types and two custom inline tokens, all declarative. */
export const manifestSpec = {
  blocks: [
    {
      name: 'callout',
      syntax: { kind: 'fence', info: 'callout' },
      render: 'block_widget',
      reveal: 'caret_in_block',
    },
    {
      name: 'chart',
      syntax: { kind: 'directive', marker: ':::', name: 'chart' },
      render: 'block_widget',
      reveal: 'caret_in_block',
    },
  ],
  inlines: [
    {
      name: 'mention',
      syntax: { kind: 'pattern', regex: '@[a-zA-Z0-9_-]+' },
      render: 'inline_widget',
      reveal: 'caret_in_node',
    },
    {
      name: 'wikilink',
      syntax: { kind: 'delimited', open: '[[', close: ']]' },
      render: 'style',
      reveal: 'caret_in_node',
    },
  ],
};

export const sample = `# Inline rendering

Markdown stays **markdown**. Put the caret inside *any* node and its syntax comes back — nothing is hidden from you, and nothing is converted into a separate model.

Ordinary things work: \`inline code\`, [a link](https://example.dev), and ~~struck text~~.

> A quote renders with a rule in the margin.
> > And nesting carries depth.

- a plain bullet
- [ ] click this checkbox
- [x] this one is done

| Surface | Integration |
| :--- | :--- |
| Web | Vanilla JavaScript |
| Apple | Swift + TextKit 2 |

## Extensions

Ping @gabe about [[the roadmap]] — both of those come from the host app's manifest, not from this editor.

\`\`\`callout warning
A custom block type. The host draws it natively; the core only says where it starts and stops.
\`\`\`

\`\`\`swift
// An unregistered fence stays styled source.
let editor = MarkdownTextView()
\`\`\`

## References

The document holds a *reference*, never the bytes. This image is a short path the host resolves:

![a generated chart](chart.png)

Same for anything else the host can fetch — a document, a video, a remote asset:

![the spec](spec.pdf)

---
`;

/** @type {import('../../dist/types/src/widgets.js').WidgetProvider} */
export const widgetProvider = {
  makeWidget({ roleName, source, payload }) {
    switch (roleName) {
      case 'callout':
        return card(fenceBody(source), payload === 'warning' ? 'warning' : 'info');
      case 'chart':
        return card(`📊 ${payload ?? ''}`, 'info');
      case 'mention':
        return chip(source);
      default:
        return null;
    }
  },
};

/** @param {string} text @param {'info'|'warning'} tone */
function card(text, tone) {
  const el = document.createElement('div');
  el.className = `demo-card demo-card-${tone}`;
  el.textContent = text;
  return el;
}

/** @param {string} text */
function chip(text) {
  const el = document.createElement('span');
  el.className = 'demo-chip';
  el.textContent = text;
  return el;
}

/** Strip the ``` fence lines, keep the body. */
function fenceBody(source) {
  return source
    .split('\n')
    .slice(1)
    .filter((l) => !l.startsWith('```'))
    .join(' ')
    .trim();
}

/**
 * Resolves references against generated assets, asynchronously.
 *
 * This is the whole point: the note contains `![a chart](chart.png)` — a short path —
 * and the bytes live wherever the host keeps them. The same shape works for a remote
 * URL, a video, a blob store, or a document previewer; only this object changes.
 *
 * @type {import('../../dist/types/src/resources.js').ResourceResolver}
 */
export const resourceResolver = {
  async resolve({ reference }) {
    // A deliberate delay so the reserved-space -> loaded transition is visible rather
    // than a synchronous illusion.
    await new Promise((r) => setTimeout(r, 350));
    if (reference.endsWith('.png')) {
      const img = document.createElement('img');
      img.className = 'demo-image';
      img.src = chartDataURL();
      img.alt = reference;
      return { state: 'ready', view: img };
    }
    if (reference.endsWith('.pdf')) {
      return { state: 'ready', view: card(`📄 ${reference} · 48 KB`, 'info') };
    }
    return { state: 'failed', message: `cannot resolve ${reference}` };
  },

  reservedSize({ reference }) {
    // A real host would read dimensions from a sidecar or the filename. Reserving
    // something plausible is what stops the document jumping on load.
    return reference.endsWith('.png')
      ? { width: 420, height: 236 }
      : { width: 240, height: 34 };
  },
};

/** The same bar chart the Apple demo draws, so the three look alike. */
function chartDataURL() {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#17191f';
  ctx.fillRect(0, 0, 640, 360);
  const bars = [0.35, 0.62, 0.48, 0.81, 0.55, 0.93];
  const slot = (640 - 80) / bars.length;
  ctx.fillStyle = '#4f8cf2';
  bars.forEach((v, i) => {
    const h = (360 - 80) * v;
    ctx.fillRect(40 + slot * i + slot * 0.18, 360 - 40 - h, slot * 0.64, h);
  });
  return canvas.toDataURL('image/png');
}
