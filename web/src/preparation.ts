import { DEFAULT_WASM_URL, loadCore } from './core.js';
import type { WasmSource } from './core.js';

export interface PreparedDocument {
  readonly markdown: string;
  readonly snapshot: Uint8Array;
  readonly durationMs: number;
}

export interface PrepareDocumentOptions {
  wasm?: WasmSource;
  manifest?: Uint8Array | null;
  signal?: AbortSignal;
  worker?: boolean;
}

interface WorkerRequest {
  markdown: string;
  wasm: ArrayBuffer;
  manifest: ArrayBuffer | null;
}

function aborted(): DOMException {
  return new DOMException('Document preparation was cancelled', 'AbortError');
}

function yieldToPresentation(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function wasmBytes(source: WasmSource): Promise<ArrayBuffer> {
  if (source instanceof ArrayBuffer) return source.slice(0);
  if (source instanceof Response) return source.clone().arrayBuffer();
  return (await fetch(source)).arrayBuffer();
}

async function prepareInline(request: WorkerRequest): Promise<PreparedDocument> {
  const started = performance.now();
  const core = await loadCore(request.wasm);
  const engine = core.newEngine(request.manifest ? new Uint8Array(request.manifest) : null);
  try {
    engine.reset(request.markdown);
    return {
      markdown: request.markdown,
      snapshot: engine.snapshot(),
      durationMs: performance.now() - started,
    };
  } finally {
    engine.free();
  }
}

/**
 * Parse and index a document away from the editor's main-thread engine.
 *
 * The returned snapshot is bound to both the exact Markdown and manifest. Installing
 * it is therefore atomic: the editor never exposes a partially parsed document.
 */
export async function prepareDocument(
  markdown: string,
  options: PrepareDocumentOptions = {},
): Promise<PreparedDocument> {
  if (options.signal?.aborted) throw aborted();
  const request: WorkerRequest = {
    markdown,
    wasm: await wasmBytes(options.wasm ?? DEFAULT_WASM_URL),
    manifest: options.manifest ? options.manifest.slice().buffer : null,
  };
  if (options.signal?.aborted) throw aborted();
  if (options.worker === false || typeof Worker === 'undefined') return prepareInline(request);

  // Let the source-first projection paint before compilation/parsing starts competing
  // for CPU. This is observable responsiveness, not just moving the work off-stack.
  await yieldToPresentation();
  if (options.signal?.aborted) throw aborted();

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./preparation-worker.ts', import.meta.url), { type: 'module' });
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      cleanup();
      reject(aborted());
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<{
      ok: boolean;
      snapshot?: ArrayBuffer;
      durationMs?: number;
      error?: string;
    }>) => {
      cleanup();
      if (!event.data.ok || !event.data.snapshot) {
        reject(new Error(event.data.error ?? 'Document preparation failed'));
        return;
      }
      resolve({
        markdown,
        snapshot: new Uint8Array(event.data.snapshot),
        durationMs: event.data.durationMs ?? 0,
      });
    };
    worker.onerror = (event) => {
      cleanup();
      reject(event.error ?? new Error(event.message));
    };
    const transfers = request.manifest
      ? [request.wasm, request.manifest]
      : [request.wasm];
    worker.postMessage(request, { transfer: transfers });
  });
}
