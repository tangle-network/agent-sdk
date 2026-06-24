/**
 * Channel Pub/Sub
 *
 * Topic-based event distribution with wildcard pattern matching.
 * Supports patterns like "message.*", "**", and exact matches.
 */

export type ChannelHandler<T = unknown> = (message: T, topic: string) => void;

export interface ChannelConfig {
  /** Maximum number of subscribers per topic (default: 100) */
  maxSubscribersPerTopic: number;
  /** Enable wildcard patterns (default: true) */
  enableWildcards: boolean;
}

interface Subscriber<T> {
  pattern: string;
  handler: ChannelHandler<T>;
  regex?: RegExp;
}

const DEFAULT_CONFIG: ChannelConfig = {
  maxSubscribersPerTopic: 100,
  enableWildcards: true,
};

export class EventChannel<T = unknown> {
  private readonly config: ChannelConfig;
  private readonly subscribers: Subscriber<T>[] = [];

  constructor(config: Partial<ChannelConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Subscribe to a topic or pattern.
   *
   * Patterns:
   * - "exact.topic" - matches only "exact.topic"
   * - "prefix.*" - matches "prefix.foo", "prefix.bar", etc.
   * - "prefix.**" - matches "prefix.foo", "prefix.foo.bar", etc.
   * - "**" - matches all topics
   *
   * Returns an unsubscribe function.
   */
  subscribe(pattern: string, handler: ChannelHandler<T>): () => void {
    const subscriber: Subscriber<T> = {
      pattern,
      handler,
      regex: this.config.enableWildcards
        ? this.patternToRegex(pattern)
        : undefined,
    };

    this.subscribers.push(subscriber);

    return () => {
      const index = this.subscribers.indexOf(subscriber);
      if (index !== -1) {
        this.subscribers.splice(index, 1);
      }
    };
  }

  /**
   * Publish a message to a topic.
   * Delivers to all matching subscribers.
   */
  publish(topic: string, message: T): number {
    let delivered = 0;

    for (const subscriber of this.subscribers) {
      if (this.matches(subscriber, topic)) {
        try {
          subscriber.handler(message, topic);
          delivered++;
        } catch (error) {
          console.error(`Error in channel handler for ${topic}:`, error);
        }
      }
    }

    return delivered;
  }

  /**
   * Check if any subscribers are listening to a topic.
   */
  hasSubscribers(topic: string): boolean {
    return this.subscribers.some((s) => this.matches(s, topic));
  }

  /**
   * Get the number of subscribers for a topic.
   */
  subscriberCount(topic: string): number {
    return this.subscribers.filter((s) => this.matches(s, topic)).length;
  }

  /**
   * Get all unique patterns being subscribed to.
   */
  getPatterns(): string[] {
    return [...new Set(this.subscribers.map((s) => s.pattern))];
  }

  /**
   * Clear all subscribers.
   */
  clear(): void {
    this.subscribers.length = 0;
  }

  /**
   * Get total subscriber count.
   */
  size(): number {
    return this.subscribers.length;
  }

  private matches(subscriber: Subscriber<T>, topic: string): boolean {
    if (!this.config.enableWildcards || !subscriber.regex) {
      return subscriber.pattern === topic;
    }
    return subscriber.regex.test(topic);
  }

  private patternToRegex(pattern: string): RegExp {
    // Handle special patterns
    if (pattern === "**") {
      return /^.*$/;
    }

    // Escape special regex characters except * and .
    let escaped = pattern.replace(/[+?^${}()|[\]\\]/g, "\\$&");

    // Replace ** with match-all
    escaped = escaped.replace(/\*\*/g, "<<<GLOBSTAR>>>");

    // Replace * with single-segment match
    escaped = escaped.replace(/\*/g, "[^.]+");

    // Restore globstar
    escaped = escaped.replace(/<<<GLOBSTAR>>>/g, ".*");

    return new RegExp(`^${escaped}$`);
  }
}
