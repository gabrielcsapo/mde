// Reproducible captures of the real site editor, in both integration variants.
//
// The script serves the production build, opens it in headless Chrome, injects a
// compact CommonMark + custom-extension document through the public editor API, and
// crops the live editor itself into site/assets/. Capture stays a small standalone CDP
// client because it has different lifecycle and image-cropping needs from the Vitest suite.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(ROOT, 'site/dist');
const ASSETS = join(ROOT, 'site/assets');
const CAPTURE_MANIFEST = JSON.parse(
  await readFile(join(ROOT, 'fixtures/captures/manifest.json'), 'utf8')
);
const CAPTURE_SCENARIOS = await Promise.all(
  CAPTURE_MANIFEST.scenarios.map(async (scenario) => ({
    ...scenario,
    markdown: await readFile(join(ROOT, 'fixtures/captures', scenario.fixture), 'utf8'),
  }))
);

const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

function serve() {
  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://capture.local').pathname);
    const requested = normalize(join(DIST, pathname));
    if (!requested.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    let file = requested;
    try {
      if (!(await stat(file)).isFile()) file = join(DIST, 'index.html');
    } catch {
      file = join(DIST, 'index.html');
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(`no Chrome found; set CHROME=/path/to/chrome`);
}

async function debuggerUrl(profile) {
  // Port 0 lets Chrome reserve an actually free endpoint. A fixed port can collide
  // with another local browser/test run and presents exactly like a slow startup.
  // Chrome publishes the chosen port only after DevTools is ready.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome did not expose a debugger target');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    });
    socket.addEventListener('error', () => reject(new Error('DevTools socket error')));
    socket.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
        },
        close: () => socket.close(),
      })
    );
  });
}

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'page evaluation failed');
  return result.value;
}

async function waitFor(cdp, expression, message) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(message);
}

async function capture(cdp, origin, variant, scenario) {
  await cdp.send('Page.navigate', { url: `${origin}/try` });
  await waitFor(cdp, 'window.__mde?.editor', 'the JS editor did not become ready');

  if (variant === 'react') {
    await evaluate(
      cdp,
      `([...document.querySelectorAll('[role="tab"]')]
        .find((button) => button.textContent.trim().startsWith('React'))?.click(), true)`
    );
    await waitFor(cdp, `window.__mde?.variant === 'react'`, 'the React editor did not become ready');
  }

  await evaluate(
    cdp,
    `(async () => {
      document.documentElement.dataset.theme = 'light';
      await document.fonts.ready;
      const openHistory = document.querySelector(
        'button[aria-controls="revision-history"][aria-pressed="true"]'
      );
      openHistory?.click();
      window.__mde.editor.setMarkdown(${JSON.stringify(scenario.markdown)});
      document.querySelector('#editor')?.scrollTo({top: 0, behavior: 'instant'});
      ${scenario.reveal ? `
      window.__mde.editor.root.focus();
      const revealAt = window.__mde.editor.markdown.indexOf(${JSON.stringify(scenario.reveal)});
      window.__mde.editor.setSelectionRange({start: revealAt + 4, end: revealAt + 4});
      window.__mde.editor.onSelectionChange();` : ''}
      ${scenario.selection ? `
      window.__mde.editor.root.focus();
      const selectionStart = window.__mde.editor.markdown.indexOf(${JSON.stringify(scenario.selection.start)});
      const selectionEnd = window.__mde.editor.markdown.indexOf(${JSON.stringify(scenario.selection.end)});
      if (selectionStart < 0 || selectionEnd <= selectionStart) {
        throw new Error('table selection markers were not found');
      }
      window.__mde.editor.setSelectionRange({start: selectionStart, end: selectionEnd});
      window.__mde.editor.onSelectionChange();
      const actualSelection = window.__mde.editor.selectionRange();
      if (actualSelection.start !== selectionStart || actualSelection.end !== selectionEnd) {
        throw new Error('editor did not preserve the requested table row selection');
      }
      if (window.__mde.editor.markdown !== ${JSON.stringify(scenario.markdown)}) {
        throw new Error('revealing the selected table changed its Markdown source');
      }
      if (window.__mde.editor.root.querySelector('table.mde-rendered-table')) {
        throw new Error('the rendered table stayed over the selected pipe source');
      }
      if (window.__mde.editor.root.querySelectorAll('.mde-line-table').length < 5) {
        throw new Error('the selected table did not reveal all source lines');
      }` : ''}
      ${scenario.mention ? `
      window.__mde.editor.root.focus();
      const mentionStart = window.__mde.editor.markdown.indexOf(${JSON.stringify(scenario.mention)});
      if (mentionStart < 0) throw new Error('mention capture marker was not found');
      const mentionEnd = mentionStart + ${JSON.stringify(scenario.mention)}.length;
      window.__mde.editor.setSelectionRange({start: mentionEnd, end: mentionEnd});
      window.__mde.editor.onSelectionChange();` : ''}
      return true;
    })()`
  );
  await new Promise((resolve) => setTimeout(resolve, 450));
  if (scenario.mention) {
    await waitFor(
      cdp,
      `document.querySelector('[role="listbox"][aria-label="Mention suggestions"]')`,
      'mention suggestion presentation did not appear'
    );
  }

  const clip = await evaluate(
    cdp,
    `(() => {
      const target = document.querySelector('.editor-demo');
      const rect = target.getBoundingClientRect();
      return {
        x: Math.max(0, rect.left - 2),
        y: Math.max(0, rect.top + scrollY - 2),
        width: Math.ceil(rect.width + 4),
        height: Math.ceil(rect.height + 4),
        scale: 1,
      };
    })()`
  );

  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    fromSurface: true,
    clip,
  });
  const file = join(ASSETS, `capture-${scenario.id}-${variant}.png`);
  await writeFile(file, Buffer.from(data, 'base64'));
  if (scenario.id === 'core') {
    await copyFile(file, join(ASSETS, `web-${variant}.png`));
  }
  console.log(`${file.slice(ROOT.length)} (${Math.round(Buffer.byteLength(data, 'base64') / 1024)} KB)`);
}

async function main() {
  await access(join(DIST, 'index.html')).catch(() => {
    throw new Error('site/dist is missing; run pnpm build:site first');
  });
  const chrome = await findChrome();
  const { server, port } = await serve();
  const profile = await mkdtemp(join(tmpdir(), 'mde-capture-'));
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--no-default-browser-check',
      '--no-first-run',
      '--window-size=1440,1000',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let cdp;
  try {
    cdp = await connect(await debuggerUrl(profile));
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const origin = `http://127.0.0.1:${port}`;
    for (const scenario of CAPTURE_SCENARIOS) {
      await capture(cdp, origin, 'js', scenario);
      await capture(cdp, origin, 'react', scenario);
    }
  } finally {
    cdp?.close();
    // This is a disposable, isolated headless process. Under heavy local Xcode load,
    // Chrome has occasionally ignored SIGTERM and kept Node alive after every image
    // was written, so make teardown deterministic.
    child.kill('SIGKILL');
    server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`web capture: ${error.message}`);
  process.exit(1);
});
