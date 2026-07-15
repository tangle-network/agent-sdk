/**
 * Backward-compatibility surface for the candidate outcome and receipt exports
 * that were renamed or collapsed when the candidate contract was unified.
 *
 * Every symbol here is deprecated and exists only so published consumers that
 * still import the pre-unification names keep resolving at ESM import time.
 * Prefer the current names; these will be removed in a future major.
 *
 * Two shapes of compat live in this module:
 *  - Pure renames (shape-identical to a current export) are re-exported as
 *    deprecated aliases and remain reference-equal to their new counterpart.
 *  - Symbols whose shape changed (a different `schemaVersion` literal, a
 *    restructured field, or a union that no longer exists) are re-declared here
 *    verbatim from the last release that published them, so old data still
 *    parses against the old name instead of silently binding to a newer shape.
 */

import { z } from "zod";
import type {
  AgentCandidateArtifactRef,
  AgentCandidateAttemptPolicy,
  AgentCandidateBenchmarkResultEvidence,
  AgentCandidateBenchmarkResultMaterial,
  AgentCandidateCode,
  AgentCandidateConfigValue,
  AgentCandidateDigestAlgorithm,
  AgentCandidateEffectiveMemory,
  AgentCandidateEntrypointReceipt,
  AgentCandidateExecution,
  AgentCandidateExecutionEnvironment,
  AgentCandidateExecutionLimits,
  AgentCandidateExecutionPlanEvidence,
  AgentCandidateFixedSpend,
  AgentCandidateInstructionDelivery,
  AgentCandidateKnowledge,
  AgentCandidateLineage,
  AgentCandidateMemoryPolicy,
  AgentCandidateMemoryReceipt,
  AgentCandidateModelAccessNetwork,
  AgentCandidateModelSettlementCall,
  AgentCandidateModelSettlementEvidence,
  AgentCandidateModelSettlementMaterial,
  AgentCandidateOciPlatform,
  AgentCandidateProfile,
  AgentCandidateProfileApplication,
  AgentCandidateProfilePlanEvidence,
  AgentCandidateProfilePlanMaterial,
  AgentCandidateRepositoryState,
  AgentCandidateResolvedModel,
  AgentCandidateSpend,
  AgentCandidateTaskOutcomeEvidence,
  AgentCandidateTermination,
  AgentCandidateTraceEvidence,
  AgentCandidateWorkingDirectory,
  AgentCandidateWorkspaceSnapshotEvidence,
  Sha256Digest,
} from "./agent-candidate.js";
import {
  agentCandidateModelSettlementCallSchema,
  agentCandidateModelSettlementEvidenceSchema,
  agentCandidateModelSettlementMaterialSchema,
  agentCandidateBenchmarkResultEvidenceSchema,
  agentCandidateFixedSpendSchema,
  agentCandidateTaskOutcomeEvidenceSchema,
} from "./agent-candidate-outcome-schema.js";
import { agentCandidateResolvedModelSchema } from "./agent-candidate-execution-plan-schema.js";
import { agentCandidateSpendSchema } from "./agent-candidate-lineage-schema.js";
import {
  agentCandidateMemoryReceiptSchema,
  agentCandidateTerminationSchema,
  agentCandidateTraceEvidenceSchema,
} from "./agent-candidate-receipt-schema.js";
import {
  isCanonicalJsonValue,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import type { HarnessType } from "./harness.js";

// =============================================================================
// Pure renames — shape-identical to a current export.
// =============================================================================

/** @deprecated Renamed to {@link AgentCandidateProfilePlanMaterial}. */
export type AgentCandidateProfilePlanMaterialV1 = AgentCandidateProfilePlanMaterial;

/** @deprecated Renamed to {@link AgentCandidateBenchmarkResultMaterial}. */
export type AgentCandidateBenchmarkResultMaterialV1 =
  AgentCandidateBenchmarkResultMaterial;

/**
 * @deprecated The router-authored call fields folded into
 * {@link AgentCandidateModelSettlementCall}; this alias is shape-identical.
 */
export type AgentCandidateModelSettlementCallV2 =
  AgentCandidateModelSettlementCall;

/**
 * @deprecated The settlement material union collapsed to the single current
 * {@link AgentCandidateModelSettlementMaterial}; this alias is shape-identical.
 */
export type AgentCandidateModelSettlementMaterialV2 =
  AgentCandidateModelSettlementMaterial;

/**
 * @deprecated Renamed to {@link agentCandidateModelSettlementCallSchema}.
 * Reference-equal to the current export.
 */
export const agentCandidateModelSettlementCallV2Schema =
  agentCandidateModelSettlementCallSchema;

/**
 * @deprecated Renamed to {@link agentCandidateModelSettlementMaterialSchema}.
 * Reference-equal to the current export.
 */
export const agentCandidateModelSettlementMaterialV2Schema =
  agentCandidateModelSettlementMaterialSchema;

// =============================================================================
// Re-added definitions — the current export changed shape, so the original is
// restored verbatim under its old name. Marked for removal in a future major.
// =============================================================================

/**
 * @deprecated The bundle contract advanced to `schemaVersion: 2`
 * ({@link AgentCandidateBundle}). This is the frozen `schemaVersion: 1` shape.
 */
export interface AgentCandidateBundleV1 {
  schemaVersion: 1;
  kind: "agent-candidate-bundle";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  profile: AgentCandidateProfile;
  code: AgentCandidateCode;
  execution: AgentCandidateExecution;
  knowledge?: AgentCandidateKnowledge;
  memory: AgentCandidateMemoryPolicy;
  lineage: AgentCandidateLineage;
  digest: Sha256Digest;
}

/**
 * @deprecated The workspace manifest advanced to `schemaVersion: 2` with an
 * unconstrained numeric `mode` ({@link AgentCandidateWorkspaceManifestMaterial}).
 * This is the frozen `schemaVersion: 1` shape.
 */
export interface AgentCandidateWorkspaceManifestMaterialV1 {
  schemaVersion: 1;
  kind: "agent-candidate-workspace-manifest";
  files: Array<{
    path: string;
    mode: 0o644 | 0o755;
    sha256: Sha256Digest;
    byteLength: number;
  }>;
}

/**
 * @deprecated The profile-plan material now carries `usage` (see
 * {@link AgentCandidateModelUsage}'s successor). This is the original
 * `resolved`/`usage` pairing kept for consumers of the old run receipt.
 */
export interface AgentCandidateModelUsage {
  resolved: AgentCandidateResolvedModel;
  usage: AgentCandidateSpend;
}

/**
 * @deprecated The execution-plan material advanced to `schemaVersion: 2` with a
 * restructured `task` ({@link AgentCandidateExecutionPlanMaterial}). This is the
 * frozen `schemaVersion: 1` shape.
 */
export interface AgentCandidateExecutionPlanMaterialV1 {
  schemaVersion: 1;
  kind: "agent-candidate-execution-plan-material";
  bundleDigest: Sha256Digest;
  executionId: string;
  attempt: AgentCandidateAttemptPolicy;
  task: {
    benchmark: string;
    benchmarkVersion: string;
    taskId: string;
    splitDigest: Sha256Digest;
    instruction: {
      encoding: "utf8";
      sha256: Sha256Digest;
      byteLength: number;
      delivery: AgentCandidateInstructionDelivery;
    };
    repository: {
      identity: string;
      rootIdentity: string;
      baseCommit: string;
      baseTree: string;
    };
    workspace: AgentCandidateWorkspaceSnapshotEvidence;
  };
  workspaces: {
    taskRoot: string;
    candidateRoot?: string;
  };
  codeKind: AgentCandidateCode["kind"];
  candidateWorkspace?: AgentCandidateWorkspaceSnapshotEvidence;
  profile: AgentCandidateProfileApplication;
  harness: HarnessType;
  harnessVersion: string;
  container: {
    source: AgentCandidateExecutionEnvironment["kind"];
    image: string;
    indexDigest: Sha256Digest;
    manifestDigest: Sha256Digest;
    platform: AgentCandidateOciPlatform;
  };
  model: {
    policy: "single";
    resolved: AgentCandidateResolvedModel;
    access: {
      kind: "evaluator-mediated";
      grantDigest: Sha256Digest;
      network: AgentCandidateModelAccessNetwork;
    };
    routes: Array<
      | { kind: "primary"; requested?: string }
      | { kind: "small"; requested: string }
      | { kind: "mode"; name: string; requested: string }
      | { kind: "subagent"; name: string; requested: string }
    >;
  };
  grader: {
    name: string;
    version: string;
    artifact: AgentCandidateArtifactRef;
  };
  launch: {
    executable: string;
    args: AgentCandidateConfigValue[];
    env: Record<string, AgentCandidateConfigValue>;
    cwd: AgentCandidateWorkingDirectory;
  };
  knowledgeManifestDigest?: Sha256Digest;
  memory: AgentCandidateEffectiveMemory;
  limits: AgentCandidateExecutionLimits;
  network: { mode: "disabled" };
}

/**
 * @deprecated The materialization receipt advanced to `schemaVersion: 2`
 * ({@link AgentCandidateMaterializationReceipt}). This is the frozen
 * `schemaVersion: 1` shape.
 */
export interface AgentCandidateMaterializationReceiptV1 {
  schemaVersion: 1;
  kind: "agent-candidate-materialization";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  bundleDigest: Sha256Digest;
  profilePlan: AgentCandidateProfilePlanEvidence;
  executionPlan: AgentCandidateExecutionPlanEvidence;
  candidateWorkspace?: AgentCandidateWorkspaceSnapshotEvidence;
  codeKind: AgentCandidateCode["kind"];
  materializedTree?: string;
  harness: HarnessType;
  harnessVersion: string;
  container: {
    source: AgentCandidateExecutionEnvironment["kind"];
    image: string;
    indexDigest: Sha256Digest;
    manifestDigest: Sha256Digest;
    platform: AgentCandidateOciPlatform;
  };
  resolvedModel: AgentCandidateResolvedModel;
  knowledgeManifestDigest?: Sha256Digest;
  entrypoint?: AgentCandidateEntrypointReceipt;
  digest: Sha256Digest;
}

/**
 * @deprecated The run receipt advanced to `schemaVersion: 3`
 * ({@link AgentCandidateRunReceipt}). This is the frozen `schemaVersion: 1`
 * shape with its aggregate `usage`/`modelUsage` accounting.
 */
export interface AgentCandidateRunReceiptV1 {
  schemaVersion: 1;
  kind: "agent-candidate-run";
  digestAlgorithm: AgentCandidateDigestAlgorithm;
  bundleDigest: Sha256Digest;
  materializationReceiptDigest: Sha256Digest;
  executionPlanDigest: Sha256Digest;
  memory: AgentCandidateMemoryReceipt;
  usage: AgentCandidateSpend;
  modelUsage: AgentCandidateModelUsage;
  trace: AgentCandidateTraceEvidence;
  termination: AgentCandidateTermination;
  digest: Sha256Digest;
}

/**
 * @deprecated The run receipt advanced to `schemaVersion: 3`
 * ({@link AgentCandidateRunReceipt}). This is the frozen `schemaVersion: 2`
 * shape that layered fixed-point spend and evidence over the V1 receipt.
 */
export interface AgentCandidateRunReceiptV2
  extends Omit<AgentCandidateRunReceiptV1, "schemaVersion"> {
  schemaVersion: 2;
  fixedUsage: AgentCandidateFixedSpend;
  modelSettlement: AgentCandidateModelSettlementEvidence;
  taskOutcome: AgentCandidateTaskOutcomeEvidence;
  benchmarkResult: AgentCandidateBenchmarkResultEvidence;
}

/**
 * @deprecated The V1/V2 run receipt generations collapsed into the single
 * current {@link AgentCandidateRunReceipt}. This union no longer has a current
 * counterpart.
 */
export type AgentCandidateRunReceiptAnyVersion =
  | AgentCandidateRunReceiptV1
  | AgentCandidateRunReceiptV2;

/**
 * Canonical model-access ledger written with the pre-router base call shape,
 * before per-call generation identity and terminal status were required.
 *
 * @deprecated The settlement material collapsed to the single current
 * {@link AgentCandidateModelSettlementMaterial} (`schemaVersion: 2`). This is
 * the frozen `schemaVersion: 1` shape.
 */
export interface AgentCandidateModelSettlementMaterialV1 {
  schemaVersion: 1;
  kind: "agent-candidate-model-settlement-material";
  executionPlanDigest: Sha256Digest;
  preparationId: string;
  grantDigest: Sha256Digest;
  closed: true;
  resolved: AgentCandidateResolvedModel;
  calls: LegacyModelSettlementCallV1[];
  usage: AgentCandidateFixedSpend;
}

/** Pre-router settlement call shape used only by {@link AgentCandidateModelSettlementMaterialV1}. */
interface LegacyModelSettlementCallV1 {
  callId: string;
  traceSpanId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsdNanos: number;
}

// -----------------------------------------------------------------------------
// Re-added schemas.
// -----------------------------------------------------------------------------

const safeCountSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "value must be a nonnegative safe integer");
const boundedIdentifierSchema = z.string().min(1).max(256);

