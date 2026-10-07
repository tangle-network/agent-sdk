import { describe, expect, it } from "vitest";
import { canonicalAgentProfileDigest } from "./agent-execution-preparation.js";
import { profileMaterializationRequests } from "./agent-profile-materialization.js";
import { agentProfileSchema } from "./profile-schema.js";

const profile = {
  harness: "claude-code",
  model: { default: "anthropic/claude-opus-5-5", provider: "anthropic", reasoningEffort: "high" },
  prompt: { systemPrompt: "Continue the research." },
  seats: [
    { harness: "claude-code", provider: "anthropic", model: "anthropic/claude-opus-5-5", selector: { kind: "all-eligible" } },
    { harness: "codex", provider: "openai", model: "openai/gpt-6-sol", selector: { kind: "seat", id: "codex-second" } },
  ],
} as const;

describe("AgentProfile.seats", () => {
  it("binds an ordered cross-provider chain into authored identity and materialization", () => {
    const parsed = agentProfileSchema.parse(profile);
    expect(parsed.seats).toEqual(profile.seats);
    expect(canonicalAgentProfileDigest(parsed)).not.toBe(
      canonicalAgentProfileDigest(agentProfileSchema.parse({ ...profile, seats: [profile.seats[0]] })),
    );
    expect(profileMaterializationRequests(parsed)).toContainEqual({
      axis: "seats",
      path: "/seats/1/model",
    });
  });

  it("keeps older profiles valid but refuses implicit provider or model changes", () => {
    expect(agentProfileSchema.safeParse({ harness: "claude-code", model: profile.model }).success).toBe(true);
    expect(agentProfileSchema.safeParse({ ...profile, seats: [] }).success).toBe(false);
    expect(agentProfileSchema.safeParse({ ...profile, harness: "codex" }).success).toBe(false);
    expect(agentProfileSchema.safeParse({ ...profile, model: { ...profile.model, default: "anthropic/claude-sonnet-5-5" } }).success).toBe(false);
    expect(agentProfileSchema.safeParse({ ...profile, seats: [{ ...profile.seats[0], provider: "openai" }] }).success).toBe(false);
  });

  it("refuses stages whose harness cannot honor the model, effort, or prompt", () => {
    expect(agentProfileSchema.safeParse({ ...profile, seats: [profile.seats[0], { ...profile.seats[1], harness: "claude-code" }] }).success).toBe(false);
    expect(agentProfileSchema.safeParse({ ...profile, seats: [profile.seats[0], { ...profile.seats[1], harness: "nanoclaw" }] }).success).toBe(false);
    expect(agentProfileSchema.safeParse({ ...profile, prompt: { appendSystemPrompt: "extra" } }).success).toBe(false);
  });

  it("allows explicit stage tool replacement without changing the first stage", () => {
    const withControls = {
      ...profile,
      tools: { Bash: true, Write: true },
      seats: [
        { ...profile.seats[0], tools: { Bash: true, Write: true } },
        { ...profile.seats[1], tools: {}, permissions: {} },
      ],
    };
    expect(agentProfileSchema.safeParse(withControls).success).toBe(true);
    expect(agentProfileSchema.safeParse({
      ...withControls,
      seats: [{ ...withControls.seats[0], tools: {} }, withControls.seats[1]],
    }).success).toBe(false);
    expect(agentProfileSchema.safeParse({
      ...withControls,
      seats: [withControls.seats[0], { ...withControls.seats[1], tools: { Bash: true } }],
    }).success).toBe(true);
  });
});
