/**
 * Conformance for the OTLP JSON wire through the published `./otlp` exports:
 * a real collector export decoded, and what the encoder writes read back.
 * The decode cases also carry the ones Tangle Intelligence's ingest decoder
 * tested before it moved here.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  decodeOtlpAttributes,
  decodeOtlpTraceExport,
  msToUnixNano,
  OTLP_SPAN_KIND,
  OTLP_STATUS_CODE,
  otlpTraceExport,
  toOtlpAttributes,
  toW3CSpanId,
  toW3CTraceId,
} from "./otlp.js";

/**
 * One line of this host's OpenTelemetry Collector file exporter, three
 * producers (Codex CLI, OpenCode, Claude Code), each span copied verbatim with
 * only its non-identifying attributes kept.
 */
const COLLECTOR_LINE = readFileSync(new URL("./fixtures/collector-export.json", import.meta.url), "utf8");

describe("decodeOtlpTraceExport on a real collector export", () => {
  const rows = decodeOtlpTraceExport(JSON.parse(COLLECTOR_LINE));

  it("keeps ids, codes, scope and nanosecond strings exactly as exported", () => {
    expect(
      rows.map((row) => [row.span_id, row.parent_span_id, row.name, row.kind, row.status_code, row.scope_name]),
    ).toEqual([
      ["cc185280867314cc", "0caba68b9b4c3405", "auth", 1, undefined, "codex_cli_rs"],
      ["bb1b34f318b7eef5", "ac16c745048f0047", "sql.execute", 3, 1, "opencode"],
      ["ec7ff20c52f5f1a5", "9a852a58e079c14e", "claude_code.llm_request", 1, undefined, "com.anthropic.claude_code.tracing"],
    ]);
    // Past 2^53: a float conversion would change these digits.
    expect(rows[0]?.start_time_unix_nano).toBe("1793041881115905373");
    // An export with no status leaves the fields absent, not null.
    expect(rows[0]).not.toHaveProperty("status_code");
    expect(rows[2]?.events).toEqual([
      { name: "gen_ai.request.attempt", time_unix_nano: "1793041877015951041", attributes: { attempt: 1 } },
    ]);
  });

  it("decodes arrays and merges resource attributes under span attributes, the span winning", () => {
    expect(rows[2]?.attributes).toMatchObject({
      "service.name": "drew-local-agents",
      "gen_ai.response.finish_reasons": ["tool_use"],
      cache_read_tokens: 931333,
      success: true,
    });
    const line = JSON.parse(COLLECTOR_LINE);
    line.resourceSpans[1].scopeSpans[0].spans[0].attributes.push({
      key: "service.name",
      value: { stringValue: "opencode-worker" },
    });
    const [, opencode] = decodeOtlpTraceExport(line);
    expect(opencode?.resource_attributes["service.name"]).toBe("opencode");
    expect(opencode?.attributes["service.name"]).toBe("opencode-worker");
  });

  it("skips a span missing its traceId or spanId, and never throws", () => {
    const line = JSON.parse(COLLECTOR_LINE);
    delete line.resourceSpans[0].scopeSpans[0].spans[0].spanId;
    line.resourceSpans[1].scopeSpans[0].spans[0].traceId = "";
    expect(decodeOtlpTraceExport(line).map((row) => row.span_id)).toEqual(["ec7ff20c52f5f1a5"]);
    for (const malformed of [null, "line", { resourceSpans: "x" }, { resourceSpans: [{ scopeSpans: [{ spans: [7] }] }] }]) {
      expect(decodeOtlpTraceExport(malformed)).toEqual([]);
    }
  });
});

describe("encode then decode", () => {
  it("reads back what every producer writes", () => {
    const span = {
      traceId: toW3CTraceId("run-1"),
      spanId: toW3CSpanId("run-1:root"),
      name: "turn",
      kind: OTLP_SPAN_KIND.INTERNAL,
      startTimeUnixNano: msToUnixNano(1_700_000_000_123.4567),
      endTimeUnixNano: msToUnixNano(Number.NaN),
      attributes: toOtlpAttributes(
        {
          model: "claude-sonnet",
          ok: true,
          tokens: 1234,
          cost: 0.0042,
          wall_ms: 120,
          tool: { name: "bash", argv: ["ls", 7, Number.NaN, undefined], nested: { deep: 1.5 } },
          nullable: null,
          missing: undefined,
          nan: Number.NaN,
          huge: 1e21,
        },
        { doubles: new Set(["wall_ms"]) },
      ),
      // An event the producer wrote without attributes reads back without them.
      events: [{ timeUnixNano: msToUnixNano(1_700_000_000_200), name: "retry" }],
      status: { code: OTLP_STATUS_CODE.ERROR, message: "boom" },
    };
    const exported = otlpTraceExport(toOtlpAttributes({ "service.name": "svc" }), { name: "scope" }, [span]);
    // Whole-millisecond types stay as the copies wrote them.
    expect(span.attributes.find((kv) => kv.key === "wall_ms")?.value).toEqual({ doubleValue: 120 });
    expect(span.attributes.find((kv) => kv.key === "tokens")?.value).toEqual({ intValue: "1234" });
    expect(decodeOtlpTraceExport(JSON.parse(JSON.stringify(exported)))).toEqual([
      {
        trace_id: span.traceId,
        span_id: span.spanId,
        parent_span_id: null,
        name: "turn",
        kind: 1,
        // Microseconds kept; a time that cannot be read is 0.
        start_time_unix_nano: "1700000000123456000",
        end_time_unix_nano: "0",
        status_code: 2,
        status_message: "boom",
        scope_name: "scope",
        resource_attributes: { "service.name": "svc" },
        span_attributes: {
          model: "claude-sonnet",
          ok: true,
          tokens: 1234,
          cost: 0.0042,
          wall_ms: 120,
          // Inside an array a value with no OTLP form keeps its position as "null".
          tool: { name: "bash", argv: ["ls", 7, "null", "null"], nested: { deep: 1.5 } },
          nullable: "null",
          huge: 1e21,
        },
        attributes: expect.objectContaining({ "service.name": "svc", model: "claude-sonnet" }),
        events: [{ name: "retry", time_unix_nano: "1700000000200000000" }],
      },
    ]);
  });
});

