import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import {
  isWellFormedUnicode,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import type { AgentProfile } from "./agent-profile.js";
import type { HarnessType } from "./harness.js";
import { harnessTypeSchema } from "./harness.js";
import { agentProfileSchema } from "./profile-schema.js";

/** Lifecycle state of one managed Agent inside an execution environment. */
export const AGENT_INSTANCE_STATUSES = [
  "starting",
  "ready",
  "busy",
  "failed",
  "stopped",
] as const;

export type AgentInstanceStatus = (typeof AGENT_INSTANCE_STATUSES)[number];

/**
 * How one Agent sees the provider-owned workspace.
 *
 * `shared` is ordinary same-computer visibility. `isolated` requests a private
 * writable view with provider-defined inspect or commit behavior. Neither mode
 * is a security boundary between mutually untrusted Agents.
 */
export const AGENT_INSTANCE_WORKSPACE_MODES = ["shared", "isolated"] as const;

export type AgentInstanceWorkspaceMode =
  (typeof AGENT_INSTANCE_WORKSPACE_MODES)[number];

export interface AgentInstanceWorkspace {
  mode: AgentInstanceWorkspaceMode;
}

/**
 * Provider-neutral request to start one managed Agent inside an existing
 * execution environment.
 *
 * Omitting `profile` asks the provider for its default Agent configuration.
 * Omitting `workspace` selects the provider's documented default. A profile
 * never implies another VM.
 */
export interface AgentInstanceSpec {
  /** Stable caller-selected id or idempotency key, when supported. */
  id?: string;
  /** Human-readable label; not immutable identity. */
  name?: string;
  /** Exact portable profile for this Agent. */
  profile?: AgentProfile;
  /** Optional execution override; otherwise the profile or provider decides. */
  harness?: HarnessType;
  workspace?: AgentInstanceWorkspace;
}

/** Credential-free identity of the profile bound to an Agent instance. */
export interface AgentInstanceProfileIdentity {
  name?: string;
  digest: Sha256Digest;
}

/**
 * Public failure summary. Providers must remove credentials and private
 * implementation details before publishing this value.
 */
export interface AgentInstanceFailure {
  code?: string;
  message: string;
}

/**
 * Portable snapshot of one managed Agent.
 *
 * The record deliberately excludes the full profile, provider request,
 * credentials, grants, process ids, placement, and fencing state.
 */
export interface AgentInstanceRecord {
  kind: "agent-instance";
  schemaVersion: 1;
  id: string;
  name?: string;
  profile?: AgentInstanceProfileIdentity;
  /** Effective harness after profile and caller override resolution. */
  harness?: HarnessType;
  workspace: AgentInstanceWorkspace;
  status: AgentInstanceStatus;
  failure?: AgentInstanceFailure;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AgentInstanceStopRequest {
  agentId: string;
  /** Provider-defined hard termination after graceful stop cannot complete. */
  force?: boolean;
}

export interface AgentInstanceStopAcknowledgement {
  agentId: string;
  outcome: "stopped" | "already-stopped" | "not-found";
}

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/,
    "identifier must use visible alphanumeric, '.', '_', ':', or '-' characters",
  );

const labelSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      isWellFormedUnicode(value) && !/[\u0000-\u001f\u007f]/u.test(value),
    "label must be valid Unicode without control characters",
  );

const failureMessageSchema = z
  .string()
  .min(1)
  .max(16_384)
  .refine(
    (value) => isWellFormedUnicode(value) && !value.includes("\0"),
    "failure message must be valid Unicode without NUL",
  );

const timestampSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const agentInstanceStatusSchema = z.enum(AGENT_INSTANCE_STATUSES);

export const agentInstanceWorkspaceModeSchema = z.enum(
  AGENT_INSTANCE_WORKSPACE_MODES,
);

export const agentInstanceWorkspaceSchema: z.ZodType<AgentInstanceWorkspace> =
  z.strictObject({
    mode: agentInstanceWorkspaceModeSchema,
  });

export const agentInstanceSpecSchema: z.ZodType<AgentInstanceSpec> =
  z.strictObject({
    id: identifierSchema.optional(),
    name: labelSchema.optional(),
    profile: agentProfileSchema.optional(),
    harness: harnessTypeSchema.optional(),
    workspace: agentInstanceWorkspaceSchema.optional(),
  });

export const agentInstanceProfileIdentitySchema: z.ZodType<AgentInstanceProfileIdentity> =
  z.strictObject({
    name: labelSchema.optional(),
    digest: sha256DigestSchema,
  });

export const agentInstanceFailureSchema: z.ZodType<AgentInstanceFailure> =
  z.strictObject({
    code: identifierSchema.optional(),
    message: failureMessageSchema,
  });

export const agentInstanceRecordSchema: z.ZodType<AgentInstanceRecord> = z
  .strictObject({
    kind: z.literal("agent-instance"),
    schemaVersion: z.literal(1),
    id: identifierSchema,
    name: labelSchema.optional(),
    profile: agentInstanceProfileIdentitySchema.optional(),
    harness: harnessTypeSchema.optional(),
    workspace: agentInstanceWorkspaceSchema,
    status: agentInstanceStatusSchema,
    failure: agentInstanceFailureSchema.optional(),
    createdAtMs: timestampSchema,
    updatedAtMs: timestampSchema,
  })
  .superRefine((record, context) => {
    if (record.updatedAtMs < record.createdAtMs) {
      context.addIssue({
        code: "custom",
        path: ["updatedAtMs"],
        message: "agent instance update cannot precede creation",
      });
    }
    if (record.status === "failed" && record.failure === undefined) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "failed agent instance requires a failure reason",
      });
    }
    if (record.status !== "failed" && record.failure !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "failure reason is valid only for failed agent instances",
      });
    }
  });

export const agentInstanceStopRequestSchema: z.ZodType<AgentInstanceStopRequest> =
  z.strictObject({
    agentId: identifierSchema,
    force: z.boolean().optional(),
  });

export const agentInstanceStopAcknowledgementSchema: z.ZodType<AgentInstanceStopAcknowledgement> =
  z.strictObject({
    agentId: identifierSchema,
    outcome: z.enum(["stopped", "already-stopped", "not-found"]),
  });
