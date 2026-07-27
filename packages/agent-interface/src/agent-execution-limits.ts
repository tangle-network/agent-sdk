import { z } from "zod";
import type {
  AgentCandidateExecutionLimits,
  AgentCandidateFixedSpend,
} from "./agent-candidate.js";
import { agentCandidateExecutionLimitsSchema } from "./agent-candidate-execution-plan-schema.js";
import { agentCandidateFixedSpendSchema } from "./agent-candidate-outcome-schema.js";

/** The observable execution facts required to prove a frozen limit was respected. */
export interface AgentExecutionLimitObservation {
  durationMs: number;
  steps: number;
  usage: AgentCandidateFixedSpend;
}

export const agentExecutionLimitObservationSchema = z
  .object({
    durationMs: z.number().finite().nonnegative(),
    steps: z.number().int().nonnegative().safe(),
    usage: agentCandidateFixedSpendSchema,
  })
  .strict() satisfies z.ZodType<AgentExecutionLimitObservation>;

export interface RefineAgentExecutionWithinLimitsOptions {
  pathPrefix?: (string | number)[];
  usagePath?: (string | number)[];
}

type ExecutionLimitViolation = {
  path: (string | number)[];
  label: string;
  actual: number;
  maximum: number;
};

/** Reject an execution record that cannot satisfy every limit it claims to use. */
export function assertAgentExecutionWithinLimits(
  limits: AgentCandidateExecutionLimits,
  observation: AgentExecutionLimitObservation,
): void {
  const parsedLimits = agentCandidateExecutionLimitsSchema.parse(limits);
  const parsedObservation = agentExecutionLimitObservationSchema.parse(observation);
  const violations = executionLimitViolations(parsedLimits, parsedObservation);
  if (violations.length === 0) return;

  throw new Error(
    violations
      .map(
        (violation) =>
          `execution ${violation.label} ${violation.actual} exceeds frozen limit ${violation.maximum}`,
      )
      .join("; "),
  );
}

/** Add schema issues instead of throwing when a receipt is parsed by Zod. */
export function refineAgentExecutionWithinLimits(
  limits: AgentCandidateExecutionLimits,
  observation: AgentExecutionLimitObservation,
  ctx: z.RefinementCtx,
  options: RefineAgentExecutionWithinLimitsOptions = {},
): void {
  const pathPrefix = options.pathPrefix ?? [];
  const usagePath = options.usagePath ?? ["usage"];
  for (const violation of executionLimitViolations(limits, observation)) {
    const path =
      violation.path[0] === "usage"
        ? [...pathPrefix, ...usagePath, ...violation.path.slice(1)]
        : [...pathPrefix, ...violation.path];
    ctx.addIssue({
      code: "custom",
      path,
      message: `execution ${violation.label} ${violation.actual} exceeds frozen limit ${violation.maximum}`,
    });
  }
}

function executionLimitViolations(
  limits: AgentCandidateExecutionLimits,
  observation: AgentExecutionLimitObservation,
): ExecutionLimitViolation[] {
  const checks: ExecutionLimitViolation[] = [
    {
      path: ["timing", "durationMs"],
      label: "durationMs",
      actual: observation.durationMs,
      maximum: limits.timeoutMs,
    },
    {
      path: ["steps"],
      label: "steps",
      actual: observation.steps,
      maximum: limits.maxSteps,
    },
    {
      path: ["usage", "modelCalls"],
      label: "modelCalls",
      actual: observation.usage.modelCalls,
      maximum: limits.maxModelCalls,
    },
    {
      path: ["usage", "inputTokens"],
      label: "inputTokens",
      actual: observation.usage.inputTokens,
      maximum: limits.maxInputTokens,
    },
    {
      path: ["usage", "outputTokens"],
      label: "outputTokens",
      actual: observation.usage.outputTokens,
      maximum: limits.maxOutputTokens,
    },
    {
      path: ["usage", "costUsdNanos"],
      label: "costUsd",
      actual: observation.usage.costUsdNanos / 1_000_000_000,
      maximum: limits.maxCostUsd,
    },
  ];
  return checks.filter((check) => check.actual > check.maximum);
}
