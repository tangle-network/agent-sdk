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
export * from "./resilience/index.js";
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
// Telemetry (GenAI + content attribute vocabularies + tokenUsage fields)
export * from "./telemetry/index.js";
// Transport
export * from "./transport/index.js";
// Event types (Part types re-exported from @tangle-network/agent-interface)
export * from "./types/index.js";
// Utilities (transport-agnostic)
export * from "./utils/index.js";
