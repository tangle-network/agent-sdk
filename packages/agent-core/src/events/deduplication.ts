/**
 * Event Deduplication
 *
 * LRU-bounded set for tracking seen event IDs.
 * Prevents duplicate event processing during reconnections.
 */

export interface DeduplicatorConfig {
  /** Maximum number of event IDs to track (default: 10000) */
  maxSize: number;
  /** Time window in milliseconds for deduplication (default: 60000 = 1min) */
  windowMs: number;
}

interface TrackedEvent {
  timestamp: number;
}

const DEFAULT_CONFIG: DeduplicatorConfig = {
  maxSize: 10000,
  windowMs: 60000,
};

export class EventDeduplicator {
  private readonly config: DeduplicatorConfig;
  private readonly seen: Map<string, TrackedEvent> = new Map();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config: Partial<DeduplicatorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanup();
  }

  /**
   * Check if an event has been seen and mark it as seen.
   * Returns true if this is a duplicate, false if it's new.
   */
  isDuplicate(eventId: string): boolean {
    const now = Date.now();
    const existing = this.seen.get(eventId);

    if (existing && now - existing.timestamp < this.config.windowMs) {
      return true;
    }

    // Evict oldest if at capacity
    if (this.seen.size >= this.config.maxSize) {
      this.evictOldest();
    }

    this.seen.set(eventId, { timestamp: now });
    return false;
  }

  /**
   * Mark an event as seen without checking for duplicates.
   */
  markSeen(eventId: string): void {
    if (this.seen.size >= this.config.maxSize) {
      this.evictOldest();
    }
    this.seen.set(eventId, { timestamp: Date.now() });
  }

  /**
   * Check if an event has been seen (without marking).
   */
  hasSeen(eventId: string): boolean {
    const existing = this.seen.get(eventId);
    if (!existing) return false;
    return Date.now() - existing.timestamp < this.config.windowMs;
  }

  /**
   * Clear all tracked events.
   */
  clear(): void {
    this.seen.clear();
  }

  /**
   * Get the number of tracked events.
   */
  size(): number {
    return this.seen.size;
  }

  /**
   * Dispose of the deduplicator and cleanup resources.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.clear();
  }

  private evictOldest(): void {
    // Map maintains insertion order, so first entry is oldest
    const firstKey = this.seen.keys().next().value;
    if (firstKey !== undefined) {
      this.seen.delete(firstKey);
    }
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.config.windowMs;
    for (const [id, entry] of this.seen) {
      if (entry.timestamp < cutoff) {
        this.seen.delete(id);
      }
    }
  }

  private startCleanup(): void {
    // Run cleanup every 30 seconds
    this.cleanupTimer = setInterval(() => this.pruneExpired(), 30000);
  }
}
