// The excerpts this site quotes, tagged by `highlight.js`.
//
// These are excerpts, not imports: trimmed and occasionally re-indented so they read at
// a glance. They are quotations of the real files — every one of them was copied from
// the path in its caption — but a quotation is not the file, and nothing here is loaded
// at runtime. The one exception is the editor on the Try it page, which imports the
// actual modules rather than quoting them.

import { tag } from './highlight.js';

// ---------------------------------------------------------------- the protocol

export const decorationRs = tag(
  'rust',
  `struct Decoration {
    start:  u32,     // UTF-16 code units — converted once, in the core, on the way out
    end:    u32,
    kind:   Kind,    // Style · Conceal · InlineWidget · BlockWidget · Gutter · Hit
    role:   RoleId,  // interned; an open set, so themes extend without protocol changes
    reveal: Reveal,  // Never · CaretInNode · CaretInLine · CaretInBlock
    depth:  u8,      // nesting level for quotes and lists
    key:    u64,     // hash(role, source slice, sibling disambiguator)
}`
);

export const patchRs = tag(
  'rust',
  `struct Patch {
    removed: Vec<u64>,              // keys
    added:   Vec<Decoration>,
    moved:   Vec<(u64, u32, u32)>,  // key, new start, new end — no rebuild
}`
);

// ---------------------------------------------------------------- history

export const historyApi = tag(
  'text',
  `revisions()        -> [{index, at_ms, inserted, removed, kind, at}]
history_position() -> how many revisions are applied
jump_to(n)         -> land anywhere in the timeline`
);

export const historyJs = tag(
  'javascript',
  `// A history panel, in about as much code as it takes to describe one.
const timeline = editor.revisions;        // oldest first, undone ones included
const applied = editor.historyPosition;   // where you are in it

for (const r of timeline) {
  const label = r.kind === 0 ? \`+\${r.inserted}\`
              : r.kind === 1 ? \`−\${r.removed}\`
              : \`\${r.removed}→\${r.inserted}\`;
  row(label, new Date(r.atMs), r.index < applied ? 'applied' : 'undone');
}

editor.jumpTo(0);   // the empty document, in one splice
editor.jumpTo(timeline.length);   // back to the newest revision`
);

export const historySwift = tag(
  'swift',
  `let timeline = editor.revisions          // [Revision], oldest first
let applied = editor.historyPosition      // Int

// Revision is Identifiable, so a SwiftUI List over it needs nothing else.
editor.jump(to: revision.index + 1)`
);

// ---------------------------------------------------------------- extensions

export const extensionsToml = tag(
  'toml',
  `[[block]]
name   = "callout"
syntax = { kind = "fence", info = "callout" }   # \`\`\`callout
render = "block_widget"
reveal = "caret_in_block"

[[block]]
name   = "chart"
syntax = { kind = "directive", marker = ":::", name = "chart" }
render = "block_widget"
reveal = "caret_in_block"

[[inline]]
name   = "mention"
syntax = { kind = "pattern", regex = "@[a-zA-Z0-9_-]+" }
render = "inline_widget"
reveal = "caret_in_node"

[[inline]]
name   = "wikilink"
syntax = { kind = "delimited", open = "[[", close = "]]" }
render = "style"
reveal = "caret_in_node"`
);

export const manifestJs = tag(
  'javascript',
  `// The web build drops the TOML parser — it cost ~350 KB of wasm for a parse that
// happens once — and takes the same manifest as a plain object instead.
export const manifestSpec = {
  blocks: [
    { name: 'callout', syntax: { kind: 'fence', info: 'callout' },
      render: 'block_widget', reveal: 'caret_in_block' },
  ],
  inlines: [
    { name: 'mention', syntax: { kind: 'pattern', regex: '@[a-zA-Z0-9_-]+' },
      render: 'inline_widget', reveal: 'caret_in_node' },
  ],
};

const engine = core.newEngine(encodeManifest(manifestSpec));`
);

