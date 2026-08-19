import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import {
  canonicalCandidateDigest,
  canonicalCandidateJson,
  isCanonicalJsonValue,
  isWellFormedUnicode,
  looksLikeCredential,
  omitTopLevelDigest,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "./agent-profile.js";
import {
  AGENT_PROFILE_MATERIALIZATION_AXES,
  type AgentProfileMaterializationAxis,
} from "./agent-profile-materialization.js";
import { harnessTypeSchema, type HarnessType } from "./harness.js";
import {
  agentWorkspaceSourceSnapshotPolicySchema,
  type AgentWorkspaceSourceSnapshotPolicy,
} from "./agent-workspace-source-snapshot.js";

export type AgentExecutionPreparationDisposition =
  | "behavior"
  | "control"
  | "overridden"
  | "unsupported";

export type AgentExecutionPreparationOwner = "runtime" | "executor";

/** One exact profile path and how the prepared execution will handle it. */
export interface AgentExecutionPreparationAxisResult {
  axis: AgentProfileMaterializationAxis;
  disposition: AgentExecutionPreparationDisposition;
  owner: AgentExecutionPreparationOwner;
  /** Public mechanism identifier; launch arguments are structurally refused. */
  mechanism: string;
  evidenceDigest?: Sha256Digest;
  /** RFC 6901 JSON Pointer. Required when one axis has multiple requested paths. */
  path?: string;
  /**
   * Sanitized public diagnostic prose for an override or unsupported path.
   * The schema refuses recognized credential formats, but cannot identify
   * arbitrary secret strings; producers remain responsible for redaction.
   */
  reason?: string;
}

export interface AgentExecutionPreparationReasoningEffort {
  requested: ReasoningEffort;
  resolved?: ReasoningEffort;
  fidelity: "exact" | "clamped" | "unsupported";
}

export interface AgentExecutionPreparationResolvedModel {
  /** Exact effective profile request; an explicit empty hint remains empty. */
  requested: string;
  /** Concrete non-empty model selected for execution. */
  resolved: string;
  /** Exact effective provider hint when present, including an explicit empty hint. */
  provider?: string;
  reasoningEffort?: AgentExecutionPreparationReasoningEffort;
}

export interface AgentExecutionPreparationWorkspace {
  /** Public, non-secret lifecycle identity for the workspace lease. */
  leaseId: string;
  /** Provider that owns the private prepared workspace capability. */
  provider: string;
  /**
   * Digest of the immutable allocation tuple (provider, lease/allocation id,
   * and canonical root). This binds `leaseId` to its allocation; it is not a
   * filesystem-content digest.
   */
  identityDigest: Sha256Digest;
  isolation: "per-run" | "shared";
  /** Canonical source snapshot before the isolated copy is prepared. */
  sourceSnapshotDigest: Sha256Digest;
  /** Public identity of the provider's exact snapshot/canonicalization policy. */
  sourceSnapshotPolicy: AgentWorkspaceSourceSnapshotPolicy;
  /** Canonical actual workspace after profile activation and before compute. */
  preparedWorkspaceDigest: Sha256Digest;
  profileActivationDigest: Sha256Digest;
}

export interface AgentExecutionPreparationMaterializer {
  name: string;
  version: string;
}

/**
 * Executor acknowledgement emitted after all launch decisions are fixed and
 * before any agent compute begins.
 *
 * `executionPlanDigest` is required to hash only public launch decisions plus
 * caller-declared public secret-slot/reference identities. Secret values belong
 * solely in the private prepared-executor closure/capability; hashing them here
 * would leak equality and permit guessing low-entropy credentials. This receipt
 * proves public plan identity, not possession of that private capability.
 * Secret-capable MCP/hook slots structurally accept only tagged public values or
 * opaque references. Other authored profile text and reference keys remain
 * caller-declared public data; recognizable-pattern refusal is defense in depth,
 * not proof that arbitrary text is non-secret.
 */
export interface AgentExecutionPreparationReceipt {
  kind: "agent-execution-preparation";
  schemaVersion: 1;
  preparationId: string;
  requestDigest: Sha256Digest;
  /** Canonical identity before executor overrides. */
  authoredProfileDigest: Sha256Digest;
  /** Canonical identity after executor overrides. */
  effectiveProfileDigest: Sha256Digest;
  backend: string;
  harness: HarnessType;
  harnessVersion: string;
  resolvedModel: AgentExecutionPreparationResolvedModel;
  workspace: AgentExecutionPreparationWorkspace;
  axisResults: AgentExecutionPreparationAxisResult[];
  /** Caller-supplied digest of public decisions and secret-reference identities. */
  executionPlanDigest: Sha256Digest;
  materializer: AgentExecutionPreparationMaterializer;
  expiresAtMs: number;
  digest: Sha256Digest;
}

const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "value cannot be blank");

const publicMechanismIdentifierSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/,
    "mechanism must be a public identifier, not launch arguments"
  )
  .refine(
    (value) => !looksLikeCredential(value),
    "mechanism cannot carry credential-like material"
  );

const publicLifecycleIdentifierSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._~:/+-]{0,499}$/,
    "lifecycle identity must be a public identifier"
  )
  .refine(
    (value) => !looksLikeCredential(value),
    "lifecycle identity cannot carry credential-like material"
  );

const publicReasonSchema = nonBlankStringSchema
  .max(4_000)
  .refine(
    (value) => !looksLikeCredential(value),
    "reason cannot carry credential-like material"
  );

const jsonPointerSchema = z
  .string()
  .refine(
    isCanonicalJsonPointer,
    "path must be a canonical RFC 6901 JSON Pointer"
  );

export const agentExecutionPreparationAxisResultSchema = z
  .strictObject({
    axis: z.enum(AGENT_PROFILE_MATERIALIZATION_AXES),
    disposition: z.enum(["behavior", "control", "overridden", "unsupported"]),
    owner: z.enum(["runtime", "executor"]),
    mechanism: publicMechanismIdentifierSchema,
    evidenceDigest: sha256DigestSchema.optional(),
    path: jsonPointerSchema.optional(),
    reason: publicReasonSchema.optional(),
  })
  .superRefine((result, context) => {
    const requiresReason =
      result.disposition === "overridden" ||
      result.disposition === "unsupported";
    if (requiresReason && result.reason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: `${result.disposition} profile coverage requires a reason`,
      });
    }
    if (!requiresReason && result.reason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: `${result.disposition} profile coverage cannot carry an override reason`,
      });
    }
  }) satisfies z.ZodType<AgentExecutionPreparationAxisResult>;

const reasoningEffortSchema = z.enum(REASONING_EFFORTS);

export const agentExecutionPreparationReasoningEffortSchema = z
  .strictObject({
    requested: reasoningEffortSchema,
    resolved: reasoningEffortSchema.optional(),
    fidelity: z.enum(["exact", "clamped", "unsupported"]),
  })
  .superRefine((effort, context) => {
    if (effort.fidelity === "unsupported") {
      if (effort.resolved !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["resolved"],
          message: "unsupported reasoning effort cannot claim a resolved value",
        });
      }
      return;
    }
    if (effort.resolved === undefined) {
      context.addIssue({
        code: "custom",
        path: ["resolved"],
        message: `${effort.fidelity} reasoning fidelity requires a resolved value`,
      });
      return;
    }
    if (effort.fidelity === "exact" && effort.resolved !== effort.requested) {
      context.addIssue({
        code: "custom",
        path: ["resolved"],
        message: "exact reasoning fidelity must preserve the requested effort",
      });
    }
    if (effort.fidelity === "clamped") {
      if (effort.resolved === effort.requested) {
        context.addIssue({
          code: "custom",
          path: ["resolved"],
          message:
            "clamped reasoning fidelity must change the requested effort",
        });
      } else if (!isDownwardReasoningClamp(effort.requested, effort.resolved)) {
        context.addIssue({
          code: "custom",
          path: ["resolved"],
          message: "reasoning effort may clamp down but must never increase",
        });
      }
    }
  }) satisfies z.ZodType<AgentExecutionPreparationReasoningEffort>;

