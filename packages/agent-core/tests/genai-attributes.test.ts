import { describe, expect, it } from "vitest";
import {
  GEN_AI_INPUT_TOKEN_KEYS,
  GEN_AI_MODEL_KEYS,
  GEN_AI_OUTPUT_TOKEN_KEYS,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  genAiUsageAttributes,
  readTokenCostUsd,
  readTokenUsage,
  TOKEN_USAGE_COST_KEYS,
  TOKEN_USAGE_INPUT_KEYS,
  TOKEN_USAGE_OUTPUT_KEYS,
} from "../src/index.js";

describe("genAiUsageAttributes", () => {
  it("emits the canonical keys for a full usage record", () => {
    expect(
      genAiUsageAttributes({
        model: "claude-opus-4-1",
        inputTokens: 1200,
        outputTokens: 340,
      }),
    ).toEqual({
      "gen_ai.request.model": "claude-opus-4-1",
      "gen_ai.usage.input_tokens": 1200,
      "gen_ai.usage.output_tokens": 340,
    });
  });

  it("omits every unknown field rather than synthesizing a zero/empty", () => {
    expect(genAiUsageAttributes({})).toEqual({});
    expect(genAiUsageAttributes({ model: "" })).toEqual({});
    expect(genAiUsageAttributes({ inputTokens: 10 })).toEqual({
      "gen_ai.usage.input_tokens": 10,
    });
  });

  it("accepts a zero token count but rejects negative / non-finite", () => {
    expect(genAiUsageAttributes({ inputTokens: 0, outputTokens: 0 })).toEqual({
      "gen_ai.usage.input_tokens": 0,
      "gen_ai.usage.output_tokens": 0,
    });
    expect(
      genAiUsageAttributes({
        inputTokens: -1,
        outputTokens: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({});
    expect(genAiUsageAttributes({ inputTokens: Number.NaN })).toEqual({});
  });

  it("the writer's primary key is always the reader candidate lists' first entry (drift guard)", () => {
    expect(GEN_AI_MODEL_KEYS[0]).toBe(GEN_AI_REQUEST_MODEL);
    expect(GEN_AI_INPUT_TOKEN_KEYS[0]).toBe(GEN_AI_USAGE_INPUT_TOKENS);
    expect(GEN_AI_OUTPUT_TOKEN_KEYS[0]).toBe(GEN_AI_USAGE_OUTPUT_TOKENS);
  });
});

describe("tokenUsage field-name vocabulary", () => {
  it("pins the producer field-name candidates and their priority order", () => {
    // Order matters: readers return the first matching key, so a reorder is a
    // behavior change and must fail here.
    expect(TOKEN_USAGE_INPUT_KEYS).toEqual([
      "inputTokens",
      "input",
      "input_tokens",
      "promptTokens",
      "prompt_tokens",
    ]);
    expect(TOKEN_USAGE_OUTPUT_KEYS).toEqual([
      "outputTokens",
      "output",
      "output_tokens",
      "completionTokens",
      "completion_tokens",
    ]);
    expect(TOKEN_USAGE_COST_KEYS).toEqual([
      "totalCostUsd",
      "costUsd",
      "total_cost_usd",
      "cost_usd",
      "cost",
    ]);
  });

  it("freezes the arrays so the shared vocabulary cannot be mutated", () => {
    expect(Object.isFrozen(TOKEN_USAGE_INPUT_KEYS)).toBe(true);
    expect(Object.isFrozen(TOKEN_USAGE_OUTPUT_KEYS)).toBe(true);
    expect(Object.isFrozen(TOKEN_USAGE_COST_KEYS)).toBe(true);
  });

  it("normalizes terminal event usage and cost shapes", () => {
    expect(
      readTokenUsage({
        tokenUsage: { prompt_tokens: "12", completion_tokens: 3.8 },
      }),
    ).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(readTokenCostUsd({ totalCostUsd: "0.0125" })).toBe(0.0125);
    expect(readTokenCostUsd({ tokenUsage: { cost_usd: 0.004 } })).toBe(0.004);
  });
});
