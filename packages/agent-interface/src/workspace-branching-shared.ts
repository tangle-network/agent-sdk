import type { Sha256Digest } from "./agent-candidate.js";
import { canonicalCandidateDigest, sha256DigestSchema } from "./agent-candidate-schema-common.js";
import {
  assertBoundedSerializedJson,
  boundedIdentifierSchema,
  boundedJsonRecordSchema,
  isBoundedJsonMaterial,
} from "./contract-limits.js";

export { sha256DigestSchema };

export const idSchema = boundedIdentifierSchema;
export const jsonRecordSchema = boundedJsonRecordSchema;

export function wireDigest(value: unknown): Sha256Digest {
  if (!isBoundedJsonMaterial(value)) {
    throw new Error("operation material exceeds the contract bounds");
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("operation material must be JSON serializable");
  assertBoundedSerializedJson(serialized);
  return canonicalCandidateDigest(JSON.parse(serialized) as unknown);
}

export function sameOptionalWireValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return wireDigest(left) === wireDigest(right);
}
