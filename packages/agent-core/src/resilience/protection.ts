/**
 * Combines timeout + circuit breaker into a single request guard.
 */

import type { CircuitBreaker } from "./circuit-breaker.js";
import { withTimeout } from "./timeout.js";

export interface ProtectionOptions {
  /** Timeout in milliseconds (0 or undefined = no timeout) */
  timeoutMs?: number;
  /** Circuit breaker instance (optional) */
  breaker?: CircuitBreaker;
  /** Operation name for error messages */
  operationName?: string;
}

/**
 * Execute a function with timeout and circuit breaker protection.
 *
 * Order of execution:
 * 1. Circuit breaker check (fail fast if open)
 * 2. Timeout wrapper
 * 3. Execute function
 * 4. Update circuit breaker state
 */
export async function withProtection<T>(
  fn: () => Promise<T>,
  options: ProtectionOptions = {},
): Promise<T> {
  const { timeoutMs, breaker, operationName = "operation" } = options;

  const execute = async (): Promise<T> => {
    if (timeoutMs && timeoutMs > 0) {
      return withTimeout(fn(), timeoutMs, `${operationName} timed out`);
    }
    return fn();
  };

  if (breaker) {
    return breaker.execute(execute);
  }

  return execute();
}

/**
 * Create a protected function that always applies the same protection options.
 */
export function createProtectedFn<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: ProtectionOptions,
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => withProtection(() => fn(...args), options);
}
