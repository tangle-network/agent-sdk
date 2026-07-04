import { describe, expect, it } from "vitest";
import { agentProfileDiffSchema } from "./profile-schema.js";
import {
  applyAgentProfileDiff,
  changedAgentProfileAxes,
  defineAgentProfileDiff,
  pruneAgentProfileDiff,
} from "./profile-diff.js";
import { defineInlineResource, type AgentProfile } from "./agent-profile.js";

const baseProfile: AgentProfile = {
  name: "baseline",
  prompt: {
    systemPrompt: "Solve directly.",
    instructions: ["Keep answers short."],
  },
  model: {
    default: "zai/glm-4.7",
    reasoningEffort: "low",
  },
  tools: {
    browser: true,
    shell: false,
  },
  mcp: {
    records: { transport: "http", url: "https://mcp.example.test" },
  },
  resources: {
    files: [
      {
        path: ".agent-profile/old.md",
        resource: defineInlineResource("old", "old"),
      },
    ],
    skills: [defineInlineResource("read-state", "Read state first.")],
  },
  hooks: {
    postFinish: [{ command: "pnpm test", blocking: true }],
  },
};

describe("AgentProfileDiff", () => {
  it("applies a full-profile overlay and named removals", () => {
    const diff = defineAgentProfileDiff({
      schemaVersion: 1,
      kind: "agent-profile-diff",
      id: "stateful-small-model-pack",
      set: {
        prompt: {
          instructions: ["Verify state before DONE."],
        },
        model: {
          small: "moonshot/kimi-k2",
          reasoningEffort: "high",
        },
        tools: {
          shell: true,
        },
        resources: {
          files: [
            {
              path: ".agent-profile/policy.md",
              resource: defineInlineResource("policy", "Read, mutate, verify."),
            },
          ],
          skills: [defineInlineResource("verify-state", "Check state after writes.")],
        },
        hooks: {
          preFinish: [{ command: "node verify.mjs", blocking: true }],
        },
      },
      remove: {
        resources: {
          files: [".agent-profile/old.md"],
          skills: ["read-state"],
        },
      },
    });

    const profile = applyAgentProfileDiff(baseProfile, diff);

    expect(profile.prompt?.systemPrompt).toBe("Solve directly.");
    expect(profile.prompt?.instructions).toEqual([
      "Keep answers short.",
      "Verify state before DONE.",
    ]);
    expect(profile.model).toEqual({
      small: "moonshot/kimi-k2",
      reasoningEffort: "high",
    });
    expect(profile.tools).toEqual({ browser: true, shell: true });
    expect(profile.resources?.files?.map((file) => file.path)).toEqual([
      ".agent-profile/policy.md",
    ]);
    expect(profile.resources?.skills?.map((skill) => skill.name)).toEqual([
      "verify-state",
    ]);
    expect(profile.hooks?.postFinish).toHaveLength(1);
    expect(profile.hooks?.preFinish).toHaveLength(1);
  });

  it("reports and prunes changed axes for causal ablations", () => {
    const diff = defineAgentProfileDiff({
      schemaVersion: 1,
      kind: "agent-profile-diff",
      set: {
        prompt: { instructions: ["Use evidence first."] },
        model: { reasoningEffort: "medium" },
        resources: { skills: [defineInlineResource("evidence-first", "Use evidence.")] },
      },
    });

    expect(changedAgentProfileAxes(diff)).toEqual(["model", "prompt", "resources"]);

    const pruned = pruneAgentProfileDiff(diff, ["resources"]);
    expect(changedAgentProfileAxes(pruned)).toEqual(["model", "prompt"]);
    expect(applyAgentProfileDiff(baseProfile, pruned).resources?.skills?.map((s) => s.name)).toEqual([
      "read-state",
    ]);
  });

  it("validates generated diffs with the public schema", () => {
    const parsed = agentProfileDiffSchema.parse({
      schemaVersion: 1,
      kind: "agent-profile-diff",
      source: {
        kind: "frontier-author",
        artifacts: ["traces://session/example"],
      },
      set: {
        subagents: {
          verifier: {
            description: "Check final state.",
            prompt: "Verify the answer against observable state.",
            model: "zai/glm-4.7",
            maxSteps: 2,
          },
        },
      },
      remove: {
        model: ["small"],
      },
    });

    expect(parsed.source?.kind).toBe("frontier-author");
    expect(changedAgentProfileAxes(parsed)).toEqual(["model", "subagents"]);
  });
});
