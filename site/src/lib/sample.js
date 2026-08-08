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
| Apple | Swift + TextKit 2 |

## Extensions

Ping @gabe about [[the roadmap]] — both of those come from the host app's manifest, not from this editor. So does the block below.

\`\`\`callout warning
A custom block type. The host draws it natively; the core only says where it starts and stops — click in here and the fence comes back.
\`\`\`

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
