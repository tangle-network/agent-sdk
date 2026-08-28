import { z } from "zod";

/** Limits applied before a value is hashed, copied, or sent to a provider. */
export const CONTRACT_MAX_STRING_LENGTH = 16_384;
/** Maximum length of one canonical confidential-attestation quote. */
export const CONTRACT_MAX_CONFIDENTIAL_ATTESTATION_QUOTE_LENGTH = 32_768;
export const CONTRACT_MAX_IDENTIFIER_LENGTH = 512;
export const CONTRACT_MAX_ARRAY_LENGTH = 1_024;
export const CONTRACT_MAX_MAP_ENTRIES = 256;
export const CONTRACT_MAX_JSON_DEPTH = 16;
export const CONTRACT_MAX_JSON_BYTES = 1_048_576;
export const CONTRACT_MAX_JSON_NODES = 8_192;

export const boundedStringSchema = z.string().max(CONTRACT_MAX_STRING_LENGTH);
export const confidentialAttestationQuoteSchema = z
  .string()
  .max(CONTRACT_MAX_CONFIDENTIAL_ATTESTATION_QUOTE_LENGTH);
export const boundedIdentifierSchema = boundedStringSchema
  .min(1)
  .max(CONTRACT_MAX_IDENTIFIER_LENGTH)
  .refine(
    (value) => value.trim() === value,
    "identifier cannot have outer whitespace",
  );

/**
 * Validate JSON without asking Zod to recursively copy an attacker-sized
 * value. This is intentionally iterative so depth and collection limits are
 * checked before canonical serialization.
 */
export function isBoundedJsonValue(value: unknown): boolean {
  const pending: Array<{
    value: unknown;
    depth: number;
    leave?: boolean;
  }> = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) continue;
    nodes += 1;
    if (nodes > CONTRACT_MAX_JSON_NODES) return false;
    const current = item.value;
    if (item.leave) {
      ancestors.delete(current as object);
      continue;
    }
    if (current === undefined) return false;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string") {
      if (current.length > CONTRACT_MAX_STRING_LENGTH) return false;
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== "object" || item.depth >= CONTRACT_MAX_JSON_DEPTH) {
      return false;
    }
    if (ancestors.has(current)) return false;
    ancestors.add(current);
    pending.push({ value: current, depth: item.depth, leave: true });
    if (Array.isArray(current)) {
      if (current.length > CONTRACT_MAX_ARRAY_LENGTH) return false;
      for (const entry of current) {
        pending.push({ value: entry, depth: item.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Object.keys(current);
    if (keys.length > CONTRACT_MAX_MAP_ENTRIES) return false;
    for (const key of keys) {
      if (key.length > CONTRACT_MAX_IDENTIFIER_LENGTH) return false;
      pending.push({
        value: (current as Record<string, unknown>)[key],
        depth: item.depth + 1,
      });
    }
  }
  return true;
}

/** Validate digest input while matching JSON's omission of undefined object fields. */
export function isBoundedJsonMaterial(value: unknown): boolean {
  const pending: Array<{
    value: unknown;
    depth: number;
    omitUndefined?: boolean;
    leave?: boolean;
  }> = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) continue;
    if (item.leave) {
      ancestors.delete(item.value as object);
      continue;
    }
    if (item.value === undefined) {
      if (item.omitUndefined === true) continue;
      return false;
    }
    nodes += 1;
    if (nodes > CONTRACT_MAX_JSON_NODES) return false;
    const current = item.value;
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string") {
      if (current.length > CONTRACT_MAX_STRING_LENGTH) return false;
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== "object" || item.depth >= CONTRACT_MAX_JSON_DEPTH) {
      return false;
    }
    if (ancestors.has(current)) return false;
    ancestors.add(current);
    pending.push({ value: current, depth: item.depth, leave: true });
    if (Array.isArray(current)) {
      if (current.length > CONTRACT_MAX_ARRAY_LENGTH) return false;
      for (const entry of current) {
        pending.push({ value: entry, depth: item.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Object.keys(current);
    if (keys.length > CONTRACT_MAX_MAP_ENTRIES) return false;
    for (const key of keys) {
      if (key.length > CONTRACT_MAX_IDENTIFIER_LENGTH) return false;
      pending.push({
        value: (current as Record<string, unknown>)[key],
        depth: item.depth + 1,
        omitUndefined: true,
      });
    }
  }
  return true;
}

export const boundedJsonSchema = z.custom<unknown>(
  isBoundedJsonValue,
  {
  message: "value exceeds the contract bounds or is not finite JSON",
  },
);

export const boundedJsonRecordSchema = z.custom<Record<string, unknown>>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    isBoundedJsonValue(value),
  { message: "metadata exceeds the contract bounds or is not a JSON object" },
);

export function assertBoundedJson(value: unknown): void {
  if (!isBoundedJsonValue(value)) {
    throw new Error("value exceeds the contract bounds or is not finite JSON");
  }
}

export function assertBoundedSerializedJson(value: string): void {
  if (new TextEncoder().encode(value).byteLength > CONTRACT_MAX_JSON_BYTES) {
    throw new Error("serialized contract material exceeds its byte bound");
  }
}

/** Copy arbitrary metadata into a map that cannot inherit prototype keys. */
export function nullPrototypeRecord<T>(value: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = Object.create(null) as Record<string, T>;
  for (const key of Object.keys(value)) result[key] = value[key] as T;
  return result;
}

export function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