export const agentExecutionPreparationReceiptSchema = z
  .strictObject({
    kind: z.literal("agent-execution-preparation"),
    schemaVersion: z.literal(1),
    preparationId: nonBlankStringSchema.max(500),
    requestDigest: sha256DigestSchema,
    authoredProfileDigest: sha256DigestSchema,
    effectiveProfileDigest: sha256DigestSchema,
    backend: nonBlankStringSchema.max(200),
    harness: harnessTypeSchema,
    harnessVersion: nonBlankStringSchema.max(200),
    resolvedModel: z.strictObject({
      requested: z.string().max(500),
      resolved: nonBlankStringSchema.max(500),
      provider: z.string().max(200).optional(),
      reasoningEffort:
        agentExecutionPreparationReasoningEffortSchema.optional(),
    }),
    workspace: z.strictObject({
      leaseId: publicLifecycleIdentifierSchema,
      provider: publicLifecycleIdentifierSchema,
      identityDigest: sha256DigestSchema,
      isolation: z.enum(["per-run", "shared"]),
      sourceSnapshotDigest: sha256DigestSchema,
      sourceSnapshotPolicy: agentWorkspaceSourceSnapshotPolicySchema,
      preparedWorkspaceDigest: sha256DigestSchema,
      profileActivationDigest: sha256DigestSchema,
    }),
    axisResults: z.array(agentExecutionPreparationAxisResultSchema),
    executionPlanDigest: sha256DigestSchema,
    materializer: z.strictObject({
      name: nonBlankStringSchema.max(200),
      version: nonBlankStringSchema.max(200),
    }),
    expiresAtMs: z.number().int().positive().safe(),
    digest: sha256DigestSchema,
  })
  .superRefine((receipt, context) => {
    const seen = new Map<string, AgentExecutionPreparationAxisResult>();
    for (const [index, result] of receipt.axisResults.entries()) {
      const key = agentExecutionPreparationAxisResultKey(
        result.axis,
        result.path
      );
      const previous = seen.get(key);
      if (previous !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["axisResults", index],
          message: agentExecutionPreparationAxisResultsEqual(previous, result)
            ? "duplicate profile axis/path result"
            : "conflicting profile axis/path results",
        });
      } else {
        seen.set(key, result);
      }
      if (
        index > 0 &&
        compareAgentExecutionPreparationAxisResults(
          receipt.axisResults[index - 1]!,
          result
        ) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["axisResults", index],
          message: "profile axis/path results must be canonically sorted",
        });
      }
    }
    if (!isCanonicalJsonValue(receipt)) {
      context.addIssue({
        code: "custom",
        message:
          "execution preparation receipt must contain only RFC 8785 JSON values",
      });
    } else if (
      canonicalCandidateDigest(omitTopLevelDigest(receipt)) !== receipt.digest
    ) {
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "execution preparation receipt digest is invalid",
      });
    }
  }) satisfies z.ZodType<AgentExecutionPreparationReceipt>;

/** @internal Canonical identity for one preparation axis and path. */
export function agentExecutionPreparationAxisResultKey(
  axis: AgentProfileMaterializationAxis,
  path: string | undefined
): string {
  return `${axis}\u0000${path ?? ""}`;
}

/** @internal Exact public equality for preparation axis rows. */
export function agentExecutionPreparationAxisResultsEqual(
  left: AgentExecutionPreparationAxisResult,
  right: AgentExecutionPreparationAxisResult
): boolean {
  try {
    return canonicalCandidateJson(left) === canonicalCandidateJson(right);
  } catch {
    return false;
  }
}

const AXIS_ORDER = new Map<string, number>(
  AGENT_PROFILE_MATERIALIZATION_AXES.map((axis, index) => [axis, index])
);

/** @internal Canonical order for preparation axis rows. */
export function compareAgentExecutionPreparationAxisResults(
  left: AgentExecutionPreparationAxisResult,
  right: AgentExecutionPreparationAxisResult
): number {
  const axisDifference =
    (AXIS_ORDER.get(left.axis) ?? Number.MAX_SAFE_INTEGER) -
    (AXIS_ORDER.get(right.axis) ?? Number.MAX_SAFE_INTEGER);
  if (axisDifference !== 0) return axisDifference;
  const leftPath = left.path ?? "";
  const rightPath = right.path ?? "";
  return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
}

function isCanonicalJsonPointer(value: string): boolean {
  if (!value.startsWith("/") || !isWellFormedUnicode(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "~") continue;
    const escape = value[index + 1];
    if (escape !== "0" && escape !== "1") return false;
    index += 1;
  }
  return true;
}

function isDownwardReasoningClamp(
  requested: ReasoningEffort,
  resolved: ReasoningEffort
): boolean {
  return (
    REASONING_EFFORTS.indexOf(resolved) < REASONING_EFFORTS.indexOf(requested)
  );
}
