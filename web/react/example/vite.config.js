import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const web = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    // `@mde/react` is a `file:` dependency, so it resolves to `web/react` and imports the
    // editor from `web/src` and the wasm from `web/mde.wasm` — all outside this app's
    // root. Vite has to be told those are allowed to be served.
    fs: { allow: [web] },
  },
  optimizeDeps: {
    // The package is plain ES modules living in the repo, not a built artifact. Leave it
    // out of the dependency pre-bundle so an edit to it is picked up immediately and so
    // `new URL('../../mde.wasm', import.meta.url)` keeps resolving against the source.
    exclude: ['@mde/react'],
  },
});
