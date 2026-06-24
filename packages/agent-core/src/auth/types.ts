/**
 * Auth Types
 *
 * Type definitions for multi-tenant authentication.
 */

import { z } from "zod";

/**
 * Product configuration for multi-tenant orchestrator.
 */
export const ProductSchema = z
  .object({
    /** Unique product identifier (e.g., "vibecode", "bgagents") */
    product_id: z.string().min(1).max(64),

    /** Human-readable name */
    name: z.string().min(1).max(255),

    /** API key for backend → orchestrator auth (format: orch_prod_{random}) */
    api_key: z.string().min(32),

    /** Signing secrets for JWT tokens */
    secrets: z.object({
      current: z.object({
        secret: z.string().min(32),
        created_at: z.number(),
      }),
      previous: z
        .object({
          secret: z.string().min(32),
          created_at: z.number(),
          expires_at: z.number(),
        })
        .optional(),
    }),

    /** Token TTL configuration (minutes) */
    token_config: z.object({
      free_ttl_minutes: z.number().min(1).max(2880).default(15),
      paid_ttl_minutes: z.number().min(1).max(2880).default(240),
      max_ttl_minutes: z.number().min(1).max(2880).default(480),
    }),

    /** Per-product rate limits */
    rate_limits: z.object({
      max_concurrent_sessions: z.number().min(1).default(10000),
      max_sessions_per_minute: z.number().min(1).default(100),
      max_requests_per_minute: z.number().min(1).default(1000),
    }),

    /**
     * When true, skip all quota checks and usage metering.
     * Rate limits still enforced (DoS protection).
     * Use for internal/company accounts that don't go through billing.
     */
    unlimited: z.boolean().default(false),

    /**
     * Admin-only notes for internal tracking.
     * Examples: "Engineering team", "Partner: Acme Corp", "Trial until 2024-03"
     */
    internal_notes: z.string().max(1000).optional(),

    /** Optional webhook URL for notifications */
    webhook_url: z.string().url().optional(),

    /** Product status */
    status: z.enum(["active", "suspended", "deleted"]).default("active"),

    /** Deployment type: shared (multi-tenant) or customer-hosted (on-prem) */
    deployment_type: z.enum(["shared", "customer-hosted"]).default("shared"),

    /** Customer orchestrator configuration (for on-prem deployments) */
    customer_orchestrator: z
      .object({
        /** Customer's orchestrator URL (e.g., https://orch.customer.internal) */
        url: z.string().url().startsWith("https://", {
          message: "Customer orchestrator URL must use HTTPS",
        }),
        /** Customer's orchestrator API key */
        api_key: z.string().min(32),
      })
      .optional(),

    /** Timestamps */
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .refine(
    (data) => {
      if (
        data.customer_orchestrator &&
        data.deployment_type !== "customer-hosted"
      ) {
        return false;
      }
      return true;
    },
    {
      message:
        "customer_orchestrator can only be set when deployment_type is 'customer-hosted'",
      path: ["customer_orchestrator"],
    },
  );

export type Product = z.infer<typeof ProductSchema>;

/**
 * Token scope types for multi-tenant access control.
 *
 * - "session": Access to a single session (requires sid)
 * - "project": Access to all sessions within a project (requires projectId)
 * - "batch": Access to multiple projects (requires projectIds array)
 */
export type TokenScope = "session" | "project" | "batch";

/**
 * Base token payload (common fields for all scopes).
 */
const BaseTokenPayloadSchema = z.object({
  /** Subject: User ID */
  sub: z.string().min(1),

  /** Product ID (used to look up signing secret) */
  pid: z.string().min(1),

  /** Sidecar/Container ID (optional, for direct routing) */
  cid: z.string().optional(),

  /** Token type (always "read" for read tokens) */
  typ: z.literal("read"),

  /** Issued at (Unix timestamp, seconds) */
  iat: z.number(),

  /** Expires at (Unix timestamp, seconds) */
  exp: z.number(),
});

/**
 * Session-scoped token payload.
 * Grants access to a single session's events.
 */
export const SessionScopedTokenPayloadSchema = BaseTokenPayloadSchema.extend({
  /** Session ID - required for session-scoped tokens */
  sid: z.string().min(1),
  /** Project ID - must not be present for session-scoped tokens */
  projectId: z.undefined().optional(),
  /** Project IDs - must not be present for session-scoped tokens */
  projectIds: z.undefined().optional(),
});

/**
 * Project-scoped token payload.
 * Grants access to all sessions within a single project.
 */
export const ProjectScopedTokenPayloadSchema = BaseTokenPayloadSchema.extend({
  /** Session ID - must not be present for project-scoped tokens */
  sid: z.undefined().optional(),
  /** Project ID - required for project-scoped tokens */
  projectId: z.string().min(1),
  /** Project IDs - must not be present for project-scoped tokens */
  projectIds: z.undefined().optional(),
});

/**
 * Batch-scoped token payload.
 * Grants access to multiple projects (organization-level access).
 */
export const BatchScopedTokenPayloadSchema = BaseTokenPayloadSchema.extend({
  /** Session ID - must not be present for batch-scoped tokens */
  sid: z.undefined().optional(),
  /** Project ID - must not be present for batch-scoped tokens */
  projectId: z.undefined().optional(),
  /** Project IDs - required for batch-scoped tokens */
  projectIds: z.array(z.string().min(1)).min(1),
});

/**
 * Read token payload (JWT claims for WebSocket auth).
 *
 * Supports three scopes:
 * - Session: sid present (single session)
 * - Project: projectId present (all sessions in project)
 * - Batch: projectIds present (multiple projects)
 *
 * For backwards compatibility, tokens with sid are session-scoped.
 */
export const ReadTokenPayloadSchema = z.union([
  SessionScopedTokenPayloadSchema,
  ProjectScopedTokenPayloadSchema,
  BatchScopedTokenPayloadSchema,
]);

export type ReadTokenPayload = z.infer<typeof ReadTokenPayloadSchema>;
export type SessionScopedTokenPayload = z.infer<
  typeof SessionScopedTokenPayloadSchema
>;
export type ProjectScopedTokenPayload = z.infer<
  typeof ProjectScopedTokenPayloadSchema
>;
export type BatchScopedTokenPayload = z.infer<
  typeof BatchScopedTokenPayloadSchema
>;

/**
 * Token validation result.
 */
export interface TokenValidationResult {
  valid: boolean;
  payload?: ReadTokenPayload;
  /** Token scope (session, project, or batch) */
  scope?: TokenScope;
  error?: string;
  errorCode?:
    | "TOKEN_MISSING"
    | "TOKEN_INVALID"
    | "TOKEN_EXPIRED"
    | "TOKEN_WRONG_TYPE"
    | "PRODUCT_NOT_FOUND"
    | "PRODUCT_SUSPENDED"
    | "SIGNATURE_INVALID";
}

/**
 * Product secrets structure.
 */
export interface ProductSecrets {
  current: {
    secret: string;
    created_at: number;
  };
  previous?: {
    secret: string;
    created_at: number;
    expires_at: number;
  };
}

/**
 * Minimal product info for token validation (avoids full product lookup).
 */
export interface ProductAuthInfo {
  product_id: string;
  secrets: ProductSecrets;
  status: "active" | "suspended" | "deleted";
}

/**
 * Session creation request from product backend.
 */
export const CreateSessionRequestSchema = z.object({
  user_id: z.string().min(1),
  project_ref: z.string().optional(),
  tier: z
    .enum(["free", "pro", "enterprise"])
    .or(z.literal("paid").transform(() => "pro" as const))
    .default("free"),
  config: z
    .object({
      image: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      resources: z
        .object({
          cpu: z.number().optional(),
          memory: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

/**
 * Session creation response to product backend.
 */
export interface CreateSessionResponse {
  session_id: string;
  sidecar_id: string;
  websocket_url: string;
}

/**
 * Message send request from product backend.
 *
 * `metadata` is intentionally free-form (.passthrough): the wire format
 * accepts arbitrary product-specific keys without requiring a schema bump.
 * Only `model` is named today; legacy gateway-credential fields previously
 * declared here were never read internally and have been dropped — any
 * such fields sent by older callers continue to flow through .passthrough.
 */
export const SendMessageRequestSchema = z.object({
  content: z.string(),
  user_id: z.string().min(1),
  execution_id: z.string().optional(),
  metadata: z
    .object({
      model: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;
