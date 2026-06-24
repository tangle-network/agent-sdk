/**
 * SDK Error Types
 *
 * Structured errors with codes, retry hints, and context.
 */

/** Error categories for routing and handling */
export type ErrorCode =
  | "NETWORK"
  | "TIMEOUT"
  | "AUTH"
  | "AUTH_EXPIRED"
  | "VALIDATION"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "SERVER"
  | "CANCELLED"
  | "UNKNOWN";

/** SDK error with structured metadata */
export class SDKError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      code: ErrorCode;
      status?: number;
      retryable?: boolean;
      retryAfterMs?: number;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "SDKError";
    this.code = options.code;
    this.status = options.status;
    this.retryable =
      options.retryable ?? this.inferRetryable(options.code, options.status);
    this.retryAfterMs = options.retryAfterMs;
    this.context = options.context;
  }

  private inferRetryable(code: ErrorCode, status?: number): boolean {
    // Network issues and server errors are typically retryable
    if (code === "NETWORK" || code === "TIMEOUT") return true;
    if (code === "RATE_LIMITED") return true;
    if (code === "SERVER" && status && status >= 500) return true;
    // Auth expired can be retried after refresh
    if (code === "AUTH_EXPIRED") return true;
    // Client errors are not retryable
    return false;
  }

  /** Create from HTTP response */
  static fromResponse(status: number, body?: unknown): SDKError {
    const message = SDKError.extractMessageFromBody(body) ?? `HTTP ${status}`;

    if (status === 401) {
      return new SDKError(message, {
        code: "AUTH",
        status,
        retryable: false,
        context: { body },
      });
    }
    if (status === 403) {
      return new SDKError(message, {
        code: "AUTH",
        status,
        retryable: false,
        context: { body },
      });
    }
    if (status === 404) {
      return new SDKError(message, {
        code: "NOT_FOUND",
        status,
        retryable: false,
        context: { body },
      });
    }
    if (status === 422 || status === 400) {
      return new SDKError(message, {
        code: "VALIDATION",
        status,
        retryable: false,
        context: { body },
      });
    }
    if (status === 429) {
      const retryAfter =
        typeof body === "object" && body !== null && "retryAfter" in body
          ? Number((body as { retryAfter: unknown }).retryAfter) * 1000
          : 1000;
      return new SDKError(message, {
        code: "RATE_LIMITED",
        status,
        retryable: true,
        retryAfterMs: retryAfter,
        context: { body },
      });
    }
    if (status >= 500) {
      return new SDKError(message, {
        code: "SERVER",
        status,
        retryable: true,
        context: { body },
      });
    }
    return new SDKError(message, {
      code: "UNKNOWN",
      status,
      context: { body },
    });
  }

  /** Create from caught error */
  static fromError(error: unknown): SDKError {
    if (error instanceof SDKError) return error;

    if (error instanceof Error) {
      // Detect network errors
      if (error.name === "TypeError" && error.message.includes("fetch")) {
        return new SDKError("Network request failed", {
          code: "NETWORK",
          cause: error,
        });
      }
      if (error.name === "AbortError") {
        return new SDKError("Request cancelled", {
          code: "CANCELLED",
          retryable: false,
          cause: error,
        });
      }
      if (error.message.includes("timeout") || error.name === "TimeoutError") {
        return new SDKError("Request timeout", {
          code: "TIMEOUT",
          cause: error,
        });
      }
      return new SDKError(error.message, { code: "UNKNOWN", cause: error });
    }

    return new SDKError(String(error), { code: "UNKNOWN" });
  }

  /**
   * Extract a human-readable message from a parsed error response body.
   *
   * Probes shapes seen across our upstreams:
   *   - `{ message: "..." }`           — most internal services
   *   - `{ error: "..." }`             — flat-error shape
   *   - `{ error: { message: "..." } }` — Hetzner Cloud API
   *   - `{ error: { details: "..." } }` — Hetzner field-level details
   *   - `string`                       — non-JSON text/plain errors
   *
   * Returns null if no message-like field is present so callers can
   * fall back to "HTTP <status>". Without this, Hetzner 422s logged
   * as opaque "HTTP 422" because the message lives at
   * `body.error.message`, blocking diagnosis of every autoscaler
   * failure (issue #785).
   */
  private static extractMessageFromBody(body: unknown): string | null {
    if (typeof body === "string" && body.trim().length > 0) {
      return body.length > 500 ? `${body.slice(0, 500)}…` : body;
    }
    if (typeof body !== "object" || body === null) return null;

    const top = body as { message?: unknown; error?: unknown };
    if (typeof top.message === "string" && top.message.length > 0) {
      return top.message;
    }
    if (typeof top.error === "string" && top.error.length > 0) {
      return top.error;
    }
    if (typeof top.error === "object" && top.error !== null) {
      const inner = top.error as {
        message?: unknown;
        details?: unknown;
        code?: unknown;
      };
      const message =
        typeof inner.message === "string" && inner.message.length > 0
          ? inner.message
          : null;
      const details =
        typeof inner.details === "string" && inner.details.length > 0
          ? inner.details
          : null;
      const code =
        typeof inner.code === "string" && inner.code.length > 0
          ? inner.code
          : null;
      const parts = [code, message, details].filter(
        (part): part is string => part !== null,
      );
      if (parts.length > 0) return parts.join(": ");
    }
    return null;
  }

  /** Check if error is retryable after token refresh */
  isAuthExpired(): boolean {
    return (
      this.code === "AUTH_EXPIRED" ||
      (this.code === "AUTH" && this.status === 401)
    );
  }
}

/** Type guard for SDKError */
export function isSDKError(error: unknown): error is SDKError {
  return error instanceof SDKError;
}

/** Type guard for retryable errors */
export function isRetryable(error: unknown): boolean {
  return isSDKError(error) && error.retryable;
}
