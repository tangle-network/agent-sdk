import { describe, expect, it } from "vitest";
import { canonicalAgentProfileDigest } from "./agent-execution-preparation.js";
import type { AgentProfile } from "./agent-profile.js";
import { agentProfileSchema } from "./profile-schema.js";
import type { HarnessType } from "./harness.js";

// @ts-expect-error Shorthand harness names are not part of the public contract.
const removedHarnessAlias: HarnessType = "claude";
void removedHarnessAlias;

describe("AgentProfile.harness (optional overridable preference)", () => {
  it("accepts a valid HarnessType and round-trips it", () => {
    const profile: AgentProfile = { name: "w", harness: "codex" };
    const parsed = agentProfileSchema.parse(profile);
    expect(parsed.harness).toBe("codex");
  });

  it("is optional — a profile without a preference still parses", () => {
    const parsed = agentProfileSchema.parse({ name: "w" });
    expect(parsed.harness).toBeUndefined();
  });

  it("rejects a harness that is not a known runner", () => {
    expect(() => agentProfileSchema.parse({ harness: "not-a-real-harness" })).toThrow();
    expect(() => agentProfileSchema.parse({ harness: "claude" })).toThrow();
    expect(() => agentProfileSchema.parse({ harness: "claudish" })).toThrow();
    expect(() => agentProfileSchema.parse({ harness: "kimi" })).toThrow();
  });

  it("accepts every known runner while binding each preference into authored identity", () => {
    const base: AgentProfile = { name: "w", prompt: { systemPrompt: "do the task" } };
    const digests = [];
    for (const harness of ["claude-code", "opencode", "pi", "cli-base"] as const) {
      const parsed = agentProfileSchema.parse({ ...base, harness });
      expect(parsed.harness).toBe(harness);
      expect(parsed.prompt).toEqual(base.prompt);
      digests.push(canonicalAgentProfileDigest(parsed));
    }
    expect(new Set(digests)).toHaveLength(4);
  });
});
