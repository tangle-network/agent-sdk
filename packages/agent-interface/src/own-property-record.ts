import { z } from "zod";
import { CONTRACT_MAX_IDENTIFIER_LENGTH, CONTRACT_MAX_MAP_ENTRIES } from "./contract-limits.js";
import { isWellFormedUnicode } from "./agent-candidate-schema-common.js";

/**
 * Zod records currently assign parsed values onto an ordinary object. The
 * special own key `__proto__` therefore invokes the legacy prototype setter
 * and disappears instead of being validated. Encode every own key before Zod
 * sees it, then restore the exact UTF-16 key with defineProperty so all string
 * keys allowed by `Record<string, ...>` remain data rather than object syntax.
 */
export function ownPropertyRecordSchema<ValueSchema extends z.ZodType>(
  valueSchema: ValueSchema,
  { maxEntries = CONTRACT_MAX_MAP_ENTRIES, admitValue }: {
    maxEntries?: number;
    admitValue?: (key: string, value: unknown) => boolean;
  } = {},
): z.ZodType<Record<string, z.output<ValueSchema>>> {
  return z.preprocess(
    (value, context) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return [];
      let entries = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (++entries > maxEntries || key.length > CONTRACT_MAX_IDENTIFIER_LENGTH) {
          context.addIssue({ code: "custom", message: "record exceeds the contract bounds" });
          return z.NEVER;
        }
      }
      const encoded: Record<string, unknown> = Object.create(null);
      for (const [key, entry] of Object.entries(value)) {
        if (admitValue && !admitValue(key, entry)) {
          context.addIssue({ code: "custom", message: "record value exceeds the contract bounds or is not portable JSON" });
          return z.NEVER;
        }
        encoded[encodeRecordKey(key)] = entry;
      }
      return encoded;
    },
    z.record(
      z
        .string()
        .regex(
          /^u(?:[0-9a-f]{4})*$/,
          "record keys must contain valid Unicode",
        ),
      valueSchema,
    ).transform((record) => {
      const restored: Record<string, z.output<ValueSchema>> = {};
      for (const [encodedKey, value] of Object.entries(record)) {
        Object.defineProperty(restored, decodeRecordKey(encodedKey), {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return restored;
    }),
  ) as z.ZodType<Record<string, z.output<ValueSchema>>>;
}

function encodeRecordKey(value: string): string {
  let encoded = isWellFormedUnicode(value) ? "u" : "i";
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

function decodeRecordKey(value: string): string {
  let decoded = "";
  for (let index = 1; index < value.length; index += 4) {
    decoded += String.fromCharCode(
      Number.parseInt(value.slice(index, index + 4), 16),
    );
  }
  return decoded;
}
