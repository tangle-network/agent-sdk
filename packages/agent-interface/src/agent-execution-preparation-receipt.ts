import { canonicalCandidateDigest } from "./agent-candidate-schema-common.js";
import { canonicalAgentProfileDigest } from "./agent-execution-preparation-profile.js";
import {
  validateAgentExecutionPreparationReceiptInternal,
  AgentExecutionPreparationValidationError,
} from "./agent-execution-preparation-validation.js";
import { normalizeAxisResults } from "./agent-execution-preparation-coverage.js";
import type {
  AgentExecutionPreparationReceipt,
  BuildAgentExecutionPreparationReceiptInput,
} from "./agent-execution-preparation-types.js";
import { cleanResolvedModel } from "./agent-execution-preparation-utils.js";
import { agentProfileSchema } from "./profile-schema.js";
import { detachAgentProfileJson } from "./agent-profile-safe-json.js";
import { agentWorkspaceLeaseRecordSchema } from "./agent-workspace-lease.js";

/** Build, self-hash, and cross-check one pre-compute executor acknowledgement. */
export function buildAgentExecutionPreparationReceipt(
  input: BuildAgentExecutionPreparationReceiptInput,
): AgentExecutionPreparationReceipt {
  const authoredProfile = agentProfileSchema.parse(
    detachAgentProfileJson(input.authoredProfile),
  );
  const effectiveProfile = agentProfileSchema.parse(
    detachAgentProfileJson(input.effectiveProfile),
  );
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
