/**
 * Transport Module
 *
 * Core transport abstractions for the Agent Dev Container SDK.
 */

// Connection Manager
export {
  ConnectionManager,
  type ConnectionManagerConfig,
} from "./connection-manager.js";

// Interface
export {
  BaseTransportAdapter,
  type Subscription,
  type TransportAdapter,
} from "./interface.js";
// Mock (for testing)
export {
  type MockResponse,
  type MockStreamEvent,
  MockTransportAdapter,
  type MockTransportConfig,
  type RecordedRequest,
} from "./mock.js";
// Types
export {
  type ConnectionQuality,
  type ConnectionState,
  DEFAULT_RECONNECTION_CONFIG,
  type ReconnectionConfig,
  type RequestOptions,
  type SSEEvent,
  type StreamOptions,
  type SubscriptionState,
  type TransportConfig,
  type TransportEvents,
  type TransportMetrics,
  type TransportMode,
} from "./types.js";
