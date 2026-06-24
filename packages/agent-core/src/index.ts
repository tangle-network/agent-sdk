/**
 * @tangle-network/agent-core
 *
 * Core transport interfaces, event utilities, and types for the Agent Dev Container SDK.
 */

// Auth
export {
  type AuthProvider,
  // Scoped token payload types
  type BatchScopedTokenPayload,
  BatchScopedTokenPayloadSchema,
  CallbackAuth,
  type ChannelAccessResult,
  // Types
  type CreateSessionRequest,
  CreateSessionRequestSchema,
  type CreateSessionResponse,
  // Channel access control
  canBatchTokenAccessChannel,
  canProjectTokenAccessChannel,
  canSessionTokenAccessChannel,
  canTokenAccessChannel,
  // Token utilities
  decodeToken,
  EnvTokenAuth,
  extractProjectFromChannel,
  extractSessionFromChannel,
  generateApiKey,
  generateSecureToken,
  generateSigningSecret,
  getAllowedChannelPatterns,
  getTokenScope,
  getTokenTTL,
  hashApiKey,
  // Token scope detection
  isBatchScopedToken,
  isProjectScopedToken,
  isSessionScopedToken,
  // Token issuance (all scopes)
  issueBatchScopedToken,
  issueProjectScopedToken,
  issueReadToken,
  issueSessionScopedToken,
  isTokenExpiringSoon,
  NoAuth,
  type Product,
  ProductAuth,
  type ProductAuthInfo,
  ProductSchema,
  type ProductSecrets,
  ProductTokenIssuer,
  type ProjectScopedTokenPayload,
  ProjectScopedTokenPayloadSchema,
  ReadTokenAuth,
  type ReadTokenPayload,
  ReadTokenPayloadSchema,
  RefreshableTokenAuth,
  type SendMessageRequest,
  SendMessageRequestSchema,
  type SessionScopedTokenPayload,
  SessionScopedTokenPayloadSchema,
  SidecarAuth,
  StaticTokenAuth,
  type TokenScope,
  type TokenValidationResult,
  validateChannelSubscription,
  validateTokenScope,
  verifyApiKey,
  verifyReadToken,
} from "./auth/index.js";
// Cache
export {
  type CacheConfig,
  type CacheStorage,
  MemoryCache,
  ResponseCache,
} from "./cache/index.js";
// Errors
export {
  type ErrorCode,
  isRetryable,
  isSDKError,
  SDKError,
} from "./errors/index.js";
// Events
export {
  type BufferedEvent,
  type ChannelConfig,
  type ChannelHandler,
  type DeduplicatorConfig,
  EventBuffer,
  type EventBufferConfig,
  EventChannel,
  EventDeduplicator,
} from "./events/index.js";
// Middleware
export {
  createHeaderInterceptor,
  createLoggingInterceptor,
  createMetricsInterceptor,
  type ErrorContext,
  generateRequestId,
  type Interceptor,
  InterceptorChain,
  type RequestContext,
  type ResponseContext,
} from "./middleware/index.js";
// Platform Abstraction
export {
  BrowserNetworkInfo,
  BrowserPersistence,
  createDefaultPlatformAdapter,
  createPlatformAdapter,
  detectPlatform,
  MemorySecureStorage,
  type NetworkInfo,
  NodeNetworkInfo,
  type PersistenceAdapter,
  type PlatformAdapter,
  type PlatformCapabilities,
  type SecureStorage,
  StoragePersistence,
} from "./platform/index.js";
// Resilience
export {
  CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitBreakerStats,
  CircuitOpenError,
  type CircuitState,
  createProtectedFn,
  createTimeoutController,
  type ProtectionOptions,
  sleep,
  TimeoutError,
  withProtection,
  withTimeout,
} from "./resilience/index.js";
// Retry
export {
  calculateDelay,
  generateIdempotencyKey,
  Retryable,
  type RetryConfig,
  withRetry,
} from "./retry/index.js";
// SSE Utilities
export {
  consumeSSEStream,
  createStreamUsageExtractor,
  createUsageCallback,
  type ParsedSSEEvent,
  parseSSEData,
  parseSSEStream,
  SSEChunkParser,
  type SSEEventData,
  type SSEParserOptions,
  type StreamTokenUsage,
  type StreamUsageAccumulator,
  StreamUsageExtractor,
} from "./sse/index.js";
// Storage
export {
  detectStorage,
  LocalStorage,
  MemoryStorage,
  OfflineQueue,
  type QueuedRequest,
  type Storage,
} from "./storage/index.js";
// Telemetry (GenAI semantic-convention attribute vocabulary + tokenUsage fields)
export {
  GEN_AI_CONVERSATION_ID,
  GEN_AI_INPUT_TOKEN_KEYS,
  GEN_AI_MODEL_KEYS,
  GEN_AI_OPERATION_NAME,
  GEN_AI_OUTPUT_TOKEN_KEYS,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  type GenAiUsage,
  genAiUsageAttributes,
  TOKEN_USAGE_INPUT_KEYS,
  TOKEN_USAGE_OUTPUT_KEYS,
} from "./telemetry/index.js";
// Transport
export {
  BaseTransportAdapter,
  // Connection Manager
  ConnectionManager,
  type ConnectionManagerConfig,
  // Types
  type ConnectionQuality,
  type ConnectionState,
  DEFAULT_RECONNECTION_CONFIG,
  type MockResponse,
  type MockStreamEvent,
  // Mock (for testing)
  MockTransportAdapter,
  type MockTransportConfig,
  type ReconnectionConfig,
  type RecordedRequest,
  type RequestOptions,
  type SSEEvent,
  type StreamOptions,
  // Interface
  type Subscription,
  type SubscriptionState,
  type TransportAdapter,
  type TransportConfig,
  type TransportEvents,
  type TransportMetrics,
  type TransportMode,
} from "./transport/index.js";
// Event types (Part types re-exported from @tangle-network/agent-interface)
export {
  type AgentEvent,
  type AgentEventType,
  AgentEventTypeSchema,
  type ConnectionInitEvent,
  type DoneEvent,
  type ErrorEvent,
  type EventMetadata,
  type ExecutionCompletedEvent,
  type ExecutionFailedEvent,
  type ExecutionStartedEvent,
  type FilePart,
  type HeartbeatEvent,
  isFilePart,
  isReasoningPart,
  isSubtaskPart,
  isTextPart,
  isToolPart,
  type MessagePartUpdatedEvent,
  type Part,
  type PartBase,
  type ReasoningPart,
  type ReplayEndEvent,
  type ReplayStartEvent,
  type ResultEvent,
  type SessionUpdatedEvent,
  type StatusEvent,
  type SubtaskPart,
  type TerminalDataEvent,
  type TerminalEvent,
  type TerminalExitEvent,
  type TerminalResizeEvent,
  type TextPart,
  type ToolPart,
  type ToolState,
  type ToolStateCompleted,
  type ToolStateError,
  type ToolStatePending,
  type ToolStateRunning,
} from "./types/index.js";
// Utilities (transport-agnostic)
export {
  createSessionTranslator,
  extractSessionId,
  matchesAnyChannel,
  matchesChannel,
  type SessionTranslation,
  translateSessionId,
} from "./utils/index.js";
