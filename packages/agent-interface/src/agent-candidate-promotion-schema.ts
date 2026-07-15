import { z } from "zod";
import type {
  AgentCandidateJsonValue,
  AgentImprovementMeasuredComparison,
  AgentImprovementProposal,
  AgentImprovementReview,
  CandidateExecutionEvidence,
} from "./agent-candidate.js";
import { agentCandidateBundleSchema } from "./agent-candidate-schema.js";
import { agentCandidateProfileActivationSchema } from "./agent-candidate-execution-plan-schema.js";
import {
  isCanonicalJsonValue,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import {
  agentCandidateMaterializationReceiptSchema,
  agentCandidateRunReceiptSchema,
} from "./agent-candidate-receipt-schema.js";
import { agentProfileSchema } from "./profile-schema.js";

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
  unavailableObjectiveVariant(costObjectiveFields),
  measuredObjectiveVariant(latencyObjectiveFields),
  unavailableObjectiveVariant(latencyObjectiveFields),
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

export const agentImprovementMeasuredComparisonSchema = z
  .object({
    kind: z.literal("agent-improvement-measured-comparison"),
    benchmark: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        splitDigest: sha256DigestSchema,
      })
      .strict(),
    baselineProfileDigest: sha256DigestSchema,
    candidateBundleDigest: sha256DigestSchema,
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
        durationMs: z.number().finite().nonnegative(),
        totalCostUsd: z.number().finite().nonnegative(),
      })
      .strict(),
    metadata: canonicalJsonObjectSchema.optional(),
  })
  .strict()
  .superRefine((comparison, ctx) => {
    refineEstimate(comparison.overall, ["overall"], ctx);
    const identities = new Set<string>();
    const qualityObjectives = new Set<string>();
    const dimensionParents: Array<{ index: number; objective: string }> = [];
    let costCount = 0;
    let latencyCount = 0;
    for (const [index, objective] of comparison.objectives.entries()) {
      if (objective.availability === "measured") {
        refineEstimate(objective, ["objectives", index], ctx);
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
    baselineProfile: agentProfileSchema,
    findings: z.array(canonicalJsonObjectSchema),
    evaluation: agentImprovementMeasuredComparisonSchema,
    candidateBundle: agentCandidateBundleSchema,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((proposal, ctx) => {
    const measuredBenchmark = proposal.evaluation.benchmark;
    const bundleBenchmark = proposal.candidateBundle.lineage.benchmark;
    if (
      !bundleBenchmark ||
      measuredBenchmark.name !== bundleBenchmark.name ||
      measuredBenchmark.version !== bundleBenchmark.version ||
      measuredBenchmark.splitDigest !== bundleBenchmark.splitDigest
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["evaluation", "benchmark"],
        message: "measured comparison must bind the candidate development split",
      });
    }
    if (proposal.evaluation.candidateBundleDigest !== proposal.candidateBundle.digest) {
      ctx.addIssue({
        code: "custom",
        path: ["evaluation", "candidateBundleDigest"],
        message: "measured comparison must bind the exact candidate bundle",
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

export const agentImprovementReviewSchema = z
  .object({
    kind: z.literal("agent-improvement-review"),
    proposalDigest: sha256DigestSchema,
    candidateBundleDigest: sha256DigestSchema,
    decision: z.enum(["approve", "reject", "request-changes"]),
    reviewedBy: z.string().min(1),
    reviewedAt: z.iso.datetime(),
    reason: z.string().min(1),
    feedback: z.string().optional(),
    digest: sha256DigestSchema,
  })
  .strict()
  .refine(isCanonicalJsonValue, "review must contain only RFC 8785 JSON values") satisfies z.ZodType<AgentImprovementReview>;

export const candidateExecutionEvidenceSchema = z
  .object({
    kind: z.literal("agent-candidate-execution-evidence"),
    proposalDigest: sha256DigestSchema,
    reviewDigest: sha256DigestSchema,
    executionId: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
    succeeded: z.literal(true),
    materializationReceipt: agentCandidateMaterializationReceiptSchema,
    profileActivation: agentCandidateProfileActivationSchema,
    receipt: agentCandidateRunReceiptSchema,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((evidence, ctx) => {
    const materialization = evidence.materializationReceipt;
    const plan = materialization.executionPlan;
    const plannedOutcome = plan.material.task.outcome;
    const capturedOutcome = evidence.receipt.taskOutcome.material.outcome;
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
        evidence.executionId === plan.material.executionId,
        ["executionId"],
        "execution evidence must bind the materialized execution id",
      ],
      [
        evidence.profileActivation.profilePlan.digest ===
          materialization.profilePlan.digest,
        ["profileActivation", "profilePlan", "digest"],
        "profile activation must bind the materialized profile plan",
      ],
      [
        capturedOutcome.kind === plannedOutcome.kind,
        ["receipt", "taskOutcome", "material", "outcome", "kind"],
        "task outcome kind must match the signed execution plan",
      ],
      [
        evidence.receipt.termination.kind === "exit" &&
          evidence.receipt.termination.exitCode === 0,
        ["receipt", "termination"],
        "successful execution evidence requires a zero exit status",
      ],
    ];
    if (plannedOutcome.kind === "output" && capturedOutcome.kind === "output") {
      checks.push([
        capturedOutcome.spec.mediaType === plannedOutcome.mediaType &&
          capturedOutcome.spec.maxBytes === plannedOutcome.maxBytes,
        ["receipt", "taskOutcome", "material", "outcome", "spec"],
        "task output constraints must match the signed execution plan",
      ]);
    }
    if (
      plannedOutcome.kind === "workspace" &&
      capturedOutcome.kind === "workspace" &&
      plan.material.task.repository
    ) {
      const repository = plan.material.task.repository;
      const base = capturedOutcome.baseRepository;
      checks.push([
        base.identity === repository.identity &&
          base.rootIdentity === repository.rootIdentity &&
          base.commit === repository.baseCommit &&
          base.tree === repository.baseTree,
        ["receipt", "taskOutcome", "material", "outcome", "baseRepository"],
        "workspace outcome must bind the signed repository base",
      ]);
    }
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
