// Runs the web test suite in real headless Chrome and reports pass/fail.
//
// A real browser, not a DOM shim: every hard bug in the web renderer —
// contenteditable behaviour, selection restore, CSS precedence on concealed runs,
// hit-testing a widget — only exists in a real engine, so a shim would pass while the
// editor was broken.
//
// No npm dependencies. Node serves the files itself (so caching cannot serve a stale
// module) and talks to Chrome over the DevTools Protocol using the global WebSocket
// that Node has had since v22.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const TIMEOUT_MS = Number(process.env.MDE_WEB_TIMEOUT ?? 60_000);

const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
};

/** Serve `web/` with caching disabled, on an ephemeral port. */
function serve() {
  const server = createServer(async (req, res) => {
    // `normalize` collapses `..`, and the prefix check keeps the server inside the root.
    const path = normalize(join(WEB_ROOT, decodeURIComponent(req.url.split('?')[0])));
    if (!path.startsWith(WEB_ROOT)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(path);
      res.writeHead(200, {
        'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
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
  for (const path of CHROME_CANDIDATES) {
    try {
      await readFile(path);
      return path;
    } catch {
      // Not executable-readable here is fine; try the next candidate.
      try {
        const { access } = await import('node:fs/promises');
        await access(path);
        return path;
      } catch {}
    }
  }
  throw new Error(
    `no Chrome found. Set CHROME=/path/to/chrome. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`
  );
}

/** Poll Chrome's HTTP endpoint until the debugger is listening. */
async function debuggerUrl(port) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Chrome did not expose a debugger target');
}

/** Minimal CDP client: send a command, await its reply. */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
    });
    ws.addEventListener('error', () => reject(new Error('CDP socket error')));
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
        },
        close: () => ws.close(),
      })
    );
  });
}

async function main() {
  const chrome = await findChrome();
  const { server, port } = await serve();
  const profile = await mkdtemp(join(tmpdir(), 'mde-chrome-'));
  const cdpPort = 9222 + (process.pid % 500);

  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      // A stable window size: some assertions measure real geometry, and a zero-sized
      // window makes hit testing meaningless.
      '--window-size=1200,900',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${cdpPort}`,
      `http://127.0.0.1:${port}/test/index.html`,
    ],
    { stdio: 'ignore' }
  );

  let exitCode = 1;
  let cdp;
  try {
    cdp = await connect(await debuggerUrl(cdpPort));

    // The suite is async (wasm load, resource resolution), so poll until it reports.
    const deadline = Date.now() + TIMEOUT_MS;
    let results = null;
    while (Date.now() < deadline) {
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__results ?? null)',
        returnByValue: true,
      });
      if (result.value && result.value !== 'null') {
        results = JSON.parse(result.value);
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    if (!results) {
      // Console errors are the usual reason the suite never reported at all.
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: 'document.body ? document.body.innerText.slice(0, 800) : "(no body)"',
        returnByValue: true,
      });
      throw new Error(`web suite did not finish within ${TIMEOUT_MS}ms.\n${result.value}`);
    }

    const passed = results.total - results.failed.length;
    for (const failure of results.failed) console.error(`  ✗ ${failure}`);
    console.log(`test result: ${results.failed.length ? 'FAILED' : 'ok'}. ` +
      `${passed} passed; ${results.failed.length} failed; ${results.total} total`);
    exitCode = results.failed.length === 0 ? 0 : 1;
  } finally {
    cdp?.close();
    child.kill();
    server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(`web tests: ${error.message}`);
  process.exit(1);
});
