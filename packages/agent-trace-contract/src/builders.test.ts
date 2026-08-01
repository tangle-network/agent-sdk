import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ATTR, LINK_KIND_ATTR } from "./attributes.js";
import {
  branchSpan,
  contractSpan,
  llmSpan,
  loopSpan,
  spanLink,
  steeredBy,
  toolSpan,
} from "./builders.js";

const TRACE = "trace-1";
const START = "2026-07-31T10:00:00.000Z";
const END = "2026-07-31T10:00:02.500Z";

describe("contractSpan", () => {
  it("builds the OTLP field shape with unset status and a null root parent", () => {
    expect(
      contractSpan({
        traceId: TRACE,
        spanId: "run",
        name: "run",
        kind: "AGENT",
        startTime: START,
        endTime: END,
      }),
    ).toEqual({
      trace_id: TRACE,
      span_id: "run",
      parent_span_id: null,
      name: "run",
      kind: "AGENT",
      start_time: START,
      end_time: END,
      status: { code: "STATUS_CODE_UNSET" },
      attributes: { [ATTR.spanKind]: "AGENT" },
    });
  });

  it("collapses an instantaneous event to end_time === start_time", () => {
    const span = contractSpan({
      traceId: TRACE,
      spanId: "event",
      name: "event",
      startTime: START,
    });
    expect(span.end_time).toBe(START);
    // No kind supplied means no kind field and no kind attribute — an absent
    // classification, not a guessed one.
    expect(span.kind).toBeUndefined();
    expect(span.attributes).toEqual({});
  });

  it("writes outcome and score, including a score of zero", () => {
    const span = contractSpan({
      traceId: TRACE,
      spanId: "verify",
      name: "verification",
      kind: "EVALUATOR",
      startTime: START,
      outcome: "fail",
      score: 0,
    });
    expect(span.attributes[ATTR.outcome]).toBe("fail");
    expect(span.attributes[ATTR.score]).toBe(0);
  });

  it("copies links and resource so later caller mutation cannot rewrite the span", () => {
    const links = [steeredBy("prior", TRACE)];
    const resource = { attributes: { "service.name": "vb" } };
    const span = contractSpan({
      traceId: TRACE,
      spanId: "round-2",
      name: "round 2",
      startTime: START,
      links,
      resource,
    });
    links.push(steeredBy("other", TRACE));
    resource.attributes["service.name"] = "changed";
    expect(span.links).toHaveLength(1);
    expect(span.resource?.attributes).toEqual({ "service.name": "vb" });
  });
});

describe("llmSpan", () => {
  it("writes the gen_ai vocabulary", () => {
    const span = llmSpan({
      traceId: TRACE,
      spanId: "llm-1",
      parentSpanId: "round-1",
      name: "coder turn",
      startTime: START,
      endTime: END,
      model: "claude-opus-4",
      system: "anthropic",
      inputTokens: 1200,
      outputTokens: 340,
      costUsd: 0.0182,
      status: { code: "STATUS_CODE_OK" },
    });
    expect(span.kind).toBe("LLM");
    expect(span.parent_span_id).toBe("round-1");
    expect(span.status).toEqual({ code: "STATUS_CODE_OK" });
    expect(span.attributes).toEqual({
      [ATTR.spanKind]: "LLM",
      [ATTR.model]: "claude-opus-4",
      [ATTR.system]: "anthropic",
      [ATTR.inputTokens]: 1200,
      [ATTR.outputTokens]: 340,
      [ATTR.costUsd]: 0.0182,
    });
  });

  it("omits usage it was not given a usable number for", () => {
    const span = llmSpan({
      traceId: TRACE,
      spanId: "llm-2",
      name: "coder turn",
      startTime: START,
      model: "",
      inputTokens: Number.NaN,
      outputTokens: -5,
      costUsd: Number.POSITIVE_INFINITY,
    });
    // A synthesized 0 would read as "this call was free" downstream; absence
    // reads as "not measured", which is recoverable.
    expect(span.attributes).toEqual({ [ATTR.spanKind]: "LLM" });
  });

  it("keeps a zero token count, which is a measurement, not an absence", () => {
    const span = llmSpan({
      traceId: TRACE,
      spanId: "llm-3",
      name: "coder turn",
      startTime: START,
      outputTokens: 0,
    });
    expect(span.attributes[ATTR.outputTokens]).toBe(0);
  });

  it("lets the typed field win over a raw attribute of the same name", () => {
    const span = llmSpan({
      traceId: TRACE,
      spanId: "llm-4",
      name: "coder turn",
      startTime: START,
      model: "typed",
      attributes: { [ATTR.model]: "raw", "vendor.custom": 1 },
    });
    expect(span.attributes[ATTR.model]).toBe("typed");
    expect(span.attributes["vendor.custom"]).toBe(1);
  });
});

