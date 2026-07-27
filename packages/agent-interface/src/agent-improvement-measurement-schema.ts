import { z } from "zod";
import type {
  AgentCandidateCostProvenance,
  AgentCandidateEvaluationPolicy,
  AgentCandidateJsonValue,
  AgentImprovementEvaluationAccounting,
  AgentImprovementMeasuredComparisonBase,
} from "./agent-candidate.js";
import { isCanonicalJsonValue, sha256DigestSchema } from "./agent-candidate-schema-common.js";
import { numbersApproximatelyEqual } from "./number-validation.js";

export const canonicalJsonSchema = z.custom<AgentCandidateJsonValue>(
  isCanonicalJsonValue,
  "value must be finite, acyclic RFC 8785 JSON",
);

export const canonicalJsonObjectSchema = z
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

export const agentImprovementCostSchema = z
  .object({
    usd: z.number().finite().nonnegative(),
    provenance: z.enum(["observed", "estimated"]),
  })
  .strict();

const agentImprovementEvaluationSchema = z
  .object({
    generationsExplored: z.number().int().nonnegative(),
    preparation: z
      .object({
        wallDurationMs: z.number().finite().nonnegative(),
        cost: agentImprovementCostSchema,
      })
      .strict(),
    measurement: z
      .object({
        wallDurationMs: z.number().finite().nonnegative(),
        workDurationMs: z.number().finite().nonnegative(),
        cost: agentImprovementCostSchema,
      })
      .strict(),
    total: z
      .object({
        wallDurationMs: z.number().finite().nonnegative(),
        cost: agentImprovementCostSchema,
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<AgentImprovementEvaluationAccounting>;

export const measuredComparisonCommonShape = {
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
  evaluation: agentImprovementEvaluationSchema,
  metadata: canonicalJsonObjectSchema.optional(),
};

type MeasuredComparison = Pick<
  AgentImprovementMeasuredComparisonBase<unknown, unknown, string>,
  "overall" | "objectives" | "power" | "evaluation"
>;

interface MeasuredComparisonIdentity {
  kind: string;
  value: string;
  path?: (string | number)[];
}

/** Keep receipt identity reuse rules identical across measured source formats. */
export function createMeasuredComparisonIdentityRegistry(options: {
  ctx: z.RefinementCtx;
  identityLabel: string;
}): (
  identities: readonly MeasuredComparisonIdentity[],
  fallbackPath: (string | number)[],
) => void {
  const seen = new Map<string, Set<string>>();
  return (identities, fallbackPath) => {
    for (const identity of identities) {
      const used = seen.get(identity.kind) ?? new Set<string>();
      if (used.has(identity.value)) {
        options.ctx.addIssue({
          code: "custom",
          path: identity.path ?? fallbackPath,
          message: `${options.identityLabel} must not reuse ${identity.kind} identity`,
        });
      }
      used.add(identity.value);
      seen.set(identity.kind, used);
    }
  };
}

export function refineMeasuredComparisonSummary<TReceipt>(
  comparison: MeasuredComparison,
  policy: Pick<AgentCandidateEvaluationPolicy, "confidenceLevel" | "resamples">,
  expectedN: number,
  measurements: readonly { baseline: TReceipt; candidate: TReceipt }[],
  values: {
    score(receipt: TReceipt): number;
    dimension(receipt: TReceipt, name: string): number | undefined;
    cost(receipt: TReceipt): number;
    costProvenance(receipt: TReceipt): AgentCandidateCostProvenance;
    latency(receipt: TReceipt): number;
  },
  ctx: z.RefinementCtx,
): void {
  refineEstimate(comparison.overall, ["overall"], ctx);
  const totalCostProvenance: AgentCandidateCostProvenance =
    comparison.evaluation.preparation.cost.provenance === "observed" &&
    comparison.evaluation.measurement.cost.provenance === "observed"
      ? "observed"
      : "estimated";
  if (
    !numbersApproximatelyEqual(
      comparison.evaluation.total.wallDurationMs,
      comparison.evaluation.preparation.wallDurationMs +
        comparison.evaluation.measurement.wallDurationMs,
    ) ||
    !numbersApproximatelyEqual(
      comparison.evaluation.total.cost.usd,
      comparison.evaluation.preparation.cost.usd + comparison.evaluation.measurement.cost.usd,
    ) ||
    comparison.evaluation.total.cost.provenance !== totalCostProvenance
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["evaluation"],
      message: "evaluation totals must equal preparation and measurement accounting",
    });
  }
  if (comparison.overall.n !== expectedN) {
    ctx.addIssue({
      code: "custom",
      path: ["overall", "n"],
      message: "measured sample count must equal the complete benchmark suite",
    });
  }
  if (measurements.length > 0) {
    refineMeasuredMean(
      comparison.overall.baseline,
      measurements.map((measurement) => values.score(measurement.baseline)),
      ["overall", "baseline"],
      ctx,
    );
    refineMeasuredMean(
      comparison.overall.candidate,
      measurements.map((measurement) => values.score(measurement.candidate)),
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
      if (measurements.length > 0) {
        const extractor =
          objective.kind === "objective"
            ? values.score
            : objective.kind === "dimension"
              ? (receipt: TReceipt) => values.dimension(receipt, objective.name)
              : objective.kind === "cost"
                ? values.cost
                : values.latency;
        const baseline = measurements.map((measurement) => extractor(measurement.baseline));
        const candidate = measurements.map((measurement) => extractor(measurement.candidate));
        const baselineValues = baseline.filter((value): value is number => value !== undefined);
        const candidateValues = candidate.filter((value): value is number => value !== undefined);
        if (
          baselineValues.length !== baseline.length ||
          candidateValues.length !== candidate.length
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["objectives", index, "name"],
            message: "every signed receipt must include each measured dimension",
          });
        } else {
          refineMeasuredMean(
            objective.baseline,
            baselineValues,
            ["objectives", index, "baseline"],
            ctx,
          );
          refineMeasuredMean(
            objective.candidate,
            candidateValues,
            ["objectives", index, "candidate"],
            ctx,
          );
        }
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
  const measurementCostUsd = measurements.reduce(
    (sum, measurement) => sum + values.cost(measurement.baseline) + values.cost(measurement.candidate),
    0,
  );
  const measurementWorkDurationMs = measurements.reduce(
    (sum, measurement) =>
      sum + values.latency(measurement.baseline) + values.latency(measurement.candidate),
    0,
  );
  const measurementCostProvenance: AgentCandidateCostProvenance = measurements.every(
    (measurement) =>
      values.costProvenance(measurement.baseline) === "observed" &&
      values.costProvenance(measurement.candidate) === "observed",
  )
    ? "observed"
    : "estimated";
  if (
    !numbersApproximatelyEqual(comparison.evaluation.measurement.cost.usd, measurementCostUsd) ||
    comparison.evaluation.measurement.cost.provenance !== measurementCostProvenance ||
    !numbersApproximatelyEqual(
      comparison.evaluation.measurement.workDurationMs,
      measurementWorkDurationMs,
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["evaluation", "measurement"],
      message: "measurement accounting must equal the complete signed receipts",
    });
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
  if (comparison.power.n !== expectedN) {
    ctx.addIssue({
      code: "custom",
      path: ["power", "n"],
      message: "power analysis must use the paired held-out sample",
    });
  }
  if (
    comparison.overall.confidenceInterval.level !== policy.confidenceLevel ||
    comparison.overall.confidenceInterval.resamples !== policy.resamples ||
    comparison.power.confidenceLevel !== policy.confidenceLevel
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
      (objective.confidenceInterval.level !== policy.confidenceLevel ||
        objective.confidenceInterval.resamples !== policy.resamples)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["objectives", index, "confidenceInterval"],
        message: "objective uncertainty must use the frozen evaluation policy",
      });
    }
  }
}

export function refineEstimate(
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
