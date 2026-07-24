import { z } from "zod";
import type {
  AgentCandidateExperiment,
  AgentCandidateJsonValue,
  AgentImprovementMeasuredComparison,
  AgentImprovementActivation,
  AgentImprovementActivationResult,
  AgentImprovementProposal,
  AgentImprovementReview,
  AgentProfileImprovementExperiment,
  AgentProfileImprovementEvidence,
  AgentProfileImprovementMeasuredComparison,
  AgentProfileImprovementMeasurement,
  AgentProfileImprovementRunReceipt,
  AgentProfileImprovementSurfaceValue,
  AgentProfileImprovementSuiteInputs,
  AgentProfileImprovementTask,
  CandidateExecutionEvidence,
} from "./agent-candidate.js";
import { agentCandidateBundleSchema } from "./agent-candidate-schema.js";
import { agentCandidateLineageSchema } from "./agent-candidate-lineage-schema.js";
import { agentCandidateBenchmarkGraderIdentitySchema } from "./agent-candidate-execution-plan-schema.js";
import {
  agentCandidateBenchmarkDimensionSchema,
  agentCandidateFixedSpendSchema,
} from "./agent-candidate-outcome-schema.js";
import { agentCandidateBenchmarkSuiteInputsSchema } from "./agent-candidate-task-schema.js";
import {
  canonicalCandidateDigest,
  isCanonicalJsonValue,
  omitTopLevelDigest,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import {
  agentCandidateMaterializationReceiptSchema,
  agentCandidateRunReceiptSchema,
} from "./agent-candidate-receipt-schema.js";
import { agentImprovementSourceSchema } from "./agent-improvement-source.js";
import {
  agentProfilePromptSchema,
  agentProfileResourceRefSchema,
} from "./profile-schema.js";

const canonicalJsonSchema = z.custom<AgentCandidateJsonValue>(
  isCanonicalJsonValue,
  "value must be finite, acyclic RFC 8785 JSON",
);
const canonicalJsonObjectSchema = z
  .record(z.string(), canonicalJsonSchema)
  .refine(isCanonicalJsonValue, "value must be finite, acyclic RFC 8785 JSON");

const confidenceIntervalSchema = z
  .object({
    level: z.number().finite().gt(0).lt(1),
    lower: z.number().finite(),
    upper: z.number().finite(),
    method: z.literal("paired-bootstrap"),
    statistic: z.literal("mean"),
    resamples: z.number().int().positive(),
  })
  .strict();

const measuredEstimateFields = {
  baseline: z.number().finite(),
  candidate: z.number().finite(),
  delta: z.number().finite(),
  confidenceInterval: confidenceIntervalSchema,
  n: z.number().int().positive(),
};

const qualityObjectiveFields = {
  kind: z.literal("objective"),
  name: z.string().min(1),
  direction: z.literal("higher-is-better"),
  unit: z.literal("score"),
};
const qualityDimensionFields = {
  kind: z.literal("dimension"),
  objective: z.string().min(1),
  name: z.string().min(1),
  direction: z.literal("higher-is-better"),
  unit: z.literal("score"),
};
const costObjectiveFields = {
  kind: z.literal("cost"),
  name: z.literal("cost"),
  direction: z.literal("lower-is-better"),
  unit: z.literal("usd"),
};
const latencyObjectiveFields = {
  kind: z.literal("latency"),
  name: z.literal("latency"),
  direction: z.literal("lower-is-better"),
  unit: z.literal("milliseconds"),
};

function measuredObjectiveVariant<T extends z.ZodRawShape>(fields: T) {
  return z
    .object({
      ...fields,
      availability: z.literal("measured"),
      ...measuredEstimateFields,
    })
    .strict();
}

function unavailableObjectiveVariant<T extends z.ZodRawShape>(fields: T) {
  return z
    .object({
      ...fields,
      availability: z.literal("unavailable"),
      reason: z.string().min(1),
    })
    .strict();
}

const measuredObjectiveSchema = z.union([
  measuredObjectiveVariant(qualityObjectiveFields),
  unavailableObjectiveVariant(qualityObjectiveFields),
  measuredObjectiveVariant(qualityDimensionFields),
  unavailableObjectiveVariant(qualityDimensionFields),
  measuredObjectiveVariant(costObjectiveFields),
  measuredObjectiveVariant(latencyObjectiveFields),
]);

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

export const agentCandidateEvaluationPolicySchema = z
  .object({
    confidenceLevel: z.number().finite().gt(0).lt(1),
    resamples: z.number().int().min(100),
    bootstrapSeed: z.number().int().safe(),
    deltaThreshold: z.number().finite().nonnegative(),
    minProductiveRuns: z.number().int().min(3),
    budgetUsd: z.number().finite().nonnegative().optional(),
    criticalDimensions: z.array(z.string().min(1)),
    regressionTolerance: z.number().finite().nonnegative(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (
      new Set(policy.criticalDimensions).size !== policy.criticalDimensions.length ||
      policy.criticalDimensions.some(
        (name, index) => index > 0 && policy.criticalDimensions[index - 1]! >= name,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["criticalDimensions"],
        message: "critical dimensions must be sorted and unique",
      });
    }
  });

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
    if (!isCanonicalJsonValue(evidence)) {
      ctx.addIssue({
        code: "custom",
        message: "candidate execution evidence must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<CandidateExecutionEvidence>;

const measuredComparisonCommonShape = {
  overall: z
    .object({
      name: z.literal("composite"),
      ...measuredEstimateFields,
      direction: z.literal("higher-is-better"),
      unit: z.literal("score"),
    })
    .strict(),
  objectives: z.array(measuredObjectiveSchema),
  candidate: z
    .object({
      label: z.string().min(1).optional(),
      rationale: z.string().min(1).optional(),
    })
    .strict()
    .refine(
      (candidate) => candidate.label !== undefined || candidate.rationale !== undefined,
      "candidate metadata requires a label or rationale",
    )
    .optional(),
  decision: z
    .object({
      outcome: z.enum([
        "ship",
        "hold",
        "need_more_work",
        "model_ceiling",
        "arch_ceiling",
      ]),
      reasons: z.array(z.string().min(1)).min(1),
      contributingChecks: z.array(
        z.object({ name: z.string().min(1), passed: z.boolean() }).strict(),
      ),
    })
    .strict(),
  power: z
    .object({
      sufficient: z.boolean(),
      n: z.number().int().positive(),
      minimumDetectableDelta: z.number().finite().nonnegative(),
      confidenceLevel: z.number().finite().gt(0).lt(1),
      scaleAssumed: z.boolean(),
      sharedScorerChannel: z.boolean(),
      reason: z.string().min(1),
    })
    .strict(),
  provenance: z
    .object({
      kind: z.literal("agent-eval-loop"),
      schema: z.string().min(1),
      runId: z.string().min(1),
      recordDigest: sha256DigestSchema,
      baselineContentHash: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
      candidateContentHash: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
    })
    .strict(),
  diff: z.string(),
  evaluation: z
    .object({
      generationsExplored: z.number().int().nonnegative(),
      searchDurationMs: z.number().finite().nonnegative(),
      executionDurationMs: z.number().finite().nonnegative(),
      durationMs: z.number().finite().nonnegative(),
      searchCostUsd: z.number().finite().nonnegative(),
      executionCostUsd: z.number().finite().nonnegative(),
      totalCostUsd: z.number().finite().nonnegative(),
    })
    .strict(),
  metadata: canonicalJsonObjectSchema.optional(),
};

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
    refineEstimate(comparison.overall, ["overall"], ctx);
    if (
      !approximatelyEqual(
        comparison.evaluation.durationMs,
        comparison.evaluation.searchDurationMs + comparison.evaluation.executionDurationMs,
      ) ||
      !approximatelyEqual(
        comparison.evaluation.totalCostUsd,
        comparison.evaluation.searchCostUsd + comparison.evaluation.executionCostUsd,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["evaluation"],
        message: "evaluation totals must equal their search and execution components",
      });
    }
    const { suite, tasks } = comparison.experiment.benchmark;
    const expectedN = suite.taskDigests.length * suite.reps;
    if (comparison.measurements.length !== expectedN) {
      ctx.addIssue({
        code: "custom",
        path: ["measurements"],
        message: "measured comparison must contain every signed benchmark cell",
      });
    }
    const executionIdentities = {
      execution: new Set<string>(),
      runCell: new Set<string>(),
      materialization: new Set<string>(),
      receipt: new Set<string>(),
      evidence: new Set<string>(),
    };
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
          const identitiesForRun = {
            execution: plan.material.executionId,
            runCell: runCell.digest,
            materialization: materialization.digest,
            receipt: evidence.receipt.digest,
            evidence: evidence.digest,
          };
          for (const [kind, identity] of Object.entries(identitiesForRun) as Array<
            [keyof typeof executionIdentities, string]
          >) {
            if (executionIdentities[kind].has(identity)) {
              ctx.addIssue({
                code: "custom",
                path: armPath,
                message: `measured executions must not reuse ${kind} identity`,
              });
            }
            executionIdentities[kind].add(identity);
          }
        }
      }
    }
    if (comparison.overall.n !== expectedN) {
      ctx.addIssue({
        code: "custom",
        path: ["overall", "n"],
        message: "measured sample count must equal the complete benchmark suite",
      });
    }
    if (comparison.measurements.length > 0) {
      refineMeasuredMean(
        comparison.overall.baseline,
        comparison.measurements.map((row) => row.baseline.receipt.benchmarkResult.material.score),
        ["overall", "baseline"],
        ctx,
      );
      refineMeasuredMean(
        comparison.overall.candidate,
        comparison.measurements.map((row) => row.candidate.receipt.benchmarkResult.material.score),
        ["overall", "candidate"],
        ctx,
      );
    }
    const identities = new Set<string>();
    const qualityObjectives = new Set<string>();
    const dimensionParents: Array<{ index: number; objective: string }> = [];
    let costCount = 0;
    let latencyCount = 0;
    for (const [index, objective] of comparison.objectives.entries()) {
      if (objective.availability === "measured") {
        refineEstimate(objective, ["objectives", index], ctx);
        if (objective.n !== expectedN) {
          ctx.addIssue({
            code: "custom",
            path: ["objectives", index, "n"],
            message: "measured objective count must equal the complete benchmark suite",
          });
        }
        if (comparison.measurements.length > 0 && objective.kind === "cost") {
          refineMeasuredMean(
            objective.baseline,
            comparison.measurements.map((row) => executionCostUsd(row.baseline)),
            ["objectives", index, "baseline"],
            ctx,
          );
          refineMeasuredMean(
            objective.candidate,
            comparison.measurements.map((row) => executionCostUsd(row.candidate)),
            ["objectives", index, "candidate"],
            ctx,
          );
        }
        if (comparison.measurements.length > 0 && objective.kind === "latency") {
          refineMeasuredMean(
            objective.baseline,
            comparison.measurements.map((row) => executionLatencyMs(row.baseline)),
            ["objectives", index, "baseline"],
            ctx,
          );
          refineMeasuredMean(
            objective.candidate,
            comparison.measurements.map((row) => executionLatencyMs(row.candidate)),
            ["objectives", index, "candidate"],
            ctx,
          );
        }
      }
      const identity =
        objective.kind === "dimension"
          ? `${objective.kind}:${objective.objective}:${objective.name}`
          : `${objective.kind}:${objective.name}`;
      if (identities.has(identity)) {
        ctx.addIssue({
          code: "custom",
          path: ["objectives", index, "name"],
          message: "measured objective identities must be unique",
        });
      }
      identities.add(identity);
      if (objective.kind === "objective") {
        qualityObjectives.add(objective.name);
      } else if (objective.kind === "dimension") {
        dimensionParents.push({ index, objective: objective.objective });
      } else if (objective.kind === "cost") {
        costCount += 1;
      } else if (objective.kind === "latency") {
        latencyCount += 1;
      }
    }
    if (costCount !== 1 || latencyCount !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["objectives"],
        message: "measured comparison must contain exactly one cost and latency objective",
      });
    }
    if (qualityObjectives.size === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["objectives"],
        message: "measured comparison must contain at least one quality objective",
      });
    }
    for (const parent of dimensionParents) {
      if (!qualityObjectives.has(parent.objective)) {
        ctx.addIssue({
          code: "custom",
          path: ["objectives", parent.index, "objective"],
          message: "measured dimension must name a present quality objective",
        });
      }
    }
    if (comparison.power.n !== comparison.overall.n) {
      ctx.addIssue({
        code: "custom",
        path: ["power", "n"],
        message: "power analysis must use the paired held-out sample",
      });
    }
    if (
      comparison.overall.confidenceInterval.level !==
        comparison.experiment.policy.confidenceLevel ||
      comparison.overall.confidenceInterval.resamples !==
        comparison.experiment.policy.resamples ||
      comparison.power.confidenceLevel !== comparison.experiment.policy.confidenceLevel
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["experiment", "policy"],
        message: "reported uncertainty must use the frozen evaluation policy",
      });
    }
    for (const [index, objective] of comparison.objectives.entries()) {
      if (
        objective.availability === "measured" &&
        (objective.confidenceInterval.level !==
          comparison.experiment.policy.confidenceLevel ||
          objective.confidenceInterval.resamples !== comparison.experiment.policy.resamples)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["objectives", index, "confidenceInterval"],
          message: "objective uncertainty must use the frozen evaluation policy",
        });
      }
    }
    if (!isCanonicalJsonValue(comparison)) {
      ctx.addIssue({
        code: "custom",
        message: "measured comparison must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentImprovementMeasuredComparison>;

const agentProfileImprovementScenarioSchema = z
  .object({
    id: z.string().min(1).max(500),
    kind: z.string().min(1).max(200),
    digest: sha256DigestSchema,
  })
  .strict();

export const agentProfileImprovementTaskSchema = z
  .object({
    kind: z.literal("agent-profile-improvement-task"),
    digestAlgorithm: z.literal("rfc8785-sha256"),
    scenario: agentProfileImprovementScenarioSchema,
    grader: agentCandidateBenchmarkGraderIdentitySchema,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((task, ctx) => {
    if (canonicalCandidateDigest(omitTopLevelDigest(task)) !== task.digest) {
      ctx.addIssue({
        code: "custom",
        path: ["digest"],
        message: "profile improvement task digest is invalid",
      });
    }
  }) satisfies z.ZodType<AgentProfileImprovementTask>;

export const agentProfileImprovementSuiteSchema = z
  .object({
    kind: z.literal("agent-profile-improvement-suite"),
    digestAlgorithm: z.literal("rfc8785-sha256"),
    splitDigest: sha256DigestSchema,
    taskDigests: z.tuple([sha256DigestSchema]).rest(sha256DigestSchema),
    reps: z.number().int().positive(),
    seeds: z.tuple([z.number().int().safe()]).rest(z.number().int().safe()),
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((suite, ctx) => {
    if (canonicalCandidateDigest(omitTopLevelDigest(suite)) !== suite.digest) {
      ctx.addIssue({
        code: "custom",
        path: ["digest"],
        message: "profile improvement suite digest is invalid",
      });
    }
  });

export const agentProfileImprovementSuiteInputsSchema = z
  .object({
    suite: agentProfileImprovementSuiteSchema,
    tasks: z.tuple([agentProfileImprovementTaskSchema]).rest(agentProfileImprovementTaskSchema),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.suite.taskDigests.length !== input.tasks.length) {
      ctx.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "profile improvement suite task count does not match its signed digests",
      });
    }
    if (input.suite.seeds.length !== input.tasks.length * input.suite.reps) {
      ctx.addIssue({
        code: "custom",
        path: ["suite", "seeds"],
        message: "profile improvement suite must have one seed per task and repetition",
      });
    }
    for (const [index, task] of input.tasks.entries()) {
      if (input.suite.taskDigests[index] !== task.digest) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index, "digest"],
          message: "profile improvement suite task digest does not match its task",
        });
      }
    }
  }) satisfies z.ZodType<AgentProfileImprovementSuiteInputs>;

