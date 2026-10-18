import type { AgentProfile } from "@tangle-network/agent-interface";

/**
 * Who authenticates the profile's model.
 * - `managed`: Tangle mints the model credential (the default).
 * - `subscription`: a selected stored subscription credential.
 * - `cli`: the harness CLI resolves and authenticates its own provider, such as OpenCode's
 *   keyless free tier. No managed key, no subscription seat, no credential resolver.
 */
export type ProfileCredentialSource = "managed" | "subscription" | "cli";

/** Authored profile intent is independent of the harness, vendor, and available accounts. */
export function profileCredentialSource(profile: AgentProfile): ProfileCredentialSource {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("Tangle credential intent requires an inline AgentProfile");
  }
  const model = profile.model;
  if (model !== undefined && (!model || typeof model !== "object" || Array.isArray(model))) {
    throw new Error("Tangle profile model must be an object");
  }
  const metadata = model?.metadata;
  if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
    throw new Error("Tangle profile model metadata must be an object");
  }
  const source = metadata?.credentialSource;
  if (source === undefined || source === "managed") return "managed";
  if (source === "subscription" || source === "cli") return source;
  throw new Error('Tangle profile model.metadata.credentialSource must be "managed", "subscription" or "cli"');
}
