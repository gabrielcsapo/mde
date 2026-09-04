import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// `site/assets` is written by the capture tooling and read at runtime: the gallery
// fetches `assets/manifest.json` and the manifest names its files as plain strings, so
// those URLs have to stay exactly what the manifest says. Nothing in the module graph
// references them, so Vite neither knows nor needs to know about them — they are served
// from where they are in dev and copied verbatim into `dist/` after a build.
//
// (The fonts are different: the stylesheet does reference them, so Vite owns them. See
// `assetFileNames` below for why they keep their names.)
function staticDirs(names) {
  return {
    name: 'mde-static-dirs',

    configureServer(server) {
      for (const name of names) {
        server.middlewares.use(`/${name}`, (req, res, next) => {
          // `req.url` is already stripped of the mount prefix here.
          const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
          const file = path.join(here, name, rel);
          // Refuse anything that escapes the directory before touching the disk.
          if (!file.startsWith(path.join(here, name) + path.sep)) return next();
          fs.stat(file, (err, stat) => {
            if (err || !stat.isFile()) return next();
            res.setHeader('Cache-Control', 'no-store');
            const type = MIME[path.extname(file).toLowerCase()];
            if (type) res.setHeader('Content-Type', type);
            fs.createReadStream(file).pipe(res);
          });
        });
      }
    },

    closeBundle() {
      for (const name of names) {
        const from = path.join(here, name);
        if (!fs.existsSync(from)) continue;
        fs.cpSync(from, path.join(here, 'dist', name), { recursive: true });
      }
    },
  };
}

/**
 * Builds the search corpus from the documentation pages, at build time, in Node.
 *
 * Search has to know what the pages say, and the pages say it in JSX. The alternatives
 * were both worse: repeating every heading and paragraph into a hand-written index is a
 * second copy that silently rots, and importing the page sources with `?raw` would ship
 * ~110 KB of unrendered JSX — tags, class attributes and all — to every visitor so the
 * browser could strip it again on load.
 *
 * So the stripping happens here and the bundle gets only the result: for each page, the
 * text under each `H2`/`H3`, keyed by the id that heading already carries as its deep
 * link. `src/lib/search.js` joins it to the titles in `docs/nav.js` and the symbol lists
 * in `lib/api.js`, neither of which needs extracting because both are already data.
 *
 * This is a text extractor, not a JSX parser, and it does not need to be one: it is
 * reading files written by this site for the purpose, and the worst case for a mistake
 * is a slightly noisy search result.
 */
function docsSearchCorpus() {
  const VIRTUAL = 'virtual:mde-docs-corpus';
  const RESOLVED = `\0${VIRTUAL}`;
  const dir = path.join(here, 'src/docs/pages');

  /** Strip JSX down to the words a reader would see. */
  const plain = (chunk) =>
    chunk
      // Attributes and tags. Done first, so class names never reach the corpus.
      .replace(/<[^>]*>/g, ' ')
      // JSX expression braces, template marks, and the quoting around string literals.
      .replace(/[{}`]/g, ' ')
      .replace(/&[a-z]+;/g, ' ')
      .replace(/[^\p{L}\p{N}\-_.#/]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  function extract(source) {
    // Comments are notes to whoever edits the page, not to whoever reads it.
    const src = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

    const heading = /<(H2|H3)\s+id="([^"]+)"\s*>([\s\S]*?)<\/\1>/g;
    const found = [];
    let m;
    while ((m = heading.exec(src)) !== null) {
      found.push({ id: m[2], title: plain(m[3]), at: m.index, after: heading.lastIndex });
    }

    const sections = [];
    // Everything before the first heading is the page's opening, and belongs to the page
    // itself rather than to any section of it.
    const lead = plain(src.slice(0, found.length ? found[0].at : src.length));
    if (lead) sections.push({ id: null, title: null, text: lead });

    found.forEach((h, i) => {
      const end = i + 1 < found.length ? found[i + 1].at : src.length;
      sections.push({ id: h.id, title: h.title, text: plain(src.slice(h.after, end)) });
    });
    return sections;
  }

  function build() {
    if (!fs.existsSync(dir)) return {};
    const out = {};
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.jsx')) continue;
      out[name.replace(/\.jsx$/, '')] = extract(fs.readFileSync(path.join(dir, name), 'utf8'));
    }
    return out;
  }

  return {
    name: 'mde-docs-corpus',
    resolveId: (id) => (id === VIRTUAL ? RESOLVED : null),
    load: (id) => (id === RESOLVED ? `export const corpus = ${JSON.stringify(build())};` : null),
    // Editing a page in development has to re-extract it, or search goes stale against
    // a page the reader can already see has changed.
    handleHotUpdate({ file, server }) {
      if (!file.startsWith(dir)) return;
      const mod = server.moduleGraph.getModuleById(RESOLVED);
      if (!mod) return;
      server.moduleGraph.invalidateModule(mod);
      server.ws.send({ type: 'full-reload' });
    },
  };
}

/**
 * Deep links are real paths, so a static host has to answer `/docs/concepts/reveal` with the
 * app rather than a 404. Vite's own dev server and `vite preview` already do; hosts that
 * do not, conventionally serve `404.html`, so the build leaves a copy of `index.html`
 * under that name. It costs 2 KB and removes a whole class of "works locally" bug.
 */
function spaFallbackCopy() {
  return {
    name: 'mde-spa-fallback',
    closeBundle() {
      const index = path.join(here, 'dist', 'index.html');
      if (fs.existsSync(index)) fs.copyFileSync(index, path.join(here, 'dist', '404.html'));
    },
  };
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export default defineConfig({
  root: here,
  base: process.env.SITE_BASE_PATH || '/',
  plugins: [react(), tailwind(), staticDirs(['assets']), docsSearchCorpus(), spaFallbackCopy()],
  server: {
    fs: {
      // The page imports the *real* editor from `web/src` and loads `web/mde.wasm`,
      // rather than a copy — that is the whole point of the live demo, so the dev
      // server has to be allowed to read one level above its root.
      allow: [repoRoot],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Vite's own output goes to `dist/static/`, which leaves `dist/assets/` to mean
    // exactly one thing: the native captures, at the paths `manifest.json` names.
    assetsDir: 'static',
    rollupOptions: {
      output: {
        assetFileNames(info) {
          // The two woff2 faces keep their names and land back at `/fonts/…`. They are
          // preloaded by `index.html`, and a preload can only name a URL that is known
          // before the build runs — so a content hash here would mean the browser
          // fetching each face twice, once for the preload and once for the stylesheet.
          const name = info.names?.[0] ?? info.name ?? '';
          if (name.endsWith('.woff2')) return 'fonts/[name][extname]';
          return 'static/[name]-[hash][extname]';
        },
      },
    },
    // The wasm core is 350 KB+ and is emitted as an asset, not inlined; nothing else
    // here is close to the default warning threshold.
    assetsInlineLimit: 4096,
  },
});
