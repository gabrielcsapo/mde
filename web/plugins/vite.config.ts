import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
const here = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({ build: { outDir: 'dist', emptyOutDir: true, sourcemap: true, lib: { entry: { suggestions: `${here}src/suggestions.ts`, attachments: `${here}src/attachments.ts`, productivity: `${here}src/productivity.ts`, composer: `${here}src/composer.ts`, examples: `${here}src/examples.ts`, typewriter: `${here}src/typewriter.ts`, 'parts-of-speech': `${here}src/parts-of-speech.ts` }, formats: ['es'], fileName: (_format, name) => `${name}.js` }, rollupOptions: { external: [/^@mde\//] } } });
