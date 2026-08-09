import { fileURLToPath } from 'node:url';
import { chmod, copyFile } from 'node:fs/promises';

import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

const here = fileURLToPath(new URL('.', import.meta.url));
const supportedBrowsers = ['chromium', 'firefox', 'webkit'] as const;
const requestedBrowsers = (process.env.MDE_BROWSERS ?? 'chromium').split(',');
const browserInstances = requestedBrowsers.map((name) => {
  const browser = supportedBrowsers.find((candidate) => candidate === name.trim());
  if (!browser) throw new Error(`unsupported MDE_BROWSERS entry: ${name}`);
  return { browser };
});

export default defineConfig({
  publicDir: false,
  plugins: [
    {
      name: 'copy-wasm-core',
      async writeBundle() {
        await copyFile(`${here}mde.wasm`, `${here}dist/mde.wasm`);
        await chmod(`${here}dist/mde.wasm`, 0o644);
      },
    },
  ],
  build: {
    assetsInlineLimit: 0,
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: true,
    lib: {
      entry: {
        index: `${here}src/index.ts`,
        'extensions/typewriter': `${here}extensions/typewriter.ts`,
        'extensions/parts-of-speech': `${here}extensions/parts-of-speech.ts`,
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    include: ['test/**/*.browser.test.js'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: browserInstances,
    },
  },
});