export const manifestBinary = tag(
  'text',
  `[4] magic "MDEM"
[4] u32 block_count
[4] u32 inline_count
block_count  x  { u8 render, u8 reveal, u8 syntax, u8 _pad, str name, str a, str b }
inline_count x  { u8 render, u8 reveal, u8 syntax, u8 _pad, str name, str a, str b }
str := u32 byte_len, then that many UTF-8 bytes

syntax  0 = fence / pattern, 1 = directive / delimited
        fence:     a = info string,  b = empty
        directive: a = marker,       b = name
        pattern:   a = regex,        b = empty
        delimited: a = open,         b = close`
);

export const hostJs = tag(
  'javascript',
  `export const widgetProvider = {
  makeWidget({ roleName, source, payload }) {
    switch (roleName) {
      case 'callout':
        return card(fenceBody(source), payload === 'warning' ? 'warning' : 'info');
      case 'chart':
        return card(\`📊 \${payload ?? ''}\`, 'info');
      case 'mention':
        return chip(source);
      default:
        return null;
    }
  },
};`
);

export const resolverJs = tag(
  'javascript',
  `export const resourceResolver = {
  async resolve({ reference }) {
    if (reference.endsWith('.png')) {
      const img = document.createElement('img');
      img.src = await urlFor(reference);   // wherever this host keeps its assets
      return { state: 'ready', view: img };
    }
    return { state: 'failed', message: \`cannot resolve \${reference}\` };
  },

  // Space to hold while it loads, so the document does not jump when it lands.
  reservedSize({ reference }) {
    return reference.endsWith('.png') ? { width: 420, height: 236 } : { width: 240, height: 34 };
  },
};`
);

// ---------------------------------------------------------------- layers

export const layerApi = tag(
  'text',
  `intern_role(name) -> RoleId             # roles are open strings; invent one at runtime
set_layer(name, [{range, role, kind}])  # replace the layer, get a patch back
clear_layer(name)`
);

export const typewriterJs = tag(
  'javascript',
  `// web/extensions/typewriter.js — the whole of what it does to the editor.
recompute() {
  const text = this.editor.markdown;
  const sel = this.editor.selectionRange();

  // No caret means no focus: dimming an entire document because the editor lost
  // focus would be a strange thing to look at.
  if (!sel) return this.editor.setLayer(TypewriterMode.LAYER, []);

  const [start, end] = paragraphAround(text, sel.start);
  const spans = [];
  if (start > 0) spans.push({ start: 0, end: start, role: this.dimRole });
  if (end < text.length) spans.push({ start: end, end: text.length, role: this.dimRole });
  if (end > start) spans.push({ start, end, role: this.focusRole });
  this.editor.setLayer(TypewriterMode.LAYER, spans);
}`
);

export const posSwift = tag(
  'swift',
  `// apple/Sources/MDEHost/PartsOfSpeech.swift
let tagger = NLTagger(tagSchemes: [.lexicalClass])
tagger.string = text

var spans: [LayerSpan] = []
tagger.enumerateTags(
    in: text.startIndex ..< text.endIndex,
    unit: .word,
    scheme: .lexicalClass,
    options: [.omitWhitespace, .omitPunctuation, .omitOther]
) { tag, range in
    guard let tag, let role = roles[tag] else { return true }
    // NSRange from String.Index, so the offsets are UTF-16 — which is what every
    // boundary in this API speaks.
    spans.append(LayerSpan(range: NSRange(range, in: text), role: role))
    return true
}
editor.setLayer(Self.layer, spans)`
);

export const posWebJs = tag(
  'javascript',
  `// web/extensions/parts-of-speech.js — a heuristic, and labelled as one.
export function tagWord(word) {
  const w = word.toLowerCase();

  // Closed classes are decided by membership, and only then do suffix rules run.
  // A suffix rule that fired first would call "the" an adjective.
  if (DETERMINERS.has(w) || PRONOUNS.has(w) || PREPOSITIONS.has(w) || CONJUNCTIONS.has(w)) {
    return null;
  }
  if (ADVERBS.has(w)) return 'adverb';
  if (VERBS.has(w)) return 'verb';
  if (ADJECTIVES.has(w)) return 'adjective';

  // "-ly" is the strongest suffix signal in English, but "reply" and "apply" are not
  // adverbs, so require something before it that looks like a stem.
  if (w.length > 4 && w.endsWith('ly') && !/[aeiou]ly$/.test(w)) return 'adverb';
  ...
}`
);

