import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import {
  canonicalCandidateDigest,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import type { PlacementInfo } from "./environment-provider.js";
import {
  AgentRunControlRefSchema,
  type AgentRunControlRef,
} from "./runtime-control.js";

const idSchema = z.string().min(1).max(512);
const jsonRecordSchema = z.record(z.string(), z.json());

function wireDigest(value: unknown): Sha256Digest {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("operation material must be JSON serializable");
  }
  return canonicalCandidateDigest(JSON.parse(serialized) as unknown);
}

export interface WorkspaceCheckpointMaterial {
  source: AgentRunControlRef;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkspaceCheckpointRequest extends WorkspaceCheckpointMaterial {
  idempotencyKey: string;
  requestDigest: Sha256Digest;
}

export function workspaceCheckpointRequestDigest(
  material: WorkspaceCheckpointMaterial,
): Sha256Digest {
  return wireDigest(material);
}

export const WorkspaceCheckpointRequestSchema = z
  .strictObject({
    source: AgentRunControlRefSchema,
    name: z.string().min(1).optional(),
    metadata: jsonRecordSchema.optional(),
    idempotencyKey: idSchema,
    requestDigest: sha256DigestSchema,
  })
  .superRefine((request, refinement) => {
    if (
      request.requestDigest !==
      workspaceCheckpointRequestDigest({
        source: request.source,
        name: request.name,
        metadata: request.metadata,
      })
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["requestDigest"],
        message: "checkpoint request digest does not match its material",
      });
    }
  }) satisfies z.ZodType<WorkspaceCheckpointRequest>;

export interface WorkspaceCheckpointRef {
  checkpointId: string;
  provider: string;
  source: AgentRunControlRef;
  idempotencyKey: string;
  requestDigest: Sha256Digest;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export const WorkspaceCheckpointRefSchema = z
  .strictObject({
    checkpointId: idSchema,
    provider: idSchema,
    source: AgentRunControlRefSchema,
    idempotencyKey: idSchema,
    requestDigest: sha256DigestSchema,
    createdAt: z.iso.datetime(),
    metadata: jsonRecordSchema.optional(),
  })
  .superRefine((checkpoint, refinement) => {
    if (checkpoint.provider !== checkpoint.source.provider) {
      refinement.addIssue({
        code: "custom",
        path: ["provider"],
        message: "checkpoint provider must match its source run",
      });
    }
  }) satisfies z.ZodType<WorkspaceCheckpointRef>;

const checkpointOperationBase = {
  idempotencyKey: idSchema,
  requestDigest: sha256DigestSchema,
};

export type WorkspaceCheckpointResult =
  | {
      status: "created" | "replayed";
      idempotencyKey: string;
      requestDigest: Sha256Digest;
      checkpoint: WorkspaceCheckpointRef;
    }
  | {
      status: "conflict";
      idempotencyKey: string;
      requestDigest: Sha256Digest;
      existingRequestDigest: Sha256Digest;
    }
  | {
      status: "unknown";
      idempotencyKey: string;
      requestDigest: Sha256Digest;
      message: string;
      retryable: boolean;
    };

export const WorkspaceCheckpointResultSchema: z.ZodType<WorkspaceCheckpointResult> =
  z.discriminatedUnion("status", [
    z.strictObject({
      status: z.enum(["created", "replayed"]),
      ...checkpointOperationBase,
      checkpoint: WorkspaceCheckpointRefSchema,
    }),
    z.strictObject({
      status: z.literal("conflict"),
      ...checkpointOperationBase,
      existingRequestDigest: sha256DigestSchema,
    }),
    z.strictObject({
      status: z.literal("unknown"),
      ...checkpointOperationBase,
      message: z.string().min(1),
      retryable: z.boolean(),
    }),
  ]).superRefine((result, refinement) => {
    if (
      (result.status === "created" || result.status === "replayed") &&
      (result.checkpoint.idempotencyKey !== result.idempotencyKey ||
        result.checkpoint.requestDigest !== result.requestDigest)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "checkpoint identity must match its operation",
      });
    }
    if (
      result.status === "conflict" &&
      result.existingRequestDigest === result.requestDigest
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "a conflict must identify a different existing request",
      });
    }
  });

export const WorkspaceOperationLookupRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  requestDigest: sha256DigestSchema,
});
export type WorkspaceOperationLookupRequest = z.infer<
  typeof WorkspaceOperationLookupRequestSchema
>;

export type WorkspaceCheckpointLookupResult =
  | {
      status: "found";
      idempotencyKey: string;
      requestDigest: Sha256Digest;
      checkpoint: WorkspaceCheckpointRef;
    }
  | {
      status: "not_found";
      idempotencyKey: string;
      requestDigest: Sha256Digest;
    }
  | {
      status: "conflict";
      idempotencyKey: string;
      requestDigest: Sha256Digest;
      existingRequestDigest: Sha256Digest;
    }
  | {
      status: "unknown";
      idempotencyKey: string;
      requestDigest: Sha256Digest;
      message: string;
      retryable: boolean;
    };

export const WorkspaceCheckpointLookupResultSchema: z.ZodType<WorkspaceCheckpointLookupResult> =
  z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("found"),
      ...checkpointOperationBase,
      checkpoint: WorkspaceCheckpointRefSchema,
    }),
    z.strictObject({
      status: z.literal("not_found"),
      ...checkpointOperationBase,
    }),
    z.strictObject({
      status: z.literal("conflict"),
      ...checkpointOperationBase,
      existingRequestDigest: sha256DigestSchema,
    }),
    z.strictObject({
      status: z.literal("unknown"),
      ...checkpointOperationBase,
      message: z.string().min(1),
      retryable: z.boolean(),
    }),
  ]).superRefine((result, refinement) => {
    if (
      result.status === "found" &&
      (result.checkpoint.idempotencyKey !== result.idempotencyKey ||
        result.checkpoint.requestDigest !== result.requestDigest)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "checkpoint identity must match its lookup operation",
      });
    }
    if (
      result.status === "conflict" &&
      result.existingRequestDigest === result.requestDigest
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "a conflict must identify a different existing request",
      });
    }
  });

export interface WorkspaceForkMaterial {
  checkpoint: WorkspaceCheckpointRef;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkspaceForkRequest extends WorkspaceForkMaterial {
  idempotencyKey: string;
  requestDigest: Sha256Digest;
}

export function workspaceForkRequestDigest(
  material: WorkspaceForkMaterial,
): Sha256Digest {
  return wireDigest(material);
}

export const WorkspaceForkRequestSchema = z
  .strictObject({
    checkpoint: WorkspaceCheckpointRefSchema,
    name: z.string().min(1).optional(),
    metadata: jsonRecordSchema.optional(),
    idempotencyKey: idSchema,
    requestDigest: sha256DigestSchema,
  })
  .superRefine((request, refinement) => {
    if (
      request.requestDigest !==
      workspaceForkRequestDigest({
        checkpoint: request.checkpoint,
        name: request.name,
        metadata: request.metadata,
      })
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["requestDigest"],
        message: "fork request digest does not match its material",
      });
    }
  }) satisfies z.ZodType<WorkspaceForkRequest>;

export interface ForkedEnvironmentRef {
  provider: string;
  environmentId: string;
  sourceCheckpointId: string;
  idempotencyKey: string;
  requestDigest: Sha256Digest;
  createdAt: string;
  placement?: PlacementInfo;
  confidential: boolean;
  metadata?: Record<string, unknown>;
}

const PlacementInfoSchema = z.strictObject({
  kind: z.enum(["local", "sandbox", "fleet", "provider"]),
  sandboxId: idSchema.optional(),
  fleetId: idSchema.optional(),
  machineId: idSchema.optional(),
  region: z.string().min(1).optional(),
  providerMetadata: jsonRecordSchema.optional(),
}) satisfies z.ZodType<PlacementInfo>;

export const ForkedEnvironmentRefSchema = z.strictObject({
  provider: idSchema,
  environmentId: idSchema,
  sourceCheckpointId: idSchema,
  idempotencyKey: idSchema,
  requestDigest: sha256DigestSchema,
  createdAt: z.iso.datetime(),
  placement: PlacementInfoSchema.optional(),
  confidential: z.boolean(),
  metadata: jsonRecordSchema.optional(),
}) satisfies z.ZodType<ForkedEnvironmentRef>;

