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
import { canonicalAgentProfileValue } from "./agent-profile-canonical.js";
import {
  REASONING_EFFORTS,
  type AgentProfile,
  type ReasoningEffort,
} from "./agent-profile.js";
import type { AgentProfileActivationEvidence } from "./agent-profile-activation.js";
import {
  AGENT_PROFILE_MATERIALIZATION_AXES,
  type AgentProfileMaterializationAxis,
  profileMaterializationRequests,
} from "./agent-profile-materialization.js";
import { harnessTypeSchema, type HarnessType } from "./harness.js";
import { agentProfileSchema, reasoningEffortSchema } from "./profile-schema.js";
import {
  agentWorkspaceLeaseRecordSchema,
  agentWorkspaceSourceSnapshotPolicySchema,
  type AgentWorkspaceExecutionBoundLeaseRecord,
  type AgentWorkspaceSealedLeaseRecord,
  type AgentWorkspaceSourceSnapshotPolicy,
} from "./agent-workspace-lease.js";

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
  authoredProfileDigest: Sha256Digest;
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

export interface BuildAgentExecutionPreparationReceiptInput {
  preparationId: string;
  requestDigest: Sha256Digest;
  authoredProfile: AgentProfile;
  effectiveProfile: AgentProfile;
  backend: string;
  harness: HarnessType;
  harnessVersion: string;
  resolvedModel: AgentExecutionPreparationResolvedModel;
  /** Exact sealed public lease projection; owner authorization remains private. */
  workspaceLease: AgentWorkspaceSealedLeaseRecord;
  profileActivation: Pick<AgentProfileActivationEvidence, "digest">;
  axisResults: readonly AgentExecutionPreparationAxisResult[];
  /** Must digest public decisions and reference identities, not resolved values. */
  executionPlanDigest: Sha256Digest;
  materializer: AgentExecutionPreparationMaterializer;
  expiresAtMs: number;
  /** Clock used only to refuse already-expired preparations. */
  nowMs?: number;
}

export interface ValidateAgentExecutionPreparationReceiptOptions {
  receipt: unknown;
  requestDigest: Sha256Digest;
  authoredProfile: AgentProfile;
  effectiveProfile: AgentProfile;
  /** Expected public-plan identity; callers must not derive it from secret values. */
  executionPlanDigest: Sha256Digest;
  profileActivation: Pick<AgentProfileActivationEvidence, "digest">;
  /** Bound lease closes the receipt→workspace link before compute begins. */
  workspaceLease: AgentWorkspaceExecutionBoundLeaseRecord;
  nowMs?: number;
  preparationId?: string;
  backend?: string;
  harness?: HarnessType;
  harnessVersion?: string;
}

export type AgentExecutionPreparationValidationIssueCode =
  | "invalid-receipt"
  | "invalid-profile"
  | "invalid-workspace-lease"
  | "workspace-not-execution-bound"
  | "execution-binding-mismatch"
  | "digest-mismatch"
  | "expectation-mismatch"
  | "expired"
  | "missing-coverage"
  | "ambiguous-coverage"
  | "duplicate-coverage"
  | "conflicting-coverage"
  | "unrequested-coverage"
  | "invalid-disposition"
  | "strict-unsupported"
  | "model-fidelity";

export interface AgentExecutionPreparationValidationIssue {
  code: AgentExecutionPreparationValidationIssueCode;
  message: string;
  axis?: AgentProfileMaterializationAxis;
  path?: string;
}

export type AgentExecutionPreparationValidationResult =
  | {
      ok: true;
      receipt: AgentExecutionPreparationReceipt;
      issues: [];
    }
  | {
      ok: false;
      issues: AgentExecutionPreparationValidationIssue[];
    };

const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "value cannot be blank");

const publicMechanismIdentifierSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/,
    "mechanism must be a public identifier, not launch arguments",
  )
  .refine(
    (value) => !looksLikeCredential(value),
    "mechanism cannot carry credential-like material",
  );

const publicLifecycleIdentifierSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._~:/+-]{0,499}$/,
    "lifecycle identity must be a public identifier",
  )
  .refine(
    (value) => !looksLikeCredential(value),
    "lifecycle identity cannot carry credential-like material",
  );

