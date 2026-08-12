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
  readonly stats: MediaPreviewCacheStats = { memoryHits: 0, persistentHits: 0, misses: 0 };
  private readonly memory = new Map<string, Blob>();
  private readonly pending = new Map<string, Promise<Blob>>();
  private cachePromise: Promise<Cache | null> | null = null;

  constructor(options: MediaPreviewCacheOptions = {}) {
    this.name = options.name ?? 'mde-media-previews-v1';
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 256));
  }

  async getOrCreate(
    request: MediaPreviewRequest,
    generate: () => Blob | Promise<Blob>,
  ): Promise<Blob> {
    const id = identity(request);
    const inMemory = this.memory.get(id);
    if (inMemory) {
      this.stats.memoryHits++;
      return inMemory;
    }
    const inFlight = this.pending.get(id);
    if (inFlight) return inFlight;

    const work = this.loadOrCreate(id, generate);
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
        this.memory.set(id, value);
        this.stats.persistentHits++;
        return value;
      }
    }

    this.stats.misses++;
    const value = await generate();
    this.memory.set(id, value);
    if (cache) {
      await cache.put(key, new Response(value, {
        headers: { 'content-type': value.type || 'application/octet-stream' },
      }));
      await this.trim(cache);
    }
    return value;
  }

  async invalidate(request: MediaPreviewRequest): Promise<void> {
    const id = identity(request);
    this.memory.delete(id);
    const cache = await this.cache();
    if (cache) await cache.delete(await this.key(id));
  }

  async clear(): Promise<void> {
    this.memory.clear();
    this.pending.clear();
    if (typeof caches !== 'undefined') await caches.delete(this.name);
    this.cachePromise = null;
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

  private async trim(cache: Cache): Promise<void> {
    const keys = await cache.keys();
    const overflow = keys.length - this.maxEntries;
    if (overflow > 0) await Promise.all(keys.slice(0, overflow).map((key) => cache.delete(key)));
  }
}
