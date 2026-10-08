import { describe, expect, it } from "vitest";
import { AgentTurnInputSchema } from "./environment-runtime.js";
import { canonicalAgentProfileDigest } from "./index.js";

const profile = {
  name: "large-mounted-research",
  harness: "claude-code" as const,
  model: { provider: "anthropic", default: "fixture-model" },
  resources: {
    files: Array.from({ length: 110 }, (_, index) => ({
      path: `inputs/source-${index}.txt`,
      resource: { kind: "inline" as const, name: `source-${index}`, content: "evidence".repeat(2600) },
    })),
  },
};

describe("typed turn profile", () => {
  it("preserves a multi-megabyte mounted profile outside bounded metadata", () => {
    expect(JSON.stringify(profile).length).toBeGreaterThan(2_000_000);
    const input = AgentTurnInputSchema.parse({ prompt: "Continue the research", profile });
    expect(input.profile).toEqual(profile);
    expect(canonicalAgentProfileDigest(input.profile!)).toBe(canonicalAgentProfileDigest(profile));
  });

  it("keeps generic provider options bounded", () => {
    expect(AgentTurnInputSchema.safeParse({ prompt: "Continue", providerOptions: { backend: { profile } } }).success).toBe(false);
    expect(AgentTurnInputSchema.safeParse({ prompt: "Continue", profile, providerOptions: { huge: "x".repeat(16385) } }).success).toBe(false);
  });

  it("uses the canonical profile contract rather than accepting arbitrary JSON", () => {
    const result = AgentTurnInputSchema.safeParse({ prompt: "Continue", profile: { ...profile, harness: "unsupported-harness" } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some(issue => issue.path[0] === "profile")).toBe(true);
  });

  it("accepts only an exact native resume coordinate", () => {
    const nativeResume = { harness: "claude-code", nativeSessionId: "native-1", sourceCheckpointId: "checkpoint-1" };
    expect(AgentTurnInputSchema.parse({ prompt: "Continue", nativeResume }).nativeResume).toEqual(nativeResume);
    expect(AgentTurnInputSchema.safeParse({ prompt: "Continue", nativeResume: { ...nativeResume, harness: "opencode" } }).success).toBe(false);
    expect(AgentTurnInputSchema.safeParse({ prompt: "Continue", nativeResume: { ...nativeResume, ignored: true } }).success).toBe(false);
  });
});
