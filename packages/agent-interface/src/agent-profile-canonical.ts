import type { AgentCandidateJsonValue } from "./agent-candidate.js";
import {
  canonicalCandidateJson,
  isWellFormedUnicode,
} from "./agent-candidate-schema-common.js";

/**
 * Normalize profile-shaped data into the canonical JSON domain used for public
 * profile identity. Undefined object entries are omitted; unsupported values,
 * sparse arrays, and cycles are rejected with their profile path.
 *
 * This module is intentionally internal. Public callers should use the
 * profile-level operations that own validation, identity, or diff semantics.
 */
export function canonicalAgentProfileValue(
  value: unknown,
): AgentCandidateJsonValue | undefined {
  return normalizeAgentProfileValue(value, [], new Set<object>());
}

/** Canonical serialization after applying AgentProfile normalization rules. */
export function canonicalAgentProfileJson(value: unknown): string | undefined {
  const normalized = canonicalAgentProfileValue(value);
  return normalized === undefined
    ? undefined
    : canonicalCandidateJson(normalized);
}

function normalizeAgentProfileValue(
  value: unknown,
  path: readonly (string | number)[],
  ancestors: Set<object>,
): AgentCandidateJsonValue | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`AgentProfile ${renderPath(path)} must be finite`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`AgentProfile ${renderPath(path)} is not JSON serializable`);
  }
  if (ancestors.has(value)) {
    throw new Error(`AgentProfile ${renderPath(path)} must be acyclic`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new Error(`AgentProfile ${renderPath(path)} must be a plain JSON object`);
  }
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return Array.from({ length: value.length }, (_, index) => {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new Error(
          `AgentProfile ${renderPath([...path, index])} cannot be a sparse array hole`,
        );
      }
      const entry = value[index];
      const normalized = normalizeAgentProfileValue(
        entry,
        [...path, index],
        nextAncestors,
      );
      if (normalized === undefined) {
        throw new Error(
          `AgentProfile ${renderPath([...path, index])} cannot be undefined`,
        );
      }
      return normalized;
    });
  }
  const material: Record<string, AgentCandidateJsonValue> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (!isWellFormedUnicode(key)) {
      throw new Error(
        `AgentProfile ${renderPath(path)} has a record key that is not valid Unicode`,
      );
    }
    const normalized = normalizeAgentProfileValue(
      entry,
      [...path, key],
      nextAncestors,
    );
    if (normalized !== undefined) {
      Object.defineProperty(material, key, {
        value: normalized,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return material;
}

function renderPath(path: readonly (string | number)[]): string {
  return path.length === 0 ? "root" : path.join(".");
}