export const toolbarJs = tag(
  'javascript',
  `// site/src/lib/toolbar.js — what adding either feature to this page cost.
{
  id: 'typewriter',
  label: 'Typewriter',
  title: 'Focus mode: dim everything but the paragraph under the caret.',
  pressed: (editor) => extensionFor(editor, 'typewriter', TypewriterMode).enabled,
  run: (editor) => extensionFor(editor, 'typewriter', TypewriterMode).toggle(),
}`
);

export const themeRolesSwift = tag(
  'swift',
  `// An extension that invents a role brings its appearance with it: the editor's Theme
// knows what the *parser* produces and nothing else.
public static func themeRoles(bodyFont: PlatformFont) -> [String: [NSAttributedString.Key: Any]] {
    [
        "typewriter-dim": [.foregroundColor: PlatformColor.platformTertiaryLabel],
        "typewriter-focus": [
            .foregroundColor: PlatformColor.platformLabel,
            .font: bodyFont.withSize(bodyFont.pointSize + 1),
        ],
    ]
}`
);

export const extensionCss = tag(
  'text',
  `/* web/extensions/extensions.css — the web half of the same idea. An unknown role
   becomes .mde-ext-<name>, so styling one is a matter of writing CSS. */
.mde-ext-pos-noun      { color: #2f6bf5; }
.mde-ext-pos-verb      { color: #c2410c; }
.mde-ext-pos-adjective { color: #7c3aed; }
.mde-ext-pos-adverb    { color: #0f766e; }`
);

// ---------------------------------------------------------------- embedding

export const buildBash = tag(
  'bash',
  `./scripts/build-web.sh    # cargo build -p mde-wasm --target wasm32-unknown-unknown
                          # → web/mde.wasm (~360 KB)

./scripts/build-rust.sh   # aarch64-apple-darwin, -ios, -ios-sim
                          # → apple/MDECore.xcframework`
);

export const mountJs = tag(
  'javascript',
  `import { loadCore, Role } from './src/core.js';
import { encodeManifest } from './src/manifest.js';
import { MarkdownEditor } from './src/editor.js';

const core = await loadCore('./mde.wasm');
const engine = core.newEngine(encodeManifest(manifestSpec));

const editor = new MarkdownEditor(document.getElementById('editor'), engine, {
  widgetProvider,      // optional — draws replaced ranges
  resourceResolver,    // optional — turns a reference into a view
});

editor.setMarkdown('# Hello\\n\\nMarkdown stays **markdown**.');

editor.addEventListener('change', () => save(editor.markdown));
editor.addEventListener('hit', (e) => {
  if (e.detail.decoration.role === Role.TaskCheckbox) editor.toggleTask(e.detail.decoration);
});`
);

export const mountHtml = tag(
  'text',
  `<link rel="stylesheet" href="web/src/theme.css">

<div id="editor"></div>
<script type="module" src="./boot.js"></script>`
);

export const mountSwift = tag(
  'swift',
  `import MDECore
import MDEditorUI

let editor = MarkdownTextView(manifest: HostExtensions.manifest, theme: theme)
editor.widgetProvider = HostWidgets()
// References in the document resolve against a directory on disk — the note holds
// \`![a chart](chart.png)\`, never the image itself.
editor.resourceResolver = DiskResourceResolver(root: assetsDirectory)
editor.resourceSizes = ResourceSizeStore.load()
editor.markdownDelegate = self

editor.setMarkdown(document)`
);

export const packageSwift = tag(
  'swift',
  `.package(path: "../mardown-editor/apple")

// The package builds three products:
//   MDECore      the engine and its value types
//   MDEditorUI   MarkdownTextView, DecorationApplier, Theme
//   MDEHost      the reference host: manifest, widgets, resolver, both extensions`
);

// ---------------------------------------------------------------- react

