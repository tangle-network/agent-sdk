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

/** Exact serialized JSON UTF-8 byte count for one string scalar. */
function serializedJsonStringBytes(value: string): number {
  let bytes = 2; // Opening and closing quotes.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      bytes += 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > CONTRACT_MAX_JSON_BYTES) return bytes;
  }
  return bytes;
}

/**
 * Validate provider event and terminal content. Unlike ordinary metadata,
 * content may contain a single large transcript or tool result. It remains
 * finite, plain JSON with the normal structural limits, and its complete JSON
 * representation is capped exactly by UTF-8 bytes.
 */
export function isBoundedEventContentJson(
  value: unknown,
  { omitUndefinedObjectFields = false }: { omitUndefinedObjectFields?: boolean } = {},
): boolean {
  const pending: Array<{
    value: unknown;
    depth: number;
    leave?: boolean;
    omitUndefined?: boolean;
  }> = [
    { value, depth: 0 },
  ];
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const addBytes = (additional: number) => {
    bytes += additional;
    return bytes <= CONTRACT_MAX_JSON_BYTES;
  };
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) continue;
    const current = item.value;
    if (current === undefined && item.omitUndefined === true) continue;
    nodes += 1;
    if (nodes > CONTRACT_MAX_JSON_NODES) return false;
    if (item.leave) {
      ancestors.delete(current as object);
      continue;
    }
    if (current === null) {
      if (!addBytes(4)) return false;
      continue;
    }
    if (typeof current === "boolean") {
      if (!addBytes(current ? 4 : 5)) return false;
      continue;
    }
    if (typeof current === "string") {
      if (!addBytes(serializedJsonStringBytes(current))) return false;
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      if (!addBytes(JSON.stringify(current).length)) return false;
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
      if (!addBytes(2 + Math.max(current.length - 1, 0))) return false;
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Array.prototype && prototype !== null) return false;
      const keys = Reflect.ownKeys(current);
      const entryKeys = keys.filter((key) => key !== "length");
      if (entryKeys.length !== current.length) return false;
      if (entryKeys.some((key) => {
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || index >= current.length || index >= 4_294_967_295;
      })) {
        return false;
      }
      for (const key of entryKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return false;
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries: Array<[string, PropertyDescriptor]> = [];
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string" || key.length > CONTRACT_MAX_IDENTIFIER_LENGTH) return false;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return false;
      if (descriptor.value === undefined && omitUndefinedObjectFields) continue;
      entries.push([key, descriptor]);
      if (entries.length > CONTRACT_MAX_MAP_ENTRIES) return false;
    }
    if (!addBytes(2 + Math.max(entries.length - 1, 0))) return false;
    for (const [key, descriptor] of entries) {
      if (!addBytes(serializedJsonStringBytes(key) + 1)) return false;
      pending.push({
        value: descriptor.value,
        depth: item.depth + 1,
        omitUndefined: omitUndefinedObjectFields,
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

/** One provider event payload or terminal response, bounded as serialized UTF-8 JSON. */
export const boundedEventContentJsonSchema = z.custom<unknown>(
  isBoundedEventContentJson,
  { message: "event content exceeds its serialized byte bound or is not finite JSON" },
);

export const boundedEventContentRecordSchema = z.custom<Record<string, unknown>>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    isBoundedEventContentJson(value),
  { message: "event content exceeds its serialized byte bound or is not a JSON object" },
);

export const boundedEventContentStringSchema = z.custom<string>(
  (value) => typeof value === "string" && isBoundedEventContentJson(value),
  { message: "event content exceeds its serialized byte bound or is not a string" },
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