const profileImprovementEvidenceSchema = z
  .object({
    kind: z.string().trim().min(1).max(100).regex(/^[a-z][a-z0-9-]*$/),
    identity: z.string().trim().min(1).max(500),
    digest: sha256DigestSchema,
  })
  .strict() satisfies z.ZodType<AgentProfileImprovementEvidence>;

const profileImprovementSurfaceValueSchema = z
  .discriminatedUnion("surface", [
    z
      .object({
        surface: z.literal("prompt"),
        value: z.object({ prompt: agentProfilePromptSchema.nullable() }).strict(),
        digest: sha256DigestSchema,
      })
      .strict(),
    z
      .object({
        surface: z.literal("skills"),
        value: z.array(agentProfileResourceRefSchema).nullable(),
        digest: sha256DigestSchema,
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (canonicalCandidateDigest(value.value) !== value.digest) {
      ctx.addIssue({
        code: "custom",
        path: ["digest"],
        message: "profile improvement surface digest is invalid",
      });
    }
  }) satisfies z.ZodType<AgentProfileImprovementSurfaceValue>;

export const agentProfileImprovementArmSchema = z
  .object({
    stateDigest: sha256DigestSchema,
    surfaces: z
      .tuple([profileImprovementSurfaceValueSchema])
      .rest(profileImprovementSurfaceValueSchema),
  })
  .strict()
  .superRefine((arm, ctx) => {
    const surfaces = arm.surfaces.map((value) => value.surface);
    if (
      new Set(surfaces).size !== surfaces.length ||
      surfaces.some((surface, index) => index > 0 && surfaces[index - 1]! >= surface)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["surfaces"],
        message: "profile improvement surfaces must be sorted and unique",
      });
    }
    if (canonicalCandidateDigest({ surfaces: arm.surfaces }) !== arm.stateDigest) {
      ctx.addIssue({
        code: "custom",
        path: ["stateDigest"],
        message: "profile improvement state digest is invalid",
      });
    }
  });