/**
 * @deprecated The run receipt no longer carries a standalone model-usage block.
 * Restored `resolved`/`usage` schema for consumers of the V1/V2 run receipt.
 */
export const agentCandidateModelUsageSchema = z
  .object({
    resolved: agentCandidateResolvedModelSchema,
    usage: agentCandidateSpendSchema,
  })
  .strict() satisfies z.ZodType<AgentCandidateModelUsage>;

/**
 * Restored per-call aggregate and canonical-value checks shared by the V1
 * settlement material. Mirrors the current internal refinement but tolerates
 * the pre-router call shape that omits `generationId`.
 */
function refineLegacyModelSettlementMaterial(
  material: {
    resolved: AgentCandidateResolvedModel;
    calls: LegacyModelSettlementCallV1[];
    usage: AgentCandidateFixedSpend;
  },
  ctx: z.RefinementCtx,
): void {
  const callIds = new Set<string>();
  const traceSpanIds = new Set<string>();
  const totals: AgentCandidateFixedSpend = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    modelCalls: material.calls.length,
    costUsdNanos: 0,
  };

  for (const [index, call] of material.calls.entries()) {
    if (callIds.has(call.callId)) {
      ctx.addIssue({
        code: "custom",
        path: ["calls", index, "callId"],
        message: "model settlement call ids must be unique",
      });
    }
    callIds.add(call.callId);
    if (traceSpanIds.has(call.traceSpanId)) {
      ctx.addIssue({
        code: "custom",
        path: ["calls", index, "traceSpanId"],
        message: "model settlement trace span ids must be unique",
      });
    }
    traceSpanIds.add(call.traceSpanId);
    if (call.model !== material.resolved.model) {
      ctx.addIssue({
        code: "custom",
        path: ["calls", index, "model"],
        message: "settled call model must match the resolved single model",
      });
    }

    for (const field of [
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "reasoningTokens",
      "costUsdNanos",
    ] as const) {
      const sum = totals[field] + call[field];
      if (!Number.isSafeInteger(sum)) {
        ctx.addIssue({
          code: "custom",
          path: ["calls", index, field],
          message: `model settlement ${field} total exceeds safe integer range`,
        });
      } else {
        totals[field] = sum;
      }
    }
  }

  if (!sameFixedSpend(totals, material.usage)) {
    ctx.addIssue({
      code: "custom",
      path: ["usage"],
      message: "model settlement usage must equal the exact per-call aggregate",
    });
  }
  if (!isCanonicalJsonValue(material)) {
    ctx.addIssue({
      code: "custom",
      message: "model settlement material must contain only RFC 8785 JSON values",
    });
  }
}

