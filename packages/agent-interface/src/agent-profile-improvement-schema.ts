import { z } from "zod";
import type {
  AgentProfileImprovementEvidence,
  AgentProfileImprovementExecutionRef,
  AgentProfileImprovementExperiment,
  AgentProfileImprovementMeasuredComparison,
  AgentProfileImprovementMeasurement,
  AgentProfileImprovementRunReceipt,
  AgentProfileImprovementRunCell,
  AgentProfileImprovementSuite,
  AgentProfileImprovementSuiteInputs,
  AgentProfileImprovementTask,
} from "./agent-profile-improvement.js";
import type { AgentCandidateFixedSpend } from "./agent-candidate.js";
import type { AgentProfileDiff } from "./profile-diff.js";
import { agentCandidateLineageSchema } from "./agent-candidate-lineage-schema.js";
import {
  canonicalCandidateDigest,
  isCanonicalJsonValue,
  omitTopLevelDigest,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import { refineAgentExecutionWithinLimits } from "./agent-execution-limits.js";
import {
  agentCandidateBenchmarkGraderIdentitySchema,
  agentCandidateExecutionLimitsSchema,
  agentCandidateResolvedModelSchema,
} from "./agent-candidate-execution-plan-schema.js";
import {
  agentCandidateBenchmarkDimensionSchema,
  agentCandidateFixedSpendSchema,
} from "./agent-candidate-outcome-schema.js";
import {
  agentCandidateEvaluationPolicySchema,
  createMeasuredComparisonIdentityRegistry,
  measuredComparisonCommonShape,
  refineMeasuredComparisonSummary,
} from "./agent-improvement-measurement-schema.js";
import { agentImprovementSourceSchema } from "./agent-improvement-source.js";
import { numbersApproximatelyEqual } from "./number-validation.js";
import { agentProfileDiffSchema } from "./profile-schema.js";

const profileImprovementScenarioSchema = z
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
    scenario: profileImprovementScenarioSchema,
    grader: agentCandidateBenchmarkGraderIdentitySchema,
    model: agentCandidateResolvedModelSchema,
    limits: agentCandidateExecutionLimitsSchema,
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
  }) satisfies z.ZodType<AgentProfileImprovementSuite>;

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

export const agentProfileImprovementArmSchema = z
  .object({
    stateDigest: sha256DigestSchema,
  })
  .strict();

export const agentProfileImprovementExecutionRefSchema = profileImprovementEvidenceSchema
  .extend({
    kind: z.literal("agent-profile-improvement-execution-ref"),
  })
  .strict() satisfies z.ZodType<AgentProfileImprovementExecutionRef>;

/**
 * The first product path changes only prompt and skills, but it uses the
 * shared profile-diff language so execution and activation apply identical
 * ordered patches.
 */
export const agentProfileImprovementChangeStepSchema = agentProfileDiffSchema.superRefine(
  (change, ctx) => {
    const changed = changedProfileImprovementSurfaces([change]);
    if (changed.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "profile improvement patch must change prompt or skills",
      });
    }

    const setKeys = Object.keys(change.set ?? {});
    if (setKeys.some((key) => key !== "prompt" && key !== "resources")) {
      ctx.addIssue({
        code: "custom",
        path: ["set"],
        message: "profile improvement patches may set only prompt or skill resources",
      });
    }
    const setResourceKeys = Object.keys(change.set?.resources ?? {});
    if (setResourceKeys.some((key) => key !== "skills")) {
      ctx.addIssue({
        code: "custom",
        path: ["set", "resources"],
        message: "profile improvement patches may set only skill resources",
      });
    }
    if (change.set?.resources?.skills?.some((skill) => skill.kind !== "inline")) {
      ctx.addIssue({
        code: "custom",
        path: ["set", "resources", "skills"],
        message: "measured profile skill patches require inline content with exact bytes",
      });
    }

    const removeKeys = Object.keys(change.remove ?? {});
    if (removeKeys.some((key) => key !== "prompt" && key !== "resources")) {
      ctx.addIssue({
        code: "custom",
        path: ["remove"],
        message: "profile improvement patches may remove only prompt or skill resources",
      });
    }
    if (change.remove?.resources === true) {
      ctx.addIssue({
        code: "custom",
        path: ["remove", "resources"],
        message: "profile improvement patches may not remove unrelated resources",
      });
    }
    const removeResources = change.remove?.resources;
    const removeResourceKeys = Object.keys(
      typeof removeResources === "object" ? removeResources : {},
    );
    if (removeResourceKeys.some((key) => key !== "skills")) {
      ctx.addIssue({
        code: "custom",
        path: ["remove", "resources"],
        message: "profile improvement patches may remove only skill resources",
      });
    }
  },
);

