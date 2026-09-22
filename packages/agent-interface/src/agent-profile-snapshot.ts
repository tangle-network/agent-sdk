import { canonicalAgentProfileValueDetached } from "./agent-profile-canonical.js";
import type { AgentProfile } from "./agent-profile.js";
import { detachAgentProfileJson } from "./agent-profile-safe-json.js";
import { agentProfileSchema } from "./profile-schema.js";

/**
 * Detach, validate, and recursively freeze one AgentProfile at an intake boundary.
 *
 * The returned value is exactly the existing schema output: this function adds no
 * defaults and applies no provider, model, or execution policy. Values outside the
 * existing canonical profile JSON domain fail instead of becoming mutable state.
 */
export function snapshotAgentProfile(value: unknown): AgentProfile {
  const parsed = agentProfileSchema.parse(
    detachAgentProfileJson(value, { rejectPrototypeSensitiveKeys: true }),
  );
  canonicalAgentProfileValueDetached(parsed);
  return deepFreeze(parsed);
}

function deepFreeze<T>(value: T): T {
  const pending: object[] = [];
  if (value !== null && typeof value === "object") pending.push(value);
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(current);
  }
  return value;
}
