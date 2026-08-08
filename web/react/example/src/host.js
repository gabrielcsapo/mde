// What a host app supplies: an extension manifest, a widget provider, a resource
// resolver. None of it is React-specific — these are the same plain objects the
// framework-free demo and the Apple apps pass, which is the point.

/** @type {import('@mde/react').ManifestSpec} */
export const manifestSpec = {
  blocks: [
    {
      name: 'callout',
      syntax: { kind: 'fence', info: 'callout' },
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

export const sample = `# React wrapper

Markdown stays **markdown**. Put the caret inside *any* node and its syntax comes back.

Ordinary things work: \`inline code\`, [a link](https://example.dev), ~~struck text~~.

> A quote renders with a rule in the margin.

- a plain bullet
- [ ] click this checkbox
- [x] this one is done

Ping @gabe about [[the roadmap]] — both come from the host's manifest.

\`\`\`callout warning
A custom block type. The host draws it; the core only says where it starts and stops.
\`\`\`

The document holds a *reference*, never the bytes:

![a generated chart](chart.png)
`;

export const second = `## A second editor

Two editors on one page share a single compiled wasm module. Type here and the other one
is unaffected — separate engines, separate histories, one core.

Ping @someone-else.
`;

/** @type {import('@mde/react').WidgetProvider} */
export const widgetProvider = {
  makeWidget({ roleName, source, payload }) {
    switch (roleName) {
      case 'callout':
        return card(fenceBody(source), payload === 'warning' ? 'warning' : 'info');
      case 'mention':
        return chip(source);
      default:
        return null;
    }
  },
};

/** @type {import('@mde/react').ResourceResolver} */
export const resourceResolver = {
  async resolve({ reference }) {
    await new Promise((r) => setTimeout(r, 250));
    if (reference.endsWith('.png')) {
      const img = document.createElement('img');
      img.className = 'demo-image';
      img.src = chartDataURL();
      img.alt = reference;
      return { state: 'ready', view: img };
    }
    return { state: 'failed', message: `cannot resolve ${reference}` };
  },
  reservedSize({ reference }) {
    return reference.endsWith('.png')
      ? { width: 420, height: 236 }
      : { width: 240, height: 34 };
  },
};

function card(text, tone) {
  const el = document.createElement('div');
  el.className = `demo-card demo-card-${tone}`;
  el.textContent = text;
  return el;
}

function chip(text) {
  const el = document.createElement('span');
  el.className = 'demo-chip';
  el.textContent = text;
  return el;
}

function fenceBody(source) {
  return source
    .split('\n')
    .slice(1)
    .filter((l) => !l.startsWith('```'))
    .join(' ')
    .trim();
}

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
