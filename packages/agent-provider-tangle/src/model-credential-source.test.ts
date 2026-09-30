import type { AgentProfile } from "@tangle-network/agent-interface";
import { describe, expect, it } from "vitest";
import { profileCredentialSource } from "./index.js";

describe("exact profile credential source", () => {
  it("defaults to managed without inferring access from a vendor or harness", () => {
    expect(profileCredentialSource({ name: "router" })).toBe("managed");
    expect(profileCredentialSource({ name: "native", harness: "claude-code", model: { provider: "anthropic", default: "fixture" } })).toBe("managed");
  });

  it.each(["managed", "subscription"] as const)("reads explicit %s intent without changing the profile", (credentialSource) => {
    const profile = { name: "researcher", model: { metadata: { credentialSource, retained: true } } };
    const before = structuredClone(profile);
    expect(profileCredentialSource(profile)).toBe(credentialSource);
    expect(profile).toEqual(before);
  });

  it.each([null, [], { name: "bad", model: null }, { name: "bad", model: { metadata: null } }, { name: "bad", model: { metadata: [] } }, { name: "bad", model: { metadata: { credentialSource: "unknown" } } }])("refuses malformed intent rather than downgrading it (%j)", (profile) => {
    expect(() => profileCredentialSource(profile as unknown as AgentProfile)).toThrow();
  });
});
