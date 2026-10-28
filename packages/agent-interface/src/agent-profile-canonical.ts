import type { AgentCandidateJsonValue } from "./agent-candidate.js";
import {
  canonicalCandidateJson,
  isWellFormedUnicode,
} from "./agent-candidate-schema-common.js";
import { CONTRACT_MAX_JSON_DEPTH, CONTRACT_MAX_JSON_NODES } from "./contract-limits.js";

type ProfilePath = readonly (string | number)[];

/** Why a value cannot be AgentProfile JSON, with the path of the offending entry. */
export class AgentProfileValueError extends Error {
  constructor(readonly path: ProfilePath, reason: string) {
    super(`AgentProfile ${renderPath(path)} ${reason}`);
    this.name = "AgentProfileValueError";
  }
}

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

/**
 * Throw the path-specific reason a value refused by the bounded admission walker is
 * not profile JSON. Reads no accessor and throws at the contract node and depth
 * bounds, so hostile input stays cheap; returns only when the refusal was a bound
 * this walker does not model, such as string or entry length.
 */
export function assertAgentProfileValue(value: unknown, path: ProfilePath): void {
  normalizeAgentProfileValue(value, path, new Set<object>(), { nodes: CONTRACT_MAX_JSON_NODES, base: path.length });
}

/** Canonical serialization after applying AgentProfile normalization rules. */
export function canonicalAgentProfileJson(value: unknown): string | undefined {
  const normalized = canonicalAgentProfileValue(value);
  return normalized === undefined ? undefined : canonicalCandidateJson(normalized);
}

function normalizeAgentProfileValue(
  value: unknown,
  path: ProfilePath,
  ancestors: Set<object>,
  bounds?: { nodes: number; readonly base: number },
): AgentCandidateJsonValue | undefined {
  const refuse = (reason: string, at: ProfilePath = path) => { throw new AgentProfileValueError(at, reason); };
  if (bounds && --bounds.nodes < 0) refuse("exceeds the contract node bound");
  if (value === undefined || value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : refuse("must be finite");
  if (typeof value !== "object") return refuse("is not JSON serializable");
  if (ancestors.has(value)) refuse("must be acyclic");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) refuse("must be a plain JSON object");
  if (bounds && path.length - bounds.base >= CONTRACT_MAX_JSON_DEPTH) refuse("exceeds the contract depth");
  const nextAncestors = new Set(ancestors).add(value);
  // Entries are read through own data descriptors so refusing a value never runs an accessor.
  const entry = (key: string | number) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return refuse("cannot be a sparse array hole", [...path, key]);
    if (!("value" in descriptor)) return refuse("must be a data property", [...path, key]);
    const normalized = normalizeAgentProfileValue(descriptor.value, [...path, key], nextAncestors, bounds);
    return normalized === undefined && typeof key === "number" ? refuse("cannot be undefined", [...path, key]) : normalized;
  };
  if (Array.isArray(value)) return Array.from({ length: value.length }, (_, index) => entry(index)!);
  const material: Record<string, AgentCandidateJsonValue> = Object.create(null);
  for (const key of Object.keys(value)) {
    if (!isWellFormedUnicode(key)) refuse("has a record key that is not valid Unicode");
    const normalized = entry(key);
    if (normalized !== undefined) {
      Object.defineProperty(material, key, { value: normalized, enumerable: true, configurable: true, writable: true });
    }
  }
  return material;
}

function renderPath(path: ProfilePath): string {
  return path.length === 0 ? "root" : path.join(".");
}
