import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentCandidateExecutionLimits } from "./agent-candidate.js";
import {
  refineAgentExecutionWithinLimits,
  type AgentExecutionLimitObservation,
} from "./agent-execution-limits.js";

const limits = {
  timeoutMs: 100,
  maxSteps: 3,
  maxModelCalls: 2,
  maxInputTokens: 10,
  maxOutputTokens: 8,
  maxTotalTokens: 18,
  maxCostUsd: 0.000000005,
};

function observation() {
  return {
    durationMs: 100,
    steps: 3,
    usage: {
      inputTokens: 10,
      outputTokens: 8,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      modelCalls: 2,
      costUsdNanos: 5,
      costProvenance: "observed" as const,
    },
  };
}

type ObservationOverride = Partial<
  Omit<AgentExecutionLimitObservation, "usage">
> & {
  usage?: Partial<AgentExecutionLimitObservation["usage"]>;
};

const overLimitCases: [string, ObservationOverride][] = [
  ["durationMs", { durationMs: 101 }],
  ["steps", { steps: 4 }],
  ["modelCalls", { usage: { modelCalls: 3 } }],
  ["inputTokens", { usage: { inputTokens: 11 } }],
  ["outputTokens", { usage: { outputTokens: 9 } }],
  ["totalTokens", { usage: { inputTokens: 10, outputTokens: 9 } }],
  ["costUsd", { usage: { costUsdNanos: 6 } }],
];

/** The issue messages a receipt schema reports for this execution. */
function violations(
  frozen: AgentCandidateExecutionLimits,
  facts: AgentExecutionLimitObservation,
): string {
  const result = z
    .unknown()
    .superRefine((_value, ctx) =>
      refineAgentExecutionWithinLimits(frozen, facts, ctx),
    )
    .safeParse(null);
  return result.success
    ? ""
    : result.error.issues.map((issue) => issue.message).join("; ");
}

describe("execution limits", () => {
  it("accepts execution facts exactly at every frozen limit", () => {
    expect(violations(limits, observation())).toBe("");
  });

  it("accepts an exact nanodollar limit despite binary floating-point rounding", () => {
    const current = observation();
    expect(
      violations(
        { ...limits, maxCostUsd: 0.000000015 },
        { ...current, usage: { ...current.usage, costUsdNanos: 15 } },
      ),
    ).toBe("");
  });

  it("does not round a fractional nanodollar limit up", () => {
    const current = observation();
    expect(
      violations(
        { ...limits, maxCostUsd: 0.0000000146 },
        { ...current, usage: { ...current.usage, costUsdNanos: 15 } },
      ),
    ).toContain("costUsd");
  });

  it("rejects an aggregate overflow even when each token channel fits", () => {
    const current = observation();
    expect(
      violations(
        { ...limits, maxTotalTokens: 17 },
        current,
      ),
    ).toContain("totalTokens");
  });

  it("does not require an aggregate limit for older limit records", () => {
    const { maxTotalTokens: _maxTotalTokens, ...legacyLimits } = limits;
    expect(violations(legacyLimits, observation())).toBe("");
  });

  it.each(overLimitCases)(
    "rejects %s above its frozen limit",
    (label, override) => {
      const current = observation();
      const candidate = {
        ...current,
        ...override,
        usage: { ...current.usage, ...(override.usage ?? {}) },
      };

      expect(violations(limits, candidate)).toContain(label);
    },
  );
});
