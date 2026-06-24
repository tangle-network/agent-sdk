/**
 * Event Buffer
 *
 * Buffers events during disconnections for replay on reconnect.
 * Implements overflow handling with configurable strategies.
 */

export interface EventBufferConfig {
  /** Maximum number of events to buffer (default: 1000) */
  maxSize: number;
  /** Time-to-live in milliseconds for buffered events (default: 300000 = 5min) */
  ttlMs: number;
  /** Strategy when buffer is full: "drop-oldest" or "drop-newest" */
  overflowStrategy: "drop-oldest" | "drop-newest";
}

export interface BufferedEvent<T = unknown> {
  id: string;
  data: T;
  timestamp: number;
  eventType?: string;
}

const DEFAULT_CONFIG: EventBufferConfig = {
  maxSize: 1000,
  ttlMs: 300000,
  overflowStrategy: "drop-oldest",
};

export class EventBuffer<T = unknown> {
  private readonly config: EventBufferConfig;
  private events: BufferedEvent<T>[] = [];
  private seenIds: Set<string> = new Set();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config: Partial<EventBufferConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanup();
  }

  /** Add an event to the buffer (deduplicates by ID) */
  push(id: string, data: T, eventType?: string): void {
    // Deduplicate by event ID to prevent duplicate events during replay
    if (this.seenIds.has(id)) {
      return;
    }

    const event: BufferedEvent<T> = {
      id,
      data,
      timestamp: Date.now(),
      eventType,
    };

    if (this.events.length >= this.config.maxSize) {
      if (this.config.overflowStrategy === "drop-oldest") {
        const removed = this.events.shift();
        if (removed) {
          this.seenIds.delete(removed.id);
        }
      } else {
        return; // drop-newest: don't add
      }
    }

    this.events.push(event);
    this.seenIds.add(id);
  }

  /** Get all buffered events */
  getAll(): BufferedEvent<T>[] {
    this.pruneExpired();
    return [...this.events];
  }

  /** Get events since a specific event ID */
  getSince(lastEventId: string): BufferedEvent<T>[] {
    this.pruneExpired();
    const index = this.events.findIndex((e) => e.id === lastEventId);
    if (index === -1) {
      return [...this.events];
    }
    return this.events.slice(index + 1);
  }

  /** Get events after a timestamp */
  getSinceTimestamp(timestamp: number): BufferedEvent<T>[] {
    this.pruneExpired();
    return this.events.filter((e) => e.timestamp > timestamp);
  }

  /** Clear all buffered events */
  clear(): void {
    this.events = [];
    this.seenIds.clear();
  }

  /** Get current buffer size */
  size(): number {
    return this.events.length;
  }

  /** Check if buffer is empty */
  isEmpty(): boolean {
    return this.events.length === 0;
  }

  /** Check if buffer is full */
  isFull(): boolean {
    return this.events.length >= this.config.maxSize;
  }

  /** Dispose of the buffer and cleanup resources */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.clear();
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.config.ttlMs;
    const expired = this.events.filter((e) => e.timestamp <= cutoff);
    for (const e of expired) {
      this.seenIds.delete(e.id);
    }
    this.events = this.events.filter((e) => e.timestamp > cutoff);
  }

  private startCleanup(): void {
    // Run cleanup every minute
    this.cleanupTimer = setInterval(() => this.pruneExpired(), 60000);
  }
}
