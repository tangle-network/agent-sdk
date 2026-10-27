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

/** Admit ordinary JSON before recursive parsing, copying or hashing. */
export function isBoundedJsonValue(value: unknown): boolean {
  return boundedJson(value);
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

/** Event content permits large strings within the exact serialized UTF-8 budget. */
export function isBoundedEventContentJson(
  value: unknown,
  { omitUndefinedObjectFields = false }: { omitUndefinedObjectFields?: boolean } = {},
): boolean {
  return boundedJson(value, { content: true, omitUndefinedObjectFields });
}

/**
 * Digest material omits undefined object fields; portable profile values require data properties.
 * `content` bounds strings by the serialized UTF-8 budget instead of each string's length, for
 * opaque values that may legitimately copy unbounded typed fields such as inline file content.
 */
export function isBoundedJsonMaterial(
  value: unknown,
  { dataPropertiesOnly = false, content = false }: { dataPropertiesOnly?: boolean; content?: boolean } = {},
): boolean {
  return boundedJson(value, { material: true, omitUndefinedObjectFields: true, dataPropertiesOnly, content });
}

/** One iterative walker owns structural admission; typed domains keep their own schema limits. */
function boundedJson(value: unknown, options: {
  content?: boolean;
  material?: boolean;
  omitUndefinedObjectFields?: boolean;
  dataPropertiesOnly?: boolean;
} = {}): boolean {
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
  const addBytes = (count: number) => !options.content || (bytes += count) <= CONTRACT_MAX_JSON_BYTES;
  while (pending.length) {
    const item = pending.pop()!;
    const current = item.value;
    if ((!item.leave || !options.material) && ++nodes > CONTRACT_MAX_JSON_NODES) return false;
    if (current === undefined && item.omitUndefined) continue;
    if (item.leave) {
      ancestors.delete(current as object);
      continue;
    }
    if (current === null || typeof current === "boolean") {
      if (!addBytes(current === null ? 4 : current ? 4 : 5)) return false;
      continue;
    }
    if (typeof current === "string") {
      if (options.content ? !addBytes(serializedJsonStringBytes(current)) : current.length > CONTRACT_MAX_STRING_LENGTH) return false;
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || !addBytes(JSON.stringify(current).length)) return false;
      continue;
    }
    if (typeof current !== "object" || item.depth >= CONTRACT_MAX_JSON_DEPTH || ancestors.has(current)) return false;
    ancestors.add(current);
    pending.push({ value: current, depth: item.depth, leave: true });
    const array = Array.isArray(current);
    if (array && current.length > CONTRACT_MAX_ARRAY_LENGTH) return false;
    const prototype = Object.getPrototypeOf(current);
    if ((!array && prototype !== Object.prototype && prototype !== null) ||
        (array && options.content && prototype !== Array.prototype && prototype !== null)) return false;
    if (options.content || options.dataPropertiesOnly) {
      const keys = Reflect.ownKeys(current).filter((key) => !array || key !== "length");
      if (array ? keys.length !== current.length : keys.length > CONTRACT_MAX_MAP_ENTRIES) return false;
      let entries = 0;
      for (const key of keys) {
        if (typeof key !== "string" || (!array && key.length > CONTRACT_MAX_IDENTIFIER_LENGTH)) return false;
        if (array && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= current.length || Number(key) >= 4_294_967_295)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) return false;
        if (!array && descriptor.value === undefined && options.omitUndefinedObjectFields) {
          if (++nodes > CONTRACT_MAX_JSON_NODES) return false;
          continue;
        }
        if (++entries > (array ? CONTRACT_MAX_ARRAY_LENGTH : CONTRACT_MAX_MAP_ENTRIES)) return false;
        if (!array && !addBytes(serializedJsonStringBytes(key) + 1)) return false;
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
      if (!addBytes(2 + Math.max(entries - 1, 0))) return false;
    } else if (array) {
      for (const entry of current) pending.push({ value: entry, depth: item.depth + 1 });
    } else {
      const keys = Object.keys(current);
      if (keys.length > CONTRACT_MAX_MAP_ENTRIES) return false;
      for (const key of keys) {
        if (key.length > CONTRACT_MAX_IDENTIFIER_LENGTH) return false;
        pending.push({
          value: (current as Record<string, unknown>)[key],
          depth: item.depth + 1,
          omitUndefined: options.omitUndefinedObjectFields,
        });
      }
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