const publicReasonSchema = nonBlankStringSchema
  .max(4_000)
  .refine(
    (value) => !looksLikeCredential(value),
    "reason cannot carry credential-like material",
  );

const jsonPointerSchema = z
  .string()
  .refine(isCanonicalJsonPointer, "path must be a canonical RFC 6901 JSON Pointer");

export const agentExecutionPreparationAxisResultSchema = z
  .strictObject({
    axis: z.enum(AGENT_PROFILE_MATERIALIZATION_AXES),
    disposition: z.enum([
      "behavior",
      "control",
      "overridden",
      "unsupported",
    ]),
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
          message: "clamped reasoning fidelity must change the requested effort",
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
      reasoningEffort: agentExecutionPreparationReasoningEffortSchema.optional(),
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
      const key = axisResultKey(result.axis, result.path);
      const previous = seen.get(key);
      if (previous !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["axisResults", index],
          message:
            canonicalRowsEqual(previous, result)
              ? "duplicate profile axis/path result"
              : "conflicting profile axis/path results",
        });
      } else {
        seen.set(key, result);
      }
      if (
        index > 0 &&
        compareAxisResults(receipt.axisResults[index - 1]!, result) >= 0
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
        message: "execution preparation receipt must contain only RFC 8785 JSON values",
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

/**
 * Canonical RFC 8785/SHA-256 identity for one validated, public AgentProfile.
 * Secret-capable MCP/hook fields are tagged. Other prompt, resource, metadata,
 * and tool text is ordinary public profile data: it may legitimately discuss
 * credentials, security incidents, or examples that resemble credentials, so
 * pattern matching cannot decide whether it is secret. Resolve opaque secret
 * references only after this public identity is fixed.
 */
export function canonicalAgentProfileDigest(profile: AgentProfile): Sha256Digest {
  const parsed = agentProfileSchema.parse(profile);
  const material = canonicalAgentProfileValue(parsed);
  if (material === undefined || !isCanonicalJsonValue(material)) {
    throw new Error("AgentProfile must contain finite, acyclic RFC 8785 JSON values");
  }
  return canonicalCandidateDigest(material);
}

/** Build, self-hash, and cross-check one pre-compute executor acknowledgement. */
export function buildAgentExecutionPreparationReceipt(
  input: BuildAgentExecutionPreparationReceiptInput,
): AgentExecutionPreparationReceipt {
  const authoredProfile = agentProfileSchema.parse(input.authoredProfile);
  const effectiveProfile = agentProfileSchema.parse(input.effectiveProfile);
  const workspaceLease = agentWorkspaceLeaseRecordSchema.parse(
    input.workspaceLease,
  );
  if (workspaceLease.phase !== "workspace-sealed") {
    throw new Error(
      "execution preparation requires a workspace-sealed lease record",
    );
  }
  const axisResults = normalizeAxisResults(
    input.axisResults,
    authoredProfile,
    effectiveProfile,
  );
  const resolvedModel = cleanResolvedModel(input.resolvedModel);
  const material = {
    kind: "agent-execution-preparation" as const,
    schemaVersion: 1 as const,
    preparationId: input.preparationId,
    requestDigest: input.requestDigest,
    authoredProfileDigest: canonicalAgentProfileDigest(authoredProfile),
    effectiveProfileDigest: canonicalAgentProfileDigest(effectiveProfile),
    backend: input.backend,
    harness: input.harness,
    harnessVersion: input.harnessVersion,
    resolvedModel,
    workspace: {
      leaseId: workspaceLease.leaseId,
      provider: workspaceLease.workspace.provider,
      identityDigest: workspaceLease.workspace.identityDigest,
      isolation: workspaceLease.isolation,
      sourceSnapshotDigest: workspaceLease.sourceSnapshotDigest,
      sourceSnapshotPolicy: { ...workspaceLease.sourceSnapshotPolicy },
      preparedWorkspaceDigest: workspaceLease.preparedWorkspaceDigest,
      profileActivationDigest: workspaceLease.profileActivationDigest,
    },
    axisResults,
    executionPlanDigest: input.executionPlanDigest,
    materializer: { ...input.materializer },
    expiresAtMs: input.expiresAtMs,
  };
  const receipt: AgentExecutionPreparationReceipt = {
    ...material,
    digest: canonicalCandidateDigest(material),
  };
  const validation = validateAgentExecutionPreparationReceiptInternal({
    receipt,
    requestDigest: input.requestDigest,
    authoredProfile,
    effectiveProfile,
    executionPlanDigest: input.executionPlanDigest,
    profileActivation: input.profileActivation,
    nowMs: input.nowMs,
    preparationId: input.preparationId,
    backend: input.backend,
    harness: input.harness,
    harnessVersion: input.harnessVersion,
    workspaceLease,
    requireExecutionBinding: false,
  });
  if (validation.ok) return validation.receipt;
  throw new AgentExecutionPreparationValidationError(validation.issues);
}

/** Validate structure, bindings, expiry, model fidelity, and exact path coverage. */
export function validateAgentExecutionPreparationReceipt(
  options: ValidateAgentExecutionPreparationReceiptOptions,
): AgentExecutionPreparationValidationResult {
  return validateAgentExecutionPreparationReceiptInternal({
    ...options,
    requireExecutionBinding: true,
  });
}

interface InternalValidateAgentExecutionPreparationReceiptOptions
  extends Omit<
    ValidateAgentExecutionPreparationReceiptOptions,
    "workspaceLease"
  > {
  workspaceLease:
    | AgentWorkspaceSealedLeaseRecord
    | AgentWorkspaceExecutionBoundLeaseRecord;
  requireExecutionBinding: boolean;
}

function validateAgentExecutionPreparationReceiptInternal(
  options: InternalValidateAgentExecutionPreparationReceiptOptions,
): AgentExecutionPreparationValidationResult {
  const parsedReceipt = agentExecutionPreparationReceiptSchema.safeParse(
    options.receipt,
  );
  if (!parsedReceipt.success) {
    return {
      ok: false,
      issues: parsedReceipt.error.issues.map((issue) => ({
        code: "invalid-receipt",
        message: `${issue.path.join(".") || "receipt"}: ${issue.message}`,
      })),
    };
  }

  const receipt = parsedReceipt.data;
  const issues: AgentExecutionPreparationValidationIssue[] = [];
  const workspaceLeaseResult = agentWorkspaceLeaseRecordSchema.safeParse(
    options.workspaceLease,
  );
  if (!workspaceLeaseResult.success) {
    return {
      ok: false,
      issues: workspaceLeaseResult.error.issues.map((issue) => ({
        code: "invalid-workspace-lease",
        message: `${issue.path.join(".") || "workspaceLease"}: ${issue.message}`,
      })),
    };
  }
  const workspaceLease = workspaceLeaseResult.data;
  const expectedPhase = options.requireExecutionBinding
    ? "execution-bound"
    : "workspace-sealed";
  if (workspaceLease.phase !== expectedPhase) {
    return {
      ok: false,
      issues: [
        {
          code: "workspace-not-execution-bound",
          message:
            `execution preparation expected workspace phase ${expectedPhase}, ` +
            `received ${workspaceLease.phase}`,
        },
      ],
    };
  }
  const authoredResult = agentProfileSchema.safeParse(options.authoredProfile);
  const effectiveResult = agentProfileSchema.safeParse(options.effectiveProfile);
  if (!authoredResult.success || !effectiveResult.success) {
    for (const result of [authoredResult, effectiveResult]) {
      if (result.success) continue;
      for (const issue of result.error.issues) {
        issues.push({
          code: "invalid-profile",
          message: `${issue.path.join(".") || "profile"}: ${issue.message}`,
        });
      }
    }
    return { ok: false, issues };
  }

  const authoredProfile = authoredResult.data;
  const effectiveProfile = effectiveResult.data;
  let authoredProfileDigest: Sha256Digest;
  let effectiveProfileDigest: Sha256Digest;
  try {
    authoredProfileDigest = canonicalAgentProfileDigest(authoredProfile);
    effectiveProfileDigest = canonicalAgentProfileDigest(effectiveProfile);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid-profile",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  compareDigest(
    issues,
    "authored profile",
    receipt.authoredProfileDigest,
    authoredProfileDigest,
  );
  compareDigest(
    issues,
    "effective profile",
    receipt.effectiveProfileDigest,
    effectiveProfileDigest,
  );
  compareDigest(
    issues,
    "request",
    receipt.requestDigest,
    options.requestDigest,
  );
  compareDigest(
    issues,
    "execution plan",
    receipt.executionPlanDigest,
    options.executionPlanDigest,
  );
  compareDigest(
    issues,
    "profile activation",
    receipt.workspace.profileActivationDigest,
    options.profileActivation.digest,
  );
  compareDigest(
    issues,
    "workspace profile activation",
    receipt.workspace.profileActivationDigest,
    workspaceLease.profileActivationDigest,
  );
  if (
    workspaceLease.phase === "execution-bound" &&
    workspaceLease.executionPreparationDigest !== receipt.digest
  ) {
    issues.push({
      code: "execution-binding-mismatch",
      message:
        "workspace execution binding does not name this preparation receipt",
    });
  }

  compareExpectation(
    issues,
    "preparation id",
    receipt.preparationId,
    options.preparationId,
  );
  compareExpectation(issues, "backend", receipt.backend, options.backend);
  compareExpectation(issues, "harness", receipt.harness, options.harness);
  compareExpectation(
    issues,
    "harness version",
    receipt.harnessVersion,
    options.harnessVersion,
  );
  compareExpectation(
    issues,
    "workspace lease",
    receipt.workspace.leaseId,
    workspaceLease.leaseId,
  );
  compareExpectation(
    issues,
    "workspace provider",
    receipt.workspace.provider,
    workspaceLease.workspace.provider,
  );
  compareExpectation(
    issues,
    "workspace identity",
    receipt.workspace.identityDigest,
    workspaceLease.workspace.identityDigest,
  );
  compareExpectation(
    issues,
    "workspace isolation",
    receipt.workspace.isolation,
    workspaceLease.isolation,
  );
  compareExpectation(
    issues,
    "source workspace snapshot",
    receipt.workspace.sourceSnapshotDigest,
    workspaceLease.sourceSnapshotDigest,
  );
  compareExpectation(
    issues,
    "source snapshot policy kind",
    receipt.workspace.sourceSnapshotPolicy.kind,
    workspaceLease.sourceSnapshotPolicy.kind,
  );
  compareExpectation(
    issues,
    "source snapshot policy name",
    receipt.workspace.sourceSnapshotPolicy.name,
    workspaceLease.sourceSnapshotPolicy.name,
  );
  compareExpectation(
    issues,
    "source snapshot policy version",
    receipt.workspace.sourceSnapshotPolicy.version,
    workspaceLease.sourceSnapshotPolicy.version,
  );
  compareDigest(
    issues,
    "source snapshot policy",
    receipt.workspace.sourceSnapshotPolicy.digest,
    workspaceLease.sourceSnapshotPolicy.digest,
  );
  compareExpectation(
    issues,
    "prepared workspace snapshot",
    receipt.workspace.preparedWorkspaceDigest,
    workspaceLease.preparedWorkspaceDigest,
  );

  if (receipt.expiresAtMs > workspaceLease.expiresAtMs) {
    issues.push({
      code: "expectation-mismatch",
      message:
        "execution preparation cannot outlive its workspace lease",
    });
  }

  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    issues.push({
      code: "expectation-mismatch",
      message: "validation clock must be a non-negative safe integer",
    });
  } else if (receipt.expiresAtMs <= nowMs) {
    issues.push({
      code: "expired",
      message: `execution preparation expired at ${receipt.expiresAtMs}`,
    });
  } else if (workspaceLease.expiresAtMs <= nowMs) {
    issues.push({
      code: "expired",
      message: `workspace lease expired at ${workspaceLease.expiresAtMs}`,
    });
  }

  validateHarnessAndModel(receipt, authoredProfile, effectiveProfile, issues);
  validateAxisCoverage(receipt, authoredProfile, effectiveProfile, issues);

  return issues.length === 0
    ? { ok: true, receipt, issues: [] }
    : { ok: false, issues };
}

