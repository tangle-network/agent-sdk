import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import { canonicalCandidateDigest } from "./agent-candidate-schema-common.js";
import { idSchema, sha256DigestSchema } from "./workspace-branching-shared.js";
import { boundedStringSchema, CONTRACT_MAX_ARRAY_LENGTH } from "./contract-limits.js";
import type { WorkspaceCheckpointRequest } from "./workspace-checkpoint.js";
import type { WorkspaceCheckpointLookupResult, WorkspaceCheckpointResult, WorkspaceOperationLookupRequest } from "./workspace-checkpoint.js";
import type { WorkspaceForkRequest } from "./workspace-fork.js";
import type { WorkspaceForkLookupResult, WorkspaceForkResult } from "./workspace-fork.js";

/**
 * Checkpoints and forked environments are separate resources with separate
 * destroy authority, so every cleanup names which kind it addresses and the
 * acknowledgement must echo it. Without this, one identifier shape reaches
 * both operations and a swapped target destroys the wrong resource.
 */
export const WorkspaceCleanupKindSchema = z.enum(["checkpoint", "fork"]);
export type WorkspaceCleanupKind = z.infer<typeof WorkspaceCleanupKindSchema>;

export interface WorkspaceCleanupMaterial {
  kind: WorkspaceCleanupKind;
  targetId: string;
  provider: string;
}

const WorkspaceCleanupMaterialSchema = z.strictObject({
  kind: WorkspaceCleanupKindSchema,
  targetId: idSchema,
  provider: idSchema,
});

/** Digest the exact resource addressed by a cleanup operation. */
export function workspaceCleanupRequestDigest(
  material: WorkspaceCleanupMaterial,
): Sha256Digest {
  return canonicalCandidateDigest(WorkspaceCleanupMaterialSchema.parse(material));
}

export const WorkspaceCleanupRequestSchema = z.strictObject({
  operationId: idSchema,
  kind: WorkspaceCleanupKindSchema,
  targetId: idSchema,
  provider: idSchema,
  requestDigest: sha256DigestSchema,
}).superRefine((request, refinement) => {
  if (
    request.requestDigest !==
    workspaceCleanupRequestDigest({
      kind: request.kind,
      targetId: request.targetId,
      provider: request.provider,
    })
  ) {
    refinement.addIssue({
      code: "custom",
      path: ["requestDigest"],
      message: "cleanup request digest does not match its target",
    });
  }
});
export type WorkspaceCleanupRequest = z.infer<
  typeof WorkspaceCleanupRequestSchema
>;

export const WorkspaceCleanupAcknowledgementSchema = z
  .strictObject({
    operationId: idSchema,
    kind: WorkspaceCleanupKindSchema,
    targetId: idSchema,
    provider: idSchema,
    requestDigest: sha256DigestSchema,
    status: z.enum([
      "deleted",
      "already_absent",
      "unknown",
      "in_use",
      "conflict",
      "transport_failure",
    ]),
    existingRequestDigest: sha256DigestSchema.optional(),
    message: boundedStringSchema.min(1).optional(),
    retryable: z.boolean().optional(),
    /** Existing resources that must be removed before this target. */
    blockingTargetIds: z.array(idSchema).min(1).max(CONTRACT_MAX_ARRAY_LENGTH).optional(),
  })
  .superRefine((acknowledgement, refinement) => {
    if (
      ["unknown", "in_use", "conflict", "transport_failure"].includes(
        acknowledgement.status,
      ) &&
      acknowledgement.message === undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["message"],
        message: `${acknowledgement.status} cleanup must include a message`,
      });
    }
    if (
      acknowledgement.status === "in_use" &&
      acknowledgement.blockingTargetIds === undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["blockingTargetIds"],
        message: "in_use cleanup must identify every known blocking target",
      });
    }
    if (
      acknowledgement.status !== "in_use" &&
      acknowledgement.blockingTargetIds !== undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["blockingTargetIds"],
        message: "only in_use cleanup may identify blocking targets",
      });
    }
    if (
      acknowledgement.blockingTargetIds &&
      new Set(acknowledgement.blockingTargetIds).size !==
        acknowledgement.blockingTargetIds.length
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["blockingTargetIds"],
        message: "blocking cleanup target ids must be unique",
      });
    }
    if (
      ["unknown", "transport_failure"].includes(acknowledgement.status) &&
      acknowledgement.retryable === undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["retryable"],
        message: `${acknowledgement.status} cleanup must state whether retry is safe`,
      });
    }
    if (
      acknowledgement.status === "conflict" &&
      acknowledgement.existingRequestDigest === undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "a cleanup conflict must include the existing digest",
      });
    }
    if (
      acknowledgement.status === "conflict" &&
      acknowledgement.existingRequestDigest === acknowledgement.requestDigest
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "a cleanup conflict must identify a different request",
      });
    }
    if (
      acknowledgement.status !== "conflict" &&
      acknowledgement.existingRequestDigest !== undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "only a cleanup conflict may include an existing digest",
      });
    }
    if (
      acknowledgement.requestDigest !==
      workspaceCleanupRequestDigest({
        kind: acknowledgement.kind,
        targetId: acknowledgement.targetId,
        provider: acknowledgement.provider,
      })
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["requestDigest"],
        message: "cleanup acknowledgement digest does not match its target",
      });
    }
  });
