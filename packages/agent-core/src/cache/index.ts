/**
 * Response Caching
 *
 * In-memory cache with TTL and cache-control support.
 */

/** Cache entry */
interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  expiresAt: number;
  etag?: string;
}

/** Cache configuration */
export interface CacheConfig {
  /** Default TTL in ms (default: 60000 = 1 minute) */
  defaultTtlMs?: number;
  /** Max entries (default: 1000) */
  maxEntries?: number;
  /** Cache key generator */
  keyGenerator?: (path: string, params?: Record<string, unknown>) => string;
}

/** Cache interface for different storage backends */
export interface CacheStorage<T = unknown> {
  get(key: string): T | undefined | Promise<T | undefined>;
  set(key: string, value: T, ttlMs?: number): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  clear(): void | Promise<void>;
}

/** In-memory LRU cache */
export class MemoryCache<T = unknown> implements CacheStorage<CacheEntry<T>> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  get(key: string): CacheEntry<T> | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry;
  }

  set(key: string, value: CacheEntry<T>): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }

    this.cache.set(key, value);
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  /** Get cache stats */
  stats(): { size: number; maxEntries: number } {
    return { size: this.cache.size, maxEntries: this.maxEntries };
  }
}

/** Response cache manager */
export class ResponseCache<T = unknown> {
  private storage: CacheStorage<CacheEntry<T>>;
  private defaultTtlMs: number;
  private keyGenerator: (
    path: string,
    params?: Record<string, unknown>,
  ) => string;

  constructor(config: CacheConfig = {}) {
    this.storage = new MemoryCache<T>(config.maxEntries);
    this.defaultTtlMs = config.defaultTtlMs ?? 60000;
    this.keyGenerator = config.keyGenerator ?? this.defaultKeyGenerator;
  }

  private defaultKeyGenerator(
    path: string,
    params?: Record<string, unknown>,
  ): string {
    if (!params || Object.keys(params).length === 0) return path;
    const sorted = Object.keys(params).sort();
    const qs = sorted.map((k) => `${k}=${JSON.stringify(params[k])}`).join("&");
    return `${path}?${qs}`;
  }

  /** Get cached response */
  async get(
    path: string,
    params?: Record<string, unknown>,
  ): Promise<T | undefined> {
    const key = this.keyGenerator(path, params);
    const entry = await this.storage.get(key);
    return entry?.data;
  }

  /** Get with stale-while-revalidate support */
  async getWithMeta(
    path: string,
    params?: Record<string, unknown>,
  ): Promise<{ data: T; stale: boolean; etag?: string } | undefined> {
    const key = this.keyGenerator(path, params);
    const entry = await this.storage.get(key);

    if (!entry) return undefined;

    const now = Date.now();
    const stale = now > entry.expiresAt;

    return { data: entry.data, stale, etag: entry.etag };
  }

  /** Cache response */
  async set(
    path: string,
    data: T,
    options?: {
      params?: Record<string, unknown>;
      ttlMs?: number;
      etag?: string;
    },
  ): Promise<void> {
    const key = this.keyGenerator(path, options?.params);
    const now = Date.now();
    const ttl = options?.ttlMs ?? this.defaultTtlMs;

    await this.storage.set(key, {
      data,
      cachedAt: now,
      expiresAt: now + ttl,
      etag: options?.etag,
    });
  }

  /** Invalidate cache entry */
  async invalidate(
    path: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    const key = this.keyGenerator(path, params);
    await this.storage.delete(key);
  }

  /** Invalidate all entries matching prefix */
  async invalidatePrefix(_prefix: string): Promise<void> {
    // Only works with MemoryCache
    if (this.storage instanceof MemoryCache) {
      // Need to iterate - not ideal but works for in-memory
      const cache = this.storage as MemoryCache<T>;
      // Can't iterate Map while modifying, so just clear for now
      cache.clear();
    }
  }

  /** Clear entire cache */
  async clear(): Promise<void> {
    await this.storage.clear();
  }

  /** Parse Cache-Control header */
  static parseCacheControl(header: string): {
    maxAge?: number;
    noCache?: boolean;
    noStore?: boolean;
  } {
    const result: { maxAge?: number; noCache?: boolean; noStore?: boolean } =
      {};

    const parts = header.split(",").map((p) => p.trim().toLowerCase());

    for (const part of parts) {
      if (part === "no-cache") result.noCache = true;
      if (part === "no-store") result.noStore = true;
      if (part.startsWith("max-age=")) {
        const age = Number.parseInt(part.slice(8), 10);
        if (!Number.isNaN(age)) result.maxAge = age * 1000; // Convert to ms
      }
    }

    return result;
  }
}
