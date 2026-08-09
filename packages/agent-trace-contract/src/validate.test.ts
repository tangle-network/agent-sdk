import { describe, expect, it } from "vitest";

import {
  ATTR,
  BRANCH_ATTR_KEYS,
  COST_ATTR_KEYS,
  firstNumberAttr,
  firstStringAttr,
  hasAttrKey,
  INPUT_TOKEN_ATTR_KEYS,
  ITERATION_ATTR_KEYS,
  MODEL_ATTR_KEYS,
  OUTPUT_TOKEN_ATTR_KEYS,
  TOOL_NAME_ATTR_KEYS,
} from "./attributes.js";
import {
  branchSpan,
  contractSpan,
  llmSpan,
  loopSpan,
  steeredBy,
  toolSpan,
} from "./builders.js";
import { resolveSpanKind } from "./classify.js";
import { deriveHexId } from "./ids.js";
import type { ContractSpan } from "./span.js";
import {
  CAPABILITY_NAMES,
  type ConformanceFinding,
  type FindingSeverity,
  MAX_SPANS_READ,
  validateTraceSpans,
} from "./validate.js";

const TRACE = deriveHexId("trace-conforming", 16);

/** The wire id for a readable one — what a conforming producer emits. */
function id(readable: string): string {
  return deriveHexId(`trace-conforming::${readable}`, 8);
}

function codes(findings: readonly ConformanceFinding[]): string[] {
  return findings.map((entry) => entry.code);
}

function capability(
  result: ReturnType<typeof validateTraceSpans>,
  name: string,
) {
  const entry = result.capabilities.find((item) => item.name === name);
  if (entry === undefined) throw new Error(`capability ${name} was not reported`);
  return entry;
}

/**
 * The tree from the README: an AGENT run, two branch arms, a two-round repair
 * loop under the first arm, and a link from round 2 back to the verdict that
 * steered it.
 */
function conformingTrace(): ContractSpan[] {
  const at = (seconds: number) =>
    new Date(Date.UTC(2026, 6, 31, 10, 0, seconds)).toISOString();
  return [
    contractSpan({
      traceId: TRACE,
      spanId: id("run"),
      name: "run",
      kind: "AGENT",
      startTime: at(0),
      endTime: at(30),
      status: { code: "STATUS_CODE_OK" },
    }),
    branchSpan({
      traceId: TRACE,
      spanId: id("cell-a"),
      parentSpanId: id("run"),
      name: "cell a",
      startTime: at(0),
      endTime: at(20),
      branchId: "a",
      arm: "with-search",
    }),
    branchSpan({
      traceId: TRACE,
      spanId: id("cell-b"),
      parentSpanId: id("run"),
      name: "cell b",
      startTime: at(0),
      endTime: at(18),
      branchId: "b",
      arm: "no-search",
    }),
    loopSpan({
      traceId: TRACE,
      spanId: id("round-1"),
      parentSpanId: id("cell-a"),
      name: "round 1",
      startTime: at(0),
      endTime: at(10),
      loopId: "repair",
      iteration: 1,
      maxIterations: 3,
      resumed: false,
    }),
    llmSpan({
      traceId: TRACE,
      spanId: id("llm-1"),
      parentSpanId: id("round-1"),
      name: "coder turn",
      startTime: at(0),
      endTime: at(6),
      model: "claude-opus-4",
      system: "anthropic",
      inputTokens: 1200,
      outputTokens: 340,
      costUsd: 0.0182,
      status: { code: "STATUS_CODE_OK" },
    }),
    toolSpan({
      traceId: TRACE,
      spanId: id("tool-1"),
      parentSpanId: id("round-1"),
      name: "tool.Bash",
      startTime: at(6),
      endTime: at(8),
      toolName: "Bash",
      status: { code: "STATUS_CODE_OK" },
    }),
    contractSpan({
      traceId: TRACE,
      spanId: id("verify-1"),
      parentSpanId: id("round-1"),
      name: "verification",
      kind: "EVALUATOR",
      startTime: at(8),
      endTime: at(10),
      outcome: "fail",
      score: 0.4,
      status: { code: "STATUS_CODE_OK" },
    }),
    loopSpan({
      traceId: TRACE,
      spanId: id("round-2"),
      parentSpanId: id("cell-a"),
      name: "round 2",
      startTime: at(10),
      endTime: at(20),
      loopId: "repair",
      iteration: 2,
      maxIterations: 3,
      resumed: true,
      links: [steeredBy(id("verify-1"), TRACE)],
    }),
    llmSpan({
      traceId: TRACE,
      spanId: id("llm-2"),
      parentSpanId: id("round-2"),
      name: "coder turn",
      startTime: at(10),
      endTime: at(16),
      model: "claude-opus-4",
      inputTokens: 1800,
      outputTokens: 210,
      costUsd: 0.0241,
      status: { code: "STATUS_CODE_OK" },
    }),
  ];
}

describe("validateTraceSpans on a conforming trace", () => {
  it("reports no findings and every capability available", () => {
    const result = validateTraceSpans(conformingTrace());
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.capabilities.map((entry) => entry.name)).toEqual([
      ...CAPABILITY_NAMES,
    ]);
    for (const entry of result.capabilities) {
      expect(entry).toEqual({ name: entry.name, available: true });
    }
  });
});

/** Deliberately hostile: every field wrong in a different way. */
function malformedSpans(): unknown[] {
  const circular: Record<string, unknown> = {
    span_id: "circular",
    trace_id: "t",
    parent_span_id: null,
    attributes: {} as Record<string, unknown>,
  };
  (circular.attributes as Record<string, unknown>).self = circular;

  return [
    null,
    undefined,
    "a span, honestly",
    42,
    [],
    {},
    { span_id: "" },
    { span_id: 7, trace_id: "t" },
    {
      span_id: "broken",
      trace_id: null,
      parent_span_id: "ghost",
      name: 99,
      kind: "GUARDRAIL",
      start_time: 5,
      end_time: "nope",
      status: null,
      attributes: null,
    },
    { span_id: "broken", trace_id: "t", parent_span_id: null },
    { span_id: "self", trace_id: "t", parent_span_id: "self" },
    { span_id: "cyc-1", trace_id: "t", parent_span_id: "cyc-2" },
    { span_id: "cyc-2", trace_id: "t", parent_span_id: "cyc-1" },
    {
      span_id: "backwards",
      trace_id: "t",
      parent_span_id: null,
      start_time: "2026-01-01T00:00:10.000Z",
      end_time: "2026-01-01T00:00:00.000Z",
      status: { code: "STATUS_CODE_OK" },
      attributes: {},
    },
    { span_id: "links-string", trace_id: "t", links: "not-an-array" },
    {
      span_id: "links-junk",
      trace_id: "t",
      links: [null, 5, { span_id: "absent" }, { trace_id: "t" }],
    },
    {
      span_id: "llm-bare",
      trace_id: "t",
      attributes: { [ATTR.spanKind]: "LLM" },
    },
    { span_id: "tool-bare", trace_id: "t", kind: "TOOL", attributes: {} },
    { span_id: "other-trace-child", trace_id: "u", parent_span_id: "self" },
    circular,
  ];
}

