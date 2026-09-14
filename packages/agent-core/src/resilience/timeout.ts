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

  let clearTimer: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    clearTimer = armTimeout(timeoutMs, () => {
      reject(
        new TimeoutError(
          message || `Operation timed out after ${timeoutMs}ms`,
          timeoutMs,
        ),
      );
    });
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimer?.();
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
  let clearTimer: (() => void) | undefined;

  if (timeoutMs > 0) {
    clearTimer = armTimeout(timeoutMs, () => {
      controller.abort(new TimeoutError("Request timeout", timeoutMs));
    });
  }

  return {
    controller,
    cleanup: () => {
      clearTimer?.();
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
    const onAbort = () => {
      clearTimer();
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const clearTimer = armTimeout(ms, () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Keep one absolute deadline; native timers overflow to 1ms beyond this chunk size. */
function armTimeout(ms: number, callback: () => void): () => void {
  const deadline = Date.now() + Math.max(0, ms);
  if (!Number.isFinite(ms) || !Number.isSafeInteger(Math.ceil(deadline))) {
    throw new SDKError("Timeout must produce a finite safe deadline", { code: "VALIDATION" });
  }
  let cleared = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (cleared) return;
    timer = setTimeout(() => {
      if (cleared) return;
      if (Date.now() >= deadline) callback();
      else arm();
    }, Math.min(2_147_483_647, Math.max(0, deadline - Date.now())));
  };
  arm();
  return () => {
    cleared = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
