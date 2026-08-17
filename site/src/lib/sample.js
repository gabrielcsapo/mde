// The document the embedded editor opens with.
//
// Long, unwrapped lines on purpose: the buffer is the source, and the renderer draws
// the source's line structure literally, so a hard-wrapped paragraph would show its
// wrap.

export const sample = `# Try me

Markdown stays **markdown**. Put the caret inside *any* node and its syntax comes back — nothing is hidden from you, and nothing is converted into a separate model.

Ordinary things work: \`inline code\`, [a link](https://example.dev), and ~~struck text~~.

> A quote renders with a rule in the margin.
> > And nesting carries depth.

- a plain bullet
- [ ] click this checkbox
- [x] this one is done

| Surface | Integration |
| :--- | :--- |
| Web | JS or React |
| Apple | Swift + TextKit |

## Extensions

Ping @gabe about [[the roadmap]] — both of those come from the host app's manifest, not from this editor. So does the block below.

\`\`\`callout warning
A custom block type. The host draws it natively; the core only says where it starts and stops — click in here and the fence comes back.
\`\`\`

The renderer plugin below claims only HTML carrying the explicit \`data-mde-render\` marker. Click the card to reveal and edit its exact source.

<div data-mde-render="try-card" style="box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#142019;background:linear-gradient(135deg,#f2fff7,#e8f3ff);border:1px solid #9bc8ad;border-radius:16px;padding:18px 20px;box-shadow:0 8px 24px rgba(25,70,48,.12)"><div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#397a57">Renderer plugin</div><div style="font-size:22px;font-weight:750;margin-top:7px">Live HTML, editable source</div><div style="font-size:14px;line-height:1.45;margin-top:6px;color:#405349">The host owns this canvas. The Markdown document still owns every source character.</div><button onclick="this.textContent='Action ran ✓';this.style.background='#0f5132'" style="margin-top:13px;border:0;border-radius:999px;padding:8px 14px;background:#176b43;color:white;font:600 13px -apple-system,BlinkMacSystemFont,sans-serif">Run custom action</button></div>

\`\`\`swift
// An unregistered fence stays styled source.
let editor = MarkdownTextView()
\`\`\`

## References, not content

The document holds a *reference*, never the bytes — a short path the host resolves asynchronously, with space reserved so nothing jumps when it lands:

![a generated chart](chart.png)

Same for anything else the host can fetch — a document, a video, a remote asset:

![the spec](spec.pdf)

---
`;
