import { z } from "zod";
import type {
  AgentCandidateExperiment,
  AgentCandidateJsonValue,
  AgentImprovementMeasuredComparison,
  AgentImprovementActivation,
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
import {
  agentCandidateMaterializationReceiptSchema,
  agentCandidateRunReceiptSchema,
} from "./agent-candidate-receipt-schema.js";

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
    evaluation: agentImprovementMeasuredComparisonSchema,
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
    if (!isCanonicalJsonValue(proposal)) {
      ctx.addIssue({
        code: "custom",
        message: "proposal must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentImprovementProposal>;

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

export const agentImprovementActivationSchema = z
  .object({
    kind: z.literal("agent-improvement-activation"),
    proposalDigest: sha256DigestSchema,
    reviewDigest: sha256DigestSchema,
    experimentDigest: sha256DigestSchema,
    candidateBundleDigest: sha256DigestSchema,
    targets: z
      .tuple([
        z
          .object({
            surface: improvementSurfaceSchema,
            identity: z.string().min(1).max(500),
            expectedBaseDigest: sha256DigestSchema,
          })
          .strict(),
      ])
      .rest(
        z
          .object({
            surface: improvementSurfaceSchema,
            identity: z.string().min(1).max(500),
            expectedBaseDigest: sha256DigestSchema,
          })
          .strict(),
      ),
    fundingOwner: z.string().min(1).max(500),
    authorizedBy: z.string().min(1).max(500),
    authorizedAt: z.iso.datetime(),
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
    if (!isCanonicalJsonValue(activation)) {
      ctx.addIssue({ code: "custom", message: "activation must contain only RFC 8785 JSON values" });
    }
  }) satisfies z.ZodType<AgentImprovementActivation>;
