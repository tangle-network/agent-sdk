import { describe, expect, it } from "vitest";

import {
  deriveHexId,
  ensureNonZeroId,
  isW3CSpanId,
  isW3CTraceId,
  SPAN_ID_HEX_LENGTH,
  TRACE_ID_HEX_LENGTH,
} from "./ids.js";

/** The human ids VerticalBench and the CLI bridge actually mint. */
const REAL_IDS = [
  "audit-run-1",
  "audit-run-1.run",
  "audit-run-1::fhenix-sealed-bid-auction.cell",
  "oc-glm52@generic-fhenix-sealed-bid-auction-r0",
  "oc-glm52@generic-fhenix-sealed-bid-auction-r1",
  "vb/web-grounded/leaf-014/shot-2",
];

function hammingDistance(left: string, right: string): number {
  let bits = 0;
  for (let index = 0; index < left.length; index++) {
    const delta =
      Number.parseInt(left[index] as string, 16) ^
      Number.parseInt(right[index] as string, 16);
    for (let bit = 0; bit < 4; bit++) if ((delta >>> bit) & 1) bits++;
  }
  return bits;
}

describe("deriveHexId shape", () => {
  it("produces ids a W3C traceparent can carry", () => {
    for (const input of REAL_IDS) {
      const traceId = deriveHexId(input, 16);
      const spanId = deriveHexId(input, 8);
      expect(traceId).toHaveLength(TRACE_ID_HEX_LENGTH);
      expect(spanId).toHaveLength(SPAN_ID_HEX_LENGTH);
      expect(isW3CTraceId(traceId)).toBe(true);
      expect(isW3CSpanId(spanId)).toBe(true);
    }
  });

  it("accepts the empty string and long unicode without throwing", () => {
    for (const input of ["", "🙈🙉🙊", "\ud800", "é".repeat(5000)]) {
      expect(isW3CTraceId(deriveHexId(input, 16))).toBe(true);
      expect(isW3CSpanId(deriveHexId(input, 8))).toBe(true);
    }
  });

  it("guards the reserved all-zero id", () => {
    expect(ensureNonZeroId("0".repeat(16))).toBe(`${"0".repeat(15)}1`);
    expect(isW3CSpanId(ensureNonZeroId("0".repeat(16)))).toBe(true);
    expect(ensureNonZeroId("00000000000000000000000000000001")).toBe(
      "00000000000000000000000000000001",
    );
  });
});

describe("deriveHexId stability", () => {
  /**
   * Pinned outputs. Two systems derive an id for the same unit of work without
   * talking to each other, so a change to this function is a change to the WIRE
   * — spans minted before and after would stop joining. These values changing is
   * a contract break, not a test to update.
   */
  it("is pinned, so an emitter upgrading does not orphan yesterday's spans", () => {
    expect(deriveHexId("audit-run-1", 16)).toBe(
      "7a91903a901193487c8e289eaa5c0ebf",
    );
    expect(deriveHexId("audit-run-1", 8)).toBe("516c71b36b7f4b1f");
    expect(deriveHexId("", 16)).toBe("6db0885e96b44f58dff74fdb99f6aa98");
    expect(deriveHexId("oc-glm52@generic-fhenix-sealed-bid-auction-r0", 8)).toBe(
      "142284f1928f8d87",
    );
  });

  it("returns the same id every call and in either order", () => {
    for (const input of REAL_IDS) {
      const first = deriveHexId(input, 16);
      for (let repeat = 0; repeat < 3; repeat++) {
        deriveHexId(`noise-${repeat}`, 8);
        expect(deriveHexId(input, 16)).toBe(first);
      }
    }
  });

  it("hashes UTF-8 bytes, so an encoding difference is not an id difference", () => {
    // A code point built from a surrogate pair and the same code point written
    // literally are one string, and must hash as one string.
    expect(deriveHexId("\u{1f600}", 16)).toBe(deriveHexId("😀", 16));
  });

  it("never returns a non-string result for a non-string argument", () => {
    const notAString = 42 as unknown as string;
    expect(isW3CTraceId(deriveHexId(notAString, 16))).toBe(true);
  });
});

describe("deriveHexId distribution", () => {
  const SAMPLE = 20000;
  const corpus = Array.from(
    { length: SAMPLE },
    (_, index) => `oc-glm52@generic-fhenix-sealed-bid-auction-r${index}`,
  );

  it("has no collisions across 20000 realistic ids, at either width", () => {
    expect(new Set(corpus.map((input) => deriveHexId(input, 16))).size).toBe(
      SAMPLE,
    );
    expect(new Set(corpus.map((input) => deriveHexId(input, 8))).size).toBe(
      SAMPLE,
    );
  });

  it("sets every output bit about half the time", () => {
    const bits = new Array<number>(TRACE_ID_HEX_LENGTH * 4).fill(0);
    for (const input of corpus) {
      const hex = deriveHexId(input, 16);
      for (let nibble = 0; nibble < hex.length; nibble++) {
        const value = Number.parseInt(hex[nibble] as string, 16);
        for (let bit = 0; bit < 4; bit++) {
          if ((value >>> bit) & 1) bits[nibble * 4 + bit] = (bits[nibble * 4 + bit] as number) + 1;
        }
      }
    }
    for (const count of bits) {
      expect(count / SAMPLE).toBeGreaterThan(0.45);
      expect(count / SAMPLE).toBeLessThan(0.55);
    }
  });

  it("flips about half the output bits for a one-character input change", () => {
    let total = 0;
    for (let index = 0; index < 2000; index++) {
      total += hammingDistance(
        deriveHexId(`vb/web-grounded/leaf-${index}/shot-1`, 16),
        deriveHexId(`vb/web-grounded/leaf-${index}/shot-2`, 16),
      );
    }
    const mean = total / 2000 / (TRACE_ID_HEX_LENGTH * 4);
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it("does not make the span id a prefix of the trace id", () => {
    for (const input of REAL_IDS) {
      expect(deriveHexId(input, 16).startsWith(deriveHexId(input, 8))).toBe(
        false,
      );
    }
  });
});

describe("W3C id predicates", () => {
  it("accepts only lowercase hex of the right width, never the all-zero id", () => {
    expect(isW3CTraceId("a".repeat(32))).toBe(true);
    expect(isW3CSpanId("a".repeat(16))).toBe(true);
    expect(isW3CTraceId("A".repeat(32))).toBe(false);
    expect(isW3CTraceId("a".repeat(31))).toBe(false);
    expect(isW3CTraceId("a".repeat(33))).toBe(false);
    expect(isW3CTraceId("0".repeat(32))).toBe(false);
    expect(isW3CSpanId("0".repeat(16))).toBe(false);
    expect(isW3CSpanId("a".repeat(32))).toBe(false);
    expect(isW3CTraceId("audit-run-1")).toBe(false);
    expect(isW3CTraceId(null)).toBe(false);
    expect(isW3CSpanId(undefined)).toBe(false);
    expect(isW3CSpanId(12345)).toBe(false);
  });
});