describe("validateTraceSpans on malformed input", () => {
  it("never throws", () => {
    expect(() =>
      validateTraceSpans(malformedSpans() as ContractSpan[]),
    ).not.toThrow();
  });

  it("reports every defect instead of failing", () => {
    const result = validateTraceSpans(malformedSpans() as ContractSpan[]);
    // Hostile in every field, and STILL a trace: spans were read, so the verdict
    // is true and each lost analysis is named by the capability it blocks.
    expect(result.ok).toBe(true);
    expect(
      result.findings.filter((entry) => entry.severity === "error"),
    ).toEqual([]);
    expect(codes(result.findings)).toEqual(
      expect.arrayContaining([
        "invalid-span",
        "duplicate-span-id",
        "orphan-parent",
        "cyclic-parent",
        "cross-trace-parent",
        "invalid-timestamp",
        "negative-duration",
        "invalid-status",
        "missing-trace-id",
        "unknown-span-kind",
        "missing-model",
        "no-usage",
        "missing-tool-name",
        "dangling-link",
      ]),
    );
  });

  it("names both spans of a two-span parent cycle and a self-parent", () => {
    const result = validateTraceSpans(malformedSpans() as ContractSpan[]);
    const cyclic = result.findings.find(
      (entry) => entry.code === "cyclic-parent",
    );
    expect(cyclic?.spanIds).toEqual(["self", "cyc-1", "cyc-2"]);
  });

  it("gives every unavailable capability a reason", () => {
    const result = validateTraceSpans(malformedSpans() as ContractSpan[]);
    for (const entry of result.capabilities) {
      if (entry.available) expect(entry.reason).toBeUndefined();
      else expect(entry.reason?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("survives non-array input of every shape", () => {
    for (const input of [null, undefined, 42, "spans", { spans: [] }, true]) {
      const result = validateTraceSpans(input as unknown as ContractSpan[]);
      expect(result.ok).toBe(false);
      expect(codes(result.findings)).toEqual(["invalid-input"]);
      expect(result.capabilities.every((entry) => !entry.available)).toBe(true);
    }
  });

  it("distinguishes an empty export from a broken one", () => {
    const result = validateTraceSpans([]);
    expect(codes(result.findings)).toEqual(["no-spans"]);
    expect(capability(result, "token-accounting").reason).toBe(
      "the export contains no spans",
    );
    const broken = validateTraceSpans([1, "two"] as unknown as ContractSpan[]);
    expect(codes(broken.findings)).toEqual(["invalid-span"]);
    // Different findings, same verdict: neither is a trace.
    expect(result.ok).toBe(false);
    expect(broken.ok).toBe(false);
  });
});

/**
 * The verdict — the one field a CI job keys off, so it has exactly one meaning:
 * is this a trace?
 *
 * The failure this pins is a report that says CONFORMS and 0/7 capabilities in
 * the same breath, which is how an unreadable file passes a pipeline. The
 * boundary is readability, not richness: a span carrying nothing but an id is a
 * poor trace and analysis can still run over it; a file with no readable span
 * is not a trace at all and every capability is gone.
 */
describe("the ok verdict", () => {
  const at = (seconds: number) =>
    new Date(Date.UTC(2026, 6, 31, 10, 0, seconds)).toISOString();

  /** What a caller gets from a 0-byte file, or one whose every line failed to parse. */
  const emptyExport: unknown[] = [];

  /** Valid JSON that simply contains no span — objects, but not spans. */
  const jsonWithoutSpans: unknown[] = [
    { level: "info", msg: "starting" },
    { level: "info", msg: "done" },
  ];

  /** Every line unparseable: what a JSONL reader yields for a binary or truncated file. */
  const allLinesUnreadable: unknown[] = [null, "{\"span_id\"", 42, [], undefined];

  const notATrace: Array<[string, unknown]> = [
    ["a 0-byte export", emptyExport],
    ["valid JSON carrying no span", jsonWithoutSpans],
    ["an export whose every entry is unreadable", allLinesUnreadable],
    ["input that is not an array at all", "not json"],
    ["input that is not an array at all (null)", null],
  ];

  for (const [label, input] of notATrace) {
    it(`refuses ${label}`, () => {
      const result = validateTraceSpans(input as ContractSpan[]);
      expect(result.ok).toBe(false);
      expect(result.capabilities).toHaveLength(CAPABILITY_NAMES.length);
      expect(result.capabilities.every((entry) => !entry.available)).toBe(true);
      const errors = result.findings.filter(
        (entry) => entry.severity === "error",
      );
      expect(errors).not.toEqual([]);
      // The message says WHY the verdict is false, in the words of the verdict.
      expect(errors.map((entry) => entry.message).join(" ")).toContain(
        "not a trace",
      );
    });
  }

  it("accepts a span that carries nothing but an id — poor, but readable", () => {
    const result = validateTraceSpans([
      { span_id: "only-an-id" },
    ] as unknown as ContractSpan[]);
    expect(result.ok).toBe(true);
    // The whole point of the boundary: analysable and useless are not the same
    // verdict, even when the capability count is identical to an empty file's.
    expect(result.capabilities.every((entry) => !entry.available)).toBe(true);
    expect(result.findings.every((entry) => entry.severity !== "error")).toBe(
      true,
    );
  });

  it("accepts one good span among unreadable entries, and counts what was lost", () => {
    const good = llmSpan({
      traceId: TRACE,
      spanId: id("llm-1"),
      name: "coder turn",
      startTime: at(0),
      endTime: at(4),
      model: "claude-opus-4",
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.01,
      status: { code: "STATUS_CODE_OK" },
    });
    const result = validateTraceSpans([
      null,
      good,
      "garbage",
      42,
    ] as unknown as ContractSpan[]);
    expect(result.ok).toBe(true);
    const dropped = result.findings.find(
      (entry) => entry.code === "invalid-span",
    );
    expect(dropped?.severity).toBe("warn");
    expect(dropped?.message).toContain("3 entries");
    expect(dropped?.message).toContain("missing from every total");
    // Readable means analysable: the surviving span's numbers are all there.
    expect(capability(result, "token-accounting").available).toBe(true);
    expect(capability(result, "cost-attribution").available).toBe(true);
    expect(capability(result, "latency-analysis").available).toBe(true);
  });

  it("says NOT A TRACE only when every entry failed to parse", () => {
    const unreadableOnly = validateTraceSpans([
      null,
      "garbage",
    ] as unknown as ContractSpan[]);
    const invalid = unreadableOnly.findings.find(
      (entry) => entry.code === "invalid-span",
    );
    expect(invalid?.severity).toBe("error");
    expect(invalid?.message).toContain("not one of the 2 entries");
    expect(invalid?.message).toContain("this is not a trace");
  });

  it("holds the verdict invariant across every fixture in this suite", () => {
    const fixtures: Array<[string, unknown]> = [
      ["conforming", conformingTrace()],
      ["malformed", malformedSpans()],
      ["empty", emptyExport],
      ["json without spans", jsonWithoutSpans],
      ["all lines unreadable", allLinesUnreadable],
      ["not an array", 42],
      ["one bare span", [{ span_id: "only-an-id" }]],
    ];
    for (const [label, input] of fixtures) {
      const result = validateTraceSpans(input as ContractSpan[]);
      const hasError = result.findings.some(
        (entry) => entry.severity === "error",
      );
      const anyCapability = result.capabilities.some((entry) => entry.available);
      // ok and error severity are the same statement, always.
      expect([label, result.ok]).toEqual([label, !hasError]);
      // A capability can only be available on something ok, so the report can
      // never read CONFORMS with nothing available, nor DOES NOT CONFORM with
      // an analysis on offer.
      if (anyCapability) expect([label, result.ok]).toEqual([label, true]);
      if (!result.ok) expect([label, anyCapability]).toEqual([label, false]);
    }
  });
});

describe("structural findings", () => {
  const at = (seconds: number) =>
    new Date(Date.UTC(2026, 6, 31, 10, 0, seconds)).toISOString();

  it("flags a trace with no parent edges at all", () => {
    const spans = ["a", "b", "c"].map((id) =>
      contractSpan({
        traceId: "flat",
        spanId: id,
        name: id,
        kind: "LLM",
        startTime: at(0),
        endTime: at(1),
        attributes: { [ATTR.model]: "m", [ATTR.inputTokens]: 5 },
      }),
    );
    const result = validateTraceSpans(spans);
    const flat = result.findings.find((entry) => entry.code === "flat-hierarchy");
    expect(flat?.spanIds).toEqual(["a", "b", "c"]);
    expect(flat?.message).toContain("every span reads as its own run");
    // Nothing measurable was lost TO THE FLATNESS here: loop and tree analysis
    // are unavailable because those attributes were never emitted, and cost
    // because no cost was emitted. A finding only blocks what it actually broke.
    expect(flat?.blocks).toBeUndefined();
  });

  it("blames flatness for the cost roll-up only when there is cost to roll up", () => {
    const spans = ["a", "b", "c"].map((id) =>
      contractSpan({
        traceId: "flat-costed",
        spanId: id,
        name: id,
        kind: "LLM",
        startTime: at(0),
        endTime: at(1),
        attributes: {
          [ATTR.model]: "m",
          [ATTR.inputTokens]: 5,
          [ATTR.costUsd]: 0.01,
        },
      }),
    );
    const result = validateTraceSpans(spans);
    const flat = result.findings.find((entry) => entry.code === "flat-hierarchy");
    expect(flat?.blocks).toEqual(["cost-attribution"]);
    expect(capability(result, "cost-attribution").reason).toContain(
      "3 spans with no parent edge at all",
    );
  });

  it("does not call a single-span trace flat", () => {
    const result = validateTraceSpans([
      contractSpan({
        traceId: "one",
        spanId: "only",
        name: "only",
        kind: "AGENT",
        startTime: at(0),
        endTime: at(1),
      }),
    ]);
    expect(codes(result.findings)).not.toContain("flat-hierarchy");
  });

  it("explains why loop convergence needs two rounds, not one", () => {
    const spans = [
      contractSpan({
        traceId: "one-round",
        spanId: "cell",
        name: "cell",
        kind: "CHAIN",
        startTime: at(0),
        endTime: at(5),
      }),
      loopSpan({
        traceId: "one-round",
        spanId: "round-1",
        parentSpanId: "cell",
        name: "round 1",
        startTime: at(0),
        endTime: at(5),
        loopId: "repair",
        iteration: 1,
      }),
    ];
    const result = validateTraceSpans(spans);
    // One of the two spans carries the attribute at all, and the reason says so:
    // "every span carries the same value" would be a claim about the cell span,
    // which was never tested for one.
    expect(capability(result, "loop-convergence")).toEqual({
      name: "loop-convergence",
      available: false,
      reason: `${ATTR.iteration} is present on 1 span and always has the value 1, so there is no round-over-round change to measure`,
    });
  });

  it("says which attribute is missing when a signal was never emitted", () => {
    const result = validateTraceSpans([
      contractSpan({
        traceId: "bare",
        spanId: "only",
        name: "only",
        kind: "AGENT",
        startTime: at(0),
        endTime: at(1),
      }),
    ]);
    expect(capability(result, "loop-convergence").reason).toBe(
      `no spans carry ${ATTR.iteration}`,
    );
    expect(capability(result, "tree-comparison").reason).toBe(
      `no spans carry ${ATTR.branchId} or ${ATTR.branchArm}`,
    );
    expect(capability(result, "steering-chain").reason).toBe(
      "no spans carry links, so causality between rounds was never recorded",
    );
    expect(capability(result, "tool-usage").reason).toBe(
      `no spans carry ${ATTR.toolName} (or any accepted alias), and no span resolves to kind TOOL`,
    );
    expect(capability(result, "token-accounting").reason).toBe(
      `no spans carry ${ATTR.inputTokens} or ${ATTR.outputTokens} (or any accepted alias)`,
    );
  });

  it("points at a price table when cost is absent but model and tokens are not", () => {
    const spans = conformingTrace().map((span) => {
      const attributes = { ...span.attributes };
      delete attributes[ATTR.costUsd];
      return { ...span, attributes };
    });
    const result = validateTraceSpans(spans);
    expect(capability(result, "cost-attribution").reason).toContain(
      "a price table applied downstream could still derive it",
    );
    expect(capability(result, "token-accounting").available).toBe(true);
  });

  it("blocks cost roll-up when a parent edge does not resolve", () => {
    const spans = conformingTrace().map((span) =>
      span.span_id === id("round-2")
        ? { ...span, parent_span_id: id("deleted-cell") }
        : span,
    );
    const result = validateTraceSpans(spans);
    const orphan = result.findings.find((entry) => entry.code === "orphan-parent");
    expect(orphan?.severity).toBe("warn");
    expect(orphan?.blocks).toEqual(["cost-attribution"]);
    expect(capability(result, "cost-attribution").reason).toContain(
      "cannot roll up to the run that authorised it",
    );
    // The dangling edge costs the cost roll-up, and only that: tokens, tools
    // and latency are still measurable, so the export is still a trace.
    expect(result.ok).toBe(true);
    expect(capability(result, "token-accounting").available).toBe(true);
    expect(capability(result, "latency-analysis").available).toBe(true);
  });

  it("breaks the steering chain when a link target is absent", () => {
    const spans = conformingTrace().filter(
      (span) => span.span_id !== id("verify-1"),
    );
    const result = validateTraceSpans(spans);
    const dangling = result.findings.find(
      (entry) => entry.code === "dangling-link",
    );
    expect(dangling?.spanIds).toEqual([id("round-2")]);
    expect(dangling?.blocks).toEqual(["steering-chain"]);
    expect(capability(result, "steering-chain").available).toBe(false);
  });

  it("orders findings by severity and never invents a block", () => {
    // The documented order is error before warn before info, which is NOT the
    // alphabetical order of those words — sorting the strings would pass while
    // the contract was violated.
    const rank: Record<FindingSeverity, number> = { error: 0, warn: 1, info: 2 };
    const result = validateTraceSpans([
      { span_id: "a", trace_id: "t" },
      { span_id: "a", trace_id: "t" },
      { span_id: "b", trace_id: "t", parent_span_id: "ghost" },
    ] as unknown as ContractSpan[]);
    const ranks = result.findings.map((entry) => rank[entry.severity]);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    expect(ranks).toContain(rank.warn);
    expect(ranks).toContain(rank.info);
    // An error finding never appears beside another one, and that is the
    // verdict rule showing through: error means no span was readable, and a
    // report with no spans in it has nothing else to say.
    expect(ranks).not.toContain(rank.error);
    const unreadable = validateTraceSpans([null] as unknown as ContractSpan[]);
    expect(unreadable.findings.map((entry) => entry.severity)).toEqual([
      "error",
    ]);
    const unavailable = new Set(
      result.capabilities.filter((e) => !e.available).map((e) => e.name),
    );
    for (const entry of result.findings) {
      for (const name of entry.blocks ?? []) expect(unavailable.has(name)).toBe(true);
    }
  });
});

describe("a span id declared twice", () => {
  const at = (seconds: number) =>
    new Date(Date.UTC(2026, 6, 31, 10, 0, seconds)).toISOString();

  /** The ancestors a multi-shot cell re-declares in every shot file. */
  function ancestors(): ContractSpan[] {
    return [
      contractSpan({
        traceId: TRACE,
        spanId: id("run"),
        name: "run",
        kind: "AGENT",
        startTime: at(0),
        endTime: at(30),
        status: { code: "STATUS_CODE_OK" },
      }),
      contractSpan({
        traceId: TRACE,
        spanId: id("cell"),
        parentSpanId: id("run"),
        name: "fhenix-sealed-bid-auction",
        kind: "CHAIN",
        startTime: at(0),
        endTime: at(30),
        status: { code: "STATUS_CODE_OK" },
      }),
    ];
  }

  function shot(index: number, start: number, end: number): ContractSpan[] {
    return [
      loopSpan({
        traceId: TRACE,
        spanId: id(`shot-${index}`),
        parentSpanId: id("cell"),
        name: `shot ${index}`,
        startTime: at(start),
        endTime: at(end),
        loopId: "shots",
        iteration: index,
        status: { code: "STATUS_CODE_OK" },
      }),
      llmSpan({
        traceId: TRACE,
        spanId: id(`shot-${index}-llm`),
        parentSpanId: id(`shot-${index}`),
        name: "coder turn",
        startTime: at(start),
        endTime: at(end),
        model: "glm-5.2",
        inputTokens: 1000 * index,
        outputTokens: 100 * index,
        costUsd: 0.01 * index,
        status: { code: "STATUS_CODE_OK" },
      }),
    ];
  }

  /** Two shot files concatenated, each carrying its own copy of the ancestors. */
  function multiShotCell(): ContractSpan[] {
    return [
      ...ancestors(),
      ...shot(1, 0, 10),
      ...ancestors(),
      ...shot(2, 10, 20),
    ];
  }

  it("is a legal re-declaration when the copies are identical", () => {
    const result = validateTraceSpans(multiShotCell());
    expect(result.ok).toBe(true);
    expect(codes(result.findings)).toEqual(["redeclared-span"]);
    const redeclared = result.findings[0] as ConformanceFinding;
    expect(redeclared.severity).toBe("info");
    expect(redeclared.spanIds).toEqual([id("run"), id("cell")]);
    // It cost nothing measurable, so it takes credit for nothing.
    expect(redeclared.blocks).toBeUndefined();
    expect(capability(result, "token-accounting").available).toBe(true);
    expect(capability(result, "cost-attribution").available).toBe(true);
    expect(capability(result, "loop-convergence").available).toBe(true);
  });

  it("counts a re-declared span once instead of twice", () => {
    // A finding lists span ids, so a merged span appears once. Before merging,
    // the same id came back for every copy — the shape of a double-counted total.
    const bare = () =>
      llmSpan({
        traceId: TRACE,
        spanId: id("llm-bare"),
        parentSpanId: id("run"),
        name: "coder turn",
        startTime: at(0),
        endTime: at(1),
        status: { code: "STATUS_CODE_OK" },
      });
    const result = validateTraceSpans([
      ...ancestors().slice(0, 1),
      bare(),
      bare(),
      bare(),
    ]);
    const noUsage = result.findings.find((entry) => entry.code === "no-usage");
    expect(noUsage?.spanIds).toEqual([id("llm-bare")]);
  });

  it("degrades the trace when the copies disagree, and says how", () => {
    const [run, cell] = ancestors() as [ContractSpan, ContractSpan];
    const result = validateTraceSpans([
      run,
      cell,
      { ...cell, parent_span_id: null, name: "a different cell" },
      ...shot(1, 0, 10),
    ]);
    // Every span here is readable, so this IS a trace; what the conflict costs
    // is named by the capability it blocks, not by failing the whole export.
    expect(result.ok).toBe(true);
    const conflict = result.findings.find(
      (entry) => entry.code === "duplicate-span-id",
    );
    expect(conflict?.severity).toBe("warn");
    expect(conflict?.spanIds).toEqual([id("cell")]);
    expect(conflict?.message).toContain("name, parent_span_id");
    expect(codes(result.findings)).not.toContain("redeclared-span");
  });

  it("does not blame a conflict for tokens when no copy carries any", () => {
    const [run, cell] = ancestors() as [ContractSpan, ContractSpan];
    const result = validateTraceSpans([
      run,
      cell,
      { ...cell, name: "a different cell" },
      ...shot(1, 0, 10),
    ]);
    const conflict = result.findings.find(
      (entry) => entry.code === "duplicate-span-id",
    );
    // The copies disagree only about a label, and carry neither usage nor cost.
    expect(conflict?.blocks).toBeUndefined();
    expect(capability(result, "token-accounting").available).toBe(true);
    expect(capability(result, "cost-attribution").available).toBe(true);
  });

  it("blocks token accounting when the copies report different token counts", () => {
    const [run] = ancestors() as [ContractSpan, ContractSpan];
    const [, llm] = shot(1, 0, 10) as [ContractSpan, ContractSpan];
    const result = validateTraceSpans([
      run,
      { ...llm, parent_span_id: id("run") },
      {
        ...llm,
        parent_span_id: id("run"),
        attributes: { ...llm.attributes, [ATTR.inputTokens]: 999999 },
      },
    ]);
    const conflict = result.findings.find(
      (entry) => entry.code === "duplicate-span-id",
    );
    expect(conflict?.blocks).toEqual(["token-accounting"]);
    expect(capability(result, "token-accounting").reason).toContain(
      "reporting different token counts",
    );
    // They agree on cost and on where they sit, so the roll-up is untouched.
    expect(capability(result, "cost-attribution").available).toBe(true);
  });

  it("leaves the token total alone when the copies disagree about the tree", () => {
    const [run] = ancestors() as [ContractSpan, ContractSpan];
    const [, llm] = shot(1, 0, 10) as [ContractSpan, ContractSpan];
    const result = validateTraceSpans([
      run,
      { ...llm, parent_span_id: id("run") },
      { ...llm, parent_span_id: id("cell") },
    ]);
    const conflict = result.findings.find(
      (entry) => entry.code === "duplicate-span-id",
    );
    // Same tokens in both copies: the sum is exactly right, only its home is not.
    expect(conflict?.blocks).toEqual(["cost-attribution"]);
    expect(capability(result, "token-accounting").available).toBe(true);
  });

  it("blocks cost roll-up when the disagreeing copies sit in different places", () => {
    const [run, cell] = ancestors() as [ContractSpan, ContractSpan];
    const [shotSpan, llm] = shot(1, 0, 10) as [ContractSpan, ContractSpan];
    const result = validateTraceSpans([
      run,
      cell,
      shotSpan,
      { ...shotSpan, parent_span_id: id("run") },
      llm,
    ]);
    // Named for what was actually compared — a bare "whose copies disagree"
    // leaves the reader to guess which of the two tests behind this count fired.
    expect(capability(result, "cost-attribution").reason).toContain(
      "1 span ids whose copies report a different cost or sit in a different place in the tree",
    );
    const conflict = result.findings.find(
      (entry) => entry.code === "duplicate-span-id",
    );
    expect(conflict?.blocks).toEqual(["cost-attribution"]);
    // The disagreement is about the tree, not about tokens.
    expect(capability(result, "token-accounting").available).toBe(true);
  });

  it("survives copies whose attributes point at themselves", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const span = {
      span_id: id("cyclic"),
      trace_id: TRACE,
      parent_span_id: null,
      name: "cyclic",
      start_time: at(0),
      end_time: at(1),
      status: { code: "STATUS_CODE_OK" },
      attributes: cyclic,
    } as unknown as ContractSpan;
    expect(() => validateTraceSpans([span, { ...span }])).not.toThrow();
  });
});

describe("id encoding", () => {
  const at = (seconds: number) =>
    new Date(Date.UTC(2026, 6, 31, 10, 0, seconds)).toISOString();

  function readableIdTrace(traceId: string, spanId: string): ContractSpan[] {
    return [
      contractSpan({
        traceId,
        spanId,
        name: "run",
        kind: "AGENT",
        startTime: at(0),
        endTime: at(10),
        status: { code: "STATUS_CODE_OK" },
        attributes: { [ATTR.inputTokens]: 10, [ATTR.costUsd]: 0.1 },
      }),
    ];
  }

  it("warns without blocking, so a foreign trace still analyses", () => {
    const result = validateTraceSpans(
      readableIdTrace("audit-run-1", "audit-run-1.run"),
    );
    const nonHex = result.findings.find((entry) => entry.code === "non-hex-id");
    expect(nonHex?.severity).toBe("warn");
    expect(nonHex?.message).toContain("cannot be correlated with a W3C traceparent");
    expect(nonHex?.blocks).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(capability(result, "token-accounting").available).toBe(true);
    expect(capability(result, "cost-attribution").available).toBe(true);
  });

  it("names the spans whose ids cannot join a tree", () => {
    const result = validateTraceSpans(
      readableIdTrace("audit-run-1", "audit-run-1.run"),
    );
    const nonHex = result.findings.find((entry) => entry.code === "non-hex-id");
    expect(nonHex?.spanIds).toEqual(["audit-run-1.run"]);
  });

  it("rejects uppercase hex and the reserved all-zero id", () => {
    for (const [traceId, spanId] of [
      [deriveHexId("t", 16).toUpperCase(), deriveHexId("s", 8)],
      ["0".repeat(32), deriveHexId("s", 8)],
      [deriveHexId("t", 16), "0".repeat(16)],
      [deriveHexId("t", 16), deriveHexId("s", 8).slice(0, 15)],
    ] as Array<[string, string]>) {
      const result = validateTraceSpans(readableIdTrace(traceId, spanId));
      expect(codes(result.findings)).toContain("non-hex-id");
    }
  });

  it("says nothing about ids that are already derived", () => {
    const result = validateTraceSpans(
      readableIdTrace(deriveHexId("audit-run-1", 16), deriveHexId("run", 8)),
    );
    expect(codes(result.findings)).not.toContain("non-hex-id");
  });
});

describe("foreign traces", () => {
  it("reads OpenInference spellings, so a non-contract producer still yields numbers", () => {
    const spans = [
      {
        trace_id: "foreign",
        span_id: "root",
        parent_span_id: null,
        name: "agent",
        start_time: "2026-07-31T10:00:00.000Z",
        end_time: "2026-07-31T10:00:05.000Z",
        status: { code: "STATUS_CODE_OK" },
        attributes: { "openinference.span.kind": "AGENT" },
      },
      {
        trace_id: "foreign",
        span_id: "call",
        parent_span_id: "root",
        name: "chat.completions",
        start_time: "2026-07-31T10:00:00.000Z",
        end_time: "2026-07-31T10:00:04.000Z",
        status: { code: "STATUS_CODE_OK" },
        attributes: {
          "llm.model_name": "gpt-4o",
          "llm.token_count.prompt": 120,
          "llm.token_count.completion": 40,
          "llm.cost_usd": 0.002,
        },
      },
      {
        trace_id: "foreign",
        span_id: "tool",
        parent_span_id: "root",
        name: "function.search",
        start_time: "2026-07-31T10:00:04.000Z",
        end_time: "2026-07-31T10:00:05.000Z",
        status: { code: "STATUS_CODE_OK" },
        attributes: { "tool.name": "search" },
      },
    ] as unknown as ContractSpan[];
    const result = validateTraceSpans(spans);
    expect(result.ok).toBe(true);
    expect(capability(result, "token-accounting").available).toBe(true);
    expect(capability(result, "cost-attribution").available).toBe(true);
    expect(capability(result, "tool-usage").available).toBe(true);
    expect(capability(result, "latency-analysis").available).toBe(true);
    // The loop and tree signals genuinely are not there — reported, not guessed.
    expect(capability(result, "loop-convergence").available).toBe(false);
    expect(capability(result, "tree-comparison").available).toBe(false);
  });
});

/**
 * Reason accuracy — the property this package sells.
 *
 * A reason is what a reader ACTS on, so a clause that names a condition nobody
 * tested is the package's worst defect, and it is invisible to the obvious test:
 * asserting the exact string only pins whatever the code says, wrong included.
 * Every reason here is therefore cross-checked against the SPANS — each absence
 * it claims is re-derived from the input, each count it prints is recomputed —
 * so a clause that is merely plausible fails.
 */
describe("reason accuracy", () => {
  const at = (seconds: number) =>
    new Date(Date.UTC(2026, 6, 31, 10, 0, seconds)).toISOString();

  type RawSpan = Record<string, unknown>;

  function span(overrides: RawSpan = {}): RawSpan {
    return {
      trace_id: "acc",
      span_id: "s",
      parent_span_id: null,
      name: "span",
      start_time: at(0),
      end_time: at(1),
      status: { code: "STATUS_CODE_OK" },
      attributes: {},
      ...overrides,
    };
  }

  function attributesOf(raw: unknown): Record<string, unknown> {
    if (raw === null || typeof raw !== "object") return {};
    const bag = (raw as RawSpan).attributes;
    if (bag === null || typeof bag !== "object" || Array.isArray(bag)) return {};
    return bag as Record<string, unknown>;
  }

  /**
   * A key family: what a reason is allowed to call it, every spelling the reader
   * actually searches, and how a usable value is read. A reason that names the
   * primary key claims something about the WHOLE family, because that is what
   * was searched.
   */
  interface Family {
    named: string[];
    keys: readonly string[];
    read: (
      attributes: Record<string, unknown>,
      keys: readonly string[],
    ) => string | number | undefined;
  }

  const FAMILIES: Family[] = [
    { named: [ATTR.model], keys: MODEL_ATTR_KEYS, read: firstStringAttr },
    {
      named: [ATTR.inputTokens, ATTR.outputTokens],
      keys: [...INPUT_TOKEN_ATTR_KEYS, ...OUTPUT_TOKEN_ATTR_KEYS],
      read: firstNumberAttr,
    },
    { named: [ATTR.costUsd], keys: COST_ATTR_KEYS, read: firstNumberAttr },
    { named: [ATTR.toolName], keys: TOOL_NAME_ATTR_KEYS, read: firstStringAttr },
    {
      named: [ATTR.iteration],
      keys: ITERATION_ATTR_KEYS,
      read: firstNumberAttr,
    },
    {
      named: [ATTR.branchId, ATTR.branchArm],
      keys: BRANCH_ATTR_KEYS,
      read: firstStringAttr,
    },
    // Branch id and arm are separate measurements, so a reason names them
    // separately — and each single-key clause needs its own family here, or the
    // clause that decides tree-comparison is a clause nothing cross-checks.
    { named: [ATTR.branchId], keys: [ATTR.branchId], read: firstStringAttr },
    { named: [ATTR.branchArm], keys: [ATTR.branchArm], read: firstStringAttr },
  ];

  /** Every key any family will name, for telling a lone key from one inside an `or` list. */
  const NAMED_KEY_ALTERNATION = [
    ...new Set(FAMILIES.flatMap((family) => family.named)),
  ]
    .map((key) => escapeForRegExp(key))
    .join("|");

  function countSpans(
    spans: RawSpan[],
    predicate: (attributes: Record<string, unknown>) => boolean,
  ): number {
    return spans.filter((raw) => predicate(attributesOf(raw))).length;
  }

  /** Spans a price table could actually price: a model AND a token count, on the SAME span. */
  function pricedSpanCount(spans: RawSpan[]): number {
    return countSpans(
      spans,
      (attributes) =>
        firstStringAttr(attributes, MODEL_ATTR_KEYS) !== undefined &&
        firstNumberAttr(attributes, [
          ...INPUT_TOKEN_ATTR_KEYS,
          ...OUTPUT_TOKEN_ATTR_KEYS,
        ]) !== undefined,
    );
  }

  /** The distinct values ONE branch key holds — never the two keys' values pooled. */
  function branchValues(spans: RawSpan[], key: string): Set<string> {
    const values = new Set<string>();
    for (const raw of spans) {
      const value = firstStringAttr(attributesOf(raw), [key]);
      if (value !== undefined) values.add(value);
    }
    return values;
  }

  function escapeForRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * How a reason is allowed to name a family: its keys joined by `or`, with the
   * optional alias caveat. Matching the whole phrase is what lets the claim be
   * read off the text either side of it.
   */
  function phrasePattern(family: Family): RegExp {
    const keys = family.named.map(escapeForRegExp).join(" or ");
    // Anchored against the `or` lists, so `agent.branch.id` inside
    // "agent.branch.id or agent.branch.arm" is read as the two-key claim it is
    // and not also as a claim about the id alone — the two say different things
    // and are checked against different counts.
    return new RegExp(
      `(?<!(?:${NAMED_KEY_ALTERNATION}) or )${keys}(?: \\(or an(?:y)? accepted alias\\))?(?! or (?:${NAMED_KEY_ALTERNATION}))`,
      "g",
    );
  }

  /**
   * The claim a reason makes where it names an attribute.
   *
   * Deliberately a CLOSED set. Anything else is `unrecognised`, and the caller
   * fails on it, because an unrecognised construction is one nothing verifies —
   * which is exactly how "and none carry gen_ai.tool.name" got shipped. Adding a
   * new way to talk about an attribute means adding it here and proving it.
   */
  type Claim =
    | { form: "absent" }
    | { form: "unusable"; count: number }
    | { form: "usable"; count: number }
    | { form: "tool-spans-lack"; toolSpans: number }
    | { form: "unrecognised"; context: string };

  /**
   * Quantifiers a reason is not allowed to use, because each one asserts
   * something about spans the branch it sits in never examined. Saying how many
   * spans were counted is always available and always true.
   */
  const UNQUANTIFIED_CLAIM =
    /\b(?:every span|all spans|none carry|none of them carry|no span carries)\b/;

  const UNUSABLE_TAIL =
    /^ — the key is present on (\d+) spans?(?: of them)? with a value that is not \w/;
  const USABLE_TAIL = /^ is present on (\d+) spans?/;
  const TOOL_LACK_HEAD = /all (\d+) TOOL spans lack a usable $/;

  function claimAt(reason: string, start: number, end: number): Claim {
    const head = reason.slice(0, start);
    const tail = reason.slice(end);
    const unusable = UNUSABLE_TAIL.exec(tail);
    if (head.endsWith("no spans carry a usable ")) {
      return unusable === null
        ? { form: "unrecognised", context: tail.slice(0, 60) }
        : { form: "unusable", count: Number(unusable[1]) };
    }
    const toolLack = TOOL_LACK_HEAD.exec(head);
    if (toolLack !== null) {
      return { form: "tool-spans-lack", toolSpans: Number(toolLack[1]) };
    }
    if (head.endsWith("no spans carry ")) return { form: "absent" };
    const usable = USABLE_TAIL.exec(tail);
    if (usable !== null) return { form: "usable", count: Number(usable[1]) };
    return { form: "unrecognised", context: `${head.slice(-40)}[KEY]${tail.slice(0, 40)}` };
  }

  /** Every factual claim in every unavailable reason, re-derived from the spans. */
  function assertReasonsMatchTheSpans(label: string, spans: RawSpan[]): void {
    const result = validateTraceSpans(spans as unknown as ContractSpan[]);
    const toolSpanCount = spans.filter(
      (raw) => resolveSpanKind(raw) === "TOOL",
    ).length;

    for (const entry of result.capabilities) {
      if (entry.available) {
        expect(entry.reason, `${label}/${entry.name}`).toBeUndefined();
        continue;
      }
      const reason = entry.reason ?? "";
      const where = `${label}/${entry.name}: ${reason}`;
      expect(reason.length, where).toBeGreaterThan(0);

      // Every place a reason names an attribute, the claim it makes there is
      // re-derived from the spans. A construction this does not recognise is a
      // failure, not a skip: an unchecked clause is the defect being guarded.
      for (const family of FAMILIES) {
        const present = countSpans(spans, (attributes) =>
          hasAttrKey(attributes, family.keys),
        );
        const readable = countSpans(
          spans,
          (attributes) => family.read(attributes, family.keys) !== undefined,
        );
        for (const match of reason.matchAll(phrasePattern(family))) {
          const key = family.named[0] as string;
          const claim = claimAt(
            reason,
            match.index,
            match.index + match[0].length,
          );
          switch (claim.form) {
            case "absent":
              // Claimed the key was never emitted: no span may carry it AT ALL,
              // under any accepted spelling, with any value.
              expect(present, `${where} — claims ${key} absent`).toBe(0);
              break;
            case "unusable":
              // Claimed the key arrived carrying something no reader can use: it
              // has to be there, nothing may have read a value out of it, and the
              // count is how many spans emitted it that way.
              expect(readable, `${where} — claims ${key} unusable`).toBe(0);
              expect(claim.count, `${where} — unusable count`).toBe(present);
              break;
            case "usable":
              expect(claim.count, `${where} — usable count`).toBe(readable);
              break;
            case "tool-spans-lack":
              expect(claim.toolSpans, `${where} — TOOL span count`).toBe(
                toolSpanCount,
              );
              expect(
                countSpans(
                  spans.filter((raw) => resolveSpanKind(raw) === "TOOL"),
                  (attributes) =>
                    family.read(attributes, family.keys) !== undefined,
                ),
                `${where} — claims no TOOL span is named`,
              ).toBe(0);
              break;
            default:
              expect.fail(
                `${where} — unverifiable claim about ${key} near "${claim.context}". Every way a reason names an attribute has to be a form this test knows how to check.`,
              );
          }
        }
      }
      if (reason.includes("no span resolves to kind TOOL")) {
        expect(toolSpanCount, `${where} — claims no TOOL span`).toBe(0);
      }
      if (reason.includes("no spans resolve to kind TOOL")) {
        expect(toolSpanCount, `${where} — claims no TOOL spans`).toBe(0);
      }
      const allTool = /all (\d+) TOOL spans/.exec(reason);
      if (allTool !== null) {
        expect(Number(allTool[1]), `${where} — TOOL span count`).toBe(
          toolSpanCount,
        );
      }

      // Two counters can both be non-zero while no single span carries both
      // halves, and a price table multiplies a rate by tokens ON ONE SPAN. So
      // both directions are re-derived per span: the claim that a table could
      // still derive a cost, and the claim that it could not.
      if (reason.includes("could still derive it")) {
        expect(
          pricedSpanCount(spans),
          `${where} — claims a price table could derive a cost`,
        ).toBeGreaterThan(0);
      }
      if (reason.includes("the two never meet on one span")) {
        expect(
          pricedSpanCount(spans),
          `${where} — claims model and tokens never share a span`,
        ).toBe(0);
      }

      // "always names X" about one branch key is a claim about THAT key's
      // values, so it is checked against that key's values and no other's.
      for (const key of BRANCH_ATTR_KEYS) {
        const claimed = new RegExp(
          `${escapeForRegExp(key)} is present on \\d+ spans? and always names (.+?)(?:;|, so )`,
        ).exec(reason);
        if (claimed === null) continue;
        expect(
          [...branchValues(spans, key)],
          `${where} — claims ${key} always names ${claimed[1]}`,
        ).toEqual([claimed[1]]);
      }

      // A reason may not quantify over the whole export without saying how many
      // spans it looked at. "every span carries the same iteration" is a claim
      // about spans that were never examined — the ones carrying no iteration at
      // all — and it is indistinguishable from a true statement until you count.
      expect(
        UNQUANTIFIED_CLAIM.exec(reason)?.[0],
        `${where} — quantifies over spans without counting them`,
      ).toBeUndefined();
    }

    // The verdict itself, not only its wording: arms are comparable exactly when
    // one branch key holds two distinct values. Reading the two keys as aliases
    // satisfies every reason-text check above and still answers this wrong.
    expect(
      capability(result, "tree-comparison").available,
      `${label}: tree-comparison availability`,
    ).toBe(
      BRANCH_ATTR_KEYS.some((key) => branchValues(spans, key).size >= 2),
    );

    // "A finding never takes credit for breaking something that broke for
    // another reason." Two conditions, because the defect is per span and the
    // capability is per trace: the spans the finding NAMES must really lack the
    // data it says they lack, and no span anywhere may carry both halves —
    // one span with a model and a token count is a row a price table prices,
    // and on a trace that derives, nothing may claim it broke the derivation.
    for (const entry of result.findings) {
      if (!(entry.blocks ?? []).includes("cost-attribution")) continue;
      const family = FAMILIES.find((candidate) =>
        entry.code === "no-usage"
          ? candidate.named.includes(ATTR.inputTokens)
          : entry.code === "missing-model"
            ? candidate.named.includes(ATTR.model)
            : false,
      );
      if (family === undefined) continue;
      for (const spanId of entry.spanIds ?? []) {
        const named = spans.find((raw) => raw?.span_id === spanId);
        expect(
          family.read(attributesOf(named), family.keys),
          `${label}: ${entry.code} names ${spanId} as lacking data it carries`,
        ).toBeUndefined();
      }
      expect(
        pricedSpanCount(spans),
        `${label}: ${entry.code} claims to block cost-attribution on a trace that has a span a price table could price`,
      ).toBe(0);
    }
  }

  const llm = (overrides: RawSpan = {}) =>
    span({ span_id: "llm", kind: "LLM", ...overrides });

  /**
   * One fixture per branch that can produce a reason. A branch with no fixture
   * is a reason nothing cross-checks, which is how the tool-usage clause went
   * unchecked in the first place.
   */
  const CORPUS: Array<[string, RawSpan[]]> = [
    ["empty attributes", [span()]],
    [
      "tool name on a span that declares another kind",
      [llm({ attributes: { [ATTR.model]: "m", [ATTR.toolName]: "Bash" } })],
    ],
    [
      "tool name unreadable, no TOOL span",
      [llm({ attributes: { [ATTR.model]: "m", [ATTR.toolName]: "" } })],
    ],
    [
      "TOOL spans with no name",
      [
        span({ span_id: "t1", kind: "TOOL" }),
        span({ span_id: "t2", kind: "TOOL", parent_span_id: "t1" }),
      ],
    ],
    [
      "TOOL spans whose name is unreadable",
      [span({ span_id: "t1", kind: "TOOL", attributes: { [ATTR.toolName]: 7 } })],
    ],
    [
      "tokens present but unreadable",
      [llm({ attributes: { [ATTR.model]: "m", [ATTR.inputTokens]: "n/a" } })],
    ],
    [
      "cost present but unreadable",
      [
        llm({
          attributes: {
            [ATTR.model]: "m",
            [ATTR.inputTokens]: 10,
            [ATTR.costUsd]: null,
          },
        }),
      ],
    ],
    [
      "cost absent, model and tokens present",
      [llm({ attributes: { [ATTR.model]: "m", [ATTR.inputTokens]: 10 } })],
    ],
    [
      // Some LLM spans lack model and tokens, so those findings exist — and must
      // not claim they broke costing, which the trace can still be priced into.
      "cost absent, model and tokens present on some spans only",
      [
        llm({ attributes: { [ATTR.model]: "m", [ATTR.inputTokens]: 10 } }),
        llm({ span_id: "bare", parent_span_id: "llm" }),
      ],
    ],
    [
      "cost absent, model absent",
      [llm({ attributes: { [ATTR.inputTokens]: 10 } })],
    ],
    [
      // Both counters non-zero, nothing derivable: the shape that made the
      // validator promise a price table could close a gap no table can close.
      "cost absent, model and tokens on DIFFERENT spans",
      [
        llm({ span_id: "priced", attributes: { [ATTR.model]: "m" } }),
        llm({
          span_id: "counted",
          parent_span_id: "priced",
          attributes: { [ATTR.inputTokens]: 10, [ATTR.outputTokens]: 5 },
        }),
      ],
    ],
    ["cost absent, nothing present", [llm()]],
    [
      "one iteration value on one of two spans",
      [
        span({ span_id: "root" }),
        span({
          span_id: "round",
          parent_span_id: "root",
          attributes: { [ATTR.iteration]: 1 },
        }),
      ],
    ],
    [
      "iteration present but unreadable",
      [span({ attributes: { [ATTR.iteration]: "first" } })],
    ],
    [
      "one branch on one of two spans",
      [
        span({ span_id: "root" }),
        span({
          span_id: "arm",
          parent_span_id: "root",
          attributes: { [ATTR.branchId]: "a" },
        }),
      ],
    ],
    [
      "branch present but unreadable",
      [span({ attributes: { [ATTR.branchArm]: "" } })],
    ],
    [
      // Two arms under one branch id — the shape that made the validator report
      // one branch and no sibling arm while both arms sat in front of it.
      "two arms sharing one branch id",
      [
        span({
          span_id: "arm-a",
          attributes: { [ATTR.branchId]: "exp", [ATTR.branchArm]: "control" },
        }),
        span({
          span_id: "arm-b",
          parent_span_id: "arm-a",
          attributes: { [ATTR.branchId]: "exp", [ATTR.branchArm]: "treatment" },
        }),
      ],
    ],
    [
      "one branch id and one arm name, genuinely a single arm",
      [
        span({
          span_id: "arm-a",
          attributes: { [ATTR.branchId]: "exp", [ATTR.branchArm]: "control" },
        }),
        span({ span_id: "plain", parent_span_id: "arm-a" }),
      ],
    ],
    [
      "two arm names under no branch id",
      [
        span({ span_id: "arm-a", attributes: { [ATTR.branchArm]: "control" } }),
        span({
          span_id: "arm-b",
          parent_span_id: "arm-a",
          attributes: { [ATTR.branchArm]: "treatment" },
        }),
      ],
    ],
    [
      "links that point nowhere",
      [span({ links: [{ trace_id: "acc", span_id: "gone" }] })],
    ],
    ["links field of the wrong shape", [span({ links: "steered" })]],
    [
      "unparseable and inverted timestamps",
      [
        span({ span_id: "bad-time", start_time: "yesterday" }),
        span({ span_id: "inverted", start_time: at(5), end_time: at(1) }),
      ],
    ],
    [
      "orphaned parent with cost to roll up",
      [
        llm({
          parent_span_id: "gone",
          attributes: { [ATTR.model]: "m", [ATTR.costUsd]: 0.01 },
        }),
      ],
    ],
    [
      "duplicate ids reporting different tokens",
      [
        llm({ attributes: { [ATTR.model]: "m", [ATTR.inputTokens]: 10 } }),
        llm({ attributes: { [ATTR.model]: "m", [ATTR.inputTokens]: 999 } }),
      ],
    ],
    ["nothing but junk", [{ not: "a span" }, null as unknown as RawSpan]],
    ["no spans at all", []],
  ];

  it.each(CORPUS)("every clause of every reason holds: %s", (label, spans) => {
    assertReasonsMatchTheSpans(label, spans);
  });

  it("does not claim an attribute is missing while a span carries it", () => {
    // The reproduction: a producer labels its tool span LLM. A declared kind
    // wins over inference, so nothing resolves to TOOL — but the attribute is
    // right there, and a reason that says "none carry gen_ai.tool.name" sends
    // that producer to fix an emit path that is already correct.
    const spans = [
      span({
        span_id: "llm",
        kind: "LLM",
        attributes: { [ATTR.model]: "m", [ATTR.toolName]: "Bash" },
      }),
    ];
    const result = validateTraceSpans(spans as unknown as ContractSpan[]);
    expect(capability(result, "tool-usage").reason).toBe(
      `no spans resolve to kind TOOL, though ${ATTR.toolName} (or an accepted alias) is present on 1 span — analysed as LLM, because each of those spans declares that kind and a declared kind wins over inference, so no span is counted as a tool call`,
    );
  });

  it("separates a key that was never emitted from one emitted unusably", () => {
    const emitted = validateTraceSpans([
      span({
        span_id: "llm",
        kind: "LLM",
        attributes: { [ATTR.model]: "m", [ATTR.inputTokens]: "n/a" },
      }),
    ] as unknown as ContractSpan[]);
    expect(capability(emitted, "token-accounting").reason).toBe(
      `no spans carry a usable ${ATTR.inputTokens} or ${ATTR.outputTokens} (or any accepted alias) — the key is present on 1 span with a value that is not a finite number`,
    );

    const never = validateTraceSpans([
      span({ span_id: "llm", kind: "LLM", attributes: { [ATTR.model]: "m" } }),
    ] as unknown as ContractSpan[]);
    expect(capability(never, "token-accounting").reason).toBe(
      `no spans carry ${ATTR.inputTokens} or ${ATTR.outputTokens} (or any accepted alias)`,
    );
  });

  it("counts the spans that carry a single-valued signal, not all of them", () => {
    const spans = [
      span({ span_id: "root" }),
      span({
        span_id: "round",
        parent_span_id: "root",
        attributes: { [ATTR.iteration]: 3, [ATTR.branchId]: "a" },
      }),
    ];
    const result = validateTraceSpans(spans as unknown as ContractSpan[]);
    expect(capability(result, "loop-convergence").reason).toBe(
      `${ATTR.iteration} is present on 1 span and always has the value 3, so there is no round-over-round change to measure`,
    );
    // Each branch key answers for ITSELF: the id named one arm on one span, and
    // the arm key named nothing at all. "id or arm is present on 1 span" would
    // be a claim about a key this trace never carried.
    expect(capability(result, "tree-comparison").reason).toBe(
      `${ATTR.branchId} is present on 1 span and always names a; no spans carry ${ATTR.branchArm}, so there is no sibling arm to compare against`,
    );
  });

  it("blames nobody for a cost the trace could still be priced into", () => {
    const result = validateTraceSpans([
      span({
        span_id: "llm",
        kind: "LLM",
        attributes: { [ATTR.model]: "m", [ATTR.inputTokens]: 10 },
      }),
      span({ span_id: "bare", kind: "LLM", parent_span_id: "llm" }),
    ] as unknown as ContractSpan[]);
    const reason = capability(result, "cost-attribution").reason ?? "";
    expect(reason).toContain("a price table applied downstream could still derive it");
    // The reason says model and tokens are present, so no finding about a
    // missing one may also claim it broke this. Both statements cannot be true.
    for (const entry of result.findings) {
      expect(entry.blocks ?? [], entry.code).not.toContain("cost-attribution");
    }
  });

  it("names what shuts the derivation route when cost cannot be derived either", () => {
    const result = validateTraceSpans([
      span({ span_id: "llm", kind: "LLM", attributes: { [ATTR.inputTokens]: 10 } }),
    ] as unknown as ContractSpan[]);
    expect(capability(result, "cost-attribution").reason).toBe(
      `no spans carry ${ATTR.costUsd} (or any accepted alias), and it cannot be derived downstream either: no spans carry ${ATTR.model} (or any accepted alias)`,
    );
    const missingModel = result.findings.find(
      (entry) => entry.code === "missing-model",
    );
    expect(missingModel?.blocks).toEqual(["cost-attribution"]);
  });

  it("tells a producer the value is the defect, not the key", () => {
    const result = validateTraceSpans([
      span({
        span_id: "llm",
        kind: "LLM",
        attributes: { [ATTR.model]: "", [ATTR.inputTokens]: 10 },
      }),
    ] as unknown as ContractSpan[]);
    const missingModel = result.findings.find(
      (entry) => entry.code === "missing-model",
    );
    expect(missingModel?.message).toContain(
      "on 1 span of them the key is present but its value is not a non-empty string",
    );
  });

  /**
   * These two reasons enumerate their whole candidate list instead of ending in
   * "or any accepted alias", which is only honest while the list is this short.
   * Adding a spelling has to break here rather than silently narrow the reason.
   */
  it("keeps the alias-free reasons honest about their key lists", () => {
    expect([...ITERATION_ATTR_KEYS]).toEqual([ATTR.iteration]);
    expect([...BRANCH_ATTR_KEYS]).toEqual([ATTR.branchId, ATTR.branchArm]);
  });
});

/**
 * "Never throws, on any input" is the README's headline promise and the reason
 * this validator is safe to point at a trace nobody here wrote.
 *
 * A property access is not a safe operation on an arbitrary object, so the
 * hostile shapes below are not exotica: an object with getters, a reactive
 * proxy, an ORM entity, a bag whose keys refuse to enumerate. Each one reaches
 * the reader as "a foreign trace", and each has to come back as findings.
 */
describe("never throws on input that fights back", () => {
  const trap = {
    get(): never {
      throw new Error("hostile get");
    },
    has(): never {
      throw new Error("hostile has");
    },
    ownKeys(): never {
      throw new Error("hostile ownKeys");
    },
    getOwnPropertyDescriptor(): never {
      throw new Error("hostile descriptor");
    },
  };

  const throwingGetter = (key: string) =>
    Object.defineProperty({}, key, {
      get(): never {
        throw new Error(`hostile ${key}`);
      },
      enumerable: true,
      configurable: true,
    });

  const HOSTILE: Array<[string, unknown]> = [
    ["the attribute bag is a proxy that throws", { span_id: "a", attributes: new Proxy({}, trap) }],
    ["the whole span is a proxy that throws", new Proxy({ span_id: "b" }, trap)],
    ["an attribute is a getter that throws", { span_id: "c", attributes: throwingGetter(ATTR.model) }],
    ["a link is a proxy that throws", { span_id: "d", links: [new Proxy({}, trap)] }],
    ["the links array is a proxy that throws", { span_id: "e", links: new Proxy([{}], trap) }],
    ["the status is a proxy that throws", { span_id: "f", status: new Proxy({}, trap) }],
    ["the resource is a proxy that throws", { span_id: "g", resource: new Proxy({}, trap) }],
    ["span_id itself is a getter that throws", throwingGetter("span_id")],
    [
      "kind is a getter that throws",
      Object.defineProperty({ span_id: "h" }, "kind", {
        get(): never {
          throw new Error("hostile kind");
        },
        enumerable: true,
      }),
    ],
    ["two copies of one id whose bags refuse to enumerate", null],
    // A bag with no prototype answers no inherited property, which is what an
    // ORM row and a JSON.parse with __proto__ stripping both hand you.
    [
      "the span has a null prototype",
      Object.assign(Object.create(null) as Record<string, unknown>, {
        span_id: "np",
        attributes: { [ATTR.model]: "m" },
      }),
    ],
    [
      "the attribute bag has a null prototype",
      {
        span_id: "np-attrs",
        attributes: Object.assign(Object.create(null) as Record<string, unknown>, {
          [ATTR.inputTokens]: 4,
        }),
      },
    ],
    ["the links field is not an array", { span_id: "nl", links: "steered_by" }],
    ["the links field is a number", { span_id: "nn", links: 7 }],
    ["the attributes field is an array", { span_id: "aa", attributes: [1, 2] }],
    ["the attributes field is null", { span_id: "an", attributes: null }],
    ["the span is its own parent", { span_id: "self", parent_span_id: "self" }],
    [
      "an attribute bag points at itself",
      (() => {
        const attributes: Record<string, unknown> = {};
        attributes.self = attributes;
        return { span_id: "cyclic-attrs", attributes };
      })(),
    ],
    [
      "a link points at the span carrying it",
      { span_id: "loop-link", links: [{ span_id: "loop-link" }] },
    ],
    ["the span_id is a number", { span_id: 7 }],
    ["the span_id is an empty string", { span_id: "" }],
    ["the span is an array", ["span_id", "arr"]],
    ["the span is a function", () => "span"],
    ["the span is a symbol-keyed bag", { [Symbol("span_id")]: "s" }],
  ];

  /**
   * A `length` a producer wrote. `Array.isArray` is true for a proxy over an
   * array, so the value read there is arbitrary — and every one of these is a
   * number this function must refuse to iterate rather than trust.
   */
  const HOSTILE_LENGTHS: Array<[string, unknown]> = [
    ["negative", -1],
    ["a float", 1.5],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["NaN", Number.NaN],
    ["a numeric string", "3"],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
    ["past the safe integer range", 2 ** 53 + 2],
    ["the largest safe integer", Number.MAX_SAFE_INTEGER],
    ["one past the array maximum", 2 ** 32],
  ];

  it.each(HOSTILE_LENGTHS)("survives a length that is %s", (label, length) => {
    const spans = new Proxy([{ span_id: "el" }] as unknown[], {
      get(target, key, receiver) {
        if (key === "length") return length;
        return Reflect.get(target, key, receiver);
      },
    });
    let result: ReturnType<typeof validateTraceSpans> | undefined;
    expect(() => {
      result = validateTraceSpans(spans as unknown as ContractSpan[]);
    }, String(label)).not.toThrow();
    expect(result?.capabilities, String(label)).toHaveLength(
      CAPABILITY_NAMES.length,
    );
    // A length no reader can use is zero entries, which is not a trace — never
    // a silent success and never an exception.
    expect(result?.ok, String(label)).toBe(
      typeof length === "number" && Number.isSafeInteger(length) && length > 0,
    );
  });

  it("survives a thousand declarations of one span id", () => {
    const identical = Array.from({ length: 1000 }, () => ({
      span_id: "same",
      trace_id: "t",
      attributes: { [ATTR.inputTokens]: 10 },
    }));
    const identicalResult = validateTraceSpans(
      identical as unknown as ContractSpan[],
    );
    expect(codes(identicalResult.findings)).toContain("redeclared-span");
    // Merged, so the total is counted once and nothing is blocked.
    expect(capability(identicalResult, "token-accounting").available).toBe(true);

    const conflicting = identical.map((span, index) => ({
      ...span,
      attributes: { [ATTR.inputTokens]: index },
    }));
    const conflictingResult = validateTraceSpans(
      conflicting as unknown as ContractSpan[],
    );
    expect(codes(conflictingResult.findings)).toContain("duplicate-span-id");
    expect(capability(conflictingResult, "token-accounting").available).toBe(
      false,
    );
  });

  it.each(HOSTILE)("survives %s", (label, hostile) => {
    const spans =
      hostile === null
        ? [
            { span_id: "dup", trace_id: "t", attributes: new Proxy({}, trap) },
            { span_id: "dup", trace_id: "t", attributes: new Proxy({}, trap) },
          ]
        : [hostile];
    let result: ReturnType<typeof validateTraceSpans> | undefined;
    expect(() => {
      result = validateTraceSpans(spans as unknown as ContractSpan[]);
    }, label).not.toThrow();
    // Surviving is not enough: it has to come back with a usable verdict.
    expect(Array.isArray(result?.findings), label).toBe(true);
    expect(result?.capabilities).toHaveLength(CAPABILITY_NAMES.length);
  });

  it("survives an array whose length and elements are hostile", () => {
    const spans = new Proxy([{ span_id: "z" }], {
      get(): never {
        throw new Error("hostile array");
      },
    });
    expect(() =>
      validateTraceSpans(spans as unknown as ContractSpan[]),
    ).not.toThrow();
  });

  it("reports a defect rather than a value it could not read", () => {
    // The model getter throws, so no model can be read — and the span is
    // reported the same way as one that never carried the attribute, because
    // that is exactly what every consumer will see.
    const result = validateTraceSpans([
      {
        span_id: "llm",
        trace_id: "t",
        kind: "LLM",
        attributes: Object.defineProperty({ [ATTR.inputTokens]: 10 }, ATTR.model, {
          get(): never {
            throw new Error("hostile model");
          },
          enumerable: true,
        }),
      },
    ] as unknown as ContractSpan[]);
    expect(codes(result.findings)).toContain("missing-model");
    expect(capability(result, "token-accounting").available).toBe(true);
  });
});

/**
 * The exact words, one branch at a time.
 *
 * The cross-check above proves every clause is DERIVABLE from the spans; this
 * pins what a consumer actually reads, because the two defects it guards are
 * invisible to an availability assertion. A reason can be false while
 * `available` is unchanged — "model and token counts are present, so a price
 * table could still derive it" said over a trace where the model is on one span
 * and the tokens on another is a false instruction on a capability that was
 * always going to be `false`. And a reason can go missing entirely when a branch
 * is rewritten. Every unavailable branch of every capability has an entry here.
 */
describe("reason text, one exact string per unavailable branch", () => {
  const at = (seconds: number) =>
    new Date(Date.UTC(2026, 6, 31, 10, 0, seconds)).toISOString();

  function span(overrides: Record<string, unknown> = {}) {
    return {
      trace_id: "txt",
      span_id: "s",
      parent_span_id: null,
      name: "n",
      start_time: at(0),
      end_time: at(1),
      status: { code: "STATUS_CODE_OK" },
      attributes: {},
      ...overrides,
    };
  }

  function reasonFor(
    name: string,
    spans: Array<Record<string, unknown>>,
  ): string | undefined {
    return capability(
      validateTraceSpans(spans as unknown as ContractSpan[]),
      name,
    ).reason;
  }

  const TOKENS = `${ATTR.inputTokens} or ${ATTR.outputTokens}`;

  const BRANCHES: Array<[string, string, Array<Record<string, unknown>>, string]> = [
    [
      "token-accounting",
      "no token key was ever emitted",
      [span({ kind: "LLM" })],
      `no spans carry ${TOKENS} (or any accepted alias)`,
    ],
    [
      "token-accounting",
      "a token key arrived unreadable",
      [span({ kind: "LLM", attributes: { [ATTR.inputTokens]: "n/a" } })],
      `no spans carry a usable ${TOKENS} (or any accepted alias) — the key is present on 1 span with a value that is not a finite number`,
    ],
    [
      "token-accounting",
      "two copies of one id report different counts",
      [
        span({ span_id: "d", kind: "LLM", attributes: { [ATTR.inputTokens]: 10 } }),
        span({ span_id: "d", kind: "LLM", attributes: { [ATTR.inputTokens]: 99 } }),
      ],
      "1 span ids are declared more than once by copies reporting different token counts, so which count to sum is undecidable",
    ],
    [
      "cost-attribution",
      "one span carries both halves, so a price table closes the gap",
      [
        span({
          kind: "LLM",
          attributes: { [ATTR.model]: "m", [ATTR.inputTokens]: 10 },
        }),
      ],
      `no spans carry ${ATTR.costUsd} (or any accepted alias); model and token counts are present, so a price table applied downstream could still derive it`,
    ],
    [
      "cost-attribution",
      // The defect this string exists to prevent: both counters non-zero, no
      // row derivable, and the old reason promised a table that could price it.
      "the halves are on different spans, so no price table closes anything",
      [
        span({ span_id: "a", kind: "LLM", attributes: { [ATTR.model]: "m" } }),
        span({
          span_id: "b",
          parent_span_id: "a",
          kind: "LLM",
          attributes: { [ATTR.inputTokens]: 10 },
        }),
      ],
      `no spans carry ${ATTR.costUsd} (or any accepted alias), and it cannot be derived downstream either: ${ATTR.model} (or an accepted alias) is present on 1 span and ${TOKENS} (or an accepted alias) is present on 1 span, but the two never meet on one span, so a price table has no row to multiply`,
    ],
    [
      "cost-attribution",
      "the model half is missing",
      [span({ kind: "LLM", attributes: { [ATTR.inputTokens]: 10 } })],
      `no spans carry ${ATTR.costUsd} (or any accepted alias), and it cannot be derived downstream either: no spans carry ${ATTR.model} (or any accepted alias)`,
    ],
    [
      "cost-attribution",
      "the token half is missing",
      [span({ kind: "LLM", attributes: { [ATTR.model]: "m" } })],
      `no spans carry ${ATTR.costUsd} (or any accepted alias), and it cannot be derived downstream either: no spans carry ${TOKENS} (or any accepted alias)`,
    ],
    [
      "cost-attribution",
      "both halves are missing",
      [span({ kind: "LLM" })],
      `no spans carry ${ATTR.costUsd} (or any accepted alias), and it cannot be derived downstream either: no spans carry ${ATTR.model} (or any accepted alias); no spans carry ${TOKENS} (or any accepted alias)`,
    ],
    [
      "cost-attribution",
      "cost is there but the tree it rolls up does not attach",
      [
        span({
          kind: "LLM",
          parent_span_id: "gone",
          attributes: { [ATTR.model]: "m", [ATTR.costUsd]: 0.01 },
        }),
      ],
      "the span tree does not attach (1 spans whose parent is absent), so spend cannot roll up to the run that authorised it",
    ],
    [
      "tool-usage",
      "no tool call was recorded at all",
      [span()],
      `no spans carry ${ATTR.toolName} (or any accepted alias), and no span resolves to kind TOOL`,
    ],
    [
      "tool-usage",
      "the tool name is on a span that declares another kind",
      [
        span({
          kind: "LLM",
          attributes: { [ATTR.model]: "m", [ATTR.toolName]: "Bash" },
        }),
      ],
      `no spans resolve to kind TOOL, though ${ATTR.toolName} (or an accepted alias) is present on 1 span — analysed as LLM, because each of those spans declares that kind and a declared kind wins over inference, so no span is counted as a tool call`,
    ],
    [
      "tool-usage",
      "the TOOL spans never named their tool",
      [
        span({ span_id: "t1", kind: "TOOL" }),
        span({ span_id: "t2", parent_span_id: "t1", kind: "TOOL" }),
      ],
      `all 2 TOOL spans lack a usable ${ATTR.toolName} (or any accepted alias), so usage cannot be broken down by tool`,
    ],
    [
      "tool-usage",
      "the TOOL spans named it unreadably",
      [span({ span_id: "t1", kind: "TOOL", attributes: { [ATTR.toolName]: 7 } })],
      `all 1 TOOL spans lack a usable ${ATTR.toolName} (or any accepted alias) — the key is present on 1 span of them with a value that is not a non-empty string, so usage cannot be broken down by tool`,
    ],
    [
      "loop-convergence",
      "no iteration was ever recorded",
      [span()],
      `no spans carry ${ATTR.iteration}`,
    ],
    [
      "loop-convergence",
      "one round only",
      [
        span({ span_id: "r" }),
        span({
          span_id: "q",
          parent_span_id: "r",
          attributes: { [ATTR.iteration]: 3 },
        }),
      ],
      `${ATTR.iteration} is present on 1 span and always has the value 3, so there is no round-over-round change to measure`,
    ],
    [
      "loop-convergence",
      "the iteration arrived unreadable",
      [span({ attributes: { [ATTR.iteration]: "first" } })],
      `no spans carry a usable ${ATTR.iteration} — the key is present on 1 span with a value that is not a finite number`,
    ],
    [
      "tree-comparison",
      "neither branch key was emitted",
      [span()],
      `no spans carry ${ATTR.branchId} or ${ATTR.branchArm}`,
    ],
    [
      "tree-comparison",
      "one branch id, no arm names",
      [
        span({ span_id: "r" }),
        span({
          span_id: "q",
          parent_span_id: "r",
          attributes: { [ATTR.branchId]: "a" },
        }),
      ],
      `${ATTR.branchId} is present on 1 span and always names a; no spans carry ${ATTR.branchArm}, so there is no sibling arm to compare against`,
    ],
    [
      "tree-comparison",
      "one branch id and one arm name — each key answers for itself",
      [
        span({
          span_id: "r",
          attributes: { [ATTR.branchId]: "exp", [ATTR.branchArm]: "control" },
        }),
        span({ span_id: "q", parent_span_id: "r" }),
      ],
      `${ATTR.branchId} is present on 1 span and always names exp; ${ATTR.branchArm} is present on 1 span and always names control, so there is no sibling arm to compare against`,
    ],
    [
      "tree-comparison",
      "an arm name with no branch id",
      [span({ attributes: { [ATTR.branchArm]: "control" } })],
      `no spans carry ${ATTR.branchId}; ${ATTR.branchArm} is present on 1 span and always names control, so there is no sibling arm to compare against`,
    ],
    [
      "tree-comparison",
      "the branch key arrived unreadable",
      [span({ attributes: { [ATTR.branchArm]: "" } })],
      `no spans carry a usable ${ATTR.branchId} or ${ATTR.branchArm} — the key is present on 1 span with a value that is not a non-empty string`,
    ],
    [
      "steering-chain",
      "nothing linked to anything",
      [span()],
      "no spans carry links, so causality between rounds was never recorded",
    ],
    [
      "steering-chain",
      "every link points outside the export",
      [span({ links: [{ trace_id: "txt", span_id: "gone" }] })],
      "all 1 span links are malformed or point at spans absent from this export",
    ],
    [
      "latency-analysis",
      "a timestamp does not parse",
      [span({ start_time: "yesterday" })],
      "1 spans have an unparseable start_time or end_time",
    ],
    [
      "latency-analysis",
      "a span ends before it starts",
      [span({ start_time: at(5), end_time: at(1) })],
      "1 spans end before they start",
    ],
    [
      "latency-analysis",
      "both timing defects at once",
      [
        span({ span_id: "x", start_time: "yesterday" }),
        span({ span_id: "y", parent_span_id: "x", start_time: at(5), end_time: at(1) }),
      ],
      "1 spans have an unparseable start_time or end_time; 1 spans end before they start",
    ],
  ];

  it.each(BRANCHES)("%s — %s", (name, _label, spans, expected) => {
    expect(reasonFor(name, spans)).toBe(expected);
  });

  it("covers every capability", () => {
    expect(new Set(BRANCHES.map(([name]) => name))).toEqual(
      new Set(CAPABILITY_NAMES),
    );
  });

  it("gives an available capability no reason to read", () => {
    // The other half of the contract: a reason exists exactly when the answer
    // is no, so a stale one can never be read off an available capability.
    const spans = [
      span({
        span_id: "arm-a",
        attributes: { [ATTR.branchId]: "exp", [ATTR.branchArm]: "control" },
      }),
      span({
        span_id: "arm-b",
        parent_span_id: "arm-a",
        attributes: { [ATTR.branchId]: "exp", [ATTR.branchArm]: "treatment" },
      }),
    ];
    expect(capability(
      validateTraceSpans(spans as unknown as ContractSpan[]),
      "tree-comparison",
    )).toEqual({ name: "tree-comparison", available: true });
  });
});

/**
 * An export bigger than this validator will read.
 *
 * `length` is a number the producer wrote, not a count of spans that exist, and
 * two separate things in this function used to scale with it: the loop, and the
 * list of positions that failed to parse. `Array.prototype.push` refuses past
 * 2^32-1 entries, so a plain sparse array — no proxy, no exotic object — ended
 * the call in a `RangeError`, breaking the one promise the package makes. Both
 * are bounded now, and the clipping is REPORTED: a caller that is told its
 * totals cover a prefix can split the export; a caller told nothing reads a
 * number that quietly lost the tail.
 */
describe("an export larger than this validator reads", () => {
  /** A producer-declared length with entries only where this test puts them. */
  function sparse(
    length: number,
    entries: Record<number, unknown>,
  ): ContractSpan[] {
    return Object.assign(new Array(length), entries) as unknown as ContractSpan[];
  }

  const truncation = (result: ReturnType<typeof validateTraceSpans>) =>
    result.findings.find((entry) => entry.code === "truncated-input");

  it("returns a verdict instead of throwing on a four-billion-entry length", () => {
    let result: ReturnType<typeof validateTraceSpans> | undefined;
    expect(() => {
      result = validateTraceSpans(sparse(4_000_000_000, { 0: { span_id: "x" } }));
    }).not.toThrow();
    // Surviving is not enough — the readable span still has to be analysed.
    expect(result?.ok).toBe(true);
    expect(result?.capabilities).toHaveLength(CAPABILITY_NAMES.length);
    expect(codes(result?.findings ?? [])).toContain("invalid-span");
  });

  it("says how much it did not read, and what that costs", () => {
    const result = validateTraceSpans(
      sparse(4_000_000_000, { 0: { span_id: "x" } }),
    );
    const clipped = truncation(result);
    expect(clipped?.severity).toBe("warn");
    expect(clipped?.message).toBe(
      `the export declares 4000000000 entries and at most ${MAX_SPANS_READ} are read in one call, so the last ${4_000_000_000 - MAX_SPANS_READ} were never looked at: every count, total and structural check reported here describes the first ${MAX_SPANS_READ} entries only, and a span outside them is invisible to all of them — split the export and validate the parts`,
    );
    // Analysable but degraded: spans were read, so this is still a trace.
    expect(clipped?.blocks).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it("keeps the record of dropped entries bounded, not one entry per position", () => {
    // The accumulator half of the defect: 249 999 unreadable positions, and the
    // message still prints a five-item sample with a true total behind it.
    const dropped = validateTraceSpans(
      sparse(4_000_000_000, { 0: { span_id: "x" } }),
    ).findings.find((entry) => entry.code === "invalid-span");
    expect(dropped?.severity).toBe("warn");
    expect(dropped?.message).toContain(
      `${MAX_SPANS_READ - 1} entries (at positions 1, 2, 3, 4, 5 and ${MAX_SPANS_READ - 6} more)`,
    );
  });

  it("reads the last entry inside the bound and reports no truncation", () => {
    const result = validateTraceSpans(
      sparse(MAX_SPANS_READ, { [MAX_SPANS_READ - 1]: { span_id: "last" } }),
    );
    expect(truncation(result)).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(
      result.findings.find((entry) => entry.code === "invalid-span")?.message,
    ).toContain(`${MAX_SPANS_READ - 1} entries`);
  });

  it("never reads the first entry outside the bound, and says so", () => {
    // One past the bound with the ONLY span sitting there: the verdict has to
    // be that nothing was readable, and the truncation finding is what tells a
    // caller the span it is looking for was never examined.
    const result = validateTraceSpans(
      sparse(MAX_SPANS_READ + 1, { [MAX_SPANS_READ]: { span_id: "beyond" } }),
    );
    expect(truncation(result)?.severity).toBe("warn");
    expect(result.ok).toBe(false);
    const invalid = result.findings.find(
      (entry) => entry.code === "invalid-span",
    );
    expect(invalid?.severity).toBe("error");
    // "read from", not "in": the entries past the bound were never examined, so
    // a count claiming them is a number this function did not measure.
    expect(invalid?.message).toBe(
      `not one of the ${MAX_SPANS_READ} entries read from this export is an object carrying a span_id, so no span could be read and this is not a trace`,
    );
  });

  it("bounds the work, not just the memory", () => {
    const started = Date.now();
    validateTraceSpans(sparse(4_000_000_000, { 0: { span_id: "x" } }));
    // A loop over the declared length would not finish this century. The bound
    // is what makes the wall time a function of MAX_SPANS_READ instead.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
