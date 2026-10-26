/**
 * Conformance for the OTLP JSON wire. The cases come from the producers and the
 * ingest that each kept a copy of this code: the Sandbox SDK trace exporter,
 * agent-app's turn trace sink, agent-eval's exporters, agent-runtime's
 * exporter, and Tangle Intelligence's ingest decoder.
 */
import { describe, expect, it } from "vitest";

import {
  decodeOtlpAnyValue,
  decodeOtlpAttributes,
  msToUnixNano,
  OTLP_SPAN_KIND,
  OTLP_STATUS_CODE,
  otlpTraceExport,
  readOtlpPartialSuccess,
  toOtlpAnyValue,
  toOtlpAttributes,
  toW3CTraceId,
} from "./otlp.js";
import { toW3CTraceId as rootToW3CTraceId } from "./index.js";

describe("toOtlpAttributes", () => {
  it("types each scalar the way every producer did", () => {
    expect(
      toOtlpAttributes({ s: "hi", b: false, i: 42, neg: -7, d: 0.5 }),
    ).toEqual([
      { key: "s", value: { stringValue: "hi" } },
      { key: "b", value: { boolValue: false } },
      { key: "i", value: { intValue: "42" } },
      { key: "neg", value: { intValue: "-7" } },
      { key: "d", value: { doubleValue: 0.5 } },
    ]);
  });

  it("drops a key with no OTLP value: undefined, NaN and the infinities", () => {
    expect(
      toOtlpAttributes({
        kept: 1,
        missing: undefined,
        nan: Number.NaN,
        up: Number.POSITIVE_INFINITY,
        down: Number.NEGATIVE_INFINITY,
      }),
    ).toEqual([{ key: "kept", value: { intValue: "1" } }]);
  });

  it("keeps a measurement listed in `doubles` a double when it lands on a whole number", () => {
    expect(
      toOtlpAttributes(
        { "tangle.duration_ms": 120, "tangle.turn.spans": 3 },
        { doubles: new Set(["tangle.duration_ms"]) },
      ),
    ).toEqual([
      { key: "tangle.duration_ms", value: { doubleValue: 120 } },
      { key: "tangle.turn.spans", value: { intValue: "3" } },
    ]);
  });

  it("sends an integer past 2^53 as a double, never as an int64 string it cannot spell", () => {
    expect(toOtlpAnyValue(1e21)).toEqual({ doubleValue: 1e21 });
    expect(toOtlpAnyValue(Number.MAX_SAFE_INTEGER)).toEqual({
      intValue: "9007199254740991",
    });
  });

  it("encodes nested arrays and objects, with null kept as the string null", () => {
    expect(
      toOtlpAttributes({
        nullable: null,
        labels: ["alpha", true, { nested: null }, 2.5, Number.NaN, undefined],
        tool: { cmd: "pnpm", args: ["test", 7], skipped: undefined },
      }),
    ).toEqual([
      { key: "nullable", value: { stringValue: "null" } },
      {
        key: "labels",
        value: {
          arrayValue: {
            values: [
              { stringValue: "alpha" },
              { boolValue: true },
              { kvlistValue: { values: [{ key: "nested", value: { stringValue: "null" } }] } },
              { doubleValue: 2.5 },
              { stringValue: "null" },
              { stringValue: "null" },
            ],
          },
        },
      },
      {
        key: "tool",
        value: {
          kvlistValue: {
            values: [
              { key: "cmd", value: { stringValue: "pnpm" } },
              {
                key: "args",
                value: { arrayValue: { values: [{ stringValue: "test" }, { intValue: "7" }] } },
              },
            ],
          },
        },
      },
    ]);
  });
});

