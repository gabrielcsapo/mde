# mdink

A native inline Markdown editor backed by one Rust parsing core. The web renderer
uses `contenteditable` and WebAssembly; the Apple renderers use TextKit 1 through
`UITextView` on iOS and `NSTextView` on macOS. All renderers preserve Markdown as the
source of truth.

## Web

```sh
pnpm add @mdink/web
```

```js
import { MarkdownEditor, loadCore } from '@mdink/web';
import wasmUrl from '@mdink/web/mde.wasm?url';
import '@mdink/web/theme.css';

const core = await loadCore(wasmUrl);
const editor = new MarkdownEditor(
  document.querySelector('#editor'),
  core.newEngine(),
);

editor.setMarkdown('# Hello\n\nMarkdown stays **Markdown**.');
```

## React

```sh
pnpm add @mdink/react @mdink/web
```

```jsx
import { MarkdownEditor } from '@mdink/react';
import wasmUrl from '@mdink/web/mde.wasm?url';
import '@mdink/web/theme.css';

export function Editor() {
  return <MarkdownEditor wasm={wasmUrl} defaultValue="# Hello" />;
}
```

## Swift

The Swift package is in `apple/`. For a local checkout, add `apple/` as a local package
dependency and select the `MDEditorUI` product:

```swift
import MDEditorUI

let editor = MarkdownTextView()
editor.setMarkdown("# Hello\n\nMarkdown stays **Markdown**.")
```

Remote Swift Package Manager distribution needs the repository and release-asset URL to
be connected first; the exact one-time setup is documented in [RELEASING.md](RELEASING.md).

## Development

```sh
pnpm install
pnpm build:site
pnpm test
```

When the native editor UI changes, refresh both hero recordings and the embedded
before/after report with one command:

```sh
pnpm capture:native-hero
```

The command rebuilds the iPhone and Mac reference apps, records the same Markdown edit
through UIKit/TextKit and AppKit/TextKit, validates both videos and their posters, then
regenerates `reports/before-after.html`.

Release notes are managed with Changesets. See [RELEASING.md](RELEASING.md) for the npm
local npm publishing with two-factor authentication and the Swift release checklist.

## GitHub Pages

In the repository's **Settings → Pages → Build and deployment**, set **Source** to
**GitHub Actions**. The `Deploy site to GitHub Pages` workflow builds the packages and
site, then publishes `site/dist` on pushes to `main`. It can also be run manually on
`main` from the Actions tab. The default site URL is https://gabrielcsapo.github.io/mdink/.

The workflow reads the base path from GitHub Pages, including custom-domain settings.
To check the project-path build locally:

```sh
SITE_BASE_PATH=/mdink/ pnpm build:site
SITE_BASE_PATH=/mdink/ pnpm preview:site
```

Open the preview at `/mdink/`. The build includes `404.html` so direct documentation links
can load the app on GitHub Pages (with an HTTP 404 status for those fallback requests).