export const agentProfileImprovementExperimentSchema = z
  .object({
    kind: z.literal("agent-profile-improvement-experiment"),
    digestAlgorithm: z.literal("rfc8785-sha256"),
    source: agentImprovementSourceSchema,
    baseline: agentProfileImprovementArmSchema,
    candidate: agentProfileImprovementArmSchema,
    candidateLineage: agentCandidateLineageSchema,
    benchmark: agentProfileImprovementSuiteInputsSchema,
    policy: agentCandidateEvaluationPolicySchema,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((experiment, ctx) => {
    if (experiment.baseline.stateDigest === experiment.candidate.stateDigest) {
      ctx.addIssue({
        code: "custom",
        path: ["candidate", "stateDigest"],
        message: "profile improvement experiment requires a changed candidate state",
      });
    }
    const baselineSurfaces = experiment.baseline.surfaces.map((value) => value.surface);
    const candidateSurfaces = experiment.candidate.surfaces.map((value) => value.surface);
    if (JSON.stringify(baselineSurfaces) !== JSON.stringify(candidateSurfaces)) {
      ctx.addIssue({
        code: "custom",
        path: ["candidate", "surfaces"],
        message: "profile improvement arms must retain the same ordered surfaces",
      });
    }
    if (
      !experiment.baseline.surfaces.some(
        (value, index) => value.digest !== experiment.candidate.surfaces[index]?.digest,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["candidate", "surfaces"],
        message: "profile improvement experiment requires a changed profile surface",
      });
    }
    const source = experiment.candidateLineage.source;
    if (
      (source === "optimizer" || source === "compound") &&
      !experiment.candidateLineage.parentDigests?.includes(experiment.baseline.stateDigest)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateLineage", "parentDigests"],
        message: "generated profile lineage must include the experiment baseline",
      });
    }
    if (
      experiment.candidateLineage.parentDigests?.includes(
        experiment.candidate.stateDigest,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateLineage", "parentDigests"],
        message: "profile lineage cannot name the candidate itself as a parent",
      });
    }
    if (
      experiment.candidateLineage.developmentSplitDigest !== undefined &&
      experiment.candidateLineage.developmentSplitDigest === experiment.benchmark.suite.splitDigest
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateLineage", "developmentSplitDigest"],
        message: "profile improvement development and held-out splits must be disjoint",
      });
    }
    if (canonicalCandidateDigest(omitTopLevelDigest(experiment)) !== experiment.digest) {
      ctx.addIssue({
        code: "custom",
        path: ["digest"],
        message: "profile improvement experiment digest is invalid",
      });
    }
  }) satisfies z.ZodType<AgentProfileImprovementExperiment>;

