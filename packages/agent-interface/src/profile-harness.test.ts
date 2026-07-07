import { describe, expect, it } from "vitest";
import type { AgentProfile } from "./agent-profile.js";
import { agentProfileSchema } from "./profile-schema.js";

describe("AgentProfile.harness (optional overridable preference)", () => {
  it("accepts a valid HarnessType and round-trips it", () => {
    const profile: AgentProfile = { name: "w", harness: "codex" };
    const parsed = agentProfileSchema.parse(profile);
    expect(parsed.harness).toBe("codex");
  });

  it("is optional — a profile without harness still parses (harness-agnostic identity)", () => {
    const parsed = agentProfileSchema.parse({ name: "w" });
    expect(parsed.harness).toBeUndefined();
  });

  it("rejects a harness that is not a known runner", () => {
    expect(() => agentProfileSchema.parse({ harness: "not-a-real-harness" })).toThrow();
  });

  it("does not constrain identity — the same profile is valid with any harness swapped in", () => {
    const base: AgentProfile = { name: "w", prompt: { systemPrompt: "do the task" } };
    for (const harness of ["claude-code", "opencode", "pi", "cli-base"] as const) {
      const parsed = agentProfileSchema.parse({ ...base, harness });
      expect(parsed.harness).toBe(harness);
      expect(parsed.prompt).toEqual(base.prompt);
    }
  });
});
