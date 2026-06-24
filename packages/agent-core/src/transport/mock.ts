/**
 * Mock Transport Adapter
 *
 * A fully controllable transport adapter for testing.
 * Allows mocking responses, simulating streams, and verifying requests.
 */

import { BaseTransportAdapter, type Subscription } from "./interface.js";
import type {
  RequestOptions,
  SSEEvent,
  StreamOptions,
  SubscriptionState,
  TransportConfig,
} from "./types.js";

/** Recorded request for verification */
export interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  timestamp: number;
}

/** Mock response configuration */
export interface MockResponse<T = unknown> {
  status?: number;
  data?: T;
  error?: Error;
  delay?: number;
}

/** Mock stream event */
export interface MockStreamEvent {
  event?: string;
  data: string;
  id?: string;
  delay?: number;
}

/** Mock subscription for testing */
class MockSubscription implements Subscription {
  readonly streamId: string;
  private _state: SubscriptionState = "active";
  private eventCallbacks: Set<(event: SSEEvent) => void> = new Set();
  private errorCallbacks: Set<(error: Error) => void> = new Set();
  private reconnectCallbacks: Set<(lastEventId: string | undefined) => void> =
    new Set();
  private events: SSEEvent[] = [];
  private eventIndex = 0;
  private closed = false;

  constructor(streamId: string, events: MockStreamEvent[] = []) {
    this.streamId = streamId;
    this.events = events.map((e, i) => ({
      id: e.id ?? `mock_${i}`,
      event: e.event,
      data: e.data,
    }));
  }

  get state(): SubscriptionState {
    return this._state;
  }

  pause(): void {
    if (this._state === "active") {
      this._state = "paused";
    }
  }

  resume(): void {
    if (this._state === "paused") {
      this._state = "active";
      this.deliverPending();
    }
  }

  close(): void {
    this._state = "closed";
    this.closed = true;
  }

  onEvent(callback: (event: SSEEvent) => void): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  onError(callback: (error: Error) => void): () => void {
    this.errorCallbacks.add(callback);
    return () => this.errorCallbacks.delete(callback);
  }

  onReconnect(callback: (lastEventId: string | undefined) => void): () => void {
    this.reconnectCallbacks.add(callback);
    return () => this.reconnectCallbacks.delete(callback);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SSEEvent> {
    while (!this.closed) {
      if (this.eventIndex < this.events.length) {
        if (this._state === "active") {
          yield this.events[this.eventIndex++];
        } else {
          await new Promise((r) => setTimeout(r, 10));
        }
      } else {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  }

  /** Push a new event to the stream (for testing) */
  pushEvent(event: SSEEvent): void {
    this.events.push(event);
    if (this._state === "active") {
      this.deliverPending();
    }
  }

  /** Simulate an error (for testing) */
  simulateError(error: Error): void {
    for (const cb of this.errorCallbacks) {
      cb(error);
    }
  }

  /** Simulate reconnection (for testing) */
  simulateReconnect(lastEventId?: string): void {
    for (const cb of this.reconnectCallbacks) {
      cb(lastEventId);
    }
  }

  private deliverPending(): void {
    while (this.eventIndex < this.events.length && this._state === "active") {
      const event = this.events[this.eventIndex++];
      for (const cb of this.eventCallbacks) {
        cb(event);
      }
    }
  }

  /** Start delivering events automatically */
  startDelivery(): void {
    this.deliverPending();
  }
}

/** Configuration for MockTransportAdapter */
export interface MockTransportConfig extends Partial<TransportConfig> {
  /** Auto-connect on creation (default: true) */
  autoConnect?: boolean;
}

/**
 * Mock transport adapter for testing.
 * Provides full control over responses and streams.
 */
export class MockTransportAdapter extends BaseTransportAdapter {
  private readonly responses = new Map<string, MockResponse>();
  private readonly streams = new Map<string, MockStreamEvent[]>();
  private readonly subscriptions = new Map<string, MockSubscription>();
  readonly requests: RecordedRequest[] = [];

  constructor(config: MockTransportConfig = {}) {
    super({
      baseUrl: config.baseUrl ?? "http://mock",
      headers: config.headers,
      timeout: config.timeout,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      autoReconnect: config.autoReconnect,
      reconnection: config.reconnection,
    });

    if (config.autoConnect !== false) {
      this.setState("connected");
    }
  }

  async connect(): Promise<void> {
    this.setState("connecting");
    this.setState("connected");
  }

  async disconnect(): Promise<void> {
    this.setState("disconnected");
    for (const sub of this.subscriptions.values()) {
      sub.close();
    }
    this.subscriptions.clear();
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const start = Date.now();

    this.requests.push({
      method: options.method ?? "GET",
      path: options.path,
      body: options.body,
      headers: options.headers,
      timestamp: start,
    });

    const key = `${options.method ?? "GET"}:${options.path}`;
    const mock = this.responses.get(key) ?? this.responses.get(options.path);

    if (mock?.delay) {
      await new Promise((r) => setTimeout(r, mock.delay));
    }

    const duration = Date.now() - start;

    if (mock?.error) {
      this.recordRequest(duration, true);
      throw mock.error;
    }

    this.recordRequest(duration, false);
    return (mock?.data ?? {}) as T;
  }

  subscribe(options: StreamOptions): Subscription {
    const streamId = `mock_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const events = this.streams.get(options.path) ?? [];
    const subscription = new MockSubscription(streamId, events);
    this.subscriptions.set(streamId, subscription);

    // Start delivering events after a microtask
    queueMicrotask(() => subscription.startDelivery());

    return subscription;
  }

  // ========== Test Helpers ==========

  /** Mock a response for a specific path */
  mockResponse<T>(path: string, response: MockResponse<T>): void {
    this.responses.set(path, response);
  }

  /** Mock a response for a specific method and path */
  mockMethodResponse<T>(
    method: string,
    path: string,
    response: MockResponse<T>,
  ): void {
    this.responses.set(`${method}:${path}`, response);
  }

  /** Mock a stream with events */
  mockStream(path: string, events: MockStreamEvent[]): void {
    this.streams.set(path, events);
  }

  /** Get a subscription by stream ID */
  getSubscription(streamId: string): MockSubscription | undefined {
    return this.subscriptions.get(streamId);
  }

  /** Get all active subscriptions */
  getActiveSubscriptions(): MockSubscription[] {
    return Array.from(this.subscriptions.values()).filter(
      (s) => s.state !== "closed",
    );
  }

  /** Push an event to all subscriptions for a path */
  pushEventToPath(_path: string, event: SSEEvent): void {
    for (const sub of this.subscriptions.values()) {
      sub.pushEvent(event);
    }
  }

  /** Clear all recorded requests */
  clearRequests(): void {
    this.requests.length = 0;
  }

  /** Clear all mocked responses */
  clearMocks(): void {
    this.responses.clear();
    this.streams.clear();
  }

  /** Get requests matching a path pattern */
  getRequestsForPath(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  /** Get the last request made */
  getLastRequest(): RecordedRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  /** Simulate connection failure */
  simulateDisconnect(): void {
    this.setState("disconnected");
    this.emit("error", new Error("Simulated disconnect"));
  }

  /** Simulate reconnection */
  simulateReconnect(): void {
    this.setState("connected");
    this.recordReconnection();
  }
}