export const agentProfileImprovementRunCellSchema = z
  .object({
    kind: z.literal("agent-profile-improvement-run-cell"),
    experimentDigest: sha256DigestSchema,
    arm: z.enum(["baseline", "candidate"]),
    stateDigest: sha256DigestSchema,
    suiteDigest: sha256DigestSchema,
    taskDigest: sha256DigestSchema,
    taskIndex: z.number().int().nonnegative(),
    repetition: z.number().int().nonnegative(),
    seed: z.number().int().safe(),
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((cell, ctx) => {
    if (canonicalCandidateDigest(omitTopLevelDigest(cell)) !== cell.digest) {
      ctx.addIssue({
        code: "custom",
        path: ["digest"],
        message: "profile improvement run cell digest is invalid",
      });
    }
  });

const timingSchema = z
  .object({
    startedAtMs: z.number().finite().nonnegative(),
    endedAtMs: z.number().finite().nonnegative(),
    durationMs: z.number().finite().nonnegative(),
  })
  .strict()
  .superRefine((timing, ctx) => {
    if (!approximatelyEqual(timing.durationMs, timing.endedAtMs - timing.startedAtMs)) {
      ctx.addIssue({
        code: "custom",
        path: ["durationMs"],
        message: "timing duration must equal its start and end timestamps",
      });
    }
  });

const agentProfileImprovementGradingSchema = z
  .object({
    grader: agentCandidateBenchmarkGraderIdentitySchema,
    evidence: profileImprovementEvidenceSchema,
    timing: timingSchema,
    usage: agentCandidateFixedSpendSchema,
    score: z.number().finite(),
    passed: z.boolean(),
    dimensions: z.array(agentCandidateBenchmarkDimensionSchema),
  })
  .strict()
  .superRefine((grading, ctx) => {
    const names = grading.dimensions.map((dimension) => dimension.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: "custom",
        path: ["dimensions"],
        message: "profile improvement grading dimension names must be unique",
      });
    }
    if (grading.evidence.digest === grading.grader.artifact.sha256) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "profile improvement grading evidence must be distinct from its grader",
      });
    }
  });