/** Throw one structured error when a preparation acknowledgement is invalid. */
export function assertAgentExecutionPreparationReceipt(
  options: ValidateAgentExecutionPreparationReceiptOptions,
): AgentExecutionPreparationReceipt {
  const validation = validateAgentExecutionPreparationReceipt(options);
  if (validation.ok) return validation.receipt;
  throw new AgentExecutionPreparationValidationError(validation.issues);
}

export class AgentExecutionPreparationValidationError extends Error {
  readonly issues: readonly AgentExecutionPreparationValidationIssue[];

  constructor(issues: readonly AgentExecutionPreparationValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("\n"));
    this.name = "AgentExecutionPreparationValidationError";
    this.issues = [...issues];
  }
}

function validateHarnessAndModel(
  receipt: AgentExecutionPreparationReceipt,
  authoredProfile: AgentProfile,
  effectiveProfile: AgentProfile,
  issues: AgentExecutionPreparationValidationIssue[],
): void {
  if (
    effectiveProfile.harness !== undefined &&
    effectiveProfile.harness !== receipt.harness
  ) {
    issues.push({
      code: "expectation-mismatch",
      message:
        `effective profile harness ${effectiveProfile.harness} does not match ` +
        `prepared harness ${receipt.harness}`,
      axis: "harness",
      path: "/harness",
    });
  }
  if (
    effectiveProfile.model?.default !== undefined &&
    effectiveProfile.model.default !== receipt.resolvedModel.requested
  ) {
    issues.push({
      code: "model-fidelity",
      message: "prepared model request does not match effective profile.model.default",
      axis: "modelDefault",
      path: "/model/default",
    });
  }
  if (
    effectiveProfile.model?.provider !== undefined &&
    effectiveProfile.model.provider !== receipt.resolvedModel.provider
  ) {
    issues.push({
      code: "model-fidelity",
      message: "prepared model provider does not match effective profile.model.provider",
      axis: "modelProvider",
      path: "/model/provider",
    });
  }

  const requestedEffort =
    effectiveProfile.model?.reasoningEffort ??
    authoredProfile.model?.reasoningEffort;
  if (requestedEffort === undefined) return;
  const effort = receipt.resolvedModel.reasoningEffort;
  if (effort === undefined) {
    issues.push({
      code: "model-fidelity",
      message: "requested reasoning effort is missing from the prepared model",
      axis: "modelReasoningEffort",
      path: "/model/reasoningEffort",
    });
    return;
  }
  if (effort.requested !== requestedEffort) {
    issues.push({
      code: "model-fidelity",
      message:
        `prepared reasoning request ${effort.requested} does not match ` +
        `profile request ${requestedEffort}`,
      axis: "modelReasoningEffort",
      path: "/model/reasoningEffort",
    });
  }
}

