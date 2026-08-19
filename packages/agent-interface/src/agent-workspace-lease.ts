import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import {
  canonicalCandidateDigest,
  isCanonicalJsonValue,
  isWellFormedUnicode,
  looksLikeCredential,
  omitTopLevelDigest,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import {
  agentWorkspacePublicIdentifierSchema as publicIdentifierSchema,
  agentWorkspaceSourceSnapshotPolicySchema,
  type AgentWorkspaceSourceSnapshotPolicy,
} from "./agent-workspace-source-snapshot.js";

export {
  agentWorkspaceSourceSnapshotPolicySchema,
  type AgentWorkspaceSourceSnapshotPolicy,
} from "./agent-workspace-source-snapshot.js";

export const AGENT_WORKSPACE_LEASE_PHASES = [
  "copy-ready",
  "workspace-sealed",
  "execution-bound",
  "destroying",
  "cleanup-failed",
  "destroyed",
] as const;

export type AgentWorkspaceLeasePhase =
  (typeof AGENT_WORKSPACE_LEASE_PHASES)[number];

/** Public allocation identity. `root` locates bytes; it grants no authority. */
export interface AgentWorkspaceAllocationIdentity {
  provider: string;
  root: string;
  /** Digest of the provider, lease/allocation identity, and canonical root. */
  identityDigest: Sha256Digest;
}

interface AgentWorkspaceLeaseRecordBase {
  kind: "agent-workspace-lease";
  schemaVersion: 1;
  leaseId: string;
  ownerId: string;
  workspace: AgentWorkspaceAllocationIdentity;
  isolation: "per-run" | "shared";
  sourceSnapshotDigest: Sha256Digest;
  /** Governs both the source and prepared workspace digest interpretation. */
  sourceSnapshotPolicy: AgentWorkspaceSourceSnapshotPolicy;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
}

interface AgentWorkspaceUnpreparedEvidence {
  preparedWorkspaceDigest?: never;
  profileActivationDigest?: never;
  executionPreparationDigest?: never;
}

interface AgentWorkspaceSealedEvidence {
  preparedWorkspaceDigest: Sha256Digest;
  profileActivationDigest: Sha256Digest;
  executionPreparationDigest?: never;
}

interface AgentWorkspaceExecutionBoundEvidence {
  preparedWorkspaceDigest: Sha256Digest;
  profileActivationDigest: Sha256Digest;
  executionPreparationDigest: Sha256Digest;
}

export type AgentWorkspaceCopyReadyLeaseRecordMaterial =
  AgentWorkspaceLeaseRecordBase &
    AgentWorkspaceUnpreparedEvidence & {
      phase: "copy-ready";
      cleanupAttempts: 0;
      cleanupError?: never;
    };

export type AgentWorkspaceSealedLeaseRecordMaterial =
  AgentWorkspaceLeaseRecordBase &
    AgentWorkspaceSealedEvidence & {
      phase: "workspace-sealed";
      cleanupAttempts: 0;
      cleanupError?: never;
    };

export type AgentWorkspaceExecutionBoundLeaseRecordMaterial =
  AgentWorkspaceLeaseRecordBase &
    AgentWorkspaceExecutionBoundEvidence & {
      phase: "execution-bound";
      cleanupAttempts: 0;
      cleanupError?: never;
    };

type AgentWorkspaceCleanupEvidence =
  | AgentWorkspaceUnpreparedEvidence
  | AgentWorkspaceSealedEvidence
  | AgentWorkspaceExecutionBoundEvidence;

export type AgentWorkspaceDestroyingLeaseRecordMaterial =
  AgentWorkspaceLeaseRecordBase &
    AgentWorkspaceCleanupEvidence & {
      phase: "destroying";
      cleanupAttempts: number;
      cleanupError?: never;
    };

export type AgentWorkspaceCleanupFailedLeaseRecordMaterial =
  AgentWorkspaceLeaseRecordBase &
    AgentWorkspaceCleanupEvidence & {
      phase: "cleanup-failed";
      cleanupAttempts: number;
      /** Sanitized public diagnostic; providers remain responsible for redaction. */
      cleanupError: string;
    };

export type AgentWorkspaceDestroyedLeaseRecordMaterial =
  AgentWorkspaceLeaseRecordBase &
    AgentWorkspaceCleanupEvidence & {
      phase: "destroyed";
      cleanupAttempts: number;
      cleanupError?: never;
    };

export type AgentWorkspaceLeaseRecordMaterial =
  | AgentWorkspaceCopyReadyLeaseRecordMaterial
  | AgentWorkspaceSealedLeaseRecordMaterial
  | AgentWorkspaceExecutionBoundLeaseRecordMaterial
  | AgentWorkspaceDestroyingLeaseRecordMaterial
  | AgentWorkspaceCleanupFailedLeaseRecordMaterial
  | AgentWorkspaceDestroyedLeaseRecordMaterial;

type WithDigest<Material> = Material extends unknown
  ? Material & { digest: Sha256Digest }
  : never;

/** Self-hashed public projection. Private authorization and durable state stay out. */
export type AgentWorkspaceLeaseRecord = WithDigest<AgentWorkspaceLeaseRecordMaterial>;
export type AgentWorkspaceCopyReadyLeaseRecord =
  WithDigest<AgentWorkspaceCopyReadyLeaseRecordMaterial>;
export type AgentWorkspaceSealedLeaseRecord =
  WithDigest<AgentWorkspaceSealedLeaseRecordMaterial>;
export type AgentWorkspaceExecutionBoundLeaseRecord =
  WithDigest<AgentWorkspaceExecutionBoundLeaseRecordMaterial>;
export type AgentWorkspaceDestroyingLeaseRecord =
  WithDigest<AgentWorkspaceDestroyingLeaseRecordMaterial>;
export type AgentWorkspaceCleanupFailedLeaseRecord =
  WithDigest<AgentWorkspaceCleanupFailedLeaseRecordMaterial>;
export type AgentWorkspaceDestroyedLeaseRecord =
  WithDigest<AgentWorkspaceDestroyedLeaseRecordMaterial>;

/**
 * Request-only owner capability. Providers persist at most a one-way digest;
 * this value never belongs in a public lease or execution receipt.
 */
export interface AgentWorkspaceLeaseAuthorization {
  leaseId: string;
  ownerToken: string;
}

export interface AgentWorkspaceSealRequest
  extends AgentWorkspaceLeaseAuthorization {
  profileActivationDigest: Sha256Digest;
}

export interface AgentWorkspaceExecutionBindingRequest
  extends AgentWorkspaceLeaseAuthorization {
  executionPreparationDigest: Sha256Digest;
}

export interface AgentWorkspaceLeaseRenewalRequest
  extends AgentWorkspaceLeaseAuthorization {
  expiresAtMs: number;
}

const controlCharacterPattern = /[\u0000-\u001f\u007f]/;

const publicLocatorSchema = z
  .string()
  .min(1)
  .max(16_384)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      isWellFormedUnicode(value) &&
      !controlCharacterPattern.test(value) &&
      !looksLikeCredential(value),
    "workspace locator must be public, well-formed text",
  );

const publicCleanupErrorSchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      isWellFormedUnicode(value) &&
      !controlCharacterPattern.test(value) &&
      !looksLikeCredential(value),
    "workspace cleanup error must be sanitized public text",
  );

const timestampSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const agentWorkspaceLeasePhaseSchema = z.enum(
  AGENT_WORKSPACE_LEASE_PHASES,
);

export const agentWorkspaceAllocationIdentitySchema = z.strictObject({
  provider: publicIdentifierSchema,
  root: publicLocatorSchema,
  identityDigest: sha256DigestSchema,
}) satisfies z.ZodType<AgentWorkspaceAllocationIdentity>;

const agentWorkspaceLeaseRecordFields = {
  kind: z.literal("agent-workspace-lease"),
  schemaVersion: z.literal(1),
  phase: agentWorkspaceLeasePhaseSchema,
  leaseId: publicIdentifierSchema,
  ownerId: publicIdentifierSchema,
  workspace: agentWorkspaceAllocationIdentitySchema,
  isolation: z.enum(["per-run", "shared"]),
  sourceSnapshotDigest: sha256DigestSchema,
  sourceSnapshotPolicy: agentWorkspaceSourceSnapshotPolicySchema,
  preparedWorkspaceDigest: sha256DigestSchema.optional(),
  profileActivationDigest: sha256DigestSchema.optional(),
  executionPreparationDigest: sha256DigestSchema.optional(),
  createdAtMs: timestampSchema,
  updatedAtMs: timestampSchema,
  expiresAtMs: timestampSchema,
  cleanupAttempts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cleanupError: publicCleanupErrorSchema.optional(),
} as const;

const rawAgentWorkspaceLeaseRecordMaterialSchema = z
  .strictObject(agentWorkspaceLeaseRecordFields)
  .superRefine((record, context) => {
    validateAgentWorkspaceLeaseState(record, context);
    if (!isCanonicalJsonValue(record)) {
      context.addIssue({
        code: "custom",
        message: "workspace lease material must contain only RFC 8785 JSON values",
      });
    }
  })
  .transform((record) => record as AgentWorkspaceLeaseRecordMaterial);

export const agentWorkspaceLeaseRecordMaterialSchema: z.ZodType<AgentWorkspaceLeaseRecordMaterial> =
  rawAgentWorkspaceLeaseRecordMaterialSchema;

