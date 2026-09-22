import type { Sha256Digest } from "./agent-candidate.js";
import {
  canonicalCandidateDigest,
  isCanonicalJsonValue,
} from "./agent-candidate-schema-common.js";
import { canonicalAgentProfileValueDetached } from "./agent-profile-canonical.js";
import { detachAgentProfileJson } from "./agent-profile-safe-json.js";
import type { AgentProfile } from "./agent-profile.js";
import { agentProfileSchema } from "./profile-schema.js";

/** Canonical RFC 8785/SHA-256 identity for one validated public profile. */
export function canonicalAgentProfileDigest(
  profile: AgentProfile,
): Sha256Digest {
  const parsed = agentProfileSchema.parse(detachAgentProfileJson(profile));
  const material = canonicalAgentProfileValueDetached(parsed);
  if (material === undefined || !isCanonicalJsonValue(material)) {
    throw new Error("AgentProfile must contain finite, acyclic RFC 8785 JSON values");
  }
  return canonicalCandidateDigest(material);
}