describe("decodeOtlpAttributes", () => {
  it("reads the shapes Intelligence's ingest receives", () => {
    expect(
      decodeOtlpAttributes([
        { key: "snake_s", value: { string_value: "hello" } },
        { key: "snake_i", value: { int_value: "43" } },
        { key: "n", value: { intValue: 7 } },
        { key: "payload.bytes", value: { bytesValue: "YWJj" } },
        { key: "vendor.future", value: { vendorValue: { score: Number.NaN, items: [{ stringValue: "kept" }] } } },
        { key: "k", value: { stringValue: "a" } },
        { key: "k", value: { intValue: "2" } },
        { key: "k", value: { boolValue: false } },
        { value: { stringValue: "no key" } },
      ]),
    ).toEqual({
      attributes: {
        snake_s: "hello",
        snake_i: 43,
        n: 7,
        "payload.bytes": "YWJj",
        "vendor.future": { vendorValue: { score: null, items: [{ stringValue: "kept" }] } },
        k: false,
      },
      duplicates: { k: ["a", 2, false] },
    });
  });

  it("keeps an int64 above 2^53 as its exact decimal string", () => {
    expect(
      decodeOtlpAttributes([
        { key: "safe", value: { intValue: "9007199254740991" } },
        { key: "big", value: { intValue: "9007199254740993" } },
      ]).attributes,
    ).toEqual({ safe: 9007199254740991, big: "9007199254740993" });
  });

  it("keeps __proto__, constructor and toString as ordinary keys, at the top and inside a kvlist", () => {
    const { attributes } = decodeOtlpAttributes(
      JSON.parse(
        JSON.stringify([
          { key: "__proto__", value: { stringValue: "p" } },
          { key: "constructor", value: { stringValue: "c" } },
          { key: "toString", value: { intValue: "1" } },
          {
            key: "nested",
            value: { kvlistValue: { values: [{ key: "__proto__", value: { kvlistValue: { values: [{ key: "polluted", value: { boolValue: true } }] } } }] } },
          },
        ]),
      ),
    );
    expect(Object.keys(attributes)).toEqual(["__proto__", "constructor", "toString", "nested"]);
    expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(attributes))).toEqual(
      JSON.parse('{"__proto__":"p","constructor":"c","toString":1,"nested":{"__proto__":{"polluted":true}}}'),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("attributeValues: 'scalar', agent-eval's analyst reading", () => {
  it("reads agent-eval's flatten fixture the way its flattener did", () => {
    // tests/otlp-flatten.test.ts in agent-eval, the export its exporter writes.
    const [row] = decodeOtlpTraceExport(
      {
        resourceSpans: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "agent-x" } }] },
            scopeSpans: [
              {
                scope: { name: "@tangle-network/agent-eval", version: "0.3.0" },
                spans: [
                  {
                    traceId: "t1",
                    spanId: "s1",
                    name: "llm.call",
                    kind: 3,
                    startTimeUnixNano: "1700000000000000000",
                    endTimeUnixNano: "1700000001000000000",
                    attributes: [
                      { key: "llm.model", value: { stringValue: "claude-sonnet" } },
                      { key: "llm.tokens.in", value: { intValue: "1200" } },
                      { key: "span.kind", value: { stringValue: "llm" } },
                    ],
                    status: { code: 2, message: "rate_limited" },
                  },
                ],
              },
            ],
          },
        ],
      },
      { attributeValues: "scalar" },
    );
    expect(row).toMatchObject({
      trace_id: "t1",
      parent_span_id: null,
      kind: 3,
      status_code: 2,
      status_message: "rate_limited",
      resource_attributes: { "service.name": "agent-x" },
      span_attributes: { "llm.model": "claude-sonnet", "llm.tokens.in": 1200, "span.kind": "llm" },
    });
  });

  it("reads arrays, kvlists and bytes as '' and int64 through Number, on the real collector line", () => {
    const line = JSON.parse(COLLECTOR_LINE);
    line.resourceSpans[2].scopeSpans[0].spans[0].attributes.push(
      { key: "big", value: { intValue: "9007199254740993" } },
      { key: "kv", value: { kvlistValue: { values: [] } } },
      { key: "raw", value: { bytesValue: "YWJj" } },
      { key: "snake", value: { string_value: "ignored" } },
    );
    const claude = decodeOtlpTraceExport(line, { attributeValues: "scalar" })[2];
    expect(claude?.span_attributes).toMatchObject({
      "gen_ai.response.finish_reasons": "",
      big: 9007199254740992,
      kv: "",
      raw: "",
      snake: "",
      cache_read_tokens: 931333,
    });
  });
});
