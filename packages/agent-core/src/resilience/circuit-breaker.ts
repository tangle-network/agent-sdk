/**
 * Circuit Breaker
 *
 * Implements the circuit breaker pattern for fail-fast behavior when
 * downstream services are unhealthy. Prevents cascade failures by
 * stopping requests to failing services.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service unhealthy, requests fail immediately
 * - HALF_OPEN: Testing if service recovered
 */

import { SDKError } from "../errors/index.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Time in ms to wait before testing recovery (half-open) */
  resetTimeoutMs: number;
  /** Number of successes in half-open state to close circuit */
  successThreshold: number;
  /** Optional: Only count these error types as failures */
  failureFilter?: (error: unknown) => boolean;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  totalFailures: number;
  totalSuccesses: number;
  totalRejected: number;
}

export class CircuitOpenError extends SDKError {
  readonly circuitName: string;
  readonly resetAfterMs: number;

  constructor(name: string, resetAfterMs: number) {
    super(`Circuit breaker '${name}' is open`, {
      code: "SERVER",
      retryable: true,
      retryAfterMs: resetAfterMs,
      context: { circuitName: name },
    });
    this.name = "CircuitOpenError";
    this.circuitName = name;
    this.resetAfterMs = resetAfterMs;
  }
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private lastFailureTime: number | null = null;

  // Lifetime stats
  private totalFailures = 0;
  private totalSuccesses = 0;
  private totalRejected = 0;

  constructor(
    private readonly name: string,
    private readonly config: CircuitBreakerConfig,
  ) {
    if (config.failureThreshold < 1) {
      throw new Error("failureThreshold must be >= 1");
    }
    if (config.resetTimeoutMs < 0) {
      throw new Error("resetTimeoutMs must be >= 0");
    }
    if (config.successThreshold < 1) {
      throw new Error("successThreshold must be >= 1");
    }
  }

  /**
   * Execute a function through the circuit breaker.
   * Throws CircuitOpenError if circuit is open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we should transition from open to half-open
    if (this.state === "open") {
      const timeSinceFailure = this.lastFailureTime
        ? Date.now() - this.lastFailureTime
        : Number.POSITIVE_INFINITY;

      if (timeSinceFailure >= this.config.resetTimeoutMs) {
        this.state = "half-open";
        this.successes = 0;
      } else {
        this.totalRejected++;
        throw new CircuitOpenError(
          this.name,
          this.config.resetTimeoutMs - timeSinceFailure,
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  private onSuccess(): void {
    this.totalSuccesses++;

    if (this.state === "half-open") {
      this.successes++;
      if (this.successes >= this.config.successThreshold) {
        // Service recovered, close circuit
        this.state = "closed";
        this.failures = 0;
        this.successes = 0;
      }
    } else if (this.state === "closed") {
      // Reset failure count on success
      this.failures = 0;
    }
  }

  private onFailure(error: unknown): void {
    // Check if this error should count as a failure
    if (this.config.failureFilter && !this.config.failureFilter(error)) {
      return;
    }

    this.totalFailures++;
    this.failures++;
    this.lastFailureTime = Date.now();
    this.successes = 0;

    if (this.state === "half-open") {
      // Any failure in half-open returns to open
      this.state = "open";
    } else if (
      this.state === "closed" &&
      this.failures >= this.config.failureThreshold
    ) {
      // Threshold exceeded, open circuit
      this.state = "open";
    }
  }

  /** Get current circuit state */
  getState(): CircuitState {
    return this.state;
  }

  /** Get circuit statistics */
  getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      totalRejected: this.totalRejected,
    };
  }

  /** Check if circuit is allowing requests */
  isAllowingRequests(): boolean {
    if (this.state === "closed" || this.state === "half-open") {
      return true;
    }

    // Check if reset timeout has passed
    const timeSinceFailure = this.lastFailureTime
      ? Date.now() - this.lastFailureTime
      : Number.POSITIVE_INFINITY;

    return timeSinceFailure >= this.config.resetTimeoutMs;
  }

  /** Manually reset the circuit to closed state */
  reset(): void {
    this.state = "closed";
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
  }

  /** Manually open the circuit */
  open(): void {
    this.state = "open";
    this.lastFailureTime = Date.now();
  }
}