function validateAxisCoverage(
  receipt: AgentExecutionPreparationReceipt,
  authoredProfile: AgentProfile,
  effectiveProfile: AgentProfile,
  issues: AgentExecutionPreparationValidationIssue[],
): void {
  const authored = requestMap(authoredProfile);
  const effective = requestMap(effectiveProfile);
  const expected = new Map([...authored, ...effective]);
  const expectedPathsByAxis = new Map<AgentProfileMaterializationAxis, string[]>();
  for (const request of expected.values()) {
    const paths = expectedPathsByAxis.get(request.axis) ?? [];
    paths.push(request.path);
    expectedPathsByAxis.set(request.axis, paths);
  }
  for (const paths of expectedPathsByAxis.values()) paths.sort();

  const actual = new Map<
    string,
    { result: AgentExecutionPreparationAxisResult; path: string }
  >();
  for (const result of receipt.axisResults) {
    const paths = expectedPathsByAxis.get(result.axis) ?? [];
    const path = result.path ?? (paths.length === 1 ? paths[0] : undefined);
    if (path === undefined) {
      issues.push({
        code:
          paths.length === 0 ? "unrequested-coverage" : "ambiguous-coverage",
        message:
          paths.length === 0
            ? `receipt covers unrequested ${result.axis} without an exact path`
            : `${result.axis} covers ${paths.length} requested paths and requires an exact path`,
        axis: result.axis,
      });
      continue;
    }
    const key = axisResultKey(result.axis, path);
    const previous = actual.get(key);
    if (previous !== undefined) {
      const duplicate = canonicalRowsEqual(
        { ...previous.result, path },
        { ...result, path },
      );
      issues.push({
        code: duplicate ? "duplicate-coverage" : "conflicting-coverage",
        message:
          duplicate
            ? `duplicate coverage for ${result.axis} at ${path}`
            : `conflicting coverage for ${result.axis} at ${path}`,
        axis: result.axis,
        path,
      });
      continue;
    }
    actual.set(key, { result, path });
    if (!expected.has(key)) {
      issues.push({
        code: "unrequested-coverage",
        message: `receipt covers unrequested ${result.axis} path ${path}`,
        axis: result.axis,
        path,
      });
    }
  }

  const allowPartial = authoredProfile.resources?.failOnError === false;
  for (const [key, request] of expected) {
    const coverage = actual.get(key);
    if (coverage === undefined) {
      issues.push({
        code: "missing-coverage",
        message: `receipt is missing ${request.axis} coverage at ${request.path}`,
        axis: request.axis,
        path: request.path,
      });
      continue;
    }
    const authoredRequest = authored.get(key);
    const effectiveRequest = effective.get(key);
    const changed =
      authoredRequest === undefined ||
      effectiveRequest === undefined ||
      !canonicalValuesEqual(authoredRequest.value, effectiveRequest.value);
    const executionOverride =
      request.axis === "modelReasoningEffort" &&
      receipt.resolvedModel.reasoningEffort?.fidelity === "clamped";

    if (
      changed &&
      coverage.result.disposition !== "overridden" &&
      coverage.result.disposition !== "unsupported"
    ) {
      issues.push({
        code: "invalid-disposition",
        message:
          `${request.axis} at ${request.path} changed between authored and ` +
          `effective profiles but is marked ${coverage.result.disposition}`,
        axis: request.axis,
        path: request.path,
      });
    }
    if (
      !changed &&
      !executionOverride &&
      coverage.result.disposition === "overridden"
    ) {
      issues.push({
        code: "invalid-disposition",
        message:
          `${request.axis} at ${request.path} is marked overridden without ` +
          "an effective change",
        axis: request.axis,
        path: request.path,
      });
    }
    if (coverage.result.disposition === "unsupported" && !allowPartial) {
      issues.push({
        code: "strict-unsupported",
        message:
          `${request.axis} at ${request.path} is unsupported but the authored ` +
          "profile did not explicitly set resources.failOnError=false",
        axis: request.axis,
        path: request.path,
      });
    }

    if (request.axis === "modelReasoningEffort") {
      const fidelity = receipt.resolvedModel.reasoningEffort?.fidelity;
      if (
        coverage.result.disposition === "unsupported" &&
        fidelity !== "unsupported"
      ) {
        issues.push({
          code: "model-fidelity",
          message: "unsupported reasoning coverage requires unsupported model fidelity",
          axis: request.axis,
          path: request.path,
        });
      }
      if (
        fidelity === "unsupported" &&
        coverage.result.disposition !== "unsupported"
      ) {
        issues.push({
          code: "model-fidelity",
          message: "unsupported reasoning fidelity must be reported as unsupported coverage",
          axis: request.axis,
          path: request.path,
        });
      }
      if (
        fidelity === "clamped" &&
        coverage.result.disposition !== "overridden"
      ) {
        issues.push({
          code: "model-fidelity",
          message: "clamped reasoning fidelity must be reported as overridden coverage",
          axis: request.axis,
          path: request.path,
        });
      }
    }
  }
}

