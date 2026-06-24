/**
 * Transport Adapter Interface
 *
 * The central abstraction for all transport implementations.
 * Provides HTTP requests and SSE stream subscriptions through a common API.
 */

import type {
  ConnectionQuality,
  ConnectionState,
  RequestOptions,
  SSEEvent,
  StreamOptions,
  SubscriptionState,
  TransportConfig,
  TransportEvents,
  TransportMetrics,
} from "./types.js";

/**
 * SSE Subscription handle for consuming server-sent events.
 * Supports pause/resume, async iteration, and event callbacks.
 */
export interface Subscription {
  /** Unique identifier for this subscription */
  readonly streamId: string;

  /** Current subscription state */
  readonly state: SubscriptionState;

  /** Pause event processing (events may still be buffered) */
  pause(): void;

  /** Resume event processing */
  resume(): void;

  /** Close the subscription and release resources */
  close(): void;

  /** Register callback for each event */
  onEvent(callback: (event: SSEEvent) => void): () => void;

  /** Register callback for errors */
  onError(callback: (error: Error) => void): () => void;

  /** Register callback for reconnection attempts */
  onReconnect(callback: (lastEventId: string | undefined) => void): () => void;

  /** Async iterator for event consumption */
  [Symbol.asyncIterator](): AsyncIterator<SSEEvent>;
}

/**
 * Transport Adapter - core abstraction for network communication.
 *
 * Implementations provide HTTP request/response and SSE streaming
 * with connection management, reconnection, and quality monitoring.
 */
export interface TransportAdapter {
  /** Current connection state */
  readonly state: ConnectionState;

  /** Connect to the server */
  connect(): Promise<void>;

  /** Disconnect from the server */
  disconnect(): Promise<void>;

  /** Check if currently connected */
  isConnected(): boolean;

  /**
   * Make an HTTP request.
   * Routes through the transport layer for connection management.
   */
  request<T>(options: RequestOptions): Promise<T>;

  /**
   * Subscribe to an SSE stream.
   * Handles reconnection and Last-Event-ID resumption.
   */
  subscribe(options: StreamOptions): Subscription;

  /** Register event listener, returns unsubscribe function */
  on<K extends keyof TransportEvents>(
    event: K,
    listener: TransportEvents[K],
  ): () => void;

  /** Get current transport metrics */
  getMetrics(): TransportMetrics;

  /** Get current connection quality */
  getQuality(): ConnectionQuality;
}

/**
 * Base class for transport adapters with shared functionality.
 * Handles event emission, metrics tracking, and connection state.
 */
export abstract class BaseTransportAdapter implements TransportAdapter {
  protected _state: ConnectionState = "disconnected";
  protected _quality: ConnectionQuality = "excellent";
  protected readonly config: Required<TransportConfig>;
  protected readonly listeners: Map<
    keyof TransportEvents,
    Set<(...args: never[]) => unknown>
  > = new Map();
  protected metrics: TransportMetrics = {
    requestCount: 0,
    failedRequests: 0,
    avgLatencyMs: 0,
    reconnectionAttempt: 0,
    totalReconnections: 0,
    missedHeartbeats: 0,
    uptimeMs: 0,
  };
  protected connectionStartTime?: number;
  private latencySum = 0;

  constructor(config: TransportConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ""),
      headers: config.headers ?? {},
      timeout: config.timeout ?? 30000,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 30000,
      autoReconnect: config.autoReconnect ?? true,
      reconnection: {
        initialDelayMs: config.reconnection?.initialDelayMs ?? 1000,
        maxDelayMs: config.reconnection?.maxDelayMs ?? 30000,
        multiplier: config.reconnection?.multiplier ?? 1.5,
        jitter: config.reconnection?.jitter ?? 0.2,
        maxAttempts: config.reconnection?.maxAttempts ?? 10,
      },
    };
  }

  get state(): ConnectionState {
    return this._state;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract request<T>(options: RequestOptions): Promise<T>;
  abstract subscribe(options: StreamOptions): Subscription;

  isConnected(): boolean {
    return this._state === "connected";
  }

  on<K extends keyof TransportEvents>(
    event: K,
    listener: TransportEvents[K],
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)?.add(listener);
    return () => this.listeners.get(event)?.delete(listener);
  }

  getMetrics(): TransportMetrics {
    return {
      ...this.metrics,
      uptimeMs: this.connectionStartTime
        ? Date.now() - this.connectionStartTime
        : 0,
    };
  }

  getQuality(): ConnectionQuality {
    return this._quality;
  }

  protected emit<K extends keyof TransportEvents>(
    event: K,
    ...args: Parameters<TransportEvents[K]>
  ): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          (listener as (...args: unknown[]) => void)(...args);
        } catch (e) {
          console.error(`Error in ${event} listener:`, e);
        }
      }
    }
  }

  protected setState(state: ConnectionState): void {
    if (this._state !== state) {
      this._state = state;
      if (state === "connected") {
        this.connectionStartTime = Date.now();
        this.metrics.reconnectionAttempt = 0;
      }
      this.emit("stateChange", state);
    }
  }

  protected setQuality(quality: ConnectionQuality): void {
    if (this._quality !== quality) {
      this._quality = quality;
      this.emit("qualityChange", quality);
    }
  }

  protected recordRequest(durationMs: number, failed: boolean): void {
    this.metrics.requestCount++;
    if (failed) {
      this.metrics.failedRequests++;
    }
    this.latencySum += durationMs;
    this.metrics.avgLatencyMs = this.latencySum / this.metrics.requestCount;
    this.metrics.lastRequestAt = Date.now();
    this.updateQuality();
  }

  protected recordReconnection(): void {
    this.metrics.totalReconnections++;
    this.emit("reconnected");
  }

  protected recordMissedHeartbeat(): void {
    this.metrics.missedHeartbeats++;
    this.updateQuality();
  }

  protected resetHeartbeatCounter(): void {
    this.metrics.missedHeartbeats = 0;
    this.updateQuality();
  }

  private updateQuality(): void {
    const failRate =
      this.metrics.requestCount > 0
        ? this.metrics.failedRequests / this.metrics.requestCount
        : 0;

    let quality: ConnectionQuality;
    if (
      this.metrics.missedHeartbeats >= 3 ||
      failRate > 0.5 ||
      this.metrics.avgLatencyMs > 5000
    ) {
      quality = "poor";
    } else if (
      this.metrics.missedHeartbeats >= 2 ||
      failRate > 0.2 ||
      this.metrics.avgLatencyMs > 2000
    ) {
      quality = "degraded";
    } else if (
      this.metrics.missedHeartbeats >= 1 ||
      failRate > 0.1 ||
      this.metrics.avgLatencyMs > 1000
    ) {
      quality = "good";
    } else {
      quality = "excellent";
    }

    this.setQuality(quality);
  }

  protected buildUrl(path: string): string {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    return `${this.config.baseUrl}${cleanPath}`;
  }

  protected buildHeaders(
    extra?: Record<string, string>,
  ): Record<string, string> {
    return {
      ...this.config.headers,
      ...extra,
    };
  }
}
