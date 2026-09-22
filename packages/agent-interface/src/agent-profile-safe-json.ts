import { isWellFormedUnicode } from "./agent-profile-unicode.js";
import {
  AGENT_PROFILE_JSON_MAX_DEPTH,
  AGENT_PROFILE_JSON_MAX_NODES,
  AGENT_PROFILE_JSON_MAX_STRING_BYTES,
  AGENT_PROFILE_JSON_MAX_TOTAL_BYTES,
  AgentProfileJsonError,
} from "./agent-profile-safe-json-limits.js";
import {
  appendAgentProfileJsonPath,
  inspectStableObject,
  renderAgentProfileJsonPath,
  type AgentProfileJsonPath,
} from "./agent-profile-safe-json-objects.js";

export {
  AGENT_PROFILE_JSON_MAX_DEPTH,
  AGENT_PROFILE_JSON_MAX_NODES,
  AGENT_PROFILE_JSON_MAX_FIELDS,
  AGENT_PROFILE_JSON_MAX_ITEMS,
  AGENT_PROFILE_JSON_MAX_STRING_BYTES,
  AGENT_PROFILE_JSON_MAX_TOTAL_BYTES,
  AgentProfileJsonError,
} from "./agent-profile-safe-json-limits.js";
export type { AgentProfileJsonErrorCode } from "./agent-profile-safe-json-limits.js";

export interface DetachAgentProfileJsonOptions {
  rejectPrototypeSensitiveKeys?: boolean;
}

interface PendingValue {
  readonly source: unknown;
  readonly path: AgentProfileJsonPath | undefined;
  readonly parent: Record<string, unknown> | unknown[] | null;
  readonly key: string | number | undefined;
}

/**
 * Detach one value with bounded, descriptor-only reads.
 *
 * The source is never read after its detached children have been scheduled.
 * A second own-key and descriptor observation rejects proxies that change the
 * view between observations instead of letting a later schema pass see a new
 * value.
 */
export function detachAgentProfileJson(
  value: unknown,
  options: DetachAgentProfileJsonOptions = {},
): unknown {
  const seen = new Set<object>();
  const pending: PendingValue[] = [
    { source: value, path: undefined, parent: null, key: undefined },
  ];
  const encoder = new TextEncoder();
  let root: unknown;
  let nodes = 0;
  let totalBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    const path = renderAgentProfileJsonPath(current.path);
    const depth = current.path?.depth ?? 0;
    if (depth > AGENT_PROFILE_JSON_MAX_DEPTH) {
      throw new AgentProfileJsonError(
        "depth-limit",
        path,
        `exceeds the maximum JSON depth of ${AGENT_PROFILE_JSON_MAX_DEPTH}`,
      );
    }

    nodes += 1;
    if (nodes > AGENT_PROFILE_JSON_MAX_NODES) {
      throw new AgentProfileJsonError(
        "node-limit",
        path,
        `exceeds the maximum JSON node count of ${AGENT_PROFILE_JSON_MAX_NODES}`,
      );
    }
    totalBytes = addBytes(totalBytes, 1, path);

    const primitive = detachPrimitive(
      current.source,
      path,
      encoder,
      (bytes) => {
        totalBytes = addBytes(totalBytes, bytes, path);
      },
    );
    if (primitive.handled) {
      assignDetached(current, primitive.value, (value) => {
        root = value;
      });
      continue;
    }

    const source = current.source as object;
    if (seen.has(source)) {
      throw new AgentProfileJsonError(
        "shared-reference",
        path,
        "must be acyclic and must not contain shared object references",
      );
    }
    seen.add(source);

    const stable = inspectStableObject(
      source,
      current.path,
      options.rejectPrototypeSensitiveKeys === true,
      encoder,
      (bytes) => {
        totalBytes = addBytes(totalBytes, bytes, path);
      },
    );
    const target: Record<string, unknown> | unknown[] = stable.array
      ? new Array(stable.length)
      : {};
    assignDetached(current, target, (value) => {
      root = value;
    });

    if (stable.array) {
      for (let index = stable.properties.length - 1; index >= 0; index -= 1) {
        const property = stable.properties[index]!;
        pending.push({
          source: property.value,
          path: appendAgentProfileJsonPath(current.path, index),
          parent: target,
          key: index,
        });
      }
      continue;
    }

    for (let index = stable.properties.length - 1; index >= 0; index -= 1) {
      const property = stable.properties[index]!;
      pending.push({
        source: property.value,
        path: appendAgentProfileJsonPath(current.path, property.key),
        parent: target,
        key: property.key,
      });
    }
  }

  return root;
}

/** Validate a programmatic profile before any recursive identity operation. */
export function assertBoundedAgentProfileJson(value: unknown): void {
  detachAgentProfileJson(value);
}

function detachPrimitive(
  value: unknown,
  path: string,
  encoder: TextEncoder,
  accountBytes: (bytes: number) => void,
): { handled: true; value: unknown } | { handled: false } {
  if (value === undefined || value === null || typeof value === "boolean") {
    return { handled: true, value };
  }
  if (typeof value === "string") {
    if (!isWellFormedUnicode(value)) {
      throw new AgentProfileJsonError(
        "invalid-unicode",
        path,
        "contains malformed Unicode",
      );
    }
    const bytes = encoder.encode(value).byteLength;
    if (bytes > AGENT_PROFILE_JSON_MAX_STRING_BYTES) {
      throw new AgentProfileJsonError(
        "string-limit",
        path,
        `exceeds the maximum string size of ${AGENT_PROFILE_JSON_MAX_STRING_BYTES} bytes`,
      );
    }
    accountBytes(bytes);
    return { handled: true, value };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AgentProfileJsonError(
        "invalid-number",
        path,
        "must be finite",
      );
    }
    return { handled: true, value };
  }
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new AgentProfileJsonError(
      "unsupported-value",
      path,
      "is not in the supported JSON value domain",
    );
  }
  if (typeof value !== "object") {
    throw new AgentProfileJsonError(
      "unsupported-value",
      path,
      "is not in the supported JSON value domain",
    );
  }
  return { handled: false };
}

function assignDetached(
  pending: PendingValue,
  value: unknown,
  setRoot: (value: unknown) => void,
): void {
  if (pending.parent === null) {
    setRoot(value);
    return;
  }
  Object.defineProperty(pending.parent, pending.key!, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function addBytes(current: number, additional: number, path: string): number {
  const next = current + additional;
  if (next > AGENT_PROFILE_JSON_MAX_TOTAL_BYTES) {
    throw new AgentProfileJsonError(
      "byte-limit",
      path,
      `exceeds the maximum JSON size of ${AGENT_PROFILE_JSON_MAX_TOTAL_BYTES} bytes`,
    );
  }
  return next;
}