export const agentProfileImprovementRunReceiptSchema = z
  .object({
    kind: z.literal("agent-profile-improvement-run"),
    digestAlgorithm: z.literal("rfc8785-sha256"),
    executionId: z.string().min(1).max(500),
    runCell: agentProfileImprovementRunCellSchema,
    runRecord: profileImprovementEvidenceSchema,
    billing: z
      .tuple([profileImprovementEvidenceSchema])
      .rest(profileImprovementEvidenceSchema),
    timing: timingSchema,
    resolvedModel: z.string().min(1).max(500),
    usage: agentCandidateFixedSpendSchema,
    trace: z
      .object({
        evidence: profileImprovementEvidenceSchema,
        eventCount: z.number().int().nonnegative(),
        modelCallCount: z.number().int().nonnegative(),
      })
      .strict(),
    output: profileImprovementEvidenceSchema,
    outcome: z.discriminatedUnion("status", [
      z.object({ status: z.literal("succeeded") }).strict(),
      z
        .object({
          status: z.literal("failed"),
          code: z.string().min(1).max(200),
          message: z.string().min(1).max(4_000),
        })
        .strict(),
    ]),
    grading: agentProfileImprovementGradingSchema,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (evidenceKey(receipt.output) === evidenceKey(receipt.grading.evidence)) {
      ctx.addIssue({
        code: "custom",
        path: ["grading", "evidence"],
        message: "profile improvement grading evidence must be distinct from the agent output",
      });
    }
    const billing = receipt.billing.map(evidenceKey);
    if (new Set(billing).size !== billing.length) {
      ctx.addIssue({
        code: "custom",
        path: ["billing"],
        message: "profile improvement billing evidence must be unique",
      });
    }
    if (canonicalCandidateDigest(omitTopLevelDigest(receipt)) !== receipt.digest) {
      ctx.addIssue({
        code: "custom",
        path: ["digest"],
        message: "profile improvement run receipt digest is invalid",
      });
    }
  }) satisfies z.ZodType<AgentProfileImprovementRunReceipt>;