const legacyModelSettlementCallV1Schema = z
  .object({
    callId: boundedIdentifierSchema,
    traceSpanId: boundedIdentifierSchema,
    model: boundedIdentifierSchema,
    inputTokens: safeCountSchema,
    outputTokens: safeCountSchema,
    cachedInputTokens: safeCountSchema,
    reasoningTokens: safeCountSchema,
    costUsdNanos: safeCountSchema,
  })
  .strict();

/**
 * @deprecated The settlement material collapsed to
 * {@link agentCandidateModelSettlementMaterialSchema} (`schemaVersion: 2`).
 * Restored `schemaVersion: 1` parser for the pre-router base call shape.
 */
export const agentCandidateModelSettlementMaterialV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("agent-candidate-model-settlement-material"),
    executionPlanDigest: sha256DigestSchema,
    preparationId: boundedIdentifierSchema,
    grantDigest: sha256DigestSchema,
    closed: z.literal(true),
    resolved: agentCandidateResolvedModelSchema,
    usage: agentCandidateFixedSpendSchema,
    calls: z.array(legacyModelSettlementCallV1Schema),
  })
  .strict()
  .superRefine(
    refineLegacyModelSettlementMaterial,
  ) satisfies z.ZodType<AgentCandidateModelSettlementMaterialV1>;

