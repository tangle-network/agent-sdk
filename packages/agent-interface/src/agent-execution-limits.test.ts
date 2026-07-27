import { describe, expect, it } from "vitest";
import {
  assertAgentExecutionWithinLimits,
  type AgentExecutionLimitObservation,
} from "./agent-execution-limits.js";

const limits = {
  timeoutMs: 100,
  maxSteps: 3,
  maxModelCalls: 2,
  maxInputTokens: 10,
  maxOutputTokens: 8,
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
  ["costUsd", { usage: { costUsdNanos: 6 } }],
];

describe("execution limits", () => {
  it("accepts execution facts exactly at every frozen limit", () => {
    expect(() => assertAgentExecutionWithinLimits(limits, observation())).not.toThrow();
  });

  it("accepts an exact nanodollar limit despite binary floating-point rounding", () => {
    const current = observation();
    expect(() =>
      assertAgentExecutionWithinLimits(
        { ...limits, maxCostUsd: 0.000000015 },
        { ...current, usage: { ...current.usage, costUsdNanos: 15 } },
      ),
    ).not.toThrow();
  });

  it("does not round a fractional nanodollar limit up", () => {
    const current = observation();
    expect(() =>
      assertAgentExecutionWithinLimits(
        { ...limits, maxCostUsd: 0.0000000146 },
        { ...current, usage: { ...current.usage, costUsdNanos: 15 } },
      ),
    ).toThrow("costUsd");
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

      expect(() => assertAgentExecutionWithinLimits(limits, candidate)).toThrow(label);
    },
  );
});