const agentProfileImprovementMeasurementSchema = z
  .object({
    baseline: agentProfileImprovementRunReceiptSchema,
    candidate: agentProfileImprovementRunReceiptSchema,
  })
  .strict() satisfies z.ZodType<AgentProfileImprovementMeasurement>;

export const agentProfileImprovementMeasuredComparisonSchema = z
  .object({
    kind: z.literal("agent-profile-improvement-measured-comparison"),
    experiment: agentProfileImprovementExperimentSchema,
    measurements: z.array(agentProfileImprovementMeasurementSchema),
    ...measuredComparisonCommonShape,
  })
  .strict()
  .superRefine((comparison, ctx) => {
    refineProfileImprovementComparison(comparison, ctx);
  }) satisfies z.ZodType<AgentProfileImprovementMeasuredComparison>;

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
    evaluation: z.union([
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
      const changed = changedProfileSurfaces(proposal.evaluation.experiment);
      if (JSON.stringify(proposal.changedSurfaces) !== JSON.stringify(changed)) {
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

function changedProfileSurfaces(
  experiment: AgentProfileImprovementExperiment,
): string[] {
  return experiment.baseline.surfaces.flatMap((value, index) =>
    value.digest === experiment.candidate.surfaces[index]?.digest ? [] : [value.surface],
  );
}

function refineEstimate(
  estimate: {
    baseline: number;
    candidate: number;
    delta: number;
    confidenceInterval: { lower: number; upper: number };
  },
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const expectedDelta = estimate.candidate - estimate.baseline;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(expectedDelta)) * 8;
  if (Math.abs(estimate.delta - expectedDelta) > tolerance) {
    ctx.addIssue({
      code: "custom",
      path: [...path, "delta"],
      message: "measured delta must equal candidate minus baseline",
    });
  }
  if (
    estimate.confidenceInterval.lower > estimate.confidenceInterval.upper ||
    estimate.delta < estimate.confidenceInterval.lower ||
    estimate.delta > estimate.confidenceInterval.upper
  ) {
    ctx.addIssue({
      code: "custom",
      path: [...path, "confidenceInterval"],
      message: "confidence interval must be ordered and contain the measured delta",
    });
  }
}

function refineProfileImprovementComparison(
  comparison: AgentProfileImprovementMeasuredComparison,
  ctx: z.RefinementCtx,
): void {
  refineEstimate(comparison.overall, ["overall"], ctx);
  if (
    !approximatelyEqual(
      comparison.evaluation.durationMs,
      comparison.evaluation.searchDurationMs + comparison.evaluation.executionDurationMs,
    ) ||
    !approximatelyEqual(
      comparison.evaluation.totalCostUsd,
      comparison.evaluation.searchCostUsd + comparison.evaluation.executionCostUsd,
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["evaluation"],
      message: "evaluation totals must equal their search and execution components",
    });
  }

  const { suite, tasks } = comparison.experiment.benchmark;
  const expectedN = tasks.length * suite.reps;
  if (comparison.measurements.length !== expectedN) {
    ctx.addIssue({
      code: "custom",
      path: ["measurements"],
      message: "profile comparison must contain every signed benchmark cell",
    });
  }

  const identities = {
    execution: new Set<string>(),
    runCell: new Set<string>(),
    receipt: new Set<string>(),
    runRecord: new Set<string>(),
    billing: new Set<string>(),
  };
  const expectedDimensions = measurementDimensionNames(comparison.measurements[0]);
  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
    const task = tasks[taskIndex];
    if (!task) continue;
    for (let repetition = 0; repetition < suite.reps; repetition += 1) {
      const index = taskIndex * suite.reps + repetition;
      const measurement = comparison.measurements[index];
      if (!measurement) continue;
      const seed = suite.seeds[index];
      for (const arm of ["baseline", "candidate"] as const) {
        const receipt = measurement[arm];
        const cell = receipt.runCell;
        const profile = comparison.experiment[arm];
        const armPath = ["measurements", index, arm] as (string | number)[];
        const checks: Array<[boolean, (string | number)[], string]> = [
          [
            cell.experimentDigest === comparison.experiment.digest,
            [...armPath, "runCell", "experimentDigest"],
            "profile run receipt must bind the measured experiment",
          ],
          [
            cell.arm === arm,
            [...armPath, "runCell", "arm"],
            "profile run receipt must bind its measured arm",
          ],
          [
            cell.stateDigest === profile.stateDigest,
            [...armPath, "runCell", "stateDigest"],
            "profile run receipt must bind the experiment arm state",
          ],
          [
            cell.suiteDigest === suite.digest &&
              cell.taskDigest === task.digest &&
              cell.taskIndex === taskIndex &&
              cell.repetition === repetition &&
              cell.seed === seed,
            [...armPath, "runCell"],
            "profile run receipt must bind the signed task, repetition, and seed",
          ],
          [
            JSON.stringify(receipt.grading.grader) === JSON.stringify(task.grader),
            [...armPath, "grading", "grader"],
            "profile run receipt must bind the signed evaluator",
          ],
          [
            JSON.stringify(receipt.grading.dimensions.map((dimension) => dimension.name)) ===
              JSON.stringify(expectedDimensions),
            [...armPath, "grading", "dimensions"],
            "profile run receipt dimensions must match the complete measured comparison",
          ],
        ];
        for (const [valid, path, message] of checks) {
          if (!valid) ctx.addIssue({ code: "custom", path, message });
        }
        const identitiesForRun = {
          execution: receipt.executionId,
          runCell: cell.digest,
          receipt: receipt.digest,
          runRecord: evidenceKey(receipt.runRecord),
        };
        for (const [kind, identity] of Object.entries(identitiesForRun) as Array<
          [keyof typeof identities, string]
        >) {
          if (identities[kind].has(identity)) {
            ctx.addIssue({
              code: "custom",
              path: armPath,
              message: `profile measurements must not reuse ${kind} identity`,
            });
          }
          identities[kind].add(identity);
        }
        for (const billing of receipt.billing) {
          const identity = evidenceKey(billing);
          if (identities.billing.has(identity)) {
            ctx.addIssue({
              code: "custom",
              path: [...armPath, "billing"],
              message: "profile measurements must not reuse billing evidence",
            });
          }
          identities.billing.add(identity);
        }
      }
      if (
        measurement.baseline.executionId === measurement.candidate.executionId ||
        measurement.baseline.runCell.digest === measurement.candidate.runCell.digest ||
        measurement.baseline.digest === measurement.candidate.digest
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["measurements", index],
          message: "profile measurement must use independent baseline and candidate executions",
        });
      }
    }
  }

  if (
    comparison.decision.outcome === "ship" &&
    comparison.measurements.some(
      (measurement) =>
        measurement.baseline.outcome.status !== "succeeded" ||
        measurement.candidate.outcome.status !== "succeeded",
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["measurements"],
      message: "a shippable profile comparison cannot include failed executions",
    });
  }

  if (comparison.overall.n !== expectedN) {
    ctx.addIssue({
      code: "custom",
      path: ["overall", "n"],
      message: "profile comparison sample count must equal the complete benchmark suite",
    });
  }
  if (comparison.measurements.length > 0) {
    refineMeasuredMean(
      comparison.overall.baseline,
      comparison.measurements.map((measurement) => measurement.baseline.grading.score),
      ["overall", "baseline"],
      ctx,
    );
    refineMeasuredMean(
      comparison.overall.candidate,
      comparison.measurements.map((measurement) => measurement.candidate.grading.score),
      ["overall", "candidate"],
      ctx,
    );
  }
  refineMeasuredObjectives(
    comparison.objectives,
    expectedN,
    comparison.experiment.policy.confidenceLevel,
    comparison.experiment.policy.resamples,
    comparison.power,
    comparison.measurements,
    {
      score: (receipt) => receipt.grading.score,
      dimension: (receipt, name) => {
        const dimension = receipt.grading.dimensions.find((entry) => entry.name === name);
        if (!dimension) throw new Error(`profile improvement receipt is missing dimension '${name}'`);
        return dimension.score;
      },
      cost: profileImprovementExecutionCostUsd,
      latency: profileImprovementExecutionLatencyMs,
    },
    ctx,
  );
  if (!isCanonicalJsonValue(comparison)) {
    ctx.addIssue({
      code: "custom",
      message: "profile measured comparison must contain only RFC 8785 JSON values",
    });
  }
}

