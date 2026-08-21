import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import { AgentExactRunControlRefSchema, type AgentExactRunControlRef } from "./runtime-control.js";
import { idSchema, jsonRecordSchema, operationIdentityShape, operationResourceIdentityMatches, refuseSelfConflict, sameOptionalWireValue, sha256DigestSchema, wireDigest } from "./workspace-branching-shared.js";
import { boundedStringSchema } from "./contract-limits.js";

export interface WorkspaceCheckpointMaterial {
  source: AgentExactRunControlRef;
  name?: string;
  metadata?: Record<string, unknown>;
}

const WorkspaceCheckpointMaterialSchema = z.strictObject({
  source: AgentExactRunControlRefSchema,
  name: idSchema.optional(),
  metadata: jsonRecordSchema.optional(),
});

export interface WorkspaceCheckpointRequest extends WorkspaceCheckpointMaterial {
  idempotencyKey: string;
  requestDigest: Sha256Digest;
}

export function workspaceCheckpointRequestDigest(
  material: WorkspaceCheckpointMaterial,
): Sha256Digest {
  const parsed = WorkspaceCheckpointMaterialSchema.parse(material);
  return wireDigest({
    source: parsed.source,
    ...(parsed.name === undefined ? {} : { name: parsed.name }),
    ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
  });
}

export const WorkspaceCheckpointRequestSchema = z
  .strictObject({
    source: AgentExactRunControlRefSchema,
    name: idSchema.optional(),
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
  source: AgentExactRunControlRef;
  idempotencyKey: string;
  requestDigest: Sha256Digest;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export const WorkspaceCheckpointRefSchema = z
  .strictObject({
    checkpointId: idSchema,
    provider: idSchema,
    source: AgentExactRunControlRefSchema,
    idempotencyKey: idSchema,
    requestDigest: sha256DigestSchema,
    createdAt: z.iso.datetime().max(64),
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
      ...operationIdentityShape,
      checkpoint: WorkspaceCheckpointRefSchema,
    }),
    z.strictObject({
      status: z.literal("conflict"),
      ...operationIdentityShape,
      existingRequestDigest: sha256DigestSchema,
    }),
    z.strictObject({
      status: z.literal("unknown"),
      ...operationIdentityShape,
      message: boundedStringSchema.min(1),
      retryable: z.boolean(),
    }),
  ]).superRefine((result, ctx) => {
    if (
      (result.status === "created" || result.status === "replayed") &&
      !operationResourceIdentityMatches(result, result.checkpoint)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "checkpoint identity must match its operation",
      });
    }
    refuseSelfConflict(result, ctx);
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
      ...operationIdentityShape,
      checkpoint: WorkspaceCheckpointRefSchema,
    }),
    z.strictObject({
      status: z.literal("not_found"),
      ...operationIdentityShape,
    }),
    z.strictObject({
      status: z.literal("conflict"),
      ...operationIdentityShape,
      existingRequestDigest: sha256DigestSchema,
    }),
    z.strictObject({
      status: z.literal("unknown"),
      ...operationIdentityShape,
      message: boundedStringSchema.min(1),
      retryable: z.boolean(),
    }),
  ]).superRefine((result, ctx) => {
    if (
      result.status === "found" &&
      !operationResourceIdentityMatches(result, result.checkpoint)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "checkpoint identity must match its lookup operation",
      });
    }
    refuseSelfConflict(result, ctx);
  });


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
    operationResourceIdentityMatches(request, result) &&
    operationResourceIdentityMatches(request, result.checkpoint) &&
    wireDigest(result.checkpoint.source) === wireDigest(request.source) &&
    sameOptionalWireValue(
      result.checkpoint.metadata,
      request.metadata,
    ) &&
    result.checkpoint.provider === request.source.provider
  );
}
