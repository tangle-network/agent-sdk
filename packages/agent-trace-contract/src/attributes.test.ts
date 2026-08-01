import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ATTR,
  attributeBag,
  BRANCH_ATTR_KEYS,
  COST_ATTR_KEYS,
  firstNumberAttr,
  firstStringAttr,
  INPUT_TOKEN_ATTR_KEYS,
  ITERATION_ATTR_KEYS,
  LINK_KIND_ATTR,
  LINK_KINDS,
  MODEL_ATTR_KEYS,
  OUTPUT_TOKEN_ATTR_KEYS,
  SPAN_KIND_ATTR_KEYS,
  TOOL_NAME_ATTR_KEYS,
} from "./attributes.js";
import {
  OUTCOMES,
  SPAN_KINDS,
  SPAN_STATUS_CODES,
  TRACE_CONTRACT_VERSION,
} from "./span.js";

describe("attribute vocabulary", () => {
  it("pins every primary key", () => {
    // These strings ARE the contract. A rename here silently breaks every
    // producer and consumer already emitting or reading them, so it must be a
    // deliberate edit to this test and a TRACE_CONTRACT_VERSION bump.
    expect(ATTR).toEqual({
      spanKind: "openinference.span.kind",
      model: "gen_ai.request.model",
      system: "gen_ai.system",
      inputTokens: "gen_ai.usage.input_tokens",
      outputTokens: "gen_ai.usage.output_tokens",
      costUsd: "gen_ai.usage.cost_usd",
      toolName: "gen_ai.tool.name",
      loopId: "agent.loop.id",
      iteration: "agent.loop.iteration",
      maxIterations: "agent.loop.max_iterations",
      resumed: "agent.loop.resumed",
      branchId: "agent.branch.id",
      branchParent: "agent.branch.parent_id",
      branchArm: "agent.branch.arm",
      outcome: "agent.outcome",
      score: "agent.outcome.score",
    });
    expect(LINK_KIND_ATTR).toBe("agent.link.kind");
  });

  it("ranks the contract's own key first in every reader list", () => {
    // Priority order decides which value wins when a span carries two spellings,
    // so a reorder is a behaviour change, not a cosmetic one.
    expect(SPAN_KIND_ATTR_KEYS[0]).toBe(ATTR.spanKind);
    expect(MODEL_ATTR_KEYS[0]).toBe(ATTR.model);
    expect(INPUT_TOKEN_ATTR_KEYS[0]).toBe(ATTR.inputTokens);
    expect(OUTPUT_TOKEN_ATTR_KEYS[0]).toBe(ATTR.outputTokens);
    expect(COST_ATTR_KEYS[0]).toBe(ATTR.costUsd);
    expect(TOOL_NAME_ATTR_KEYS[0]).toBe(ATTR.toolName);
    expect(ITERATION_ATTR_KEYS).toEqual([ATTR.iteration]);
    expect(BRANCH_ATTR_KEYS).toEqual([ATTR.branchId, ATTR.branchArm]);
  });

  it("accepts the spellings agent-eval and agent-core already read", () => {
    // Cross-package compatibility: agent-eval's LLM_MODEL_ATTR_KEYS,
    // LLM_*_TOKEN_ATTR_KEYS, LLM_COST_ATTR_KEYS and TOOL_NAME_ATTR_KEYS, plus
    // agent-core/telemetry's GEN_AI_* candidates. If this list shrinks, traces
    // those packages emit stop yielding numbers here.
    expect(MODEL_ATTR_KEYS).toContain("llm.model_name");
    expect(MODEL_ATTR_KEYS).toContain("gen_ai.response.model");
    expect(MODEL_ATTR_KEYS).toContain("model");
    expect(INPUT_TOKEN_ATTR_KEYS).toContain("llm.token_count.prompt");
    expect(INPUT_TOKEN_ATTR_KEYS).toContain("gen_ai.usage.prompt_tokens");
    expect(OUTPUT_TOKEN_ATTR_KEYS).toContain("llm.token_count.completion");
    expect(OUTPUT_TOKEN_ATTR_KEYS).toContain("gen_ai.usage.completion_tokens");
    expect(COST_ATTR_KEYS).toContain("llm.cost_usd");
    expect(TOOL_NAME_ATTR_KEYS).toContain("tool.name");
    expect(SPAN_KIND_ATTR_KEYS).toContain("inference.observation_kind");
  });

  it("does not accept a bare cost key", () => {
    // Deliberate divergence from agent-eval: presence of a cost key is what
    // makes this package claim a trace is costable, and `cost` is too generic
    // to carry that claim.
    expect(COST_ATTR_KEYS).not.toContain("cost");
  });
});

