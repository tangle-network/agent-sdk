import { describe, expect, it } from "vitest";
import { canonicalAgentProfileDigest } from "./agent-execution-preparation.js";
import { profileMaterializationRequests } from "./agent-profile-materialization.js";
import { parseSeatSpec } from "./harness-capabilities.js";
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
    expect(agentProfileSchema.safeParse({ ...profile, seats: [profile.seats[0], { ...profile.seats[1], harness: "kimi-code" }] }).success).toBe(false);
    // claude-code runs any router-served model, so a cross-provider seat on it is valid.
    expect(agentProfileSchema.safeParse({ ...profile, seats: [profile.seats[0], { ...profile.seats[1], harness: "claude-code" }] }).success).toBe(true);
    expect(agentProfileSchema.safeParse({ ...profile, seats: [profile.seats[0], { ...profile.seats[1], harness: "nanoclaw" }] }).success).toBe(false);
    expect(agentProfileSchema.safeParse({ ...profile, prompt: { appendSystemPrompt: "extra" } }).success).toBe(false);
  });

  it("accepts a seat whose provider is a knowledge-base alias of its bare model, such as the GLM coding plan", () => {
    // Discovery's record-families root re-seated to opencode/zai-coding-plan/glm-5.3 on 2026-10-31: `glm-5.3` resolves to `zai`,
    // and the seat rule refused the plan provider the knowledge base lists as an alias of that model.
    const plan = {
      harness: "opencode",
      model: { default: "glm-5.3", provider: "zai-coding-plan", reasoningEffort: "xhigh" },
      prompt: { instructions: ["Continue the research."] },
      seats: [{ harness: "opencode", provider: "zai-coding-plan", model: "glm-5.3", selector: { kind: "all-eligible" } }],
    } as const;
    expect(agentProfileSchema.safeParse(plan).success).toBe(true);
    const unknown = { ...plan, model: { ...plan.model, provider: "zai-coding" }, seats: [{ ...plan.seats[0], provider: "zai-coding" }] };
    expect(agentProfileSchema.safeParse(unknown).error?.issues.map((issue) => issue.path.join("."))).toEqual(["seats.0.provider"]);
  });

  it("accepts opencode's keyless free route as a pool stage or the first stage, as parseSeatSpec does", () => {
    // Discovery's seat pool `claude-code/anthropic/claude-fable-5-1, opencode/opencode/glm-5.3-flash-free` failed at
    // seats.1.provider on 2026-11-02: `glm-5.3-flash-free` reads as the `zai` family and no spelling named opencode's route.
    const keyless = { harness: "opencode", provider: "opencode", model: "glm-5.3-flash-free", selector: { kind: "all-eligible" } } as const;
    const fable = { harness: "claude-code", provider: "anthropic", model: "claude-fable-5-1", selector: { kind: "all-eligible" } } as const;
    const pool = { harness: "claude-code", model: { default: "claude-fable-5-1", provider: "anthropic" }, seats: [fable, keyless] };
    expect(agentProfileSchema.safeParse(pool).error?.issues).toBeUndefined();
    const free = { harness: "opencode", model: { default: "glm-5.3-flash-free", provider: "opencode" }, seats: [keyless, fable] };
    expect(agentProfileSchema.safeParse(free).error?.issues).toBeUndefined();
    expect(parseSeatSpec("opencode/opencode/glm-5.3-flash-free")).toMatchObject({ harness: "opencode", provider: "opencode" });

    // A provider that cannot serve its model stays refused, in the schema and in parseSeatSpec alike.
    const wrong = { ...pool, seats: [fable, { ...keyless, provider: "anthropic" }] };
    expect(agentProfileSchema.safeParse(wrong).error?.issues.map((issue) => issue.path.join("."))).toEqual(["seats.1.provider"]);
    expect(agentProfileSchema.safeParse({ ...pool, seats: [fable, { ...keyless, model: "glm-5.3" }] }).success).toBe(false);
    // A model outside every family is left to its provider, as harnessModelSupport leaves it to the harness.
    expect(agentProfileSchema.safeParse({ ...pool, seats: [fable, { ...keyless, model: "big-pickle" }] }).success).toBe(true);

    // A subscription pool's keyless stage carries its own managed intent (setup-smoke-ad744553 failed its first turn
    // when stage 1 inherited 'subscription'); stage 0 may restate only the profile's effective source.
    const subscription = { ...pool, model: { ...pool.model, metadata: { credentialSource: "subscription" } } };
    const managedStage = { ...keyless, credentialSource: "managed" } as const;
    expect(agentProfileSchema.parse({ ...subscription, seats: [{ ...fable, credentialSource: "subscription" }, managedStage] }).seats?.[1])
      .toEqual(managedStage);
    expect(agentProfileSchema.safeParse({ ...subscription, seats: [{ ...fable, credentialSource: "managed" }, managedStage] })
      .error?.issues.map((issue) => issue.path.join("."))).toEqual(["seats.0.credentialSource"]);
    expect(agentProfileSchema.safeParse({ ...pool, seats: [{ ...fable, credentialSource: "managed" }, managedStage] }).success).toBe(true);
    expect(agentProfileSchema.safeParse({ ...pool, seats: [fable, { ...keyless, credentialSource: "byok" }] }).success).toBe(false);
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
