import { fileURLToPath } from 'node:url';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';

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
  // This workspace contains the `web/react/` package. Without exact aliases Vite's
  // dependency optimiser can mistake that directory for the bare `react` package when
  // a browser test lives beneath it, producing two runtimes (or bundling the adapter as
  // React itself). Keep the integration test on the peer runtime a consumer receives.
  resolve: {
    alias: [
      {
        find: /^react$/,
        replacement: fileURLToPath(new URL('./node_modules/react/index.js', import.meta.url)),
      },
      {
        find: /^react-dom$/,
        replacement: fileURLToPath(new URL('./node_modules/react-dom/index.js', import.meta.url)),
      },
      {
        find: /^react-dom\/client$/,
        replacement: fileURLToPath(new URL('./node_modules/react-dom/client.js', import.meta.url)),
      },
    ],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client'],
  },
  define: {
    __MDE_PERF__: JSON.stringify(process.env.MDE_PERF === '1'),
    __MDE_PERF_BUDGETS__: JSON.stringify({
      load100KB: Number(process.env.MDE_WEB_100KB_LOAD_BUDGET_MS ?? 100),
      load1MB: Number(process.env.MDE_WEB_1MB_LOAD_BUDGET_MS ?? 750),
      edit100KB: Number(process.env.MDE_WEB_100KB_EDIT_BUDGET_MS ?? 75),
      edit1MB: Number(process.env.MDE_WEB_1MB_EDIT_BUDGET_MS ?? 450),
      layer1MB: Number(process.env.MDE_WEB_1MB_LAYER_BUDGET_MS ?? 25),
      typewriter100KB: Number(process.env.MDE_WEB_100KB_TYPEWRITER_BUDGET_MS ?? 50),
      scroll1MB: Number(process.env.MDE_WEB_1MB_SCROLL_BUDGET_MS ?? 50),
      maxDomNodes1MB: Number(process.env.MDE_WEB_1MB_DOM_NODE_BUDGET ?? 210000),
    }),
  },
  publicDir: false,
  plugins: [
    {
      name: 'copy-wasm-core',
      configureServer(server) {
        server.middlewares.use('/__mde_perf_report', (request, response, next) => {
          if (request.method !== 'POST') {
            next();
            return;
          }
          const chunks: Buffer[] = [];
          request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          request.on('end', async () => {
            const directory = `${here}../target/performance`;
            await mkdir(directory, { recursive: true });
            await writeFile(`${directory}/web-metrics.json`, Buffer.concat(chunks));
            response.writeHead(204).end();
          });
        });
      },
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
    include: ['test/**/*.browser.test.js', 'react/test/**/*.browser.test.js'],
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
