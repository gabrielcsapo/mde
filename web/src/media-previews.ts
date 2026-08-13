export type MediaPreviewKind = 'video-poster' | 'audio-waveform';

export interface MediaPreviewRequest {
  /** Stable asset identity used by the host's resource resolver. */
  reference: string;
  kind: MediaPreviewKind;
  width: number;
  height?: number;
  /** ETag, modification date, content hash, or another token that changes with bytes. */
  version?: string;
}

export interface MediaPreviewCacheOptions {
  name?: string;
  maxEntries?: number;
  maxMemoryBytes?: number;
  maxPersistentBytes?: number;
}

export interface MediaPreviewCacheStats {
  memoryHits: number;
  persistentHits: number;
  misses: number;
}

function identity(request: MediaPreviewRequest): string {
  return JSON.stringify([
    request.kind,
    request.reference,
    Math.max(1, Math.round(request.width)),
    Math.max(0, Math.round(request.height ?? 0)),
    request.version ?? '',
  ]);
}

function bucketed(request: MediaPreviewRequest): MediaPreviewRequest {
  const bucket = (value: number) => Math.ceil(Math.max(1, value) / 128) * 128;
  return {
    ...request,
    width: bucket(request.width),
    height: request.height ? bucket(request.height) : undefined,
  };
}

async function digest(value: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
  // Cache Storage is normally unavailable in the same old/insecure environments that
  // lack SubtleCrypto. This still gives the in-memory fallback a stable compact key.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Persistent, size-keyed storage for expensive browser video posters and audio
 * waveforms. The host supplies the decoder because it owns resource URLs, credentials,
 * and media policy; this class makes the result reusable across editors and launches.
 */
export class MediaPreviewCache {
  readonly name: string;
  readonly maxEntries: number;
  readonly maxMemoryBytes: number;
  readonly maxPersistentBytes: number;
  readonly stats: MediaPreviewCacheStats = { memoryHits: 0, persistentHits: 0, misses: 0 };
  private readonly memory = new Map<string, Blob>();
  private memoryBytes = 0;
  private readonly pending = new Map<string, Promise<Blob>>();
  private cachePromise: Promise<Cache | null> | null = null;
  private inventoryPromise: Promise<void> | null = null;
  private readonly persistent = new Map<string, { request: Request; bytes: number }>();
  private persistentBytes = 0;

  constructor(options: MediaPreviewCacheOptions = {}) {
    this.name = options.name ?? 'mde-media-previews-v1';
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 256));
    this.maxMemoryBytes = Math.max(1, Math.floor(options.maxMemoryBytes ?? 16 * 1024 * 1024));
    this.maxPersistentBytes = Math.max(
      1, Math.floor(options.maxPersistentBytes ?? 128 * 1024 * 1024),
    );
  }

  async getOrCreate(
    request: MediaPreviewRequest,
    generate: (target: MediaPreviewRequest) => Blob | Promise<Blob>,
  ): Promise<Blob> {
    const target = bucketed(request);
    const id = identity(target);
    const inMemory = this.memory.get(id);
    if (inMemory) {
      this.memory.delete(id);
      this.memory.set(id, inMemory);
      this.stats.memoryHits++;
      return inMemory;
    }
    const inFlight = this.pending.get(id);
    if (inFlight) return inFlight;

    const work = this.loadOrCreate(id, () => generate(target));
    this.pending.set(id, work);
    try {
      return await work;
    } finally {
      this.pending.delete(id);
    }
  }

  private async loadOrCreate(id: string, generate: () => Blob | Promise<Blob>): Promise<Blob> {
    const key = await this.key(id);
    const cache = await this.cache();
    if (cache) {
      const response = await cache.match(key);
      if (response) {
        const value = await response.blob();
        this.remember(id, value);
        this.stats.persistentHits++;
        return value;
      }
    }

    this.stats.misses++;
    const value = await generate();
    this.remember(id, value);
    if (cache) {
      await cache.put(key, new Response(value, {
        headers: {
          'content-type': value.type || 'application/octet-stream',
          'x-mde-preview-bytes': String(value.size),
        },
      }));
      await this.recordAndTrim(cache, key, value.size);
    }
    return value;
  }

  async invalidate(request: MediaPreviewRequest): Promise<void> {
    const id = identity(bucketed(request));
    this.forget(id);
    const cache = await this.cache();
    if (cache) {
      const key = await this.key(id);
      const normalized = new Request(key);
      const entry = this.persistent.get(normalized.url);
      if (entry) {
        this.persistent.delete(normalized.url);
        this.persistentBytes = Math.max(0, this.persistentBytes - entry.bytes);
      }
      await cache.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.memory.clear();
    this.memoryBytes = 0;
    this.pending.clear();
    if (typeof caches !== 'undefined') await caches.delete(this.name);
    this.cachePromise = null;
    this.inventoryPromise = null;
    this.persistent.clear();
    this.persistentBytes = 0;
  }

  private async cache(): Promise<Cache | null> {
    if (this.cachePromise) return this.cachePromise;
    this.cachePromise = typeof caches === 'undefined'
      ? Promise.resolve(null)
      : caches.open(this.name).catch(() => null);
    return this.cachePromise;
  }

  private async key(id: string): Promise<string> {
    const hash = await digest(id);
    const origin = globalThis.location?.origin ?? 'https://mde.invalid';
    return new URL(`/__mde_media_previews__/${hash}`, origin).href;
  }

  private remember(id: string, value: Blob): void {
    this.forget(id);
    this.memory.set(id, value);
    this.memoryBytes += value.size;
    while (this.memory.size > this.maxEntries || this.memoryBytes > this.maxMemoryBytes) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.forget(oldest);
    }
  }

  private forget(id: string): void {
    const value = this.memory.get(id);
    if (!value) return;
    this.memory.delete(id);
    this.memoryBytes = Math.max(0, this.memoryBytes - value.size);
  }

  private async inventory(cache: Cache): Promise<void> {
    if (!this.inventoryPromise) {
      this.inventoryPromise = (async () => {
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          const bytes = Number(response?.headers.get('x-mde-preview-bytes') ?? 0);
          this.persistent.set(request.url, { request, bytes });
          this.persistentBytes += bytes;
        }
      })();
    }
    await this.inventoryPromise;
  }

  private async recordAndTrim(cache: Cache, request: RequestInfo | URL, bytes: number): Promise<void> {
    await this.inventory(cache);
    const normalized = new Request(request);
    const previous = this.persistent.get(normalized.url);
    if (previous) this.persistentBytes -= previous.bytes;
    else this.persistent.delete(normalized.url);
    this.persistent.set(normalized.url, { request: normalized, bytes });
    this.persistentBytes += bytes;
    const removals = [];
    while (
      this.persistent.size > this.maxEntries || this.persistentBytes > this.maxPersistentBytes
    ) {
      const oldest = this.persistent.entries().next().value;
      if (!oldest) break;
      const [url, entry] = oldest;
      this.persistent.delete(url);
      this.persistentBytes = Math.max(0, this.persistentBytes - entry.bytes);
      removals.push(cache.delete(entry.request));
    }
    await Promise.all(removals);
  }
}
