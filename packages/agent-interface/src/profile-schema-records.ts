import { z } from "zod";
import { isWellFormedUnicode } from "./agent-candidate-schema-common.js";
import {
  AGENT_PROFILE_JSON_MAX_DEPTH,
  AGENT_PROFILE_JSON_MAX_NODES,
  detachAgentProfileJson,
} from "./agent-profile-safe-json.js";

export const AGENT_PROFILE_RECORD_SCAN_MAX_DEPTH = AGENT_PROFILE_JSON_MAX_DEPTH;
export const AGENT_PROFILE_RECORD_SCAN_MAX_NODES = AGENT_PROFILE_JSON_MAX_NODES;

/** Detach raw model input before any schema conversion can materialize records. */
export function assertSafeAgentProfileModelInput(value: unknown): void {
  detachAgentProfileModelInput(value);
}

export function detachAgentProfileModelInput(value: unknown): unknown {
  return detachAgentProfileJson(value, { rejectPrototypeSensitiveKeys: true });
}

export function validateNestedRecordKeys(
  value: unknown,
  context: z.RefinementCtx,
  path: PropertyKey[],
  seen: Set<object>,
): void {
  const pending: Array<{ value: unknown; path: PropertyKey[] }> = [
    { value, path },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (
      current.value === null ||
      typeof current.value !== "object" ||
      seen.has(current.value)
    ) {
      continue;
    }
    if (current.path.length > AGENT_PROFILE_RECORD_SCAN_MAX_DEPTH) {
      context.addIssue({
        code: "custom",
        path: current.path,
        message: `record nesting exceeds the maximum depth of ${AGENT_PROFILE_RECORD_SCAN_MAX_DEPTH}`,
      });
      continue;
    }
    seen.add(current.value);

    const entries = Object.entries(current.value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, entry] = entries[index]!;
      nodes += 1;
      if (nodes > AGENT_PROFILE_RECORD_SCAN_MAX_NODES) {
        context.addIssue({
          code: "custom",
          path: current.path,
          message: `record input exceeds the maximum node count of ${AGENT_PROFILE_RECORD_SCAN_MAX_NODES}`,
        });
        return;
      }
      const keyPath = [...current.path, key];
      if (!isWellFormedUnicode(key)) {
        context.addIssue({
          code: "custom",
          path: keyPath,
          message: "record keys must contain valid Unicode",
        });
      }
      pending.push({ value: entry, path: keyPath });
    }
  }
}

/** Keep record keys as data while Zod validates the value schema. */
export function ownPropertyRecordSchema<ValueSchema extends z.ZodType>(
  valueSchema: ValueSchema,
): z.ZodType<Record<string, z.output<ValueSchema>>> {
  return z.preprocess(
    encodeOwnRecordKeys,
    z
      .record(
        z
          .string()
          .regex(
            /^u(?:[0-9a-f]{4})*$/,
            "record keys must contain valid Unicode",
          ),
        valueSchema,
      )
      .transform((record) => {
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

function encodeOwnRecordKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const encoded: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    encoded[encodeRecordKey(key)] = entry;
  }
  return encoded;
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
