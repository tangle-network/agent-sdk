import { canonicalAgentProfileValue } from "./agent-profile-canonical.js";
import type { AgentProfile } from "./agent-profile.js";
import { agentProfileSchema } from "./profile-schema.js";

/**
 * Detach, validate, and recursively freeze one AgentProfile at an intake boundary.
 *
 * The returned value is exactly the existing schema output: this function adds no
 * defaults and applies no provider, model, or execution policy. Values outside the
 * existing canonical profile JSON domain fail instead of becoming mutable state.
 */
export function snapshotAgentProfile(value: unknown): AgentProfile {
  const parsed = agentProfileSchema.parse(structuredClone(value));
  canonicalAgentProfileValue(parsed);
  return deepFreeze(parsed);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
