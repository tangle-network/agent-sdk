/**
 * Timeout Utilities
 *
 * Promise-based timeout handling with proper cleanup.
 */

import { SDKError } from "../errors/index.js";

export class TimeoutError extends SDKError {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message, {
      code: "TIMEOUT",
      retryable: true,
      context: { timeoutMs },
    });
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Wrap a promise with a timeout.
 * Rejects with TimeoutError if the promise doesn't resolve in time.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message?: string,
): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }

  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new TimeoutError(
          message || `Operation timed out after ${timeoutMs}ms`,
          timeoutMs,
        ),
      );
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

/**
 * Create an AbortController that auto-aborts after a timeout.
 * Returns the controller and a cleanup function.
 */
export function createTimeoutController(timeoutMs: number): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      controller.abort(new TimeoutError("Request timeout", timeoutMs));
    }, timeoutMs);
  }

  return {
    controller,
    cleanup: () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    },
  };
}

/**
 * Sleep for a specified duration.
 * Optionally accepts an AbortSignal for cancellation.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const timeoutId = setTimeout(resolve, ms);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeoutId);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
