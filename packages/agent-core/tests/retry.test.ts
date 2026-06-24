/**
 * Retry Logic Tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SDKError } from "../src/errors/index.js";
import {
  calculateDelay,
  generateIdempotencyKey,
  withRetry,
} from "../src/retry/index.js";

describe("calculateDelay", () => {
  beforeEach(() => {
    // Mock Math.random for predictable jitter
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should calculate exponential backoff", () => {
    const config = {
      initialDelayMs: 1000,
      multiplier: 2,
      jitter: 0,
      maxDelayMs: 30000,
    };

    expect(calculateDelay(0, config)).toBe(1000);
    expect(calculateDelay(1, config)).toBe(2000);
    expect(calculateDelay(2, config)).toBe(4000);
    expect(calculateDelay(3, config)).toBe(8000);
  });

  it("should cap at maxDelayMs", () => {
    const config = {
      initialDelayMs: 1000,
      multiplier: 2,
      maxDelayMs: 5000,
      jitter: 0,
    };

    expect(calculateDelay(0, config)).toBe(1000);
    expect(calculateDelay(1, config)).toBe(2000);
    expect(calculateDelay(2, config)).toBe(4000);
    expect(calculateDelay(3, config)).toBe(5000); // Capped
    expect(calculateDelay(4, config)).toBe(5000); // Still capped
  });

  it("should apply jitter", () => {
    // With random = 0.5, jitter should be 0 (middle of range)
    const config = {
      initialDelayMs: 1000,
      multiplier: 2,
      jitter: 0.2,
      maxDelayMs: 30000,
    };

    const delay = calculateDelay(0, config);
    expect(delay).toBe(1000); // 0.5 maps to 0 jitter
  });

  it("should use default config values", () => {
    const delay = calculateDelay(0, {});
    // Default: initialDelayMs=1000, jitter=0.2, random=0.5 -> 0 jitter
    expect(delay).toBe(1000);
  });
});

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should return immediately on success", async () => {
    const fn = vi.fn().mockResolvedValue("success");

    const resultPromise = withRetry(fn);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(0);
  });

  it("should retry on retryable error", async () => {
    const retryableError = new SDKError("Server error", {
      code: "SERVER",
      status: 500,
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryableError)
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValue("success");

    const resultPromise = withRetry(fn, { maxAttempts: 3 });

    // Run through all retries
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should not retry non-retryable errors", async () => {
    const nonRetryableError = new SDKError("Bad request", {
      code: "VALIDATION",
      status: 400,
    });

    const fn = vi.fn().mockRejectedValue(nonRetryableError);

    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow(
      "Bad request",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should throw after max attempts", async () => {
    const retryableError = new SDKError("Server error", {
      code: "SERVER",
      status: 500,
    });

    const fn = vi.fn().mockRejectedValue(retryableError);

    const resultPromise = withRetry(fn, { maxAttempts: 3 });

    // Attach error handler immediately to prevent unhandled rejection warning
    resultPromise.catch(() => {});

    await vi.runAllTimersAsync();

    await expect(resultPromise).rejects.toThrow("Server error");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should call onRetry callback", async () => {
    const retryableError = new SDKError("Server error", {
      code: "SERVER",
      status: 500,
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValue("success");

    const onRetry = vi.fn();

    const resultPromise = withRetry(fn, { maxAttempts: 3, onRetry });
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.any(SDKError),
      1,
      expect.any(Number),
    );
  });

  it("should use custom shouldRetry predicate", async () => {
    const error = new SDKError("Custom error", { code: "UNKNOWN" });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("success");

    const shouldRetry = vi.fn().mockReturnValue(true);

    const resultPromise = withRetry(fn, { maxAttempts: 3, shouldRetry });
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(shouldRetry).toHaveBeenCalledWith(expect.any(SDKError), 0);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should respect retryAfterMs from error", async () => {
    const retryableError = new SDKError("Rate limited", {
      code: "RATE_LIMITED",
      status: 429,
      retryAfterMs: 5000,
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValue("success");

    const resultPromise = withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
    });

    // Should wait for retryAfterMs (5000), not initialDelayMs (100)
    vi.advanceTimersByTime(4999);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await vi.runAllTimersAsync();

    await resultPromise;
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("generateIdempotencyKey", () => {
  it("should generate key with idem_ prefix", () => {
    const key = generateIdempotencyKey();
    expect(key).toMatch(/^idem_[a-z0-9]+_[a-z0-9]+$/);
  });

  it("should generate unique keys", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      keys.add(generateIdempotencyKey());
    }
    expect(keys.size).toBe(100);
  });
});
