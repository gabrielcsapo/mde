import { afterEach, expect, test } from 'vitest';

import { MediaPreviewCache } from '../src/media-previews.ts';
import { ResourceCache } from '../src/resources.ts';

const cacheNames = [];

afterEach(async () => {
  await Promise.all(cacheNames.splice(0).map((name) => caches.delete(name)));
});

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate, timeout = 5_000) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeout) throw new Error('timed out waiting for media');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function makeFourKImage() {
  const canvas = new OffscreenCanvas(3_840, 2_160);
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, '#13253d');
  gradient.addColorStop(0.5, '#d76a45');
  gradient.addColorStop(1, '#f5d77a');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < 80; index++) {
    context.fillStyle = `hsla(${index * 17}, 70%, 60%, 0.35)`;
    context.fillRect((index * 191) % canvas.width, (index * 97) % canvas.height, 240, 160);
  }
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
}

test('real media pipeline reports cold decode, stale-scroll, and preview-cache costs', async () => {
  const image = await makeFourKImage();
  const decodeStarted = performance.now();
  const bitmaps = await Promise.all(Array.from({ length: 8 }, () => createImageBitmap(
    image,
    { resizeWidth: 1_280, resizeHeight: 720, resizeQuality: 'high' },
  )));
  const imageDecodeMs = performance.now() - decodeStarted;
  bitmaps.forEach((bitmap) => bitmap.close());

  const completed = [];
  let aborted = 0;
  let firstPreviewMs = null;
  const resolver = {
    estimatedMemoryCostBytes() { return 1_280 * 720 * 4; },
    resolve({ reference, signal, publishPreview }) {
      return new Promise((resolve, reject) => {
        const previewTimer = setTimeout(() => {
          const view = document.createElement('img');
          view.width = 320;
          view.height = 180;
          publishPreview({ state: 'ready', view, memoryCostBytes: 320 * 180 * 4 });
          firstPreviewMs ??= performance.now();
        }, 8);
        const timer = setTimeout(() => {
          completed.push(reference);
          const view = document.createElement('img');
          view.width = 1_280;
          view.height = 720;
          resolve({ state: 'ready', view, memoryCostBytes: 1_280 * 720 * 4 });
        }, 45);
        signal.addEventListener('abort', () => {
          clearTimeout(previewTimer);
          clearTimeout(timer);
          aborted++;
          reject(new DOMException('cancelled', 'AbortError'));
        }, { once: true });
      });
    },
    reservedSize() { return { width: 640, height: 360 }; },
  };
  const wanted = new Set(Array.from({ length: 6 }, (_, index) => `photo-${42 + index}.jpg`));
  const resources = new ResourceCache(resolver, () => {}, { maxConcurrent: 6 });
  const resourceStarted = performance.now();
  for (let index = 0; index < 48; index++) {
    resources.view({ reference: `photo-${index}.jpg`, roleName: 'image', source: '' });
  }
  await nextTask();
  const staleScrollStarted = performance.now();
  resources.prioritize(wanted);
  await waitUntil(() => [...wanted].every((reference) => completed.includes(reference)));
  const staleScrollMs = performance.now() - staleScrollStarted;
  const staleCompletions = completed.filter((reference) => !wanted.has(reference)).length;
  resources.reset();

  const name = `mde-preview-perf-${crypto.randomUUID()}`;
  cacheNames.push(name);
  const previews = new MediaPreviewCache({ name, maxEntries: 96 });
  const preview = new Blob([new Uint8Array(32 * 1_024)], { type: 'image/webp' });
  const cacheFillStarted = performance.now();
  for (let index = 0; index < 128; index++) {
    await previews.getOrCreate(
      { kind: 'video-poster', reference: `clip-${index}.mov`, width: 640, version: 'v1' },
      () => preview,
    );
  }
  const cacheFillMs = performance.now() - cacheFillStarted;

  const bucketName = `mde-preview-bucket-${crypto.randomUUID()}`;
  cacheNames.push(bucketName);
  const bucketed = new MediaPreviewCache({ name: bucketName, maxEntries: 32 });
  let nearbySizeGenerations = 0;
  const nearbyStarted = performance.now();
  for (let width = 601; width <= 720; width++) {
    await bucketed.getOrCreate(
      { kind: 'video-poster', reference: 'same-clip.mov', width, version: 'v1' },
      (target) => {
        nearbySizeGenerations++;
        if (target.width < width) throw new Error('preview bucket undersized the request');
        return preview;
      },
    );
  }
  const nearbySizeMs = performance.now() - nearbyStarted;

  const report = {
    imageBytes: image.size,
    imageDecodeMs,
    staleScrollMs,
    staleCompletions,
    firstPreviewMs: firstPreviewMs === null ? null : firstPreviewMs - resourceStarted,
    aborted,
    cacheFillMs,
    persistentEntries: (await (await caches.open(name)).keys()).length,
    nearbySizeGenerations,
    nearbySizeMs,
  };
  console.log(`MDE_WEB_REAL_MEDIA ${JSON.stringify(report)}`);
  await fetch('/__mde_perf_media_report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report, null, 2),
  });

  expect(image.size).toBeGreaterThan(100_000);
  expect(report.persistentEntries).toBeLessThanOrEqual(96);
  expect(report.firstPreviewMs).toBeLessThan(45);
  expect(resources.peakInFlightMemoryBytes).toBeLessThanOrEqual(48 * 1024 * 1024);
  expect(nearbySizeGenerations).toBe(2);
  expect(imageDecodeMs).toBeLessThan(5_000);
}, 30_000);
