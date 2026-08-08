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

React is deliberately not a dependency or bundled entry point. Use `@mde/react` for the
React adapter. Optional extensions are separate imports:

```ts
import { TypewriterMode } from '@mde/web/extensions/typewriter';
```

Build with `npm run build`. Vite emits the ESM library and Wasm asset; TypeScript emits
declarations from the same source.