const forkOperationBase = {
  idempotencyKey: idSchema,
  requestDigest: sha256DigestSchema,
};

export type WorkspaceForkResult =
  | {
      status: "created" | "replayed";
      idempotencyKey: string;
      requestDigest: Sha256Digest;
      environment: ForkedEnvironmentRef;
    }
  | {
      status: "conflict";
      idempotencyKey: string;
      requestDigest: Sha256Digest;
      existingRequestDigest: Sha256Digest;
    }
  | {
      status: "unknown";
      idempotencyKey: string;
      requestDigest: Sha256Digest;
      message: string;
      retryable: boolean;
    };

export const WorkspaceForkResultSchema: z.ZodType<WorkspaceForkResult> =
  z.discriminatedUnion("status", [
    z.strictObject({
      status: z.enum(["created", "replayed"]),
      ...forkOperationBase,
      environment: ForkedEnvironmentRefSchema,
    }),
    z.strictObject({
      status: z.literal("conflict"),
      ...forkOperationBase,
      existingRequestDigest: sha256DigestSchema,
    }),
    z.strictObject({
      status: z.literal("unknown"),
      ...forkOperationBase,
      message: z.string().min(1),
      retryable: z.boolean(),
    }),
  ]).superRefine((result, refinement) => {
    if (
      (result.status === "created" || result.status === "replayed") &&
      (result.environment.idempotencyKey !== result.idempotencyKey ||
        result.environment.requestDigest !== result.requestDigest)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["environment"],
        message: "forked environment identity must match its operation",
      });
    }
    if (
      result.status === "conflict" &&
      result.existingRequestDigest === result.requestDigest
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "a conflict must identify a different existing request",
      });
    }
  });

export type WorkspaceForkLookupResult =
  | {
      status: "found";
      idempotencyKey: string;
      requestDigest: Sha256Digest;
      environment: ForkedEnvironmentRef;
    }
  | {
      status: "not_found";
      idempotencyKey: string;
      requestDigest: Sha256Digest;
    }
  | {
      status: "conflict";
      idempotencyKey: string;
      requestDigest: Sha256Digest;
      existingRequestDigest: Sha256Digest;
    }
  | {
      status: "unknown";
      idempotencyKey: string;
      requestDigest: Sha256Digest;
      message: string;
      retryable: boolean;
    };

export const WorkspaceForkLookupResultSchema: z.ZodType<WorkspaceForkLookupResult> =
  z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("found"),
      ...forkOperationBase,
      environment: ForkedEnvironmentRefSchema,
    }),
    z.strictObject({ status: z.literal("not_found"), ...forkOperationBase }),
    z.strictObject({
      status: z.literal("conflict"),
      ...forkOperationBase,
      existingRequestDigest: sha256DigestSchema,
    }),
    z.strictObject({
      status: z.literal("unknown"),
      ...forkOperationBase,
      message: z.string().min(1),
      retryable: z.boolean(),
    }),
  ]).superRefine((result, refinement) => {
    if (
      result.status === "found" &&
      (result.environment.idempotencyKey !== result.idempotencyKey ||
        result.environment.requestDigest !== result.requestDigest)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["environment"],
        message: "forked environment identity must match its lookup operation",
      });
    }
    if (
      result.status === "conflict" &&
      result.existingRequestDigest === result.requestDigest
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["existingRequestDigest"],
        message: "a conflict must identify a different existing request",
      });
    }
  });

export const WorkspaceCleanupRequestSchema = z.strictObject({
  operationId: idSchema,
  targetId: idSchema,
  provider: idSchema,
});
export type WorkspaceCleanupRequest = z.infer<
  typeof WorkspaceCleanupRequestSchema
>;

