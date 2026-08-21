import { z } from "zod";
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

/**
 * The two fields that identify one durable workspace operation.
 *
 * Every result and lookup answer carries them, so a caller can bind an answer
 * to the exact request it asked before using the resource it names.
 */
export const operationIdentityShape = {
  idempotencyKey: idSchema,
  requestDigest: sha256DigestSchema,
};

/**
 * Refuse a conflict answer that names the request it was asked about.
 *
 * A conflict states that the key is already held by a different request. An
 * answer whose `existingRequestDigest` equals the request's own digest states
 * a conflict with itself, which is a replay, so the caller would retry a
 * request the service already accepted.
 */
export function refuseSelfConflict(
  result: { status: string; requestDigest: string; existingRequestDigest?: string },
  ctx: z.RefinementCtx,
): void {
  if (
    result.status === "conflict" &&
    result.existingRequestDigest === result.requestDigest
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["existingRequestDigest"],
      message: "a conflict must identify a different existing request",
    });
  }
}

/**
 * Whether the resource an answer carries was produced by that same operation.
 *
 * A checkpoint or forked environment repeats the key and digest of the
 * operation that made it. An answer carrying a resource stamped with anything
 * else names a resource the caller did not ask for.
 */
export function operationResourceIdentityMatches(
  operation: { idempotencyKey: string; requestDigest: string },
  resource: { idempotencyKey: string; requestDigest: string },
): boolean {
  return (
    resource.idempotencyKey === operation.idempotencyKey &&
    resource.requestDigest === operation.requestDigest
  );
}
