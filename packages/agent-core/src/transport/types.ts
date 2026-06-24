/**
 * Transport Types
 *
 * Core type definitions for the transport layer abstraction.
 */

/** Connection lifecycle states */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

/** Connection quality levels for monitoring */
export type ConnectionQuality = "excellent" | "good" | "degraded" | "poor";

/**
 * Transport mode for event delivery.
 *
 * - 'websocket': WebSocket via SessionGatewayClient (default, traditional server)
 * - 'sse': HTTP SSE (serverless/Cloudflare Workers)
 */
export type TransportMode = "websocket" | "sse";

/** SSE event from server */
export interface SSEEvent {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

/** Request options for HTTP calls */
export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeout?: number;
}

/** Stream subscription options */
export interface StreamOptions {
  /** HTTP method (default: GET, use POST for streaming endpoints that accept a body) */
  method?: "GET" | "POST";
  path: string;
  /** Request body (for POST requests) */
  body?: unknown;
  headers?: Record<string, string>;
  /** Last event ID for resumption */
  lastEventId?: string;
  /** Reconnection configuration */
  reconnect?: ReconnectionConfig;
  /** Abort signal */
  signal?: AbortSignal;
}

/** Reconnection configuration with exponential backoff */
export interface ReconnectionConfig {
  /** Initial delay in milliseconds (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs?: number;
  /** Backoff multiplier (default: 1.5) */
  multiplier?: number;
  /** Jitter factor 0-1 (default: 0.2) */
  jitter?: number;
  /** Maximum reconnection attempts (default: 10, -1 for infinite) */
  maxAttempts?: number;
}

/** Default reconnection config */
export const DEFAULT_RECONNECTION_CONFIG: Required<ReconnectionConfig> = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  multiplier: 1.5,
  jitter: 0.2,
  maxAttempts: 10,
};

/** Transport quality metrics */
export interface TransportMetrics {
  /** Total requests made */
  requestCount: number;
  /** Failed requests */
  failedRequests: number;
  /** Average latency in ms */
  avgLatencyMs: number;
  /** Current reconnection attempt (0 if connected) */
  reconnectionAttempt: number;
  /** Total reconnection attempts since start */
  totalReconnections: number;
  /** Missed heartbeats in current connection */
  missedHeartbeats: number;
  /** Last successful request timestamp */
  lastRequestAt?: number;
  /** Connection uptime in ms */
  uptimeMs: number;
}

/** Transport event types */
export interface TransportEvents {
  /** Connection state changed */
  stateChange: (state: ConnectionState) => void;
  /** Error occurred */
  error: (error: Error) => void;
  /** Reconnecting with attempt count */
  reconnecting: (attempt: number, maxAttempts: number) => void;
  /** Successfully reconnected */
  reconnected: () => void;
  /** Quality changed */
  qualityChange: (quality: ConnectionQuality) => void;
  /** Heartbeat received */
  heartbeat: (timestamp: number) => void;
}

/** Base transport configuration */
export interface TransportConfig {
  /** Base URL for requests */
  baseUrl: string;
  /** Default headers for all requests */
  headers?: Record<string, string>;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Heartbeat interval in ms for quality monitoring (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Enable automatic reconnection (default: true) */
  autoReconnect?: boolean;
  /** Reconnection config */
  reconnection?: ReconnectionConfig;
}

/** Subscription state */
export type SubscriptionState = "active" | "paused" | "closed";