export const WorkspaceCleanupAcknowledgementSchema = z
  .strictObject({
    operationId: idSchema,
    targetId: idSchema,
    provider: idSchema,
    status: z.enum([
      "deleted",
      "already_absent",
      "unknown",
      "in_use",
      "conflict",
      "transport_failure",
    ]),
    message: z.string().min(1).optional(),
    retryable: z.boolean().optional(),
    /** Existing resources that must be removed before this target. */
    blockingTargetIds: z.array(idSchema).min(1).optional(),
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
    request: WorkspaceCleanupRequest,
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
    request: WorkspaceCleanupRequest,
    options?: { signal?: AbortSignal },
  ): Promise<WorkspaceCleanupAcknowledgement>;
}

/** Bind a checkpoint result to the exact request before using the resource. */
export function workspaceCheckpointResultMatchesRequest(
  request: WorkspaceCheckpointRequest,
  result: WorkspaceCheckpointResult | WorkspaceCheckpointLookupResult,
): boolean {
  const parsedRequest = WorkspaceCheckpointRequestSchema.safeParse(request);
  const parsedResult = WorkspaceCheckpointResultSchema.safeParse(result);
  const parsedLookup = WorkspaceCheckpointLookupResultSchema.safeParse(result);
  if (!parsedRequest.success) return false;
  const exactRequest = parsedRequest.data;
  if (
    parsedResult.success &&
    (parsedResult.data.status === "created" ||
      parsedResult.data.status === "replayed")
  ) {
    return checkpointResultMatchesParsed(exactRequest, parsedResult.data);
  }
  if (parsedLookup.success && parsedLookup.data.status === "found") {
    return checkpointResultMatchesParsed(exactRequest, parsedLookup.data);
  }
  return false;
}

function checkpointResultMatchesParsed(
  request: WorkspaceCheckpointRequest,
  result: Extract<WorkspaceCheckpointResult, { status: "created" | "replayed" }> |
    Extract<WorkspaceCheckpointLookupResult, { status: "found" }>,
): boolean {
  return (
    result.idempotencyKey === request.idempotencyKey &&
    result.requestDigest === request.requestDigest &&
    result.checkpoint.idempotencyKey === request.idempotencyKey &&
    result.checkpoint.requestDigest === request.requestDigest &&
    wireDigest(result.checkpoint.source) === wireDigest(request.source) &&
    sameOptionalWireValue(
      result.checkpoint.metadata,
      request.metadata,
    ) &&
    result.checkpoint.provider === request.source.provider
  );
}

/** Bind a fork result to the exact checkpoint request before using it. */
export function workspaceForkResultMatchesRequest(
  request: WorkspaceForkRequest,
  result: WorkspaceForkResult | WorkspaceForkLookupResult,
): boolean {
  const parsedRequest = WorkspaceForkRequestSchema.safeParse(request);
  const parsedResult = WorkspaceForkResultSchema.safeParse(result);
  const parsedLookup = WorkspaceForkLookupResultSchema.safeParse(result);
  if (!parsedRequest.success) return false;
  const exactRequest = parsedRequest.data;
  if (
    parsedResult.success &&
    (parsedResult.data.status === "created" ||
      parsedResult.data.status === "replayed")
  ) {
    return forkResultMatchesParsed(exactRequest, parsedResult.data);
  }
  if (parsedLookup.success && parsedLookup.data.status === "found") {
    return forkResultMatchesParsed(exactRequest, parsedLookup.data);
  }
  return false;
}

function forkResultMatchesParsed(
  request: WorkspaceForkRequest,
  result: Extract<WorkspaceForkResult, { status: "created" | "replayed" }> |
    Extract<WorkspaceForkLookupResult, { status: "found" }>,
): boolean {
  return (
    result.idempotencyKey === request.idempotencyKey &&
    result.requestDigest === request.requestDigest &&
    result.environment.idempotencyKey === request.idempotencyKey &&
    result.environment.requestDigest === request.requestDigest &&
    result.environment.sourceCheckpointId === request.checkpoint.checkpointId &&
    result.environment.provider === request.checkpoint.provider &&
    sameOptionalWireValue(result.environment.metadata, request.metadata)
  );
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
    exactAcknowledgement.targetId === exactRequest.targetId &&
    exactAcknowledgement.provider === exactRequest.provider
  );
}

function sameOptionalWireValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return wireDigest(left) === wireDigest(right);
}
