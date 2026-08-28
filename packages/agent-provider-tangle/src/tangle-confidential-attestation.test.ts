import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_MAX_CONFIDENTIAL_ATTESTATION_QUOTE_LENGTH,
} from "@tangle-network/agent-interface";
import {
  decodeTangleConfidentialAttestationQuote,
  encodeTangleConfidentialAttestationQuote,
  MAX_TEE_EVIDENCE_BYTES,
  MAX_TEE_MEASUREMENT_BYTES,
} from "./tangle-confidential-attestation.js";
import type { TangleConfidentialAttestationReport } from "./tangle-confidential-attestation.js";

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../test/fixtures/aws-nitro-document.cbor",
);
const fixtureEvidence = Array.from(readFileSync(fixturePath));

function report(
  evidence: readonly number[] = fixtureEvidence,
): TangleConfidentialAttestationReport {
  return {
    tee_type: "nitro",
    evidence,
    measurement: Array.from({ length: 48 }, (_, index) => index),
    timestamp: 1_756_368_000,
  };
}

describe("canonical Tangle confidential-attestation quotes", () => {
  it("round-trips the real 4,461-byte Nitro evidence compactly", () => {
    const input = report();
    const quote = encodeTangleConfidentialAttestationQuote(input);

    expect(quote).toBeDefined();
    expect(quote!.length).toBeLessThanOrEqual(
      CONTRACT_MAX_CONFIDENTIAL_ATTESTATION_QUOTE_LENGTH,
    );
    expect(quote).toMatch(/^\{"version":1,"kind":"tangle-sandbox-tee"/u);
    expect(quote).not.toMatch(/\[\d+(?:,\d+)*\]/u);
    expect(decodeTangleConfidentialAttestationQuote(quote)).toEqual({
      ...input,
      evidence: [...input.evidence],
      measurement: [...input.measurement],
    });
  });

  it("keeps every accepted raw field inside the quote bound", () => {
    const maximum: TangleConfidentialAttestationReport = {
      ...report(Array.from({ length: MAX_TEE_EVIDENCE_BYTES }, () => 255)),
      measurement: Array.from(
        { length: MAX_TEE_MEASUREMENT_BYTES },
        () => 255,
      ),
    };
    const quote = encodeTangleConfidentialAttestationQuote(maximum);

    expect(quote).toBeDefined();
    expect(quote!.length).toBeLessThanOrEqual(
      CONTRACT_MAX_CONFIDENTIAL_ATTESTATION_QUOTE_LENGTH,
    );
    expect(decodeTangleConfidentialAttestationQuote(quote)).toEqual(maximum);
    expect(
      encodeTangleConfidentialAttestationQuote({
        ...maximum,
        evidence: [...maximum.evidence, 255],
      }),
    ).toBeUndefined();
  });

  it("rejects legacy, malformed, non-canonical, and oversized quotes", () => {
    const input = report();
    const quote = encodeTangleConfidentialAttestationQuote(input);
    assert(quote);
    const document = JSON.parse(quote) as Record<string, unknown>;

    const malformed = [
      Buffer.from(JSON.stringify(input), "utf8").toString("base64url"),
      JSON.stringify({ ...document, version: 2 }),
      JSON.stringify({ ...document, unknown: true }),
      JSON.stringify({ ...document, evidence: `${document.evidence}= ` }),
      ` ${quote}`,
      JSON.stringify({ ...document, evidence: "A" }),
      "x".repeat(CONTRACT_MAX_CONFIDENTIAL_ATTESTATION_QUOTE_LENGTH + 1),
    ];
    for (const candidate of malformed) {
      expect(decodeTangleConfidentialAttestationQuote(candidate)).toBeUndefined();
    }

    expect(
      encodeTangleConfidentialAttestationQuote({
        ...input,
        unsupported: true,
      } as TangleConfidentialAttestationReport & { unsupported: boolean }),
    ).toBeUndefined();
    expect(
      encodeTangleConfidentialAttestationQuote({
        ...input,
        evidence: [256],
      }),
    ).toBeUndefined();
  });
});
