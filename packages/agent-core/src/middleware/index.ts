/**
 * Request/Response Interceptors
 *
 * Middleware for modifying requests, responses, and handling errors.
 */

import type { SDKError } from "../errors/index.js";
import type { RequestOptions } from "../transport/types.js";

/** Request context passed through interceptor chain */
export interface RequestContext {
  /** Original request options */
  request: RequestOptions;
  /** Request start time */
  startedAt: number;
  /** Unique request ID */
  requestId: string;
  /** Retry attempt number (0 = first attempt) */
  attempt: number;
  /** Custom metadata */
  meta: Record<string, unknown>;
}

/** Response context */
export interface ResponseContext<T = unknown> {
  /** Request context */
  request: RequestContext;
  /** Response data */
  data: T;
  /** Response time in ms */
  durationMs: number;
  /** HTTP status (if available) */
  status?: number;
}

/** Error context */
export interface ErrorContext {
  /** Request context */
  request: RequestContext;
  /** The error */
  error: SDKError;
  /** Duration before error */
  durationMs: number;
}

/** Interceptor interface */
export interface Interceptor {
  /** Modify request before sending */
  onRequest?(ctx: RequestContext): RequestContext | Promise<RequestContext>;
  /** Process successful response */
  onResponse?<T>(ctx: ResponseContext<T>): T | Promise<T>;
  /** Handle error (can transform or rethrow) */
  onError?(ctx: ErrorContext): void | Promise<void>;
}

/** Interceptor chain executor */
export class InterceptorChain {
  private interceptors: Interceptor[] = [];

  /** Add interceptor to chain */
  use(interceptor: Interceptor): this {
    this.interceptors.push(interceptor);
    return this;
  }

  /** Remove interceptor */
  remove(interceptor: Interceptor): this {
    const idx = this.interceptors.indexOf(interceptor);
    if (idx >= 0) this.interceptors.splice(idx, 1);
    return this;
  }

  /** Run request through interceptors */
  async executeRequest(ctx: RequestContext): Promise<RequestContext> {
    let current = ctx;
    for (const interceptor of this.interceptors) {
      if (interceptor.onRequest) {
        current = await interceptor.onRequest(current);
      }
    }
    return current;
  }

  /** Run response through interceptors (reverse order) */
  async executeResponse<T>(ctx: ResponseContext<T>): Promise<T> {
    let data = ctx.data;
    for (let i = this.interceptors.length - 1; i >= 0; i--) {
      const interceptor = this.interceptors[i];
      if (interceptor.onResponse) {
        data = await interceptor.onResponse({ ...ctx, data });
      }
    }
    return data;
  }

  /** Notify interceptors of error */
  async executeError(ctx: ErrorContext): Promise<void> {
    for (const interceptor of this.interceptors) {
      if (interceptor.onError) {
        await interceptor.onError(ctx);
      }
    }
  }
}

/** Generate unique request ID */
export function generateRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Built-in interceptors

/** Logging interceptor */
export function createLoggingInterceptor(
  logger: {
    debug?(msg: string, data?: unknown): void;
    info?(msg: string, data?: unknown): void;
    error?(msg: string, data?: unknown): void;
  } = console,
): Interceptor {
  return {
    onRequest(ctx) {
      logger.debug?.(
        `[${ctx.requestId}] ${ctx.request.method ?? "GET"} ${ctx.request.path}`,
        {
          attempt: ctx.attempt,
        },
      );
      return ctx;
    },
    onResponse(ctx) {
      logger.info?.(
        `[${ctx.request.requestId}] ${ctx.request.request.method ?? "GET"} ${ctx.request.request.path} ${ctx.status ?? 200} (${ctx.durationMs}ms)`,
      );
      return ctx.data;
    },
    onError(ctx) {
      logger.error?.(
        `[${ctx.request.requestId}] ${ctx.request.request.method ?? "GET"} ${ctx.request.request.path} ${ctx.error.code} (${ctx.durationMs}ms)`,
        {
          error: ctx.error.message,
        },
      );
    },
  };
}

/** Metrics interceptor */
export function createMetricsInterceptor(
  onMetric: (metric: {
    path: string;
    method: string;
    status: "success" | "error";
    durationMs: number;
    errorCode?: string;
  }) => void,
): Interceptor {
  return {
    onResponse(ctx) {
      onMetric({
        path: ctx.request.request.path,
        method: ctx.request.request.method ?? "GET",
        status: "success",
        durationMs: ctx.durationMs,
      });
      return ctx.data;
    },
    onError(ctx) {
      onMetric({
        path: ctx.request.request.path,
        method: ctx.request.request.method ?? "GET",
        status: "error",
        durationMs: ctx.durationMs,
        errorCode: ctx.error.code,
      });
    },
  };
}

/** Header injection interceptor */
export function createHeaderInterceptor(
  headers:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>),
): Interceptor {
  return {
    async onRequest(ctx) {
      const h = typeof headers === "function" ? await headers() : headers;
      return {
        ...ctx,
        request: {
          ...ctx.request,
          headers: { ...ctx.request.headers, ...h },
        },
      };
    },
  };
}