export const agentProfileImprovementChangeSchema = z
  .tuple([agentProfileImprovementChangeStepSchema])
  .rest(agentProfileImprovementChangeStepSchema)
  .superRefine((change, ctx) => {
    const surfaces = changedProfileImprovementSurfaces(change);
    if (surfaces.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "profile improvement change must alter at least one supported surface",
      });
    }
  }) satisfies z.ZodType<[AgentProfileDiff, ...AgentProfileDiff[]]>;

export const agentProfileImprovementExperimentSchema = z
  .object({
    kind: z.literal("agent-profile-improvement-experiment"),
    digestAlgorithm: z.literal("rfc8785-sha256"),
    source: agentImprovementSourceSchema,
    executionRef: agentProfileImprovementExecutionRefSchema,
    baseline: agentProfileImprovementArmSchema,
    candidate: agentProfileImprovementArmSchema,
    change: agentProfileImprovementChangeSchema,
    candidateLineage: agentCandidateLineageSchema,
    benchmark: agentProfileImprovementSuiteInputsSchema,
    policy: agentCandidateEvaluationPolicySchema,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((experiment, ctx) => {
    if (experiment.baseline.stateDigest !== experiment.source.sourceDigest) {
      ctx.addIssue({
        code: "custom",
        path: ["baseline", "stateDigest"],
        message: "profile improvement baseline must bind the exact source state",
      });
    }
    if (experiment.baseline.stateDigest === experiment.candidate.stateDigest) {
      ctx.addIssue({
        code: "custom",
        path: ["candidate", "stateDigest"],
        message: "profile improvement experiment requires a changed candidate state",
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
    if (experiment.candidateLineage.parentDigests?.includes(experiment.candidate.stateDigest)) {
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
    attempt: z.number().int().positive(),
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
  }) satisfies z.ZodType<AgentProfileImprovementRunCell>;

const timingSchema = z
  .object({
    startedAtMs: z.number().finite().nonnegative(),
    endedAtMs: z.number().finite().nonnegative(),
    durationMs: z.number().finite().nonnegative(),
  })
  .strict()
  .superRefine((timing, ctx) => {
    if (!numbersApproximatelyEqual(timing.durationMs, timing.endedAtMs - timing.startedAtMs)) {
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
    executionRef: agentProfileImprovementExecutionRefSchema,
    runCell: agentProfileImprovementRunCellSchema,
    runRecord: profileImprovementEvidenceSchema,
    billing: z
      .tuple([profileImprovementEvidenceSchema])
      .rest(profileImprovementEvidenceSchema),
    timing: timingSchema,
    steps: z.number().int().nonnegative().safe(),
    resolvedModel: agentCandidateResolvedModelSchema,
    limits: agentCandidateExecutionLimitsSchema,
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
    if (receipt.trace.modelCallCount !== receipt.usage.modelCalls) {
      ctx.addIssue({
        code: "custom",
        path: ["trace", "modelCallCount"],
        message: "profile trace model calls must equal settled execution model calls",
      });
    }
    if (receipt.trace.eventCount < receipt.trace.modelCallCount) {
      ctx.addIssue({
        code: "custom",
        path: ["trace", "eventCount"],
        message: "profile trace must retain at least one event for every model call",
      });
    }
    refineAgentExecutionWithinLimits(
      receipt.limits,
      {
        durationMs: receipt.timing.durationMs,
        steps: receipt.steps,
        usage: combinedProfileUsage(receipt.usage, receipt.grading.usage),
      },
      ctx,
    );
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

function combinedProfileUsage(
  execution: AgentCandidateFixedSpend,
  grading: AgentCandidateFixedSpend,
): AgentCandidateFixedSpend {
  return {
    inputTokens: execution.inputTokens + grading.inputTokens,
    outputTokens: execution.outputTokens + grading.outputTokens,
    cachedInputTokens: execution.cachedInputTokens + grading.cachedInputTokens,
    reasoningTokens: execution.reasoningTokens + grading.reasoningTokens,
    modelCalls: execution.modelCalls + grading.modelCalls,
    costUsdNanos: execution.costUsdNanos + grading.costUsdNanos,
    costProvenance:
      execution.costProvenance === "observed" && grading.costProvenance === "observed"
        ? "observed"
        : "estimated",
  };
}

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

export function changedProfileImprovementSurfaces(
  change: readonly AgentProfileDiff[],
): string[] {
  const surfaces = new Set<string>();
  for (const step of change) {
    if (step.set?.prompt !== undefined || step.remove?.prompt !== undefined) {
      surfaces.add("prompt");
    }
    if (
      step.set?.resources?.skills !== undefined ||
      (typeof step.remove?.resources === "object" &&
        step.remove.resources.skills !== undefined)
    ) {
      surfaces.add("skills");
    }
  }
  return [...surfaces].sort();
}

function refineProfileImprovementComparison(
  comparison: AgentProfileImprovementMeasuredComparison,
  ctx: z.RefinementCtx,
): void {
  const { suite, tasks } = comparison.experiment.benchmark;
  const expectedN = tasks.length * suite.reps;
  if (
    comparison.provenance.baselineContentHash !== comparison.experiment.baseline.stateDigest ||
    comparison.provenance.candidateContentHash !== comparison.experiment.candidate.stateDigest
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["provenance"],
      message: "profile comparison provenance must bind both complete measured states",
    });
  }
  if (comparison.measurements.length !== expectedN) {
    ctx.addIssue({
      code: "custom",
      path: ["measurements"],
      message: "profile comparison must contain every signed benchmark cell",
    });
  }

  const recordProfileIdentities = createMeasuredComparisonIdentityRegistry({
    ctx,
    identityLabel: "profile measurements",
  });
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
            JSON.stringify(receipt.executionRef) === JSON.stringify(comparison.experiment.executionRef),
            [...armPath, "executionRef"],
            "profile run receipt must bind the measured executor",
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
              cell.seed === seed &&
              cell.attempt === 1,
            [...armPath, "runCell"],
            "publishable profile evidence must use the first signed task attempt",
          ],
          [
            JSON.stringify(receipt.grading.grader) === JSON.stringify(task.grader),
            [...armPath, "grading", "grader"],
            "profile run receipt must bind the signed evaluator",
          ],
          [
            JSON.stringify(receipt.resolvedModel) === JSON.stringify(task.model),
            [...armPath, "resolvedModel"],
            "profile run receipt must bind the signed model snapshot",
          ],
          [
            JSON.stringify(receipt.limits) === JSON.stringify(task.limits),
            [...armPath, "limits"],
            "profile run receipt must bind the signed execution limits",
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
        recordProfileIdentities(
          [
            { kind: "execution", value: receipt.executionId },
            { kind: "runCell", value: cell.digest },
            { kind: "receipt", value: receipt.digest },
            { kind: "runRecord", value: evidenceKey(receipt.runRecord) },
            ...receipt.billing.map((billing) => ({
              kind: "billing",
              value: evidenceKey(billing),
              path: [...armPath, "billing"],
            })),
          ],
          armPath,
        );
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

  refineMeasuredComparisonSummary(
    comparison,
    comparison.experiment.policy,
    expectedN,
    comparison.measurements,
    {
      score: (receipt) => receipt.grading.score,
      dimension: (receipt, name) =>
        receipt.grading.dimensions.find((dimension) => dimension.name === name)?.score,
      cost: profileImprovementExecutionCostUsd,
      costProvenance: profileImprovementExecutionCostProvenance,
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

function profileImprovementExecutionCostProvenance(
  receipt: AgentProfileImprovementRunReceipt,
): "observed" | "estimated" {
  return receipt.usage.costProvenance === "observed" &&
    receipt.grading.usage.costProvenance === "observed"
    ? "observed"
    : "estimated";
}

function profileImprovementExecutionLatencyMs(receipt: AgentProfileImprovementRunReceipt): number {
  return receipt.timing.durationMs + receipt.grading.timing.durationMs;
}