describe("wire vocabulary", () => {
  it("pins every enumerated value a consumer validates against", () => {
    // Each of these is the runtime companion to a string union, so a downstream
    // validator can check a foreign trace's values without duplicating the list.
    expect(SPAN_KINDS).toEqual([
      "AGENT",
      "CHAIN",
      "LLM",
      "TOOL",
      "EVALUATOR",
      "RETRIEVER",
      "UNKNOWN",
    ]);
    expect(SPAN_STATUS_CODES).toEqual([
      "STATUS_CODE_UNSET",
      "STATUS_CODE_OK",
      "STATUS_CODE_ERROR",
    ]);
    expect(OUTCOMES).toEqual(["pass", "fail", "error"]);
    expect(LINK_KINDS).toEqual(["steered_by", "graded_by", "retry_of"]);
  });

  it("keeps the contract version equal to the published package version", () => {
    // A consumer reads TRACE_CONTRACT_VERSION off an installed build to learn
    // WHICH release produced its spans, so a constant that names a version npm
    // never published is a wrong answer to that question, not a stale one.
    // Bumping package.json without this constant fails here, by design.
    const manifest: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const version = (manifest as { version: string }).version;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(TRACE_CONTRACT_VERSION).toBe(version);
  });

  it("freezes the vocabulary against accidental mutation by a consumer", () => {
    expect(Object.isFrozen(ATTR)).toBe(true);
    expect(Object.isFrozen(SPAN_KINDS)).toBe(true);
    expect(Object.isFrozen(MODEL_ATTR_KEYS)).toBe(true);
    expect(Object.isFrozen(OUTCOMES)).toBe(true);
  });
});

describe("attribute readers", () => {
  it("turns any non-object attributes field into an empty bag", () => {
    expect(attributeBag(null)).toEqual({});
    expect(attributeBag(undefined)).toEqual({});
    expect(attributeBag("nope")).toEqual({});
    expect(attributeBag([1, 2])).toEqual({});
    expect(attributeBag({ a: 1 })).toEqual({ a: 1 });
  });

  it("reads the first non-empty string across candidates", () => {
    expect(firstStringAttr({ b: "second" }, ["a", "b"])).toBe("second");
    expect(firstStringAttr({ a: "", b: "second" }, ["a", "b"])).toBe("second");
    expect(firstStringAttr({ a: 7 }, ["a"])).toBeUndefined();
    expect(firstStringAttr({}, ["a"])).toBeUndefined();
  });

  it("reads the first finite number, tolerating numeric strings", () => {
    expect(firstNumberAttr({ a: 12 }, ["a"])).toBe(12);
    expect(firstNumberAttr({ a: "12" }, ["a"])).toBe(12);
    expect(firstNumberAttr({ a: 0 }, ["a"])).toBe(0);
    expect(firstNumberAttr({ a: Number.NaN, b: 3 }, ["a", "b"])).toBe(3);
    expect(firstNumberAttr({ a: Number.POSITIVE_INFINITY }, ["a"])).toBeUndefined();
    expect(firstNumberAttr({ a: "  " }, ["a"])).toBeUndefined();
    expect(firstNumberAttr({ a: "abc" }, ["a"])).toBeUndefined();
  });
});
