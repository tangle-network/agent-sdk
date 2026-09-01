import { z } from "zod";
import {
  boundedIdentifierSchema,
  boundedJsonRecordSchema,
  boundedStringSchema,
  CONTRACT_MAX_ARRAY_LENGTH,
} from "./contract-limits.js";
import { workspaceCwdSchema } from "./workspace-cwd.js";
import type { WorkspaceCwd } from "./workspace-cwd.js";

import type { AgentProfile } from "./agent-profile.js";

/** Portable profile reference: inline profile or provider catalog id. */
export type AgentProfileRef = AgentProfile | string;

export type AgentEnvironmentStatus =
  | "pending"
  | "provisioning"
  | "running"
  | "stopped"
  | "failed"
  | "expired"
  | "unknown";

export type AgentSessionStatus =
  | AgentEnvironmentStatus
  | "completed"
  | "cancelled";

/** Outbound network modes an ordinary agent environment can request. */
export type AgentEnvironmentEgressMode = "open" | "strict" | "blocked";

/**
 * Outbound network policy for one agent environment.
 *
 * `open` permits every destination. `strict` permits only the named domains plus the model
 * endpoints the provider itself provisioned into the environment. `blocked` denies every
 * destination.
 *
 * A provider that cannot satisfy the requested mode must fail the create. It must never weaken
 * the policy and never widen it: a policy that differs from the request is invisible from inside
 * the environment, and the refusal it produces there reads as an authorization error that names
 * nothing.
 */
export type AgentEnvironmentEgressPolicy =
  | { mode: "open" }
  | { mode: "blocked" }
  | { mode: "strict"; allowDomains?: readonly string[] };

/**
 * One allowed destination host.
 *
 * A whitespace-only or outer-padded entry matches no host, so a policy carrying one is an
 * allowlist the caller believes is in force and is not. That is the same silent-weakening this
 * contract refuses everywhere else, so the entry is rejected rather than trimmed: trimming would
 * accept a typo and change what the caller asked for.
 */
const egressAllowDomainSchema = boundedIdentifierSchema;

/** Runtime contract for the portable egress policy carried by providers. */
export const AgentEnvironmentEgressPolicySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("open") }),
  z.strictObject({ mode: z.literal("blocked") }),
  z.strictObject({
    mode: z.literal("strict"),
    /**
     * Order does not change the policy, but it does change the create identity: this value is
     * canonicalized into {@link agentEnvironmentCreateInputDigest}, so two same-key creates whose
     * domains differ only in order are read as different creates and the second is refused. Build
     * the list in a stable order.
     */
    allowDomains: z
      .array(egressAllowDomainSchema)
      .max(CONTRACT_MAX_ARRAY_LENGTH)
      .optional(),
  }),
]) satisfies z.ZodType<AgentEnvironmentEgressPolicy>;

export interface WorkspaceRequest {
  /** Provider-specific environment/template id, for example "universal". */
  environment?: string;
  /** Container image or image alias when the provider supports image-backed workspaces. */
  image?: string;
  /** Repository to clone or mount before the agent runs. */
  repoUrl?: string;
  /** Git ref for {@link repoUrl}. */
  gitRef?: string;
  /**
   * Explicitly based working directory inside the environment or on the host.
   * Repository paths use `base: "repository"`; host paths use `base: "host"`.
   */
  cwd?: WorkspaceCwd;
  /** Opaque provider-native workspace fields. */
  providerOptions?: Record<string, unknown>;
}

/** Runtime contract for the portable workspace request carried by providers. */
export const WorkspaceRequestSchema = z
  .strictObject({
    environment: boundedIdentifierSchema.optional(),
    image: boundedStringSchema.min(1).optional(),
    repoUrl: boundedStringSchema.min(1).optional(),
    gitRef: boundedIdentifierSchema.optional(),
    cwd: workspaceCwdSchema.optional(),
    providerOptions: boundedJsonRecordSchema.optional(),
  })
  .superRefine((workspace, refinement) => {
    if (workspace.environment !== undefined && workspace.image !== undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["image"],
        message: "workspace cannot specify both environment and image",
      });
    }
    if (workspace.gitRef !== undefined && workspace.repoUrl === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["gitRef"],
        message: "workspace gitRef requires repoUrl",
      });
    }
  }) satisfies z.ZodType<WorkspaceRequest>;

export interface ResourceRequest {
  cpu?: number;
  memoryMb?: number;
  diskMb?: number;
  gpu?: string;
  providerOptions?: Record<string, unknown>;
}

export interface AgentEnvironmentQuery {
  name?: string;
  metadata?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
}

export interface AgentEnvironmentSummary {
  id: string;
  provider: string;
  name?: string;
  status?: AgentEnvironmentStatus;
  metadata?: Record<string, unknown>;
}

export interface ExecRequest {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CheckpointRequest {
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckpointRef {
  id: string;
  provider?: string;
  metadata?: Record<string, unknown>;
}

export interface ForkRequest {
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface PlacementInfo {
  kind: "local" | "sandbox" | "fleet" | "provider";
  sandboxId?: string;
  fleetId?: string;
  machineId?: string;
  region?: string;
  providerMetadata?: Record<string, unknown>;
}