export type WorkspaceCleanupAcknowledgement = z.infer<
  typeof WorkspaceCleanupAcknowledgementSchema
>;

/** Optional durable workspace branch operations implemented by capable providers. */
export interface AgentWorkspaceBranching {
  checkpoint(
    request: WorkspaceCheckpointRequest,
    options?: { signal?: AbortSignal },
  ): Promise<WorkspaceCheckpointResult>;
  lookupCheckpoint(
    request: WorkspaceOperationLookupRequest,
    options?: { signal?: AbortSignal },
  ): Promise<WorkspaceCheckpointLookupResult>;
  deleteCheckpoint(
    request: WorkspaceCleanupRequest & { kind: "checkpoint" },
    options?: { signal?: AbortSignal },
  ): Promise<WorkspaceCleanupAcknowledgement>;
  fork(
    request: WorkspaceForkRequest,
    options?: { signal?: AbortSignal },
  ): Promise<WorkspaceForkResult>;
  lookupFork(
    request: WorkspaceOperationLookupRequest,
    options?: { signal?: AbortSignal },
  ): Promise<WorkspaceForkLookupResult>;
  destroyFork(
    request: WorkspaceCleanupRequest & { kind: "fork" },
    options?: { signal?: AbortSignal },
  ): Promise<WorkspaceCleanupAcknowledgement>;
}

/**
 * Provider-level entry point for reconstructing branch operations by source.
 *
 * Environment handles are process-local views. A coordinator that restarts
 * must obtain a fresh source-scoped handle before it looks up or cleans a
 * checkpoint or fork. The returned handle must reject a resource that does
 * not belong to its source scope. Providers return null when the source is
 * absent, the resolved environment id does not match, or the deployment
 * cannot prove the complete branching surface.
 */
export interface AgentWorkspaceBranchingProvider {
  forEnvironment(
    sourceEnvironmentId: string,
    options?: { signal?: AbortSignal },
  ): Promise<AgentWorkspaceBranching | null>;
}

/** Bind cleanup confirmation to the exact provider resource and operation. */
export function workspaceCleanupAcknowledgementMatches(
  request: WorkspaceCleanupRequest,
  acknowledgement: WorkspaceCleanupAcknowledgement,
): boolean {
  const parsedRequest = WorkspaceCleanupRequestSchema.safeParse(request);
  const parsedAcknowledgement =
    WorkspaceCleanupAcknowledgementSchema.safeParse(acknowledgement);
  if (!parsedRequest.success || !parsedAcknowledgement.success) return false;
  const exactRequest = parsedRequest.data;
  const exactAcknowledgement = parsedAcknowledgement.data;
  return (
    (exactAcknowledgement.status === "deleted" ||
      exactAcknowledgement.status === "already_absent") &&
    exactAcknowledgement.operationId === exactRequest.operationId &&
    exactAcknowledgement.kind === exactRequest.kind &&
    exactAcknowledgement.targetId === exactRequest.targetId &&
    exactAcknowledgement.provider === exactRequest.provider &&
    exactAcknowledgement.requestDigest === exactRequest.requestDigest
  );
}
