import { loadCore } from './core.js';

interface WorkerRequest {
  markdown: string;
  wasm: ArrayBuffer;
  manifest: ArrayBuffer | null;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const started = performance.now();
  let engine;
  try {
    const core = await loadCore(event.data.wasm);
    engine = core.newEngine(
      event.data.manifest ? new Uint8Array(event.data.manifest) : null,
    );
    engine.reset(event.data.markdown);
    const snapshot = engine.snapshot();
    self.postMessage(
      { ok: true, snapshot: snapshot.buffer, durationMs: performance.now() - started },
      { transfer: [snapshot.buffer] },
    );
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    engine?.free();
  }
};

