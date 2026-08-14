# @mde/web

The framework-free web renderer for mde. It owns a native `contenteditable` buffer and
uses the Rust/Wasm core to decide what every markdown range means.

```ts
import { MarkdownEditor, loadCore } from '@mde/web';
import '@mde/web/theme.css';

const core = await loadCore();
const editor = new MarkdownEditor(
  document.querySelector('#editor')!,
  core.newEngine(),
);
editor.setMarkdown('# Hello\n');
```

For multi-megabyte documents, prepare the exact Rust state in a Worker while the
editor presents the full source immediately. The source projection remains read-only
until activation, so input cannot race an engine describing another document:

```ts
import { prepareDocument } from '@mde/web';

const prepared = prepareDocument(markdown, { wasm: '/assets/mde.wasm' });
await editor.setMarkdownProgressively(markdown, prepared);
```

Prepared snapshots are tied to the exact Markdown and encoded manifest. A mismatch is
rejected rather than silently rendering the wrong decoration state.

Journal hosts can persist expensive video poster frames and audio waveforms across
editor instances. The host remains responsible for decoding because it owns resource
URLs and credentials; the cache owns stable size/version keys and bounded storage:

```ts
import { MediaPreviewCache } from '@mde/web';

const previews = new MediaPreviewCache({ maxEntries: 256 });
const poster = await previews.getOrCreate(
  { kind: 'video-poster', reference: asset.id, width: 640, version: asset.etag },
  () => generatePoster(asset),
);
```

Commands and bounded multi-document sessions are framework-neutral:

```ts
import { MarkdownSession, executeMarkdownCommand } from '@mde/web';

const session = new MarkdownSession(editor, { maxDocuments: 12 });
session.open('today', '# Today\n');
executeMarkdownCommand(editor, 'bold');
session.open('yesterday', '# Yesterday\n'); // saves Today before switching
session.switchTo('today');
```

React is deliberately not a dependency or bundled entry point. Use `@mde/react` for the
React adapter. Optional extensions are separate imports:

```ts
import { TypewriterMode } from '@mde/web/extensions/typewriter';
```

## Plugins

Runtime extensions have a scoped lifecycle. Listeners registered with `context.on` and
layers created with `context.setLayer` are removed automatically when the plugin is
removed, its setup fails, or the editor is destroyed. Local layer names are qualified by
plugin name, so packages cannot overwrite each other accidentally.

```ts
import {
  MarkdownEditor,
  composePluginManifests,
  definePlugin,
  encodeManifest,
} from '@mde/web';

const comments = definePlugin({
  name: 'com.example.comments',
  manifest: {
    inlines: [{
      name: 'comment-anchor',
      syntax: { kind: 'pattern', regex: '\\[\\^comment-[0-9]+\\]' },
      render: 'hit',
    }],
  },
  setup(context) {
    const role = context.internRole('active-comment');
    context.on('selectionchange', () => {
      context.setLayer('active', activeCommentSpans(context.editor, role));
    });
    return () => disconnectCommentSession();
  },
});

const manifest = composePluginManifests(null, [comments]);
const engine = core.newEngine(encodeManifest(manifest));
const editor = new MarkdownEditor(host, engine);
editor.installPlugin(comments);
```

`composeManifests` also combines plain manifest objects and rejects duplicate block or
inline names before engine construction. A pre-encoded manifest cannot be combined with
plugin syntax because its definitions are no longer inspectable.

For document-wide analysis, use the context scheduler instead of owning timers. Calls
with the same name coalesce, stale work receives an `AbortSignal`, and removal prevents
late results from repainting. Put CPU-heavy work in a Worker and await its response:

```ts
context.on('change', () => {
  context.scheduleAnalysis(
    'lint',
    ({ markdown, signal }) => lintWorker.run(markdown, { signal }),
    (spans) => context.setLayer('lint', spans),
    { delayMs: 100, budgetMs: 16 },
  );
});
```

Every analysis emits `plugindiagnostic` with its duration, budget status, sequence, and
cancellation state; compatibility reports include those diagnostics.

Plugins can also add lifecycle-owned canvas UI without placing presentation text inside
the contenteditable document. This shipped extension provides `@` autocomplete and a
Command-O image/video/link composer; the same plugin object works through `@mde/react`:

```ts
import {
  attachmentComposer,
  mentionAutocomplete,
} from '@mde/web/extensions/composer';
import '@mde/web/extensions.css';

editor.installPlugin(mentionAutocomplete({
  candidates: [{ handle: 'gabe', label: 'Gabriel' }],
}));
editor.installPlugin(attachmentComposer());
```

Package authors build the same behavior from `context.showPresentation`,
`dismissPresentation`, `registerCommand`, and `onRoot`. All owned views, shortcuts, and
listeners disappear automatically on plugin removal or editor teardown.

Plugin packages can verify the portable lifecycle without depending on a particular
test framework:

```ts
import { checkPluginCompatibility } from '@mde/web/plugin-testing';

expect(await checkPluginCompatibility(editor, comments)).toMatchObject({
  installed: true,
  removed: true,
  sourcePreserved: true,
  cleanupRemovedLayers: true,
});
```

Build with `pnpm run build`. Vite emits the ESM library and Wasm asset; TypeScript emits
declarations from the same source.

Browser tests run against the built package in real Chromium through Vitest Browser Mode:

```sh
pnpm run test:install-browser # once on a fresh machine
pnpm test
pnpm run test:watch           # visible browser during development
```
