import { z } from "zod";
import { CONTRACT_MAX_IDENTIFIER_LENGTH, CONTRACT_MAX_MAP_ENTRIES } from "./contract-limits.js";
import { isWellFormedUnicode } from "./agent-candidate-schema-common.js";
import { AgentProfileValueError } from "./agent-profile-canonical.js";

/**
 * Zod records currently assign parsed values onto an ordinary object. The
 * special own key `__proto__` therefore invokes the legacy prototype setter
 * and disappears instead of being validated. Encode every own key before Zod
 * sees it, then restore the exact UTF-16 key with defineProperty so all string
 * keys allowed by `Record<string, ...>` remain data rather than object syntax.
 */
export function ownPropertyRecordSchema<ValueSchema extends z.ZodType>(
  valueSchema: ValueSchema,
  { maxEntries = CONTRACT_MAX_MAP_ENTRIES, prepareValue }: {
    maxEntries?: number;
    prepareValue?: (key: string, value: unknown) => unknown;
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
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) {
          context.addIssue({ code: "custom", message: "record entries must be data properties" });
          return z.NEVER;
        }
        let entry: unknown;
        try {
          entry = prepareValue ? prepareValue(key, descriptor.value) : descriptor.value;
        } catch (error) {
          // Only a profile-value refusal is a validation issue; any other throw is a defect.
          if (!(error instanceof AgentProfileValueError)) throw error;
          context.addIssue({ code: "custom", path: [...error.path], message: error.message });
          return z.NEVER;
        }
        if (entry === z.NEVER) {
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
    // Issues carry the encoded key Zod saw; report the caller's key. `when` runs this after value issues too.
    ).superRefine((_record, context) => {
      for (const issue of context.issues) {
        const key = issue.path?.[0];
        if (typeof key === "string" && /^[ui](?:[0-9a-f]{4})*$/.test(key)) issue.path![0] = decodeRecordKey(key);
      }
    }, { when: () => true }).transform((record) => {
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
