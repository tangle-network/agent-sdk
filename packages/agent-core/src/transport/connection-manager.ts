/**
 * Connection Manager
 *
 * Manages reconnection logic with exponential backoff and jitter.
 */

import {
  DEFAULT_RECONNECTION_CONFIG,
  type ReconnectionConfig,
} from "./types.js";

export interface ConnectionManagerConfig extends ReconnectionConfig {
  onReconnecting?: (attempt: number, maxAttempts: number) => void;
  onReconnected?: () => void;
  onFailed?: (error: Error) => void;
}

export class ConnectionManager {
  private readonly config: Required<ReconnectionConfig>;
  private attempt = 0;
  private aborted = false;
  private readonly callbacks: {
    onReconnecting?: (attempt: number, maxAttempts: number) => void;
    onReconnected?: () => void;
    onFailed?: (error: Error) => void;
  };

  constructor(config: ConnectionManagerConfig = {}) {
    this.config = {
      initialDelayMs:
        config.initialDelayMs ?? DEFAULT_RECONNECTION_CONFIG.initialDelayMs,
      maxDelayMs: config.maxDelayMs ?? DEFAULT_RECONNECTION_CONFIG.maxDelayMs,
      multiplier: config.multiplier ?? DEFAULT_RECONNECTION_CONFIG.multiplier,
      jitter: config.jitter ?? DEFAULT_RECONNECTION_CONFIG.jitter,
      maxAttempts:
        config.maxAttempts ?? DEFAULT_RECONNECTION_CONFIG.maxAttempts,
    };
    this.callbacks = {
      onReconnecting: config.onReconnecting,
      onReconnected: config.onReconnected,
      onFailed: config.onFailed,
    };
  }

  /**
   * Calculate delay for current attempt with exponential backoff and jitter.
   */
  private calculateDelay(): number {
    const exponentialDelay =
      this.config.initialDelayMs * this.config.multiplier ** (this.attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, this.config.maxDelayMs);
    const jitterRange = cappedDelay * this.config.jitter;
    const jitter = (Math.random() - 0.5) * 2 * jitterRange;
    return Math.max(0, cappedDelay + jitter);
  }

  /**
   * Wait for the calculated delay.
   */
  private async wait(): Promise<void> {
    const delay = this.calculateDelay();
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  /**
   * Check if more reconnection attempts are allowed.
   */
  canRetry(): boolean {
    if (this.aborted) return false;
    if (this.config.maxAttempts === -1) return true;
    return this.attempt < this.config.maxAttempts;
  }

  /**
   * Get current attempt number.
   */
  getAttempt(): number {
    return this.attempt;
  }

  /**
   * Reset the connection manager state.
   */
  reset(): void {
    this.attempt = 0;
    this.aborted = false;
  }

  /**
   * Abort any pending reconnection attempts.
   */
  abort(): void {
    this.aborted = true;
  }

  /**
   * Execute a reconnection attempt with the provided connect function.
   * Returns true if connection succeeded, false if should retry.
   */
  async reconnect(connectFn: () => Promise<void>): Promise<boolean> {
    if (!this.canRetry()) {
      const error = new Error(
        `Max reconnection attempts (${this.config.maxAttempts}) exceeded`,
      );
      this.callbacks.onFailed?.(error);
      return false;
    }

    this.attempt++;
    this.callbacks.onReconnecting?.(this.attempt, this.config.maxAttempts);

    await this.wait();

    if (this.aborted) {
      return false;
    }

    try {
      await connectFn();
      this.callbacks.onReconnected?.();
      this.reset();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run reconnection loop until success or max attempts.
   */
  async runReconnectionLoop(connectFn: () => Promise<void>): Promise<boolean> {
    while (this.canRetry()) {
      const success = await this.reconnect(connectFn);
      if (success) {
        return true;
      }
    }
    return false;
  }
}
