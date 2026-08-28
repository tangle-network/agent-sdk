import {
  CONTRACT_MAX_CONFIDENTIAL_ATTESTATION_QUOTE_LENGTH,
} from "@tangle-network/agent-interface";
import type { SandboxTeeAttestationReportLike } from "./tangle-types.js";

/** Version of the canonical opaque quote carried by a confidential attestation. */
export const TANGLE_CONFIDENTIAL_ATTESTATION_QUOTE_VERSION = 1 as const;
/** Kind discriminator prevents this codec from accepting another quote format. */
export const TANGLE_CONFIDENTIAL_ATTESTATION_QUOTE_KIND =
  "tangle-sandbox-tee" as const;

/** Raw evidence bound before it can enter a portable attestation. */
export const MAX_TEE_EVIDENCE_BYTES = 16_384;
/** Raw measurement bound before it can enter a portable attestation. */
export const MAX_TEE_MEASUREMENT_BYTES = 256;
const MAX_TEE_TYPE_LENGTH = 64;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const QUOTE_KEYS = [
  "version",
  "kind",
  "tee_type",
  "evidence",
  "measurement",
  "timestamp",
] as const;

/** Read-only report shape accepted by the quote encoder. */
export interface TangleConfidentialAttestationReport {
  readonly tee_type: string;
  readonly evidence: readonly number[];
  readonly measurement: readonly number[];
  readonly timestamp: number;
}

interface TangleConfidentialAttestationQuoteDocument {
  readonly version: typeof TANGLE_CONFIDENTIAL_ATTESTATION_QUOTE_VERSION;
  readonly kind: typeof TANGLE_CONFIDENTIAL_ATTESTATION_QUOTE_KIND;
  readonly tee_type: string;
  readonly evidence: string;
  readonly measurement: string;
  readonly timestamp: number;
}

/**
 * Encode a Sandbox TEE report without decimal JSON byte arrays.
 *
 * The returned JSON uses a fixed key order and unpadded base64url byte fields.
 * `undefined` means the report is not a valid bounded report or the quote does
 * not fit the shared confidential-attestation field.
 */
export function encodeTangleConfidentialAttestationQuote(
  report: TangleConfidentialAttestationReport,
): string | undefined {
  if (!validReportShape(report)) return undefined;
  const document: TangleConfidentialAttestationQuoteDocument = {
    version: TANGLE_CONFIDENTIAL_ATTESTATION_QUOTE_VERSION,
    kind: TANGLE_CONFIDENTIAL_ATTESTATION_QUOTE_KIND,
    tee_type: report.tee_type,
    evidence: bytesToBase64url(report.evidence),
    measurement: bytesToBase64url(report.measurement),
    timestamp: report.timestamp,
  };
  const quote = JSON.stringify(document);
  return quote.length <= CONTRACT_MAX_CONFIDENTIAL_ATTESTATION_QUOTE_LENGTH
    ? quote
    : undefined;
}

/**
 * Decode and canonicalize a provider quote.
 *
 * The parser rejects old numeric-array quotes, unknown fields, non-canonical
 * JSON, malformed base64url, and reports outside the provider bounds.
 */
export function decodeTangleConfidentialAttestationQuote(
  quote: unknown,
): SandboxTeeAttestationReportLike | undefined {
  if (
    typeof quote !== "string" ||
    quote.length === 0 ||
    quote.length > CONTRACT_MAX_CONFIDENTIAL_ATTESTATION_QUOTE_LENGTH
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(quote) as unknown;
  } catch {
    return undefined;
  }
  const document = quoteDocument(parsed);
  if (document === undefined) return undefined;
  const report = reportFromDocument(document);
  if (report === undefined) return undefined;
  return encodeTangleConfidentialAttestationQuote(report) === quote
    ? report
    : undefined;
}

function validReportShape(
  report: TangleConfidentialAttestationReport,
): report is TangleConfidentialAttestationReport {
  if (!isPlainObject(report)) return false;
  if (!hasExactKeys(report, ["tee_type", "evidence", "measurement", "timestamp"])) {
    return false;
  }
  return (
    validTeeType(report.tee_type) &&
    validBytes(report.evidence, MAX_TEE_EVIDENCE_BYTES) &&
    validBytes(report.measurement, MAX_TEE_MEASUREMENT_BYTES) &&
    Number.isSafeInteger(report.timestamp) &&
    report.timestamp > 0
  );
}

function quoteDocument(
  value: unknown,
): TangleConfidentialAttestationQuoteDocument | undefined {
  if (!isPlainObject(value) || !hasExactKeys(value, QUOTE_KEYS)) return undefined;
  const candidate = value as Record<string, unknown>;
  const teeType = candidate.tee_type;
  const evidenceValue = candidate.evidence;
  const measurementValue = candidate.measurement;
  const timestamp = candidate.timestamp;
  if (
    candidate.version !== TANGLE_CONFIDENTIAL_ATTESTATION_QUOTE_VERSION ||
    candidate.kind !== TANGLE_CONFIDENTIAL_ATTESTATION_QUOTE_KIND ||
    !validTeeType(teeType) ||
    typeof evidenceValue !== "string" ||
    typeof measurementValue !== "string" ||
    typeof timestamp !== "number" ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0
  ) {
    return undefined;
  }
  const evidence = base64urlToBytes(evidenceValue, MAX_TEE_EVIDENCE_BYTES);
  const measurement = base64urlToBytes(
    measurementValue,
    MAX_TEE_MEASUREMENT_BYTES,
  );
  if (evidence === undefined || measurement === undefined) return undefined;
  return {
    version: TANGLE_CONFIDENTIAL_ATTESTATION_QUOTE_VERSION,
    kind: TANGLE_CONFIDENTIAL_ATTESTATION_QUOTE_KIND,
    tee_type: teeType,
    evidence: evidenceValue,
    measurement: measurementValue,
    timestamp,
  };
}

function reportFromDocument(
  document: TangleConfidentialAttestationQuoteDocument,
): SandboxTeeAttestationReportLike | undefined {
  const evidence = base64urlToBytes(document.evidence, MAX_TEE_EVIDENCE_BYTES);
  const measurement = base64urlToBytes(
    document.measurement,
    MAX_TEE_MEASUREMENT_BYTES,
  );
  if (evidence === undefined || measurement === undefined) return undefined;
  const report = {
    tee_type: document.tee_type,
    evidence: Array.from(evidence),
    measurement: Array.from(measurement),
    timestamp: document.timestamp,
  } satisfies SandboxTeeAttestationReportLike;
  return validReportShape(report) ? report : undefined;
}

function validTeeType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TEE_TYPE_LENGTH &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validBytes(value: unknown, maxLength: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.every(
      (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
    )
  );
}

function bytesToBase64url(bytes: readonly number[]): string {
  return Buffer.from(Uint8Array.from(bytes)).toString("base64url");
}

function base64urlToBytes(value: string, maxLength: number): Uint8Array | undefined {
  if (value.length === 0 || !BASE64URL_PATTERN.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length === 0 ||
    bytes.length > maxLength ||
    bytes.toString("base64url") !== value
  ) {
    return undefined;
  }
  return bytes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
