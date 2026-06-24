/**
 * SDK Error Tests
 */

import { describe, expect, it } from "vitest";
import { isRetryable, isSDKError, SDKError } from "../src/errors/index.js";

describe("SDKError", () => {
  describe("constructor", () => {
    it("should create error with message and code", () => {
      const error = new SDKError("Test error", { code: "NETWORK" });

      expect(error.message).toBe("Test error");
      expect(error.code).toBe("NETWORK");
      expect(error.name).toBe("SDKError");
    });

    it("should infer retryable for network errors", () => {
      const error = new SDKError("Network error", { code: "NETWORK" });
      expect(error.retryable).toBe(true);
    });

    it("should infer retryable for timeout errors", () => {
      const error = new SDKError("Timeout", { code: "TIMEOUT" });
      expect(error.retryable).toBe(true);
    });

    it("should infer retryable for rate limited errors", () => {
      const error = new SDKError("Rate limited", { code: "RATE_LIMITED" });
      expect(error.retryable).toBe(true);
    });

    it("should infer retryable for server errors (5xx)", () => {
      const error = new SDKError("Server error", {
        code: "SERVER",
        status: 500,
      });
      expect(error.retryable).toBe(true);
    });

    it("should not be retryable for validation errors", () => {
      const error = new SDKError("Invalid input", { code: "VALIDATION" });
      expect(error.retryable).toBe(false);
    });

    it("should not be retryable for auth errors", () => {
      const error = new SDKError("Unauthorized", { code: "AUTH" });
      expect(error.retryable).toBe(false);
    });

    it("should allow explicit retryable override", () => {
      const error = new SDKError("Auth error", {
        code: "AUTH",
        retryable: true,
      });
      expect(error.retryable).toBe(true);
    });

    it("should store retryAfterMs", () => {
      const error = new SDKError("Rate limited", {
        code: "RATE_LIMITED",
        retryAfterMs: 5000,
      });
      expect(error.retryAfterMs).toBe(5000);
    });

    it("should store context", () => {
      const error = new SDKError("Error", {
        code: "UNKNOWN",
        context: { requestId: "123" },
      });
      expect(error.context).toEqual({ requestId: "123" });
    });

    it("should store cause", () => {
      const cause = new Error("Original error");
      const error = new SDKError("Wrapped error", {
        code: "UNKNOWN",
        cause,
      });
      expect(error.cause).toBe(cause);
    });
  });

  describe("fromResponse", () => {
    it("should create AUTH error for 401", () => {
      const error = SDKError.fromResponse(401);
      expect(error.code).toBe("AUTH");
      expect(error.status).toBe(401);
      expect(error.retryable).toBe(false);
    });

    it("should create AUTH error for 403", () => {
      const error = SDKError.fromResponse(403);
      expect(error.code).toBe("AUTH");
      expect(error.status).toBe(403);
    });

    it("should create NOT_FOUND error for 404", () => {
      const error = SDKError.fromResponse(404);
      expect(error.code).toBe("NOT_FOUND");
      expect(error.retryable).toBe(false);
    });

    it("should create VALIDATION error for 400", () => {
      const error = SDKError.fromResponse(400);
      expect(error.code).toBe("VALIDATION");
      expect(error.retryable).toBe(false);
    });

    it("should create VALIDATION error for 422", () => {
      const error = SDKError.fromResponse(422);
      expect(error.code).toBe("VALIDATION");
    });

    it("should create RATE_LIMITED error for 429", () => {
      const error = SDKError.fromResponse(429);
      expect(error.code).toBe("RATE_LIMITED");
      expect(error.retryable).toBe(true);
    });

    it("should extract retryAfter from body for 429", () => {
      const error = SDKError.fromResponse(429, { retryAfter: 5 });
      expect(error.retryAfterMs).toBe(5000); // Converted to ms
    });

    it("should create SERVER error for 5xx", () => {
      const error = SDKError.fromResponse(500);
      expect(error.code).toBe("SERVER");
      expect(error.retryable).toBe(true);
    });

    it("should create UNKNOWN error for other status codes", () => {
      const error = SDKError.fromResponse(418);
      expect(error.code).toBe("UNKNOWN");
    });

    it("should extract message from body", () => {
      const error = SDKError.fromResponse(400, { message: "Custom message" });
      expect(error.message).toBe("Custom message");
    });

    it("should use HTTP status as message if no body", () => {
      const error = SDKError.fromResponse(500);
      expect(error.message).toBe("HTTP 500");
    });

    // Regression: harden 2026-04-26 / issue #785.
    //
    // Hetzner Cloud API errors come back as
    //   { error: { code, message, details } }
    //
    // The previous implementation only probed `body.message` (top
    // level), so every Hetzner failure was logged as an opaque
    // "HTTP 422" with no context — operators had to replay against
    // the live API to learn what failed. Each of these cases is a
    // shape we have actually seen in production logs.
    it("extracts nested message from Hetzner-style { error: { message } }", () => {
      const error = SDKError.fromResponse(422, {
        error: {
          code: "invalid_input",
          message: "server type ax41 unavailable",
        },
      });
      expect(error.message).toBe("invalid_input: server type ax41 unavailable");
      expect(error.context?.body).toBeDefined();
    });

    it("extracts message from { error: { details } } when message is missing", () => {
      const error = SDKError.fromResponse(422, {
        error: { details: "field 'image' is required" },
      });
      expect(error.message).toBe("field 'image' is required");
    });

    it("falls back to flat { error: 'string' } shape", () => {
      const error = SDKError.fromResponse(400, { error: "bad request" });
      expect(error.message).toBe("bad request");
    });

    it("uses plain-text body when response was not JSON", () => {
      const error = SDKError.fromResponse(503, "service unavailable");
      expect(error.message).toBe("service unavailable");
    });

    it("truncates oversized plain-text bodies", () => {
      const huge = "x".repeat(10_000);
      const error = SDKError.fromResponse(500, huge);
      expect(error.message.length).toBeLessThanOrEqual(501);
      expect(error.message.endsWith("…")).toBe(true);
    });

    it("falls back to HTTP <status> when no message field is recognizable", () => {
      const error = SDKError.fromResponse(418, { unrelated: "field" });
      expect(error.message).toBe("HTTP 418");
    });
  });

  describe("fromError", () => {
    it("should return same error if already SDKError", () => {
      const original = new SDKError("Test", { code: "NETWORK" });
      const result = SDKError.fromError(original);
      expect(result).toBe(original);
    });

    it("should detect network errors from TypeError", () => {
      const error = new TypeError("fetch failed");
      const result = SDKError.fromError(error);
      expect(result.code).toBe("NETWORK");
      expect(result.retryable).toBe(true);
    });

    it("should detect AbortError as cancelled", () => {
      const error = new DOMException("Aborted", "AbortError");
      const result = SDKError.fromError(error);
      expect(result.code).toBe("CANCELLED");
      expect(result.retryable).toBe(false);
    });

    it("should detect timeout errors", () => {
      const error = new Error("Request timeout");
      const result = SDKError.fromError(error);
      expect(result.code).toBe("TIMEOUT");
      expect(result.retryable).toBe(true);
    });

    it("should wrap other errors as UNKNOWN", () => {
      const error = new Error("Some error");
      const result = SDKError.fromError(error);
      expect(result.code).toBe("UNKNOWN");
      expect(result.message).toBe("Some error");
    });

    it("should handle non-Error values", () => {
      const result = SDKError.fromError("string error");
      expect(result.code).toBe("UNKNOWN");
      expect(result.message).toBe("string error");
    });
  });

  describe("isAuthExpired", () => {
    it("should return true for AUTH_EXPIRED code", () => {
      const error = new SDKError("Token expired", { code: "AUTH_EXPIRED" });
      expect(error.isAuthExpired()).toBe(true);
    });

    it("should return true for AUTH code with 401 status", () => {
      const error = new SDKError("Unauthorized", {
        code: "AUTH",
        status: 401,
      });
      expect(error.isAuthExpired()).toBe(true);
    });

    it("should return false for AUTH code with 403 status", () => {
      const error = new SDKError("Forbidden", {
        code: "AUTH",
        status: 403,
      });
      expect(error.isAuthExpired()).toBe(false);
    });
  });
});

describe("isSDKError", () => {
  it("should return true for SDKError instances", () => {
    const error = new SDKError("Test", { code: "UNKNOWN" });
    expect(isSDKError(error)).toBe(true);
  });

  it("should return false for regular Error", () => {
    const error = new Error("Test");
    expect(isSDKError(error)).toBe(false);
  });

  it("should return false for non-errors", () => {
    expect(isSDKError(null)).toBe(false);
    expect(isSDKError(undefined)).toBe(false);
    expect(isSDKError("error")).toBe(false);
  });
});

describe("isRetryable", () => {
  it("should return true for retryable SDKError", () => {
    const error = new SDKError("Network error", { code: "NETWORK" });
    expect(isRetryable(error)).toBe(true);
  });

  it("should return false for non-retryable SDKError", () => {
    const error = new SDKError("Bad request", { code: "VALIDATION" });
    expect(isRetryable(error)).toBe(false);
  });

  it("should return false for regular Error", () => {
    const error = new Error("Test");
    expect(isRetryable(error)).toBe(false);
  });
});
