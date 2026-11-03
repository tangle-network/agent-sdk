import type { AgentProfile } from "@tangle-network/agent-interface";

/** The credential intent a profile can declare. `managed` is the deprecated spelling of `router`. */
export type ProfileCredentialSource = "router" | "api-key" | "subscription";

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
  if (source === undefined || source === "managed" || source === "router") return "router";
  if (source === "api-key") return "api-key";
  if (source === "subscription") return "subscription";
  throw new Error('Tangle profile model.metadata.credentialSource must be "router", "api-key", or "subscription"');
}
