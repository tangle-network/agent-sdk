import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import type { PlacementInfo } from "./environment-requests.js";
import { AgentExactRunControlRefSchema, type AgentExactRunControlRef } from "./runtime-control.js";
import { idSchema, jsonRecordSchema, operationIdentityShape, operationResourceIdentityMatches, refuseSelfConflict, sameOptionalWireValue, sha256DigestSchema, wireDigest } from "./workspace-branching-shared.js";
import { WorkspaceCheckpointRefSchema, type WorkspaceCheckpointRef } from "./workspace-checkpoint.js";
import {
  ConfidentialAttestationSchema,
  ConfidentialExecutionRequestSchema,
  confidentialExecutionVerified,
  type ConfidentialAttestationVerifier,
  type ConfidentialAttestation,
  type ConfidentialExecutionRequest,
} from "./workspace-confidentiality.js";
import { boundedStringSchema } from "./contract-limits.js";

export interface WorkspaceForkMaterial {
  checkpoint: WorkspaceCheckpointRef;
  name?: string;
  metadata?: Record<string, unknown>;
  /** Requested placement is part of the operation identity. */
  placement: PlacementInfo;
  /** What the caller asked for; never what the provider proved. */
  confidential?: ConfidentialExecutionRequest;
}

const PlacementInfoSchema = z.strictObject({
  kind: z.enum(["local", "sandbox", "fleet", "provider"]),
  sandboxId: idSchema.optional(),
  fleetId: idSchema.optional(),
  machineId: idSchema.optional(),
  region: idSchema.optional(),
  providerMetadata: jsonRecordSchema.optional(),
}) satisfies z.ZodType<PlacementInfo>;

const WorkspaceForkMaterialSchema = z.strictObject({
  checkpoint: WorkspaceCheckpointRefSchema,
  name: idSchema.optional(),
  metadata: jsonRecordSchema.optional(),
  placement: PlacementInfoSchema,
  confidential: ConfidentialExecutionRequestSchema.optional(),
});

export interface WorkspaceForkRequest extends WorkspaceForkMaterial {
  idempotencyKey: string;
  requestDigest: Sha256Digest;
}

export function workspaceForkRequestDigest(
  material: WorkspaceForkMaterial,
): Sha256Digest {
  const parsed = WorkspaceForkMaterialSchema.parse(material);
  return wireDigest({
    checkpoint: parsed.checkpoint,
    ...(parsed.name === undefined ? {} : { name: parsed.name }),
    ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
    placement: parsed.placement,
    ...(parsed.confidential === undefined
      ? {}
      : { confidential: parsed.confidential }),
  });
}

export const WorkspaceForkRequestSchema = z
  .strictObject({
    checkpoint: WorkspaceCheckpointRefSchema,
    name: idSchema.optional(),
    metadata: jsonRecordSchema.optional(),
    placement: PlacementInfoSchema,
    confidential: ConfidentialExecutionRequestSchema.optional(),
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
        placement: request.placement,
        confidential: request.confidential,
      })
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["requestDigest"],
        message: "fork request digest does not match its material",
      });
    }
    if (
      request.confidential?.requested === true &&
      (request.confidential.nonce === undefined ||
        request.confidential.policy === undefined ||
        request.confidential.profileDigest === undefined)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["confidential"],
        message:
          "a confidential fork request must bind a nonce, policy, and profile digest",
      });
    }
  }) satisfies z.ZodType<WorkspaceForkRequest>;

export interface ForkedEnvironmentRef {
  provider: string;
  environmentId: string;
  /** Environment the checkpoint was taken from; a fork must never reuse it. */
  sourceEnvironmentId: string;
  /** Full source run identity; an environment id alone is not sufficient. */
  source: AgentExactRunControlRef;
  sourceCheckpointId: string;
  idempotencyKey: string;
  requestDigest: Sha256Digest;
  createdAt: string;
  placement: PlacementInfo;
  /**
   * What the caller asked for. This is never proof: read it with
   * {@link forkedEnvironmentConfidentialityVerified}, never on its own.
   */
  confidentialRequested: boolean;
  /** Present only when the provider produced verifiable attestation evidence. */
  confidentialAttestation?: ConfidentialAttestation;
  /** Legacy assertion retained for wire compatibility; never trusted as proof. */
  confidential?: boolean;
  metadata?: Record<string, unknown>;
}