describe("decodeOtlpAttributes", () => {
  it("maps each OTLP value kind, camelCase or snake_case, and coerces int64 strings to numbers", () => {
    expect(
      decodeOtlpAttributes([
        { key: "s", value: { stringValue: "hi" } },
        { key: "snake_s", value: { string_value: "hello" } },
        { key: "b", value: { boolValue: true } },
        { key: "d", value: { doubleValue: 1.5 } },
        { key: "i", value: { intValue: "42" } },
        { key: "snake_i", value: { int_value: "43" } },
        { key: "n", value: { intValue: 7 } },
        { key: "big", value: { intValue: "not-a-number" } },
      ]).attributes,
    ).toEqual({
      s: "hi",
      snake_s: "hello",
      b: true,
      d: 1.5,
      i: 42,
      snake_i: 43,
      n: 7,
      big: "not-a-number",
    });
  });

  it("decodes nested arrays, kvlists and bytes", () => {
    expect(
      decodeOtlpAttributes([
        {
          key: "gen_ai.prompt.messages",
          value: {
            arrayValue: {
              values: [
                {
                  kvlistValue: {
                    values: [
                      { key: "role", value: { stringValue: "system" } },
                      { key: "content", value: { stringValue: "use repo" } },
                    ],
                  },
                },
                {
                  kvlistValue: {
                    values: [
                      { key: "role", value: { stringValue: "user" } },
                      { key: "content", value: { stringValue: "fix EO-286" } },
                    ],
                  },
                },
              ],
            },
          },
        },
        {
          key: "tool.input",
          value: {
            kvlistValue: {
              values: [
                { key: "cmd", value: { stringValue: "pnpm" } },
                {
                  key: "args",
                  value: { arrayValue: { values: [{ stringValue: "test" }, { intValue: "7" }] } },
                },
              ],
            },
          },
        },
        { key: "payload.bytes", value: { bytesValue: "YWJj" } },
      ]).attributes,
    ).toEqual({
      "gen_ai.prompt.messages": [
        { role: "system", content: "use repo" },
        { role: "user", content: "fix EO-286" },
      ],
      "tool.input": { cmd: "pnpm", args: ["test", 7] },
      "payload.bytes": "YWJj",
    });
  });

  it("keeps an unknown future value shape as JSON instead of dropping the key", () => {
    expect(
      decodeOtlpAttributes([
        {
          key: "vendor.future.payload",
          value: {
            vendorValue: { nested: true, score: Number.NaN, items: [{ stringValue: "kept" }] },
          },
        },
      ]).attributes,
    ).toEqual({
      "vendor.future.payload": {
        vendorValue: { nested: true, score: null, items: [{ stringValue: "kept" }] },
      },
    });
  });

  it("reports every value of a repeated key, last one winning", () => {
    expect(
      decodeOtlpAttributes([
        { key: "k", value: { stringValue: "a" } },
        { key: "k", value: { intValue: "2" } },
        { key: "other", value: { boolValue: true } },
      ]),
    ).toEqual({
      attributes: { k: 2, other: true },
      duplicates: { k: ["a", 2] },
    });
  });

  it("returns empty records for an absent or malformed list, and skips keyless entries", () => {
    expect(decodeOtlpAttributes(undefined)).toEqual({ attributes: {}, duplicates: {} });
    expect(decodeOtlpAttributes("nope")).toEqual({ attributes: {}, duplicates: {} });
    expect(
      decodeOtlpAttributes([null, { value: { stringValue: "x" } }, { key: "ok", value: { boolValue: false } }])
        .attributes,
    ).toEqual({ ok: false });
    expect(decodeOtlpAnyValue({ doubleValue: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe("encode then decode", () => {
  it("returns what the producer put in, except null, which reads back as the string null", () => {
    const record = {
      model: "claude-sonnet",
      ok: true,
      tokens: 1234,
      cost: 0.0042,
      tags: ["a", "b"],
      tool: { name: "bash", argv: ["ls", "-la"], exit: 0, nested: { deep: 1.5 } },
      nullable: null,
    };
    expect(decodeOtlpAttributes(toOtlpAttributes(record)).attributes).toEqual({
      ...record,
      nullable: "null",
    });
  });

  it("survives a JSON round trip, the way a collector receives it", () => {
    const encoded = toOtlpAttributes({ n: 9007199254740991, d: 2.25, s: "x" });
    expect(decodeOtlpAttributes(JSON.parse(JSON.stringify(encoded))).attributes).toEqual({
      n: 9007199254740991,
      d: 2.25,
      s: "x",
    });
  });
});

describe("msToUnixNano", () => {
  it("writes whole milliseconds exactly as every producer did", () => {
    expect(msToUnixNano(1_777_680_000_000)).toBe("1777680000000000000");
    expect(msToUnixNano(Date.parse("2026-05-02T00:00:01.000Z"))).toBe("1777680001000000000");
  });

  it("keeps microseconds and floors anything finer", () => {
    expect(msToUnixNano(1_700_000_000_123.4567)).toBe("1700000000123456000");
  });

  it("writes 0 for a time it cannot read", () => {
    expect(msToUnixNano(Number.NaN)).toBe("0");
    expect(msToUnixNano(Date.parse("not a date"))).toBe("0");
  });
});

describe("otlpTraceExport", () => {
  it("wraps spans in one resource and one scope", () => {
    const span = {
      traceId: toW3CTraceId("run-1"),
      spanId: "a".repeat(16),
      name: "root",
      kind: OTLP_SPAN_KIND.INTERNAL,
      startTimeUnixNano: "1",
      endTimeUnixNano: "2",
      attributes: [],
      status: { code: OTLP_STATUS_CODE.OK },
    };
    expect(
      otlpTraceExport(toOtlpAttributes({ "service.name": "svc" }), { name: "scope", version: "1" }, [span]),
    ).toEqual({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
          scopeSpans: [{ scope: { name: "scope", version: "1" }, spans: [span] }],
        },
      ],
    });
  });

  it("re-exports the root package's id rule, not a second one", () => {
    expect(toW3CTraceId).toBe(rootToW3CTraceId);
  });
});

describe("readOtlpPartialSuccess", () => {
  it("reads rejected spans as the int64 string OTLP JSON sends or as a number", () => {
    expect(
      readOtlpPartialSuccess(JSON.stringify({ partialSuccess: { rejectedSpans: "1", errorMessage: "bad span" } })),
    ).toEqual({ rejectedSpans: 1, errorMessage: "bad span" });
    expect(readOtlpPartialSuccess(JSON.stringify({ partialSuccess: { rejectedSpans: 3 } }))).toEqual({
      rejectedSpans: 3,
    });
  });

  it("treats an empty, non-JSON or full-success body as nothing rejected", () => {
    for (const body of ["", "  ", "accepted", "{}", JSON.stringify({ partialSuccess: {} }), "null"]) {
      expect(readOtlpPartialSuccess(body)).toEqual({ rejectedSpans: 0 });
    }
    expect(readOtlpPartialSuccess(JSON.stringify({ partialSuccess: { rejectedSpans: "-2" } }))).toEqual({
      rejectedSpans: 0,
    });
  });
});
