import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import { canonicalCandidateDigest, sha256DigestSchema } from "./agent-candidate-schema-common.js";
import {
  assertBoundedJson,
  assertBoundedSerializedJson,
  boundedIdentifierSchema,
  boundedJsonSchema,
  boundedJsonRecordSchema,
  boundedStringSchema,
  CONTRACT_MAX_ARRAY_LENGTH,
  isBoundedJsonMaterial,
} from "./contract-limits.js";
import type { BackendMessage } from "./backend-message.js";
import type { InputPart } from "./parts.js";

export { sha256DigestSchema };

export const idSchema = boundedIdentifierSchema;
export const jsonRecordSchema = boundedJsonRecordSchema;

export function wireDigest(value: unknown): Sha256Digest {
  if (!isBoundedJsonMaterial(value)) {
    throw new Error("operation material exceeds the contract bounds");
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("portable context material must be JSON serializable");
  assertBoundedSerializedJson(serialized);
  const normalized = JSON.parse(serialized) as unknown;
  assertBoundedJson(normalized);
  return canonicalCandidateDigest(normalized);
}

export const InputPartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: boundedStringSchema }),
  z.strictObject({
    type: z.literal("file"),
    filename: boundedStringSchema.optional(),
    mediaType: boundedStringSchema.optional(),
    url: boundedStringSchema.optional(),
    path: boundedStringSchema.optional(),
    content: boundedStringSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("image"),
    filename: boundedStringSchema.optional(),
    mediaType: boundedStringSchema.optional(),
    url: boundedStringSchema.optional(),
    path: boundedStringSchema.optional(),
  }),
]) satisfies z.ZodType<InputPart>;

export const BackendMessageSchema = z.strictObject({
  id: idSchema,
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(boundedJsonSchema).max(CONTRACT_MAX_ARRAY_LENGTH),
  timestamp: z.iso.datetime().max(64),
  metadata: jsonRecordSchema.optional(),
}) satisfies z.ZodType<BackendMessage>;

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