function measurementDimensionNames(
  measurement: AgentProfileImprovementMeasurement | undefined,
): string[] {
  return measurement?.baseline.grading.dimensions.map((dimension) => dimension.name) ?? [];
}

function evidenceKey(evidence: AgentProfileImprovementEvidence): string {
  return `${evidence.kind}\u0000${evidence.identity}\u0000${evidence.digest}`;
}

function profileImprovementExecutionCostUsd(receipt: AgentProfileImprovementRunReceipt): number {
  return (receipt.usage.costUsdNanos + receipt.grading.usage.costUsdNanos) / 1_000_000_000;
}

function profileImprovementExecutionLatencyMs(receipt: AgentProfileImprovementRunReceipt): number {
  return receipt.timing.durationMs + receipt.grading.timing.durationMs;
}

function refineMeasuredObjectives<TReceipt>(
  objectives: AgentProfileImprovementMeasuredComparison["objectives"],
  expectedN: number,
  confidenceLevel: number,
  resamples: number,
  power: AgentProfileImprovementMeasuredComparison["power"],
  measurements: readonly { baseline: TReceipt; candidate: TReceipt }[],
  values: {
    score(receipt: TReceipt): number;
    dimension(receipt: TReceipt, name: string): number;
    cost(receipt: TReceipt): number;
    latency(receipt: TReceipt): number;
  },
  ctx: z.RefinementCtx,
): void {
  const identities = new Set<string>();
  const qualityObjectives = new Set<string>();
  const dimensionParents: Array<{ index: number; objective: string }> = [];
  let costCount = 0;
  let latencyCount = 0;
  for (const [index, objective] of objectives.entries()) {
    if (objective.availability === "measured") {
      refineEstimate(objective, ["objectives", index], ctx);
      if (objective.n !== expectedN) {
        ctx.addIssue({
          code: "custom",
          path: ["objectives", index, "n"],
          message: "measured objective count must equal the complete benchmark suite",
        });
      }
      if (measurements.length > 0) {
        const extractor =
          objective.kind === "objective"
            ? values.score
            : objective.kind === "dimension"
              ? (receipt: TReceipt) => values.dimension(receipt, objective.name)
              : objective.kind === "cost"
                ? values.cost
                : values.latency;
        refineMeasuredMean(
          objective.baseline,
          measurements.map((measurement) => extractor(measurement.baseline)),
          ["objectives", index, "baseline"],
          ctx,
        );
        refineMeasuredMean(
          objective.candidate,
          measurements.map((measurement) => extractor(measurement.candidate)),
          ["objectives", index, "candidate"],
          ctx,
        );
      }
    }
    const identity =
      objective.kind === "dimension"
        ? `${objective.kind}:${objective.objective}:${objective.name}`
        : `${objective.kind}:${objective.name}`;
    if (identities.has(identity)) {
      ctx.addIssue({
        code: "custom",
        path: ["objectives", index, "name"],
        message: "measured objective identities must be unique",
      });
    }
    identities.add(identity);
    if (objective.kind === "objective") {
      qualityObjectives.add(objective.name);
    } else if (objective.kind === "dimension") {
      dimensionParents.push({ index, objective: objective.objective });
    } else if (objective.kind === "cost") {
      costCount += 1;
    } else if (objective.kind === "latency") {
      latencyCount += 1;
    }
  }
  if (costCount !== 1 || latencyCount !== 1) {
    ctx.addIssue({
      code: "custom",
      path: ["objectives"],
      message: "measured comparison must contain exactly one cost and latency objective",
    });
  }
  if (qualityObjectives.size === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["objectives"],
      message: "measured comparison must contain at least one quality objective",
    });
  }
  for (const parent of dimensionParents) {
    if (!qualityObjectives.has(parent.objective)) {
      ctx.addIssue({
        code: "custom",
        path: ["objectives", parent.index, "objective"],
        message: "measured dimension must name a present quality objective",
      });
    }
  }
  if (power.n !== expectedN) {
    ctx.addIssue({
      code: "custom",
      path: ["power", "n"],
      message: "power analysis must use the paired held-out sample",
    });
  }
  for (const [index, objective] of objectives.entries()) {
    if (
      objective.availability === "measured" &&
      (objective.confidenceInterval.level !== confidenceLevel ||
        objective.confidenceInterval.resamples !== resamples)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["objectives", index, "confidenceInterval"],
        message: "objective uncertainty must use the frozen evaluation policy",
      });
    }
  }
}

function refineMeasuredMean(
  reported: number,
  values: number[],
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const measured = values.reduce((sum, value) => sum + value, 0) / values.length;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(measured)) * values.length * 8;
  if (Math.abs(reported - measured) > tolerance) {
    ctx.addIssue({
      code: "custom",
      path,
      message: "reported mean must equal the signed per-cell results",
    });
  }
}

function approximatelyEqual(left: number, right: number): boolean {
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 16;
  return Math.abs(left - right) <= tolerance;
}

function executionCostUsd(evidence: CandidateExecutionEvidence): number {
  return (
    evidence.receipt.modelSettlement.material.usage.costUsdNanos +
    evidence.receipt.benchmarkResult.material.grading.usage.costUsdNanos
  ) / 1_000_000_000;
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