/**
 * @deprecated The run receipt collapsed to
 * {@link agentCandidateRunReceiptSchema} (`schemaVersion: 3`). Restored
 * `schemaVersion: 1` parser with aggregate usage accounting.
 */
export const agentCandidateRunReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("agent-candidate-run"),
    digestAlgorithm: z.literal("rfc8785-sha256"),
    bundleDigest: sha256DigestSchema,
    materializationReceiptDigest: sha256DigestSchema,
    executionPlanDigest: sha256DigestSchema,
    memory: agentCandidateMemoryReceiptSchema,
    usage: agentCandidateSpendSchema,
    modelUsage: agentCandidateModelUsageSchema,
    trace: agentCandidateTraceEvidenceSchema,
    termination: agentCandidateTerminationSchema,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const usageMatchesModel =
      receipt.usage.costUsd === receipt.modelUsage.usage.costUsd &&
      receipt.usage.inputTokens === receipt.modelUsage.usage.inputTokens &&
      receipt.usage.outputTokens === receipt.modelUsage.usage.outputTokens &&
      receipt.usage.cachedInputTokens ===
        receipt.modelUsage.usage.cachedInputTokens &&
      receipt.usage.modelCalls === receipt.modelUsage.usage.modelCalls;
    if (!usageMatchesModel) {
      ctx.addIssue({
        code: "custom",
        path: ["modelUsage", "usage"],
        message: "single-model usage must equal aggregate protected usage",
      });
    }
    if (receipt.trace.modelCallCount !== receipt.modelUsage.usage.modelCalls) {
      ctx.addIssue({
        code: "custom",
        path: ["trace", "modelCallCount"],
        message: "trace model-call count must match protected single-model usage",
      });
    }
    if (!isCanonicalJsonValue(receipt)) {
      ctx.addIssue({
        code: "custom",
        message: "run receipt must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentCandidateRunReceiptV1>;

function legacyUsageMatchesFixed(
  legacy: AgentCandidateModelUsage["usage"],
  fixed: AgentCandidateFixedSpend,
): boolean {
  return (
    legacy.costUsd === fixed.costUsdNanos / 1_000_000_000 &&
    legacy.inputTokens === fixed.inputTokens &&
    legacy.outputTokens === fixed.outputTokens &&
    (legacy.cachedInputTokens ?? 0) === fixed.cachedInputTokens &&
    legacy.modelCalls === fixed.modelCalls
  );
}

/**
 * @deprecated The run receipt collapsed to
 * {@link agentCandidateRunReceiptSchema} (`schemaVersion: 3`). Restored
 * `schemaVersion: 2` parser. Its evidence members bind the current settlement,
 * task-outcome, and benchmark-result schemas.
 */
export const agentCandidateRunReceiptV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal("agent-candidate-run"),
    digestAlgorithm: z.literal("rfc8785-sha256"),
    bundleDigest: sha256DigestSchema,
    materializationReceiptDigest: sha256DigestSchema,
    executionPlanDigest: sha256DigestSchema,
    memory: agentCandidateMemoryReceiptSchema,
    usage: agentCandidateSpendSchema,
    modelUsage: agentCandidateModelUsageSchema,
    trace: agentCandidateTraceEvidenceSchema,
    termination: agentCandidateTerminationSchema,
    fixedUsage: agentCandidateFixedSpendSchema,
    modelSettlement: agentCandidateModelSettlementEvidenceSchema,
    taskOutcome: agentCandidateTaskOutcomeEvidenceSchema,
    benchmarkResult: agentCandidateBenchmarkResultEvidenceSchema,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const legacyUsageMatchesModel =
      receipt.usage.costUsd === receipt.modelUsage.usage.costUsd &&
      receipt.usage.inputTokens === receipt.modelUsage.usage.inputTokens &&
      receipt.usage.outputTokens === receipt.modelUsage.usage.outputTokens &&
      receipt.usage.cachedInputTokens ===
        receipt.modelUsage.usage.cachedInputTokens &&
      receipt.usage.modelCalls === receipt.modelUsage.usage.modelCalls;
    if (!legacyUsageMatchesModel) {
      ctx.addIssue({
        code: "custom",
        path: ["modelUsage", "usage"],
        message: "single-model usage must equal aggregate protected usage",
      });
    }
    if (!legacyUsageMatchesFixed(receipt.usage, receipt.fixedUsage)) {
      ctx.addIssue({
        code: "custom",
        path: ["fixedUsage"],
        message: "fixed usage must exactly preserve the legacy usage totals",
      });
    }
    if (
      !sameFixedSpend(receipt.fixedUsage, receipt.modelSettlement.material.usage)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["modelSettlement", "material", "usage"],
        message: "model settlement aggregate must equal fixed run usage",
      });
    }
    if (
      JSON.stringify(receipt.modelUsage.resolved) !==
      JSON.stringify(receipt.modelSettlement.material.resolved)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["modelSettlement", "material", "resolved"],
        message: "model settlement must bind the run's resolved model",
      });
    }
    if (
      receipt.modelSettlement.material.executionPlanDigest !==
      receipt.executionPlanDigest
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["modelSettlement", "material", "executionPlanDigest"],
        message: "model settlement must bind the executed plan",
      });
    }
    if (receipt.trace.modelCallCount !== receipt.fixedUsage.modelCalls) {
      ctx.addIssue({
        code: "custom",
        path: ["trace", "modelCallCount"],
        message: "trace model-call count must match fixed run usage",
      });
    }
    if (
      receipt.taskOutcome.material.executionPlanDigest !==
      receipt.executionPlanDigest
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["taskOutcome", "material", "executionPlanDigest"],
        message: "task outcome must bind the executed plan",
      });
    }
    if (
      receipt.benchmarkResult.material.executionPlanDigest !==
      receipt.executionPlanDigest
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["benchmarkResult", "material", "executionPlanDigest"],
        message: "benchmark result must bind the executed plan",
      });
    }
    if (
      receipt.benchmarkResult.material.taskOutcomeDigest !==
      receipt.taskOutcome.digest
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["benchmarkResult", "material", "taskOutcomeDigest"],
        message: "benchmark result must bind the exact task outcome",
      });
    }
    if (!isCanonicalJsonValue(receipt)) {
      ctx.addIssue({
        code: "custom",
        message: "run receipt must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentCandidateRunReceiptV2>;

/**
 * @deprecated The run receipt generations collapsed into a single current
 * schema. Restored union parser for consumers that accepted both generations.
 */
export const agentCandidateRunReceiptAnyVersionSchema = z.union([
  agentCandidateRunReceiptV1Schema,
  agentCandidateRunReceiptV2Schema,
]) satisfies z.ZodType<AgentCandidateRunReceiptAnyVersion>;

/**
 * @deprecated No longer exported from the outcome module. Restored spend-equality
 * helper for consumers that compared fixed-point usage totals.
 */
export function sameFixedSpend(
  left: AgentCandidateFixedSpend,
  right: AgentCandidateFixedSpend,
): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.reasoningTokens === right.reasoningTokens &&
    left.modelCalls === right.modelCalls &&
    left.costUsdNanos === right.costUsdNanos
  );
}