export const agentWorkspaceLeaseRecordSchema: z.ZodType<AgentWorkspaceLeaseRecord> =
  z
    .strictObject({
      ...agentWorkspaceLeaseRecordFields,
      digest: sha256DigestSchema,
    })
    .superRefine((record, context) => {
      validateAgentWorkspaceLeaseState(record, context);
      if (!isCanonicalJsonValue(record)) {
        context.addIssue({
          code: "custom",
          message: "workspace lease record must contain only RFC 8785 JSON values",
        });
      } else if (
        canonicalCandidateDigest(omitTopLevelDigest(record)) !== record.digest
      ) {
        context.addIssue({
          code: "custom",
          path: ["digest"],
          message: "workspace lease record digest is invalid",
        });
      }
    })
    .transform((record) => record as AgentWorkspaceLeaseRecord);

/** Canonical public identity; private token/state fields cannot enter its schema. */
export function canonicalAgentWorkspaceLeaseRecordDigest(
  material: AgentWorkspaceLeaseRecordMaterial,
): Sha256Digest {
  return canonicalCandidateDigest(
    agentWorkspaceLeaseRecordMaterialSchema.parse(material),
  );
}

/** Build and self-hash one phase-valid public workspace lease record. */
export function buildAgentWorkspaceLeaseRecord<
  Material extends AgentWorkspaceLeaseRecordMaterial,
>(material: Material): WithDigest<Material> {
  const parsed = agentWorkspaceLeaseRecordMaterialSchema.parse(material);
  return agentWorkspaceLeaseRecordSchema.parse({
    ...parsed,
    digest: canonicalCandidateDigest(parsed),
  }) as WithDigest<Material>;
}

function validateAgentWorkspaceLeaseState(
  record: {
    phase: AgentWorkspaceLeasePhase;
    preparedWorkspaceDigest?: Sha256Digest;
    profileActivationDigest?: Sha256Digest;
    executionPreparationDigest?: Sha256Digest;
    createdAtMs: number;
    updatedAtMs: number;
    expiresAtMs: number;
    cleanupAttempts: number;
    cleanupError?: string;
  },
  context: z.RefinementCtx,
): void {
  if (record.updatedAtMs < record.createdAtMs) {
    context.addIssue({
      code: "custom",
      path: ["updatedAtMs"],
      message: "workspace lease update cannot precede creation",
    });
  }
  if (record.expiresAtMs <= record.createdAtMs) {
    context.addIssue({
      code: "custom",
      path: ["expiresAtMs"],
      message: "workspace lease expiry must follow creation",
    });
  }

  const hasPrepared = record.preparedWorkspaceDigest !== undefined;
  const hasActivation = record.profileActivationDigest !== undefined;
  const hasExecution = record.executionPreparationDigest !== undefined;
  if (hasPrepared !== hasActivation) {
    context.addIssue({
      code: "custom",
      message:
        "prepared workspace and profile activation evidence must appear together",
    });
  }
  if (hasExecution && (!hasPrepared || !hasActivation)) {
    context.addIssue({
      code: "custom",
      path: ["executionPreparationDigest"],
      message: "execution binding requires sealed workspace evidence",
    });
  }

  const active =
    record.phase === "copy-ready" ||
    record.phase === "workspace-sealed" ||
    record.phase === "execution-bound";
  if (active && record.cleanupAttempts !== 0) {
    context.addIssue({
      code: "custom",
      path: ["cleanupAttempts"],
      message: "active workspace phases cannot have cleanup attempts",
    });
  }
  if (!active && record.cleanupAttempts < 1) {
    context.addIssue({
      code: "custom",
      path: ["cleanupAttempts"],
      message: "cleanup workspace phases require at least one cleanup attempt",
    });
  }

  if (record.phase === "copy-ready" && (hasPrepared || hasExecution)) {
    context.addIssue({
      code: "custom",
      message: "copy-ready workspace cannot carry preparation evidence",
    });
  }
  if (
    record.phase === "workspace-sealed" &&
    (!hasPrepared || !hasActivation || hasExecution)
  ) {
    context.addIssue({
      code: "custom",
      message:
        "workspace-sealed phase requires preparation evidence without execution binding",
    });
  }
  if (
    record.phase === "execution-bound" &&
    (!hasPrepared || !hasActivation || !hasExecution)
  ) {
    context.addIssue({
      code: "custom",
      message: "execution-bound phase requires complete preparation evidence",
    });
  }

  if (record.phase === "cleanup-failed") {
    if (record.cleanupError === undefined) {
      context.addIssue({
        code: "custom",
        path: ["cleanupError"],
        message: "cleanup-failed phase requires a sanitized error",
      });
    }
  } else if (record.cleanupError !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["cleanupError"],
      message: "cleanup error is valid only in cleanup-failed phase",
    });
  }
}
