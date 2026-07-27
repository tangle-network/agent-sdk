import { z } from "zod";
import type {
  AgentCandidateExperiment,
  AgentCandidateJsonValue,
  AgentImprovementMeasuredComparison,
  AgentImprovementActivation,
  AgentImprovementActivationResult,
  AgentImprovementProposal,
  AgentImprovementReview,
  CandidateExecutionEvidence,
} from "./agent-candidate.js";
import { agentCandidateBundleSchema } from "./agent-candidate-schema.js";
import { agentCandidateLineageSchema } from "./agent-candidate-lineage-schema.js";
import { agentCandidateBenchmarkSuiteInputsSchema } from "./agent-candidate-task-schema.js";
import {
  canonicalCandidateDigest,
  isCanonicalJsonValue,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import { refineAgentExecutionWithinLimits } from "./agent-execution-limits.js";
import {
  agentCandidateMaterializationReceiptSchema,
  agentCandidateRunReceiptSchema,
} from "./agent-candidate-receipt-schema.js";
import {
  agentCandidateEvaluationPolicySchema,
  canonicalJsonObjectSchema,
  createMeasuredComparisonIdentityRegistry,
  measuredComparisonCommonShape,
  refineMeasuredComparisonSummary,
} from "./agent-improvement-measurement-schema.js";
import {
  agentProfileImprovementExecutionRefSchema,
  agentProfileImprovementMeasuredComparisonSchema,
  changedProfileImprovementSurfaces,
} from "./agent-profile-improvement-schema.js";

const improvementSurfaceSchema = z.enum([
  "prompt",
  "skills",
  "tools",
  "mcp",
  "hooks",
  "subagents",
  "agent-profile",
  "memory",
  "code",
  "knowledge",
]);

export const agentCandidateExperimentSchema = z
  .object({
    kind: z.literal("agent-candidate-experiment"),
    digestAlgorithm: z.literal("rfc8785-sha256"),
    baseline: agentCandidateBundleSchema,
    candidate: agentCandidateBundleSchema,
    candidateLineage: agentCandidateLineageSchema,
    benchmark: agentCandidateBenchmarkSuiteInputsSchema,
    policy: agentCandidateEvaluationPolicySchema,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((experiment, ctx) => {
    const source = experiment.candidateLineage.source;
    if (
      (source === "optimizer" || source === "compound") &&
      !experiment.candidateLineage.parentDigests?.includes(experiment.baseline.digest)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateLineage", "parentDigests"],
        message: "generated candidate lineage must include the experiment baseline",
      });
    }
    if (experiment.candidateLineage.parentDigests?.includes(experiment.candidate.digest)) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateLineage", "parentDigests"],
        message: "candidate lineage cannot name the candidate itself as a parent",
      });
    }
    if (
      experiment.candidateLineage.developmentSplitDigest !== undefined &&
      experiment.benchmark.tasks.some(
        (task) =>
          task.benchmark.splitDigest ===
          experiment.candidateLineage.developmentSplitDigest,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateLineage", "developmentSplitDigest"],
        message: "candidate development and held-out splits must be disjoint",
      });
    }
    if (!isCanonicalJsonValue(experiment)) {
      ctx.addIssue({
        code: "custom",
        message: "candidate experiment must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentCandidateExperiment>;

export const candidateExecutionEvidenceSchema = z
  .object({
    kind: z.literal("agent-candidate-execution-evidence"),
    materializationReceipt: agentCandidateMaterializationReceiptSchema,
    receipt: agentCandidateRunReceiptSchema,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((evidence, ctx) => {
    const materialization = evidence.materializationReceipt;
    const plan = materialization.executionPlan;
    const checks: Array<[boolean, (string | number)[], string]> = [
      [
        evidence.receipt.materializationReceiptDigest === materialization.digest,
        ["receipt", "materializationReceiptDigest"],
        "run receipt must bind the included materialization receipt",
      ],
      [
        evidence.receipt.executionPlanDigest === plan.digest,
        ["receipt", "executionPlanDigest"],
        "run receipt must bind the included execution plan",
      ],
      [
        evidence.receipt.bundleDigest === materialization.bundleDigest,
        ["receipt", "bundleDigest"],
        "run receipt and materialization must bind one bundle",
      ],
      [
        evidence.receipt.runCellDigest === plan.material.runCell.digest,
        ["receipt", "runCellDigest"],
        "run receipt must bind the materialized run cell",
      ],
      [
        materialization.profileActivation.profilePlan.digest ===
          plan.material.profile.planDigest,
        ["materializationReceipt", "profileActivation", "profilePlan", "digest"],
        "profile activation must bind the materialized execution plan",
      ],
      [
        evidence.receipt.modelSettlement.material.grantDigest ===
          plan.material.model.access.grantDigest,
        ["receipt", "modelSettlement", "material", "grantDigest"],
        "model settlement must bind the execution plan grant",
      ],
    ];
    for (const [valid, path, message] of checks) {
      if (!valid) ctx.addIssue({ code: "custom", path, message });
    }
    refineAgentExecutionWithinLimits(
      plan.material.limits,
      {
        durationMs: evidence.receipt.timing.durationMs,
        steps: evidence.receipt.steps,
        usage: evidence.receipt.modelSettlement.material.usage,
      },
      ctx,
      {
        pathPrefix: ["receipt"],
        usagePath: ["modelSettlement", "material", "usage"],
      },
    );
    if (!isCanonicalJsonValue(evidence)) {
      ctx.addIssue({
        code: "custom",
        message: "candidate execution evidence must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<CandidateExecutionEvidence>;

export const agentImprovementMeasuredComparisonSchema = z
  .object({
    kind: z.literal("agent-improvement-measured-comparison"),
    experiment: agentCandidateExperimentSchema,
    measurements: z.array(
      z
        .object({
          baseline: candidateExecutionEvidenceSchema,
          candidate: candidateExecutionEvidenceSchema,
        })
        .strict(),
    ),
    ...measuredComparisonCommonShape,
  })
  .strict()
  .superRefine((comparison, ctx) => {
    const { suite, tasks } = comparison.experiment.benchmark;
    const expectedN = suite.taskDigests.length * suite.reps;
    if (comparison.measurements.length !== expectedN) {
      ctx.addIssue({
        code: "custom",
        path: ["measurements"],
        message: "measured comparison must contain every signed benchmark cell",
      });
    }
    const recordExecutionIdentities = createMeasuredComparisonIdentityRegistry({
      ctx,
      identityLabel: "measured executions",
    });
    for (let taskIndex = 0; taskIndex < suite.taskDigests.length; taskIndex += 1) {
      const task = tasks[taskIndex];
      if (!task) continue;
      for (let repetition = 0; repetition < suite.reps; repetition += 1) {
        const index = taskIndex * suite.reps + repetition;
        const measurement = comparison.measurements[index];
        if (!measurement) continue;
        const seed = suite.seeds[index];
        for (const arm of ["baseline", "candidate"] as const) {
          const evidence = measurement[arm];
          const bundle = comparison.experiment[arm];
          const materialization = evidence.materializationReceipt;
          const plan = materialization.executionPlan;
          const runCell = plan.material.runCell;
          const result = evidence.receipt.benchmarkResult.material;
          const outcome = evidence.receipt.taskOutcome.material.outcome;
          const armPath = ["measurements", index, arm] as (string | number)[];
          const expectedTree =
            bundle.code.kind === "disabled"
              ? undefined
              : bundle.code.kind === "no-op"
                ? bundle.code.baseTree
                : bundle.code.candidateTree;
          const containerMatches =
            bundle.execution.environment.kind === "evaluator-task-container"
              ? task.evaluatorTaskContainer !== undefined &&
                plan.material.container.source === "evaluator-task-container" &&
                JSON.stringify(plan.material.container) ===
                  JSON.stringify(task.evaluatorTaskContainer)
              : plan.material.container.source === "pinned-container" &&
                plan.material.container.image ===
                  bundle.execution.environment.container.image &&
                plan.material.container.indexDigest ===
                  bundle.execution.environment.container.indexDigest;
          const checks: Array<[boolean, (string | number)[], string]> = [
            [
              runCell.experimentDigest === comparison.experiment.digest,
              [...armPath, "materializationReceipt", "executionPlan", "material", "runCell", "experimentDigest"],
              "execution evidence must bind the measured experiment",
            ],
            [
              runCell.arm === arm,
              [...armPath, "materializationReceipt", "executionPlan", "material", "runCell", "arm"],
              "execution evidence must bind its measured arm",
            ],
            [
              runCell.bundleDigest === bundle.digest && materialization.bundleDigest === bundle.digest,
              [...armPath, "materializationReceipt", "bundleDigest"],
              "execution evidence must bind the experiment arm bundle",
            ],
            [
              runCell.suiteDigest === suite.digest &&
                runCell.taskDigest === task.digest &&
                runCell.taskIndex === taskIndex &&
                runCell.repetition === repetition &&
                runCell.seed === seed &&
                runCell.attempt === 1,
              [...armPath, "materializationReceipt", "executionPlan", "material", "runCell"],
              "publishable execution evidence must use the first signed task attempt",
            ],
            [
              materialization.codeKind === bundle.code.kind,
              [...armPath, "materializationReceipt", "codeKind"],
              "materialized code must match the experiment arm bundle",
            ],
            [
              materialization.benchmark.suite.digest === suite.digest &&
                materialization.benchmark.task.digest === task.digest,
              [...armPath, "materializationReceipt", "benchmark"],
              "execution evidence must capture the signed suite and selected task",
            ],
            [
              materialization.harness === bundle.execution.harness &&
                materialization.harnessVersion === bundle.execution.harnessVersion &&
                plan.material.harness === bundle.execution.harness &&
                plan.material.harnessVersion === bundle.execution.harnessVersion,
              [...armPath, "materializationReceipt", "harness"],
              "execution evidence must bind the candidate harness and version",
            ],
            [
              JSON.stringify(plan.material.instructionDelivery) ===
                JSON.stringify(bundle.execution.instructionDelivery),
              [...armPath, "materializationReceipt", "executionPlan", "material", "instructionDelivery"],
              "execution plan must bind the candidate instruction delivery",
            ],
            [
              JSON.stringify(plan.material.limits) === JSON.stringify(task.limits),
              [...armPath, "materializationReceipt", "executionPlan", "material", "limits"],
              "execution plan must bind every signed task limit",
            ],
            [
              containerMatches,
              [...armPath, "materializationReceipt", "executionPlan", "material", "container"],
              "execution plan must bind the candidate or evaluator task container",
            ],
            [
              JSON.stringify(plan.material.candidateWorkspace) ===
                JSON.stringify(bundle.execution.workspace) &&
                JSON.stringify(materialization.candidateWorkspace) ===
                  JSON.stringify(bundle.execution.workspace),
              [...armPath, "materializationReceipt", "candidateWorkspace"],
              "execution evidence must bind the candidate workspace",
            ],
            [
              materialization.materializedTree === expectedTree,
              [...armPath, "materializationReceipt", "materializedTree"],
              "materialized tree must match the candidate code",
            ],
            [
              plan.material.launch.cwd.workspace === bundle.execution.cwd.workspace &&
                plan.material.launch.cwd.path === bundle.execution.cwd.path,
              [...armPath, "materializationReceipt", "executionPlan", "material", "launch", "cwd"],
              "execution plan must bind the candidate working directory",
            ],
            [
              plan.material.knowledgeManifestDigest === bundle.knowledge?.snapshot.digest &&
                materialization.knowledgeManifestDigest === bundle.knowledge?.snapshot.digest,
              [...armPath, "materializationReceipt", "knowledgeManifestDigest"],
              "execution evidence must bind the candidate knowledge snapshot",
            ],
            [
              (bundle.memory.mode === "disabled" && plan.material.memory.mode === "disabled") ||
                (bundle.memory.mode === "isolated" &&
                  plan.material.memory.mode === "isolated" &&
                  plan.material.memory.seedDigest === bundle.memory.seed?.sha256),
              [...armPath, "materializationReceipt", "executionPlan", "material", "memory"],
              "execution plan must bind the candidate memory policy",
            ],
            [
              result.evidence.sha256 !== task.grader.artifact.sha256,
              [...armPath, "receipt", "benchmarkResult", "material", "evidence", "sha256"],
              "grading evidence must be distinct from the signed grader implementation",
            ],
            [
              JSON.stringify(result.grader) === JSON.stringify(task.grader),
              [...armPath, "receipt", "benchmarkResult", "material", "grader"],
              "benchmark result must bind the signed grader",
            ],
            [
              materialization.profileActivation.profilePlan.material.sourceProfileDigest ===
                canonicalCandidateDigest(bundle.profile as AgentCandidateJsonValue),
              [...armPath, "materializationReceipt", "profileActivation", "profilePlan", "material", "sourceProfileDigest"],
              "materialized profile files must bind the experiment arm profile",
            ],
            [
              JSON.stringify(materialization.resolvedModel) === JSON.stringify(task.model),
              [...armPath, "materializationReceipt", "resolvedModel"],
              "execution must use the selected task model",
            ],
            [
              (task.limits.maxModelCalls === 0 &&
                materialization.executionPlan.material.model.access.network.mode ===
                  "disabled") ||
                (task.limits.maxModelCalls > 0 &&
                  materialization.executionPlan.material.model.access.network.mode ===
                    "gateway-only"),
              [
                ...armPath,
                "materializationReceipt",
                "executionPlan",
                "material",
                "model",
                "access",
                "network",
              ],
              "model gateway access must match the signed model-call limit",
            ],
            [
              outcome.kind === task.outcome.kind,
              [...armPath, "receipt", "taskOutcome", "material", "outcome", "kind"],
              "captured outcome must match the selected task contract",
            ],
            [
              task.outcome.kind !== "output" ||
                (outcome.kind === "output" &&
                  outcome.spec.mediaType === task.outcome.mediaType &&
                  outcome.spec.maxBytes === task.outcome.maxBytes),
              [...armPath, "receipt", "taskOutcome", "material", "outcome", "spec"],
              "captured output must match the selected task specification",
            ],
            [
              task.outcome.kind !== "workspace" ||
                (outcome.kind === "workspace" &&
                  task.repository !== undefined &&
                  outcome.baseRepository.identity === task.repository.identity &&
                  outcome.baseRepository.rootIdentity === task.repository.rootIdentity &&
                  outcome.baseRepository.commit === task.repository.baseCommit &&
                  outcome.baseRepository.tree === task.repository.baseTree),
              [...armPath, "receipt", "taskOutcome", "material", "outcome", "baseRepository"],
              "captured workspace must start from the selected task repository",
            ],
          ];
          for (const [valid, path, message] of checks) {
            if (!valid) ctx.addIssue({ code: "custom", path, message });
          }
          recordExecutionIdentities(
            [
              { kind: "execution", value: plan.material.executionId },
              { kind: "runCell", value: runCell.digest },
              { kind: "materialization", value: materialization.digest },
              { kind: "receipt", value: evidence.receipt.digest },
              { kind: "evidence", value: evidence.digest },
            ],
            armPath,
          );
        }
      }
    }
    refineMeasuredComparisonSummary(
      comparison,
      comparison.experiment.policy,
      expectedN,
      comparison.measurements,
      {
        score: (evidence) => evidence.receipt.benchmarkResult.material.score,
        dimension: (evidence, name) =>
          evidence.receipt.benchmarkResult.material.dimensions.find(
            (dimension) => dimension.name === name,
        )?.score,
      cost: executionCostUsd,
      costProvenance: executionCostProvenance,
      latency: executionLatencyMs,
      },
      ctx,
    );
    if (!isCanonicalJsonValue(comparison)) {
      ctx.addIssue({
        code: "custom",
        message: "measured comparison must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentImprovementMeasuredComparison>;


export const agentImprovementProposalSchema = z
  .object({
    kind: z.literal("agent-improvement-proposal"),
    runId: z.string().min(1).max(200),
    changedSurfaces: z
      .tuple([improvementSurfaceSchema])
      .rest(improvementSurfaceSchema)
      .refine(
        (surfaces) => new Set(surfaces).size === surfaces.length,
        "changed surfaces must be unique",
      ),
    proposedAt: z.iso.datetime(),
    findings: z.array(canonicalJsonObjectSchema),
    evaluation: z.discriminatedUnion("kind", [
      agentImprovementMeasuredComparisonSchema,
      agentProfileImprovementMeasuredComparisonSchema,
    ]),
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((proposal, ctx) => {
    if (proposal.evaluation.decision.outcome !== "ship") {
      ctx.addIssue({
        code: "custom",
        path: ["evaluation", "decision", "outcome"],
        message: "an improvement proposal requires a passing measured comparison",
      });
    }
    if (
      !proposal.evaluation.power.sufficient ||
      proposal.evaluation.overall.n <
        proposal.evaluation.experiment.policy.minProductiveRuns
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["evaluation", "power"],
        message: "an improvement proposal requires sufficient pre-registered power",
      });
    }
    if (proposal.evaluation.kind === "agent-improvement-measured-comparison") {
      if (
        proposal.evaluation.experiment.baseline.digest ===
        proposal.evaluation.experiment.candidate.digest
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["evaluation", "experiment", "candidate", "digest"],
          message: "an improvement proposal requires a changed candidate bundle",
        });
      }
    } else {
      const changed = changedProfileImprovementSurfaces(proposal.evaluation.experiment.change);
      if (!sameSurfaces(proposal.changedSurfaces, changed)) {
        ctx.addIssue({
          code: "custom",
          path: ["changedSurfaces"],
          message: "proposal changed surfaces must equal the measured profile changes",
        });
      }
    }
    if (!isCanonicalJsonValue(proposal)) {
      ctx.addIssue({
        code: "custom",
        message: "proposal must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentImprovementProposal>;

function sameSurfaces(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((surface) => right.includes(surface));
}

function executionCostUsd(evidence: CandidateExecutionEvidence): number {
  return (
    evidence.receipt.modelSettlement.material.usage.costUsdNanos +
    evidence.receipt.benchmarkResult.material.grading.usage.costUsdNanos
  ) / 1_000_000_000;
}

function executionCostProvenance(
  evidence: CandidateExecutionEvidence,
): "observed" | "estimated" {
  return evidence.receipt.modelSettlement.material.usage.costProvenance === "observed" &&
    evidence.receipt.benchmarkResult.material.grading.usage.costProvenance === "observed"
    ? "observed"
    : "estimated";
}

function executionLatencyMs(evidence: CandidateExecutionEvidence): number {
  return (
    evidence.receipt.timing.durationMs +
    evidence.receipt.benchmarkResult.material.grading.timing.durationMs
  );
}

export const agentImprovementReviewSchema = z
  .object({
    kind: z.literal("agent-improvement-review"),
    proposalDigest: sha256DigestSchema,
    decision: z.enum(["approve", "reject", "request-changes"]),
    reviewedBy: z.string().min(1),
    reviewedAt: z.iso.datetime(),
    reason: z.string().min(1),
    feedback: z.string().optional(),
    digest: sha256DigestSchema,
  })
  .strict()
  .refine(isCanonicalJsonValue, "review must contain only RFC 8785 JSON values") satisfies z.ZodType<AgentImprovementReview>;

const improvementActivationTargetSchema = z
  .object({
    surface: improvementSurfaceSchema,
    identity: z.string().min(1).max(500),
    expectedBaseDigest: sha256DigestSchema,
  })
  .strict();

export const agentImprovementActivationSchema = z
  .object({
    kind: z.literal("agent-improvement-activation"),
    proposalDigest: sha256DigestSchema,
    reviewDigest: sha256DigestSchema,
    experimentDigest: sha256DigestSchema,
    candidateDigest: sha256DigestSchema,
    executionRef: agentProfileImprovementExecutionRefSchema.optional(),
    intent: z.enum(["activate-candidate", "restore-baseline"]),
    targets: z
      .tuple([improvementActivationTargetSchema])
      .rest(improvementActivationTargetSchema),
    fundingOwner: z.string().min(1).max(500),
    authorizedBy: z.string().min(1).max(500),
    authorizedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((activation, ctx) => {
    const identities = activation.targets.map(
      (target) => `${target.surface}\u0000${target.identity}`,
    );
    if (new Set(identities).size !== identities.length) {
      ctx.addIssue({
        code: "custom",
        path: ["targets"],
        message: "activation targets must be unique by surface and identity",
      });
    }
    if (Date.parse(activation.expiresAt) <= Date.parse(activation.authorizedAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "activation expiry must follow its authorization time",
      });
    }
    if (!isCanonicalJsonValue(activation)) {
      ctx.addIssue({ code: "custom", message: "activation must contain only RFC 8785 JSON values" });
    }
  }) satisfies z.ZodType<AgentImprovementActivation>;

const improvementActivationTargetTransitionSchema = z
  .object({
    surface: improvementSurfaceSchema,
    identity: z.string().min(1).max(500),
    beforeDigest: sha256DigestSchema,
    afterDigest: sha256DigestSchema,
  })
  .strict();

const improvementActivationTargetStateSchema = z
  .object({
    surface: improvementSurfaceSchema,
    identity: z.string().min(1).max(500),
    currentDigest: sha256DigestSchema,
  })
  .strict();

const improvementActivationOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("applied"),
      transactionId: z.string().min(1).max(500),
      targets: z
        .tuple([improvementActivationTargetTransitionSchema])
        .rest(improvementActivationTargetTransitionSchema),
    })
    .strict(),
  z
    .object({
      status: z.literal("already-applied"),
      targets: z
        .tuple([improvementActivationTargetStateSchema])
        .rest(improvementActivationTargetStateSchema),
    })
    .strict(),
  z
    .object({
      status: z.literal("conflict"),
      targets: z
        .tuple([improvementActivationTargetStateSchema])
        .rest(improvementActivationTargetStateSchema),
    })
    .strict(),
  z.object({ status: z.literal("expired") }).strict(),
  z
    .object({
      status: z.literal("unsupported"),
      code: z.string().min(1).max(100),
      message: z.string().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      code: z.string().min(1).max(100),
      message: z.string().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      status: z.literal("indeterminate"),
      code: z.string().min(1).max(100),
      message: z.string().min(1).max(2_000),
    })
    .strict(),
]);

export const agentImprovementActivationResultSchema = z
  .object({
    kind: z.literal("agent-improvement-activation-result"),
    idempotencyKey: sha256DigestSchema,
    attemptedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    outcome: improvementActivationOutcomeSchema,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((result, ctx) => {
    if (Date.parse(result.completedAt) < Date.parse(result.attemptedAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "activation completion cannot predate its attempt",
      });
    }
    const targets = "targets" in result.outcome ? result.outcome.targets : [];
    const identities = targets.map((target) => `${target.surface}\u0000${target.identity}`);
    if (new Set(identities).size !== identities.length) {
      ctx.addIssue({
        code: "custom",
        path: ["outcome", "targets"],
        message: "activation outcome targets must be unique by surface and identity",
      });
    }
    if (!isCanonicalJsonValue(result)) {
      ctx.addIssue({
        code: "custom",
        message: "activation result must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentImprovementActivationResult>;