interface RequestedPath {
  axis: AgentProfileMaterializationAxis;
  path: string;
  value: unknown;
}

function requestMap(profile: AgentProfile): Map<string, RequestedPath> {
  const requests = new Map<string, RequestedPath>();
  for (const request of profileMaterializationRequests(profile)) {
    requests.set(axisResultKey(request.axis, request.path), {
      ...request,
      value: readJsonPointer(profile, request.path),
    });
  }
  return requests;
}

function normalizeAxisResults(
  results: readonly AgentExecutionPreparationAxisResult[],
  authoredProfile: AgentProfile,
  effectiveProfile: AgentProfile,
): AgentExecutionPreparationAxisResult[] {
  const expected = new Map([
    ...profileMaterializationRequests(authoredProfile).map((request) => [
      axisResultKey(request.axis, request.path),
      request,
    ] as const),
    ...profileMaterializationRequests(effectiveProfile).map((request) => [
      axisResultKey(request.axis, request.path),
      request,
    ] as const),
  ]);
  const pathsByAxis = new Map<AgentProfileMaterializationAxis, string[]>();
  for (const request of expected.values()) {
    const paths = pathsByAxis.get(request.axis) ?? [];
    paths.push(request.path);
    pathsByAxis.set(request.axis, paths);
  }
  return results
    .map((result) => {
      const possiblePaths = pathsByAxis.get(result.axis) ?? [];
      const path =
        result.path ??
        (possiblePaths.length === 1 ? possiblePaths[0] : undefined);
      return cleanAxisResult(result, path);
    })
    .sort(compareAxisResults);
}

