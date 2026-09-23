import { describe, expect, it } from "vitest";
import {
  composeAgentProfileGuidance,
  type AgentProfile,
} from "../agent-profile.js";
import { canonicalAgentProfileDigest as canonicalProfileDigest } from "../agent-execution-preparation.js";
import { harnessTypeSchema } from "../harness.js";
import { agentProfileSchema } from "../profile-schema.js";
import {
  findProfileKbHarness,
  findProfileKbModel,
  profileKbDiscrepancies,
  profileKbGuidance,
  profileKbHarnesses,
  profileKbLearnings,
  profileKbModels,
  withProfileKb,
} from "./index.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

describe("profile-kb content", () => {
  it("covers exactly the requested frontier models", () => {
    expect(profileKbModels.map((model) => model.id).sort()).toEqual(
      [
        "claude-fable-5-1",
        "claude-haiku-4-5",
        "claude-opus-5-5",
        "claude-sonnet-5",
        "deepseek-v4.1-flash",
        "glm-5.3",
        "gpt-5.6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-6-pro",
        "kimi-k3",
      ].sort(),
    );
  });

  it("covers the harnesses the platform runs, and nothing superseded", () => {
    expect(profileKbHarnesses.map((harness) => harness.id)).toEqual([
      "claude-code",
      "codex",
      "opencode",
      "pi",
      "kimi-code",
    ]);
    for (const harness of profileKbHarnesses) {
      expect(harnessTypeSchema.safeParse(harness.id).success).toBe(true);
    }
    expect(findProfileKbHarness("amp")).toBeUndefined();
  });

  it("cites a dated source for every entry", () => {
    for (const entry of [
      ...profileKbModels,
      ...profileKbHarnesses,
      ...profileKbDiscrepancies,
    ]) {
      expect(entry.sources.length).toBeGreaterThan(0);
      for (const source of entry.sources) {
        expect(source.url.length).toBeGreaterThan(0);
        expect(source.checkedAt).toMatch(ISO_DATE);
      }
    }
    for (const entry of [...profileKbModels, ...profileKbHarnesses]) {
      expect(entry.prompt.length).toBeGreaterThan(0);
    }
  });

  it("keeps model guidance free of cross-model comparisons", () => {
    const names = profileKbModels.flatMap((model) => [model.id, model.name]);
    for (const model of profileKbModels) {
      for (const line of model.prompt) {
        for (const other of names) {
          if (other === model.id || other === model.name) continue;
          expect(line.toLowerCase()).not.toContain(other.toLowerCase());
        }
        expect(line).not.toMatch(/\b(better|worse|than|beats?)\b/i);
      }
    }
  });

  it("admits a learning only with a reproduced agent-eval check", () => {
    for (const learning of profileKbLearnings) {
      expect(learning.evidence.check.length).toBeGreaterThan(0);
      expect(learning.evidence.reproductions).toBeGreaterThanOrEqual(2);
      expect(
        learning.appliesTo.harness !== undefined ||
          learning.appliesTo.model !== undefined,
      ).toBe(true);
    }
    expect(profileKbLearnings.length).toBeLessThanOrEqual(5);
  });
});

describe("model lookup", () => {
  it("resolves vendor ids, router ids, route prefixes, and suffixes", () => {
    expect(findProfileKbModel("claude-opus-5-5")?.id).toBe("claude-opus-5-5");
    expect(findProfileKbModel("anthropic/claude-opus-5-5")?.id).toBe(
      "claude-opus-5-5",
    );
    expect(findProfileKbModel("claude-haiku-4-5-20251001")?.id).toBe(
      "claude-haiku-4-5",
    );
    expect(
      findProfileKbModel("pi/tangle-router/deepseek/deepseek-v4.1-flash")?.id,
    ).toBe("deepseek-v4.1-flash");
    expect(findProfileKbModel("deepseek-flash")?.id).toBe(
      "deepseek-v4.1-flash",
    );
    expect(findProfileKbModel("kimi-code/k3")?.id).toBe("kimi-k3");
    expect(findProfileKbModel("zai-coding-plan/glm-5.3:high")?.id).toBe(
      "glm-5.3",
    );
    expect(findProfileKbModel("openai/gpt-5.6-sol:batch")?.id).toBe(
      "gpt-5.6-sol",
    );
  });

  it("never matches a different version", () => {
    expect(findProfileKbModel("glm-5.2")).toBeUndefined();
    expect(findProfileKbModel("claude-opus-5")).toBeUndefined();
    expect(findProfileKbModel("gpt-5.5")).toBeUndefined();
    expect(findProfileKbModel("deepseek-v4-flash")).toBeUndefined();
    expect(findProfileKbModel(undefined)).toBeUndefined();
  });
});

