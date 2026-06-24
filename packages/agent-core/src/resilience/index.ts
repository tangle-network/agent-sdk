/**
 * Circuit breaker + timeout primitives for guarding outbound service calls.
 */

export {
  CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitBreakerStats,
  CircuitOpenError,
  type CircuitState,
} from "./circuit-breaker.js";
export {
  createProtectedFn,
  type ProtectionOptions,
  withProtection,
} from "./protection.js";
export {
  createTimeoutController,
  sleep,
  TimeoutError,
  withTimeout,
} from "./timeout.js";