export const reactBasicJsx = tag(
  'javascript',
  `import { MarkdownEditor } from '@mde/react';
import '../vendor/mardown-editor/web/src/theme.css'; // wherever you vendored it

export function Editor({ note, onSave }) {
  return (
    <MarkdownEditor
      defaultValue={note}
      manifest={manifestSpec}
      widgetProvider={widgetProvider}
      resourceResolver={resourceResolver}
      onChange={(markdown) => onSave(markdown)}
      className="note-editor"
    />
  );
}`
);

export const reactCommandsJsx = tag(
  'javascript',
  `const editor = useMarkdownEditorRef();
const [history, setHistory] = useEditorHistory();

return (
  <>
    <button onClick={() => editor.current?.wrapSelection('**')}>Bold</button>
    <button disabled={!history.canUndo} onClick={() => editor.current?.undo()}>Undo</button>
    <button disabled={!history.canRedo} onClick={() => editor.current?.redo()}>Redo</button>

    <MarkdownEditor ref={editor} defaultValue={note} onHistoryChange={setHistory} />
  </>
);`
);

export const reactHistoryJsx = tag(
  'javascript',
  `// Only re-read the timeline when it actually moved.
const revisions = useMemo(
  () => ref.current?.getRevisions() ?? [],
  [history.count, history.position]
);

return revisions.map((r) => (
  <button key={r.index} onClick={() => ref.current.jumpTo(r.index + 1)}>
    +{r.inserted}
  </button>
));`
);

export const reactLayersJsx = tag(
  'javascript',
  `// A layer is what the host says it is; the core diffs it and repaints what changed.
const layers = {
  matches: hits.map(({ start, end }) => ({ start, end, role: 'search-hit' })),
};

<MarkdownEditor defaultValue={note} layers={layers} />

/* .mde-ext-search-hit { background: rgba(255, 215, 0, .35); } */`
);

// ---------------------------------------------------------------- FFI

export const mdeH = tag(
  'c',
  `// All text offsets are UTF-16 code units, matching NSTextStorage.

// \`manifest\` is NUL-terminated TOML, or NULL for no extensions. Returns NULL if the
// manifest fails to parse.
MdeEngine *mde_engine_new(const char *manifest);
void       mde_engine_free(MdeEngine *e);

// Returned pointers are engine-owned and invalidated by the next call on that engine.
const MdePatch *mde_reset(MdeEngine *e, const uint8_t *text, size_t len);
const MdePatch *mde_edit(MdeEngine *e, const MdeEdit *edits, size_t n,
                         uint32_t expected_len, uint64_t now_ms);
const MdePatch *mde_set_selection(MdeEngine *e, uint32_t anchor, uint32_t head);
const MdePatch *mde_clear_selection(MdeEngine *e);`
);

export const mdeStructsH = tag(
  'c',
  `typedef struct {
    uint32_t start;
    uint32_t end;
    uint64_t key;
    uint32_t role;
    uint8_t  kind;
    uint8_t  reveal;
    uint8_t  depth;
    /* Paint order among ties. 0 = derived from the markdown; higher values are
       host-supplied layers, painted after the parse and in ascending order. */
    uint8_t  layer;
} MdeDecoration;

typedef struct {
    uint32_t status;
    const uint64_t     *removed;   size_t removed_len;
    const MdeDecoration *added;    size_t added_len;
    const MdeMove       *moved;    size_t moved_len;
} MdePatch;`
);

export const wasmReadJs = tag(
  'javascript',
  `// web/src/core.js — the same bytes Swift reads as an UnsafeBufferPointer.
readPatch() {
  const view = new DataView(exports.memory.buffer, exports.mde_patch_ptr(), len);
  ...
  for (let i = 0; i < addedLen; i++, off += DECORATION_SIZE) {
    added.push({
      start:  view.getUint32(off, true),
      end:    view.getUint32(off + 4, true),
      key:    view.getBigUint64(off + 8, true),
      role:   view.getUint32(off + 16, true),
      kind:   view.getUint8(off + 20),
      reveal: view.getUint8(off + 21),
      depth:  view.getUint8(off + 22),
      layer:  view.getUint8(off + 23),
    });
  }
}`
);
