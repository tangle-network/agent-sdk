import type { AgentProfile } from "./agent-profile.js";
import { agentProfileSchema } from "./profile-schema.js";
import {
  agentWorkspaceLeaseRecordSchema,
  type AgentWorkspaceExecutionBoundLeaseRecord,
  type AgentWorkspaceSealedLeaseRecord,
} from "./agent-workspace-lease.js";
import { agentExecutionPreparationReceiptSchema } from "./agent-execution-preparation-schema.js";
import { canonicalAgentProfileDigest } from "./agent-execution-preparation-profile.js";
import { detachAgentProfileJson } from "./agent-profile-safe-json.js";
import {
  validateAxisCoverage,
  validateHarnessAndModel,
} from "./agent-execution-preparation-coverage.js";
import type {
  AgentExecutionPreparationReceipt,
  AgentExecutionPreparationValidationIssue,
  AgentExecutionPreparationValidationResult,
  ValidateAgentExecutionPreparationReceiptOptions,
} from "./agent-execution-preparation-types.js";
import { compareDigest, compareExpectation } from "./agent-execution-preparation-utils.js";

interface InternalValidateAgentExecutionPreparationReceiptOptions
  extends Omit<ValidateAgentExecutionPreparationReceiptOptions, "workspaceLease"> {
  workspaceLease:
    | AgentWorkspaceSealedLeaseRecord
    | AgentWorkspaceExecutionBoundLeaseRecord;
  requireExecutionBinding: boolean;
}

export function validateAgentExecutionPreparationReceiptInternal(
  options: InternalValidateAgentExecutionPreparationReceiptOptions,
): AgentExecutionPreparationValidationResult {
  let receiptInput: unknown;
  let authoredProfileInput: unknown;
  let effectiveProfileInput: unknown;
  try {
    receiptInput = detachAgentProfileJson(options.receipt);
    authoredProfileInput = detachAgentProfileJson(options.authoredProfile);
    effectiveProfileInput = detachAgentProfileJson(options.effectiveProfile);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid-receipt",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  const parsedReceipt = agentExecutionPreparationReceiptSchema.safeParse(
    receiptInput,
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
  const authoredResult = agentProfileSchema.safeParse(authoredProfileInput);
  const effectiveResult = agentProfileSchema.safeParse(effectiveProfileInput);
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
  let authoredProfileDigest: string;
  let effectiveProfileDigest: string;
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
  compareDigest(issues, "request", receipt.requestDigest, options.requestDigest);
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
      message: "workspace execution binding does not name this preparation receipt",
    });
  }

  compareExpectation(issues, "preparation id", receipt.preparationId, options.preparationId);
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
      message: "execution preparation cannot outlive its workspace lease",
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

export function validateAgentExecutionPreparationReceipt(
  options: ValidateAgentExecutionPreparationReceiptOptions,
): AgentExecutionPreparationValidationResult {
  return validateAgentExecutionPreparationReceiptInternal({
    ...options,
    requireExecutionBinding: true,
  });
}

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