describe("toolSpan, loopSpan, branchSpan", () => {
  it("writes the tool name", () => {
    const span = toolSpan({
      traceId: TRACE,
      spanId: "tool-1",
      name: "tool.Bash",
      startTime: START,
      toolName: "Bash",
    });
    expect(span.kind).toBe("TOOL");
    expect(span.attributes[ATTR.toolName]).toBe("Bash");
  });

  it("writes one loop ITERATION, defaulting to CHAIN", () => {
    const span = loopSpan({
      traceId: TRACE,
      spanId: "round-2",
      parentSpanId: "cell",
      name: "round 2",
      startTime: START,
      loopId: "repair",
      iteration: 2,
      maxIterations: 4,
      resumed: true,
      links: [steeredBy("verify-1", TRACE)],
    });
    expect(span.kind).toBe("CHAIN");
    expect(span.attributes).toEqual({
      [ATTR.spanKind]: "CHAIN",
      [ATTR.loopId]: "repair",
      [ATTR.iteration]: 2,
      [ATTR.maxIterations]: 4,
      [ATTR.resumed]: true,
    });
    // Causality is the link; the parent stays the containing cell.
    expect(span.parent_span_id).toBe("cell");
    expect(span.links).toEqual([
      {
        trace_id: TRACE,
        span_id: "verify-1",
        attributes: { [LINK_KIND_ATTR]: "steered_by" },
      },
    ]);
  });

  it("keeps resumed:false, which says the iteration started fresh", () => {
    const span = loopSpan({
      traceId: TRACE,
      spanId: "round-1",
      name: "round 1",
      startTime: START,
      loopId: "repair",
      iteration: 1,
      resumed: false,
    });
    expect(span.attributes[ATTR.resumed]).toBe(false);
  });

  it("writes one tree arm and honours a kind override", () => {
    const span = branchSpan({
      traceId: TRACE,
      spanId: "arm-b",
      name: "with-search",
      startTime: START,
      branchId: "b",
      branchParentId: "root",
      arm: "with-search",
      kind: "AGENT",
    });
    expect(span.kind).toBe("AGENT");
    expect(span.attributes[ATTR.branchId]).toBe("b");
    expect(span.attributes[ATTR.branchParent]).toBe("root");
    expect(span.attributes[ATTR.branchArm]).toBe("with-search");
  });
});

describe("links", () => {
  it("tags the causal edge with its kind", () => {
    expect(spanLink("graded_by", "verify-1", TRACE)).toEqual({
      trace_id: TRACE,
      span_id: "verify-1",
      attributes: { [LINK_KIND_ATTR]: "graded_by" },
    });
    expect(steeredBy("verify-1", TRACE).attributes).toEqual({
      [LINK_KIND_ATTR]: "steered_by",
    });
  });
});

describe("purity", () => {
  it("returns byte-identical spans for identical input", () => {
    const init = {
      traceId: TRACE,
      spanId: "llm-1",
      name: "coder turn",
      startTime: START,
      endTime: END,
      model: "claude-opus-4",
      inputTokens: 10,
    };
    expect(JSON.stringify(llmSpan(init))).toBe(JSON.stringify(llmSpan(init)));
  });

  it("never mutates the caller's init object", () => {
    const attributes = { "vendor.custom": 1 };
    const init = {
      traceId: TRACE,
      spanId: "llm-1",
      name: "coder turn",
      startTime: START,
      model: "claude-opus-4",
      attributes,
    };
    llmSpan(init);
    expect(attributes).toEqual({ "vendor.custom": 1 });
    expect(init.startTime).toBe(START);
  });

  it("contains no clock, randomness or I/O in the builder source", () => {
    // The determinism test above cannot catch a Date.now() called twice inside
    // the same millisecond. Reading the source can. A builder that invents its
    // own timestamps or ids cannot be replayed against a recorded trace and will
    // disagree with the timestamps the producer already holds.
    const source = readFileSync(
      fileURLToPath(new URL("./builders.ts", import.meta.url)),
      "utf8",
    );
    const body = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of [
      "Date.now",
      "new Date",
      "performance.now",
      "Math.random",
      "crypto",
      "randomUUID",
      "process.",
      "require(",
      "import(",
      "fetch(",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });
});
