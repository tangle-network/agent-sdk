/**
 * Offline Storage Abstraction
 *
 * Platform-agnostic storage interface with implementations for different environments.
 */

/** Storage interface */
export interface Storage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
}

/** In-memory storage (default fallback) */
export class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const value = this.data.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  async keys(): Promise<string[]> {
    return Array.from(this.data.keys());
  }
}

/** Browser localStorage wrapper */
export class LocalStorage implements Storage {
  constructor(private prefix = "sdk_") {}

  private key(k: string): string {
    return `${this.prefix}${k}`;
  }

  async get<T>(key: string): Promise<T | null> {
    if (typeof localStorage === "undefined") return null;
    const value = localStorage.getItem(this.key(key));
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(this.key(key), JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(this.key(key));
  }

  async clear(): Promise<void> {
    if (typeof localStorage === "undefined") return;
    const keys = await this.keys();
    for (const key of keys) {
      localStorage.removeItem(this.key(key));
    }
  }

  async keys(): Promise<string[]> {
    if (typeof localStorage === "undefined") return [];
    const result: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(this.prefix)) {
        result.push(key.slice(this.prefix.length));
      }
    }
    return result;
  }
}

/** Offline request queue */
export interface QueuedRequest {
  id: string;
  path: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  createdAt: number;
  attempts: number;
  idempotencyKey?: string;
}

/** Offline queue manager */
export class OfflineQueue {
  private readonly storageKey = "offline_queue";

  constructor(private storage: Storage) {}

  /** Add request to queue */
  async enqueue(
    request: Omit<QueuedRequest, "id" | "createdAt" | "attempts">,
  ): Promise<string> {
    const queue = await this.getQueue();
    const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    queue.push({
      ...request,
      id,
      createdAt: Date.now(),
      attempts: 0,
    });

    await this.storage.set(this.storageKey, queue);
    return id;
  }

  /** Get all queued requests */
  async getQueue(): Promise<QueuedRequest[]> {
    return (await this.storage.get<QueuedRequest[]>(this.storageKey)) ?? [];
  }

  /** Get next request to process */
  async peek(): Promise<QueuedRequest | null> {
    const queue = await this.getQueue();
    return queue[0] ?? null;
  }

  /** Remove request from queue */
  async dequeue(id: string): Promise<void> {
    const queue = await this.getQueue();
    const filtered = queue.filter((r) => r.id !== id);
    await this.storage.set(this.storageKey, filtered);
  }

  /** Increment attempt count */
  async incrementAttempts(id: string): Promise<void> {
    const queue = await this.getQueue();
    const request = queue.find((r) => r.id === id);
    if (request) {
      request.attempts++;
      await this.storage.set(this.storageKey, queue);
    }
  }

  /** Get queue size */
  async size(): Promise<number> {
    const queue = await this.getQueue();
    return queue.length;
  }

  /** Clear queue */
  async clear(): Promise<void> {
    await this.storage.delete(this.storageKey);
  }

  /** Process queue with handler */
  async process(
    handler: (request: QueuedRequest) => Promise<boolean>,
    options?: { maxAttempts?: number; batchSize?: number },
  ): Promise<{ processed: number; failed: number }> {
    const maxAttempts = options?.maxAttempts ?? 3;
    const batchSize = options?.batchSize ?? 10;

    const queue = await this.getQueue();
    let processed = 0;
    let failed = 0;

    for (let i = 0; i < Math.min(queue.length, batchSize); i++) {
      const request = queue[i];

      if (request.attempts >= maxAttempts) {
        await this.dequeue(request.id);
        failed++;
        continue;
      }

      try {
        const success = await handler(request);
        if (success) {
          await this.dequeue(request.id);
          processed++;
        } else {
          await this.incrementAttempts(request.id);
        }
      } catch {
        await this.incrementAttempts(request.id);
      }
    }

    return { processed, failed };
  }
}

/** Detect available storage */
export function detectStorage(): Storage {
  // Browser with localStorage
  if (typeof localStorage !== "undefined") {
    return new LocalStorage();
  }

  // Fallback to memory
  return new MemoryStorage();
}
