import { describe, expect, it } from "vitest";
import { AgentExecutionError } from "./execution-failure.js";

describe("AgentExecutionError", () => {
  it("preserves observed usage without making the failed execution successful", () => {
    const error = new AgentExecutionError("tool permission denied", {
      tokenUsage: { inputTokens: 19965, outputTokens: 747, cacheReadInputTokens: 29696 },
      timing: { startedAt: 100, completedAt: 300, durationMs: 200 },
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("tool permission denied");
    expect(error.receipt.tokenUsage).toEqual({
      inputTokens: 19965, outputTokens: 747, cacheReadInputTokens: 29696,
    });
    expect(error.receipt).not.toHaveProperty("outcome");
    expect(error.receipt.tokenUsage).not.toHaveProperty("cost");
  });

  it("snapshots and freezes failure accounting before handing it to callers", () => {
    const tokenUsage = { inputTokens: 12 };
    const error = new AgentExecutionError("interrupted", { tokenUsage });
    tokenUsage.inputTokens = 99;
    expect(error.receipt.tokenUsage).toEqual({ inputTokens: 12 });
    expect(Object.isFrozen(error.receipt)).toBe(true);
    expect(Object.isFrozen(error.receipt.tokenUsage)).toBe(true);
  });

  it("does not invent usage for a failure before inference", () => {
    const cause = new Error("ENOENT");
    const error = new AgentExecutionError("could not start", {}, { cause });
    expect(error.receipt).toEqual({});
    expect(error.cause).toBe(cause);
  });

  it.each([-1, NaN, Infinity, 1.5])("rejects invalid observed token counts: %s", (inputTokens) => {
    expect(() => new AgentExecutionError("failed", { tokenUsage: { inputTokens } })).toThrow();
  });
});
