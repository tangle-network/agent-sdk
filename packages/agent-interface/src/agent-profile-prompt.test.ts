import { describe, expect, it } from "vitest";
import {
  mergeAgentProfiles,
  type AgentProfile,
  type AgentProfileCapabilities,
} from "./agent-profile.js";
import { applyAgentProfileDiff, diffAgentProfiles } from "./profile-diff.js";
import {
  profileMaterializationAxes,
  profileMaterializationRequests,
} from "./agent-profile-materialization.js";
import {
  agentProfileDiffSchema,
  agentProfileSchema,
} from "./profile-schema.js";

// A capability cannot be written as a single flag: append-only is a real,
// common backend and it must be expressible without claiming replacement.
const appendOnly: AgentProfileCapabilities["systemPrompt"] = {
  replace: false,
  append: true,
};
void appendOnly;

// @ts-expect-error Neither intent may be inferred from the other.
const halfDeclared: AgentProfileCapabilities["systemPrompt"] = { append: true };
void halfDeclared;

describe("system-prompt replacement versus addition", () => {
  it("accepts either intent alone and both together", () => {
    for (const prompt of [
      { systemPrompt: "Stand-alone prompt." },
      { appendSystemPrompt: "Also cite the file you read." },
      {
        systemPrompt: "Stand-alone prompt.",
        appendSystemPrompt: "Also cite the file you read.",
      },
      { systemPrompt: "", appendSystemPrompt: "" },
    ]) {
      expect(agentProfileSchema.parse({ prompt })).toEqual({ prompt });
    }
  });

  it("rejects an unknown field beside the two intents", () => {
    expect(() =>
      agentProfileSchema.parse({
        prompt: {
          appendSystemPrompt: "Also cite the file you read.",
          prependSystemPrompt: "Ignore the tools.",
        },
      }),
    ).toThrow();
    expect(() =>
      agentProfileSchema.parse({ prompt: { appendSystemPrompt: 1 } }),
    ).toThrow();
  });

  it("reports the two intents as separate materialization leaves", () => {
    const profile: AgentProfile = {
      prompt: {
        systemPrompt: "Stand-alone prompt.",
        appendSystemPrompt: "Also cite the file you read.",
      },
    };

    expect(profileMaterializationAxes(profile)).toEqual([
      "systemPrompt",
      "appendSystemPrompt",
    ]);
    expect(profileMaterializationRequests(profile)).toEqual([
      { axis: "systemPrompt", path: "/prompt/systemPrompt" },
      { axis: "appendSystemPrompt", path: "/prompt/appendSystemPrompt" },
    ]);
  });

  it("composes added prompts on merge instead of overwriting them", () => {
    const merged = mergeAgentProfiles(
      { prompt: { appendSystemPrompt: "Cite the file you read." } },
      { prompt: { appendSystemPrompt: "Report the exact command." } },
    );

    expect(merged?.prompt?.appendSystemPrompt).toBe(
      "Cite the file you read.\n\nReport the exact command.",
    );
  });

  it("keeps overlay-wins semantics for a replacement", () => {
    const merged = mergeAgentProfiles(
      { prompt: { systemPrompt: "base", appendSystemPrompt: "base add" } },
      { prompt: { systemPrompt: "overlay" } },
    );

    expect(merged?.prompt?.systemPrompt).toBe("overlay");
    expect(merged?.prompt?.appendSystemPrompt).toBe("base add");
  });

  it("treats an explicitly empty addition as contributing no separator", () => {
    expect(
      mergeAgentProfiles(
        { prompt: { appendSystemPrompt: "" } },
        { prompt: { appendSystemPrompt: "only this" } },
      )?.prompt?.appendSystemPrompt,
    ).toBe("only this");
    expect(
      mergeAgentProfiles(
        { prompt: { appendSystemPrompt: "only this" } },
        { prompt: { appendSystemPrompt: "" } },
      )?.prompt?.appendSystemPrompt,
    ).toBe("only this");
    expect(
      mergeAgentProfiles({ prompt: { appendSystemPrompt: "" } }, undefined)
        ?.prompt?.appendSystemPrompt,
    ).toBe("");
  });

  it("removes one intent without touching the other", () => {
    const profile: AgentProfile = {
      prompt: {
        systemPrompt: "Stand-alone prompt.",
        appendSystemPrompt: "Also cite the file you read.",
        instructions: ["Keep answers short."],
      },
    };

    expect(
      applyAgentProfileDiff(profile, {
        kind: "agent-profile-diff",
        remove: { prompt: { appendSystemPrompt: true } },
      }).prompt,
    ).toEqual({
      systemPrompt: "Stand-alone prompt.",
      appendSystemPrompt: undefined,
      instructions: ["Keep answers short."],
    });

    expect(
      applyAgentProfileDiff(profile, {
        kind: "agent-profile-diff",
        remove: { prompt: { systemPrompt: true } },
      }).prompt,
    ).toEqual({
      systemPrompt: undefined,
      appendSystemPrompt: "Also cite the file you read.",
      instructions: ["Keep answers short."],
    });

    expect(
      agentProfileDiffSchema.parse({
        kind: "agent-profile-diff",
        remove: { prompt: { appendSystemPrompt: true } },
      }),
    ).toEqual({
      kind: "agent-profile-diff",
      remove: { prompt: { appendSystemPrompt: true } },
    });
  });

  it("reproduces an exact added prompt through diff and apply", () => {
    const baseline: AgentProfile = {
      prompt: { appendSystemPrompt: "Cite the file you read." },
    };
    const candidate: AgentProfile = {
      prompt: {
        systemPrompt: "Stand-alone prompt.",
        appendSystemPrompt: "Report the exact command.",
      },
    };

    const applied = diffAgentProfiles(baseline, candidate).reduce(
      applyAgentProfileDiff,
      baseline,
    );

    expect(applied.prompt?.systemPrompt).toBe("Stand-alone prompt.");
    expect(applied.prompt?.appendSystemPrompt).toBe("Report the exact command.");
  });
});