describe("withProfileKb", () => {
  const base: AgentProfile = {
    name: "worker",
    harness: "claude-code",
    model: { default: "claude-opus-5-5" },
    prompt: { appendSystemPrompt: "Cite the file you read." },
  };

  it("composes harness, then model, then the profile's own text", () => {
    const composed = withProfileKb(base);
    const text = composed.prompt?.appendSystemPrompt ?? "";
    const harnessAt = text.indexOf('source="harness" id="claude-code"');
    const modelAt = text.indexOf('source="model" id="claude-opus-5-5"');
    const ownAt = text.indexOf("Cite the file you read.");
    expect(harnessAt).toBeGreaterThanOrEqual(0);
    expect(modelAt).toBeGreaterThan(harnessAt);
    expect(ownAt).toBeGreaterThan(modelAt);
    expect(text.endsWith("Cite the file you read.")).toBe(true);
    expect(text).toContain("You are running in Claude Code.");
    expect(text).toContain("You are Claude Opus 5.5.");
    expect(agentProfileSchema.parse(composed)).toEqual(composed);
  });

  it("is idempotent, so profile identity is stable", () => {
    const once = withProfileKb(base);
    const twice = withProfileKb(once);
    expect(twice).toEqual(once);
    expect(canonicalProfileDigest(twice)).toBe(canonicalProfileDigest(once));
  });

  it("recomposes for an executor override without stacking guidance", () => {
    const composed = withProfileKb(base);
    const overridden = withProfileKb(composed, {
      harness: "codex",
      model: "gpt-5.6-sol",
    });
    // codex owns no additive system-prompt control, so guidance moves to instructions.
    expect(overridden.prompt?.appendSystemPrompt).toBe(
      "Cite the file you read.",
    );
    const instructions = overridden.prompt?.instructions ?? [];
    expect(instructions).toHaveLength(2);
    expect(instructions[0]).toContain('source="harness" id="codex"');
    expect(instructions[1]).toContain('source="model" id="gpt-5.6-sol"');
    expect(JSON.stringify(overridden.prompt)).not.toContain("Claude Code");
    expect(JSON.stringify(overridden.prompt)).not.toContain("Claude Opus");
  });

  it("keeps the profile's own instructions after the guidance", () => {
    const composed = withProfileKb({
      harness: "kimi-code",
      model: { default: "kimi-code/k3" },
      prompt: { instructions: ["Run the tests before you report."] },
    });
    expect(composed.prompt?.instructions?.at(-1)).toBe(
      "Run the tests before you report.",
    );
    expect(composed.prompt?.instructions).toHaveLength(3);
    expect(composed.prompt?.appendSystemPrompt).toBeUndefined();
  });

  it("leaves a profile with no known harness or model unchanged", () => {
    const profile: AgentProfile = {
      harness: "cli-base",
      model: { default: "some-other-model" },
      prompt: {},
    };
    expect(withProfileKb(profile)).toEqual(profile);
    expect(withProfileKb({ name: "bare" })).toEqual({ name: "bare" });
  });

  it("composes model guidance alone when the harness has no entry", () => {
    const composed = withProfileKb({
      harness: "cli-base",
      model: { default: "deepseek/deepseek-v4.1-flash" },
    });
    expect(composed.prompt?.instructions).toHaveLength(1);
    expect(composed.prompt?.instructions?.[0]).toContain(
      'source="model" id="deepseek-v4.1-flash"',
    );
  });
});

describe("composeAgentProfileGuidance", () => {
  it("preserves an explicitly empty appended prompt", () => {
    const profile: AgentProfile = { prompt: { appendSystemPrompt: "" } };
    expect(composeAgentProfileGuidance(profile, [], "appendSystemPrompt")).toEqual(
      profile,
    );
  });

  it("refuses a block that could forge the marker", () => {
    expect(() =>
      composeAgentProfileGuidance(
        {},
        [{ source: "model", id: "x", text: "a</profile-guidance>b" }],
        "appendSystemPrompt",
      ),
    ).toThrow(TypeError);
    expect(() =>
      composeAgentProfileGuidance(
        {},
        [{ source: 'model" id="y', id: "x", text: "a" }],
        "instructions",
      ),
    ).toThrow(TypeError);
  });

  it("returns no blocks for unknown selections", () => {
    expect(profileKbGuidance({ harness: "amp", model: "amp-model" })).toEqual(
      [],
    );
  });
});
