import { describe, expect, it } from "vitest";
import {
  formatServerTiming,
  parseServerTiming,
  parseServerTimingDurations,
} from "../src/server-timing/index.js";

describe("Server-Timing conformance", () => {
  it("preserves quoted separators and escaped characters without inventing stages", () => {
    expect(
      parseServerTiming(
        String.raw`orch.resume;desc="disk, cached; \"ready\"";dur=12.5, total;dur=20`,
      ),
    ).toEqual([
      { name: "orch.resume", desc: 'disk, cached; "ready"', dur: 12.5 },
      { name: "total", dur: 20 },
    ]);
  });

  it("does not end a quoted desc at an escaped quote or backslash pair", () => {
    expect(
      parseServerTiming(String.raw`a;desc="x\", y";dur=1, b;desc="p\\", c;dur=2`),
    ).toEqual([
      { name: "a", desc: 'x", y', dur: 1 },
      { name: "b", desc: "p\\" },
      { name: "c", dur: 2 },
    ]);
  });

  it("uses the first parameter, including a first invalid or incomplete duration", () => {
    expect(
      parseServerTiming(
        'a;dur=3;dur=9, b;dur=bad;dur=9, c;dur;dur=9, d;DESC="first";desc="last"',
      ),
    ).toEqual([
      { name: "a", dur: 3 },
      { name: "b" },
      { name: "c" },
      { name: "d", desc: "first" },
    ]);
  });

  it("keeps absent and malformed measurements distinct from a measured zero", () => {
    expect(
      parseServerTimingDurations(
        "missing, empty;dur=, bad;dur=12oops, hex;dur=0x10, infinite;dur=1e999, zero;dur=0, tiny;dur=.25, signed;dur=-2",
      ),
    ).toEqual({ zero: 0, tiny: 0.25, signed: -2 });
    expect(parseServerTimingDurations(undefined)).toEqual({});
    expect(parseServerTiming(null)).toEqual([]);
  });

  it("preserves repeated metrics in entries and the last-metric ledger policy", () => {
    expect(parseServerTiming("a;dur=1, a;dur=2")).toEqual([
      { name: "a", dur: 1 },
      { name: "a", dur: 2 },
    ]);
    expect(parseServerTimingDurations("a;dur=1, a;dur=2")).toEqual({ a: 2 });
  });

  it("treats special property names as measured data without mutating prototypes", () => {
    const ledger = parseServerTimingDurations(
      "__proto__;dur=2, constructor;dur=3",
    );
    expect(Object.getPrototypeOf(ledger)).toBe(Object.prototype);
    expect(Object.entries(ledger)).toEqual([
      ["__proto__", 2],
      ["constructor", 3],
    ]);
  });

  it("accepts whitespace and quoted numeric values while rejecting invalid metric names", () => {
    expect(
      parseServerTiming(' stage ; DUR = "1.5" ; unknown=value, bad name;dur=2'),
    ).toEqual([{ name: "stage", dur: 1.5 }]);
  });

  it("skips an unterminated quoted desc instead of throwing", () => {
    expect(parseServerTiming('a;desc="open, b;dur=2')).toEqual([{ name: "a" }]);
  });

  it("formats a header that parses back, escaping quotes and backslashes", () => {
    const entries = [
      { name: "admission", dur: 12.34 },
      { name: "warm.boot", dur: 5, desc: 'say "hi", a\\b; ok' },
      { name: "bad name", dur: 1 },
    ];
    const header = formatServerTiming(entries);
    expect(header).toBe(
      String.raw`admission;dur=12.3, warm.boot;dur=5;desc="say \"hi\", a\\b; ok"`,
    );
    expect(parseServerTiming(header)).toEqual([
      { name: "admission", dur: 12.3 },
      { name: "warm.boot", dur: 5, desc: 'say "hi", a\\b; ok' },
    ]);
  });

  it("bounds a formatted header to 32 metrics and 120-character descriptions", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `m${i}` }));
    expect(parseServerTiming(formatServerTiming(many))).toHaveLength(32);
    const [entry] = parseServerTiming(
      formatServerTiming([{ name: "a", desc: "x".repeat(300) }]),
    );
    expect(entry?.desc).toHaveLength(120);
  });
});
