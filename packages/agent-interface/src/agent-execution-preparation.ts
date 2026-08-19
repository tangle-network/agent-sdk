import type { Sha256Digest } from "./agent-candidate.js";
import {
  canonicalCandidateDigest,
  canonicalCandidateJson,
  isCanonicalJsonValue,
} from "./agent-candidate-schema-common.js";
import { canonicalAgentProfileValue } from "./agent-profile-canonical.js";
import type { AgentProfile } from "./agent-profile.js";
import type { AgentProfileActivationEvidence } from "./agent-profile-activation.js";
import {
  type AgentProfileMaterializationAxis,
  profileMaterializationRequests,
} from "./agent-profile-materialization.js";
import {
  agentExecutionPreparationAxisResultKey as axisResultKey,
  agentExecutionPreparationAxisResultsEqual as canonicalRowsEqual,
  agentExecutionPreparationReceiptSchema,
  compareAgentExecutionPreparationAxisResults as compareAxisResults,
  type AgentExecutionPreparationAxisResult,
  type AgentExecutionPreparationMaterializer,
  type AgentExecutionPreparationReceipt,
  type AgentExecutionPreparationResolvedModel,
} from "./agent-execution-preparation-receipt.js";
import type { HarnessType } from "./harness.js";
import { agentProfileSchema } from "./profile-schema.js";
import {
  agentWorkspaceLeaseRecordSchema,
  type AgentWorkspaceExecutionBoundLeaseRecord,
  type AgentWorkspaceSealedLeaseRecord,
} from "./agent-workspace-lease.js";

export {
  agentExecutionPreparationAxisResultSchema,
  agentExecutionPreparationReasoningEffortSchema,
  agentExecutionPreparationReceiptSchema,
  type AgentExecutionPreparationAxisResult,
  type AgentExecutionPreparationDisposition,
  type AgentExecutionPreparationMaterializer,
  type AgentExecutionPreparationOwner,
  type AgentExecutionPreparationReasoningEffort,
  type AgentExecutionPreparationReceipt,
  type AgentExecutionPreparationResolvedModel,
  type AgentExecutionPreparationWorkspace,
} from "./agent-execution-preparation-receipt.js";

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