export const ForkedEnvironmentRefSchema = z
  .strictObject({
    provider: idSchema,
    environmentId: idSchema,
    sourceEnvironmentId: idSchema,
    source: AgentExactRunControlRefSchema,
    sourceCheckpointId: idSchema,
    idempotencyKey: idSchema,
    requestDigest: sha256DigestSchema,
    createdAt: z.iso.datetime().max(64),
    placement: PlacementInfoSchema,
    confidentialRequested: z.boolean(),
    confidentialAttestation: ConfidentialAttestationSchema.optional(),
    confidential: z.boolean().optional(),
    metadata: jsonRecordSchema.optional(),
  })
  .superRefine((environment, refinement) => {
    if (environment.environmentId === environment.sourceEnvironmentId) {
      refinement.addIssue({
        code: "custom",
        path: ["environmentId"],
        message: "a forked environment must differ from its source environment",
      });
    }
    if (environment.source.environmentId !== environment.sourceEnvironmentId) {
      refinement.addIssue({
        code: "custom",
        path: ["sourceEnvironmentId"],
        message: "source environment id must match the complete source identity",
      });
    }
    if (environment.provider !== environment.source.provider) {
      refinement.addIssue({
        code: "custom",
        path: ["provider"],
        message: "fork provider must match the source provider",
      });
    }
    if (
      environment.confidentialAttestation !== undefined &&
      environment.confidentialAttestation.environmentId !==
        environment.environmentId
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["confidentialAttestation", "environmentId"],
        message: "attestation must be bound to the forked environment",
      });
    }
    if (
      environment.confidentialAttestation !== undefined &&
      environment.confidentialRequested !== true
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["confidentialAttestation"],
        message:
          "attestation cannot accompany a fork that did not request confidentiality",
      });
    }
  }) satisfies z.ZodType<ForkedEnvironmentRef>;

/** The only supported way to decide whether a fork may be shown confidential. */
export function forkedEnvironmentConfidentialityVerified(
  request: WorkspaceForkRequest,
  environment: ForkedEnvironmentRef,
  verifyProviderAttestation?: ConfidentialAttestationVerifier,
): boolean {
  const parsedRequest = WorkspaceForkRequestSchema.safeParse(request);
  const parsedEnvironment = ForkedEnvironmentRefSchema.safeParse(environment);
  if (!parsedRequest.success || !parsedEnvironment.success) return false;
  const exactRequest = parsedRequest.data;
  const exactEnvironment = parsedEnvironment.data;
  if (
    exactEnvironment.requestDigest !== exactRequest.requestDigest ||
    exactEnvironment.provider !== exactRequest.checkpoint.provider ||
    exactEnvironment.sourceCheckpointId !== exactRequest.checkpoint.checkpointId ||
    exactEnvironment.sourceEnvironmentId !== exactRequest.checkpoint.source.environmentId ||
    wireDigest(exactEnvironment.source) !==
      wireDigest(exactRequest.checkpoint.source) ||
    wireDigest(exactEnvironment.placement) !==
      wireDigest(exactRequest.placement) ||
    !sameOptionalWireValue(exactEnvironment.metadata, exactRequest.metadata)
  ) {
    return false;
  }
  return confidentialExecutionVerified({
    request: exactRequest.confidential ?? { requested: false },
    environment: {
      provider: exactEnvironment.provider,
      environmentId: exactEnvironment.environmentId,
      source: exactEnvironment.source,
      requestDigest: exactEnvironment.requestDigest,
      confidentialRequested: exactEnvironment.confidentialRequested,
    },
    attestation: parsedEnvironment.data.confidentialAttestation,
    ...(verifyProviderAttestation ? { verifyProviderAttestation } : {}),
  });
}

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
      ...operationIdentityShape,
      environment: ForkedEnvironmentRefSchema,
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
      !operationResourceIdentityMatches(result, result.environment)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["environment"],
        message: "forked environment identity must match its operation",
      });
    }
    refuseSelfConflict(result, ctx);
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
      ...operationIdentityShape,
      environment: ForkedEnvironmentRefSchema,
    }),
    z.strictObject({ status: z.literal("not_found"), ...operationIdentityShape }),
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
      !operationResourceIdentityMatches(result, result.environment)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["environment"],
        message: "forked environment identity must match its lookup operation",
      });
    }
    refuseSelfConflict(result, ctx);
  });

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
  const source = request.checkpoint.source;
  return (
    operationResourceIdentityMatches(request, result) &&
    operationResourceIdentityMatches(request, result.environment) &&
    result.environment.sourceCheckpointId === request.checkpoint.checkpointId &&
    result.environment.provider === request.checkpoint.provider &&
    result.environment.sourceEnvironmentId === source.environmentId &&
    wireDigest(result.environment.source) === wireDigest(source) &&
    result.environment.environmentId !== source.environmentId &&
    wireDigest(result.environment.placement) === wireDigest(request.placement) &&
    result.environment.confidentialRequested ===
      (request.confidential?.requested ?? false) &&
    sameOptionalWireValue(result.environment.metadata, request.metadata)
  );
}