function cleanAxisResult(
  result: AgentExecutionPreparationAxisResult,
  path: string | undefined,
): AgentExecutionPreparationAxisResult {
  return {
    axis: result.axis,
    disposition: result.disposition,
    owner: result.owner,
    mechanism: result.mechanism,
    ...(result.evidenceDigest === undefined
      ? {}
      : { evidenceDigest: result.evidenceDigest }),
    ...(path === undefined ? {} : { path }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

function cleanResolvedModel(
  model: AgentExecutionPreparationResolvedModel,
): AgentExecutionPreparationResolvedModel {
  return {
    requested: model.requested,
    resolved: model.resolved,
    ...(model.provider === undefined ? {} : { provider: model.provider }),
    ...(model.reasoningEffort === undefined
      ? {}
      : {
          reasoningEffort: {
            requested: model.reasoningEffort.requested,
            ...(model.reasoningEffort.resolved === undefined
              ? {}
              : { resolved: model.reasoningEffort.resolved }),
            fidelity: model.reasoningEffort.fidelity,
          },
        }),
  };
}

function readJsonPointer(root: unknown, pointer: string): unknown {
  let value = root;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalCandidateJson(left) === canonicalCandidateJson(right);
  } catch {
    return Object.is(left, right);
  }
}

function canonicalRowsEqual(
  left: AgentExecutionPreparationAxisResult,
  right: AgentExecutionPreparationAxisResult,
): boolean {
  try {
    return canonicalCandidateJson(left) === canonicalCandidateJson(right);
  } catch {
    return false;
  }
}

function compareDigest(
  issues: AgentExecutionPreparationValidationIssue[],
  label: string,
  actual: Sha256Digest,
  expected: Sha256Digest,
): void {
  if (actual === expected) return;
  issues.push({
    code: "digest-mismatch",
    message: `${label} digest does not match the prepared execution`,
  });
}

function compareExpectation<T>(
  issues: AgentExecutionPreparationValidationIssue[],
  label: string,
  actual: T,
  expected: T | undefined,
): void {
  if (expected === undefined || actual === expected) return;
  issues.push({
    code: "expectation-mismatch",
    message: `${label} does not match the prepared execution`,
  });
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

const AXIS_ORDER = new Map<string, number>(
  AGENT_PROFILE_MATERIALIZATION_AXES.map((axis, index) => [axis, index]),
);

function compareAxisResults(
  left: AgentExecutionPreparationAxisResult,
  right: AgentExecutionPreparationAxisResult,
): number {
  const axisDifference =
    (AXIS_ORDER.get(left.axis) ?? Number.MAX_SAFE_INTEGER) -
    (AXIS_ORDER.get(right.axis) ?? Number.MAX_SAFE_INTEGER);
  if (axisDifference !== 0) return axisDifference;
  const leftPath = left.path ?? "";
  const rightPath = right.path ?? "";
  return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
}

function axisResultKey(
  axis: AgentProfileMaterializationAxis,
  path: string | undefined,
): string {
  return `${axis}\u0000${path ?? ""}`;
}

function isDownwardReasoningClamp(
  requested: ReasoningEffort,
  resolved: ReasoningEffort,
): boolean {
  return (
    REASONING_EFFORTS.indexOf(resolved) < REASONING_EFFORTS.indexOf(requested)
  );
}
