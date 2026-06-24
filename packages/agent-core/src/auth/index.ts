/**
 * Authentication Configuration
 *
 * Token management with refresh hooks and expiration handling.
 */

import { issueReadToken } from "./tokens.js";

// Re-export channel access utilities
export * from "./channel-access.js";
// Re-export shared auth providers (eliminates 185 lines of duplication with browser.ts)
export type { AuthProvider } from "./shared-providers.js";
export {
  CallbackAuth,
  NoAuth,
  ReadTokenAuth,
  RefreshableTokenAuth,
  StaticTokenAuth,
} from "./shared-providers.js";
export * from "./tokens.js";
// Re-export types and token utilities
export * from "./types.js";

/**
 * Environment-based auth that reads from env vars.
 * Matches the server-side patterns used in sidecar/orchestrator.
 */
export class EnvTokenAuth {
  private envVar: string;
  private fallback?: string;

  constructor(options: { envVar: string; fallback?: string }) {
    this.envVar = options.envVar;
    this.fallback = options.fallback;
  }

  async getToken(): Promise<string | null> {
    // Works in Node.js; in browser, fallback would be used
    if (typeof process !== "undefined" && process.env) {
      return process.env[this.envVar] ?? this.fallback ?? null;
    }
    return this.fallback ?? null;
  }
}

/**
 * Pre-configured auth for sidecar connections.
 * Uses SIDECAR_AUTH_TOKEN env var (matches server expectation).
 */
export class SidecarAuth extends EnvTokenAuth {
  constructor(token?: string) {
    super({ envVar: "SIDECAR_AUTH_TOKEN", fallback: token });
  }
}

/**
 * Product-based auth for multi-tenant orchestrator connections.
 * Uses ORCHESTRATOR_API_SECRET_KEY env var.
 */
export class ProductAuth extends EnvTokenAuth {
  constructor(apiKey?: string) {
    super({ envVar: "ORCHESTRATOR_API_SECRET_KEY", fallback: apiKey });
  }
}

/**
 * Product token issuer for backend services.
 *
 * Use this in product backends to issue read tokens for WebSocket connections.
 *
 * @example
 * ```typescript
 * import { ProductTokenIssuer } from "@tangle-network/agent-core";
 *
 * const issuer = new ProductTokenIssuer({
 *   productId: "vibecode",
 *   signingSecret: process.env.ORCHESTRATOR_SIGNING_SECRET!,
 *   ttlMinutes: { free: 15, pro: 240 },
 * });
 *
 * // Issue a token for a user session
 * const token = issuer.issue({
 *   userId: "user_123",
 *   sessionId: "sess_abc",
 *   tier: "pro",
 * });
 *
 * // Return token to frontend for WebSocket connection
 * res.json({
 *   readToken: token.token,
 *   expiresAt: token.expiresAt,
 *   websocketUrl: `wss://orchestrator.example.com/session?token=${token.token}`,
 * });
 * ```
 */
export class ProductTokenIssuer {
  private readonly productId: string;
  private readonly signingSecret: string;
  private readonly ttlMinutes: {
    free: number;
    pro: number;
    enterprise?: number;
  };

  constructor(config: {
    productId: string;
    signingSecret: string;
    /** TTL in minutes for each tier (default: { free: 15, pro: 240 }) */
    ttlMinutes?: { free?: number; pro?: number; enterprise?: number };
  }) {
    this.productId = config.productId;
    this.signingSecret = config.signingSecret;
    this.ttlMinutes = {
      free: config.ttlMinutes?.free ?? 15,
      pro: config.ttlMinutes?.pro ?? 240,
      enterprise: config.ttlMinutes?.enterprise ?? 480,
    };
  }

  /**
   * Issue a read token for a user session.
   */
  issue(params: {
    userId: string;
    sessionId: string;
    tier?: "free" | "pro" | "enterprise";
    sidecarId?: string;
  }): { token: string; expiresAt: number } {
    const tier = params.tier ?? "free";
    const ttl = this.ttlMinutes[tier] ?? this.ttlMinutes.free;

    const token = issueReadToken(
      this.signingSecret,
      {
        sub: params.userId,
        sid: params.sessionId,
        pid: this.productId,
        cid: params.sidecarId,
      },
      ttl,
    );

    const expiresAt = Math.floor(Date.now() / 1000) + ttl * 60;

    return { token, expiresAt };
  }

  /**
   * Get the TTL in minutes for a tier.
   */
  getTtlMinutes(tier: "free" | "pro" | "enterprise" = "free"): number {
    return this.ttlMinutes[tier] ?? this.ttlMinutes.free;
  }
}
