/**
 * Request Retry Logic
 *
 * Per-request retry with exponential backoff and idempotency.
 */

import { isRetryable, SDKError } from "../errors/index.js";

/** Retry configuration */
export interface RetryConfig {
  /** Max retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in ms (default: 1000) */
  initialDelayMs?: number;
  /** Max delay in ms (default: 30000) */
  maxDelayMs?: number;
  /** Backoff multiplier (default: 2) */
  multiplier?: number;
  /** Jitter factor 0-1 (default: 0.2) */
  jitter?: number;
  /** Custom retry predicate */
  shouldRetry?: (error: SDKError, attempt: number) => boolean;
  /** Callback before retry */
  onRetry?: (error: SDKError, attempt: number, delayMs: number) => void;
}

const DEFAULT_RETRY_CONFIG: Required<
  Omit<RetryConfig, "shouldRetry" | "onRetry">
> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  multiplier: 2,
  jitter: 0.2,
};

/** Calculate delay for attempt with jitter */
export function calculateDelay(attempt: number, config: RetryConfig): number {
  const { initialDelayMs, maxDelayMs, multiplier, jitter } = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
  };

  const baseDelay = Math.min(
    initialDelayMs * multiplier ** attempt,
    maxDelayMs,
  );

  const jitterRange = baseDelay * jitter;
  const jitterValue = Math.random() * jitterRange * 2 - jitterRange;

  return Math.max(0, Math.floor(baseDelay + jitterValue));
}

/** Execute function with retry */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  config: RetryConfig = {},
): Promise<T> {
  const maxAttempts = config.maxAttempts ?? DEFAULT_RETRY_CONFIG.maxAttempts;
  let lastError: SDKError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = SDKError.fromError(error);

      // Check if we should retry
      const shouldRetry = config.shouldRetry
        ? config.shouldRetry(lastError, attempt)
        : isRetryable(lastError);

      if (!shouldRetry || attempt >= maxAttempts - 1) {
        throw lastError;
      }

      // Calculate delay (use server's retry-after if provided)
      const delay = lastError.retryAfterMs ?? calculateDelay(attempt, config);

      config.onRetry?.(lastError, attempt + 1, delay);

      await sleep(delay);
    }
  }

  throw lastError ?? new SDKError("Max retries exceeded", { code: "UNKNOWN" });
}

/** Sleep utility */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Idempotency key generator */
export function generateIdempotencyKey(): string {
  return `idem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Retry decorator for class methods */
export function Retryable(config: RetryConfig = {}) {
  return <T>(
    _target: object,
    _propertyKey: string,
    descriptor: TypedPropertyDescriptor<(...args: unknown[]) => Promise<T>>,
  ): TypedPropertyDescriptor<(...args: unknown[]) => Promise<T>> => {
    const original = descriptor.value;
    if (!original) return descriptor;

    descriptor.value = async function (
      this: unknown,
      ...args: unknown[]
    ): Promise<T> {
      return withRetry((_attempt) => {
        // Inject attempt count if function accepts it
        return original.apply(this, args);
      }, config);
    };

    return descriptor;
  };
}
