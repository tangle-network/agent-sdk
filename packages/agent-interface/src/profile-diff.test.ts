import { describe, expect, it } from "vitest";
import { agentProfileDiffSchema, agentProfileSchema } from "./profile-schema.js";
import {
  applyAgentProfileDiff,
  type AgentProfileDiff,
  changedAgentProfileAxes,
  defineAgentProfileDiff,
  diffAgentProfiles,
  pruneAgentProfileDiff,
} from "./profile-diff.js";
import {
  defineInlineResource,
  type AgentProfile,
  type AgentProfileResources,
} from "./agent-profile.js";

const baseProfile: AgentProfile = {
  name: "baseline",
  harness: "claude-code",
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

const resourceFieldCases = {
  files: {
    files: [
      {
        path: "protocol.md",
        resource: defineInlineResource("protocol", "Follow the protocol."),
      },
    ],
  },
  tools: {
    tools: [defineInlineResource("search", "Search primary sources.")],
  },
  skills: {
    skills: [defineInlineResource("verify", "Verify before reporting.")],
  },
  agents: {
    agents: [defineInlineResource("critic", "Try to refute the result.")],
  },
  commands: {
    commands: [defineInlineResource("measure", "Measure the real path.")],
  },
  instructions: { instructions: "Keep exact evidence." },
  failOnError: { failOnError: true },
} satisfies { [Key in keyof AgentProfileResources]-?: AgentProfileResources };

const profileFieldCases = {
  name: { name: "candidate" },
  description: { description: "A complete candidate profile." },
  version: { version: "2" },
  tags: { tags: [] },
  prompt: { prompt: { systemPrompt: "Measure, then answer." } },
  model: { model: { reasoningEffort: "high" } },
  harness: { harness: "codex" },
  permissions: { permissions: { shell: "allow" } },
  tools: { tools: { shell: true } },
  mcp: {
    mcp: {
      local: {
        command: "node",
        args: [{ kind: "public", value: "server.js" }],
        env: { MODE: { kind: "public", value: "audit" } },
      },
      remote: {
        transport: "http",
        url: "https://mcp.example.test",
        headers: {
          Authorization: {
            kind: "secret-ref",
            key: "papers-service-auth",
            format: "bearer",
          },
        },
      },
    },
  },
  connections: {
    connections: [{ connectionId: "papers", capabilities: ["search"] }],
  },
  subagents: {
    subagents: { critic: { prompt: "Find the strongest counterexample." } },
  },
  resources: { resources: resourceFieldCases.skills },
  hooks: {
    hooks: {
      afterRun: [
        {
          command: "record-result",
          env: {
            AUDIT_TOKEN: { kind: "secret-ref", key: "audit-sink-auth" },
          },
        },
      ],
    },
  },
  modes: { modes: { adversarial: { prompt: "Attempt a refutation." } } },
  confidential: { confidential: { sealed: true } },
  metadata: { metadata: { role: "research-leader" } },
  extensions: { extensions: { codex: { sandbox: "danger-full-access" } } },
} satisfies { [Key in keyof AgentProfile]-?: AgentProfile };

const expectedAxisByProfileField = {
  name: "identity",
  description: "identity",
  version: "identity",
  tags: "identity",
  prompt: "prompt",
  model: "model",
  harness: "harness",
  permissions: "permissions",
  tools: "tools",
  mcp: "mcp",
  connections: "connections",
  subagents: "subagents",
  resources: "resources",
  hooks: "hooks",
  modes: "modes",
  confidential: "confidential",
  metadata: "metadata",
  extensions: "extensions",
} as const satisfies { [Key in keyof AgentProfile]-?: ReturnType<typeof changedAgentProfileAxes>[number] };

function verifiedProfileDiffs(
  baseline: AgentProfile,
  candidate: AgentProfile,
): AgentProfileDiff[] {
  return diffAgentProfiles(baseline, candidate).map((diff) =>
    agentProfileDiffSchema.parse(diff),
  );
}

function applyProfileDiffs(
  baseline: AgentProfile,
  diffs: readonly AgentProfileDiff[],
): AgentProfile {
  const applied = diffs.reduce(
    (profile, diff) => applyAgentProfileDiff(profile, diff),
    agentProfileSchema.parse(baseline),
  );
  return agentProfileSchema.parse(applied);
}

describe("AgentProfileDiff", () => {
  it("does not materialize absent resource arrays for an empty diff", () => {
    const profile: AgentProfile = {
      name: "minimal",
      prompt: { systemPrompt: "baseline" },
      resources: { failOnError: true },
    };

    expect(
      applyAgentProfileDiff(profile, {
        kind: "agent-profile-diff",
      }),
    ).toEqual(profile);
  });

  it("constructs valid exact replacement steps for every profile field", () => {
    for (const [field, input] of Object.entries(profileFieldCases)) {
      const candidate = agentProfileSchema.parse(input);
      const diffs = verifiedProfileDiffs({}, candidate);
      const changed = new Set(diffs.flatMap(changedAgentProfileAxes));

      expect(diffs.length, field).toBe(2);
      expect(changed, field).toEqual(
        new Set([expectedAxisByProfileField[field as keyof AgentProfile]]),
      );
      expect(applyProfileDiffs({}, diffs), field).toEqual(candidate);
    }
  });

  it("keeps replacement diffs exhaustive and precise for every resource field", () => {
    for (const [field, resources] of Object.entries(resourceFieldCases)) {
      const candidate = agentProfileSchema.parse({ resources });
      const diffs = verifiedProfileDiffs({}, candidate);

      expect(diffs, field).toHaveLength(2);
      expect(diffs[0]?.remove?.resources, field).toEqual({ [field]: true });
      expect(diffs[1]?.set?.resources, field).toEqual(resources);
      expect(applyProfileDiffs({}, diffs), field).toEqual(candidate);
    }
  });

  it("removes every profile field with one deterministic reset step", () => {
    const baseline = agentProfileSchema.parse({
      ...Object.assign({}, ...Object.values(profileFieldCases)),
      resources: Object.assign({}, ...Object.values(resourceFieldCases)),
    });
    const diffs = verifiedProfileDiffs(baseline, {});

    expect(diffs).toEqual([
      {
        kind: "agent-profile-diff",
        remove: {
          identity: true,
          tags: true,
          prompt: true,
          model: true,
          harness: true,
          permissions: true,
          tools: true,
          mcp: true,
          connections: true,
          subagents: true,
          resources: {
            files: true,
            tools: true,
            skills: true,
            agents: true,
            commands: true,
            instructions: true,
            failOnError: true,
          },
          hooks: true,
          modes: true,
          confidential: true,
          metadata: true,
          extensions: true,
        },
      },
    ]);
    expect(applyProfileDiffs(baseline, diffs)).toEqual({});
  });

  it("returns no steps for canonically equal profiles", () => {
    const baseline = agentProfileSchema.parse({
      name: "same",
      tags: ["a", "b"],
      metadata: { alpha: 1, beta: 2 },
      mcp: {
        alpha: { url: "https://alpha.example.test" },
        beta: { url: "https://beta.example.test" },
      },
    });
    const reordered = agentProfileSchema.parse({
      mcp: {
        beta: { url: "https://beta.example.test" },
        alpha: { url: "https://alpha.example.test" },
      },
      metadata: { beta: 2, alpha: 1 },
      tags: ["a", "b"],
      name: "same",
    });

    expect(diffAgentProfiles(baseline, baseline)).toEqual([]);
    expect(diffAgentProfiles(baseline, reordered)).toEqual([]);
  });

  it("emits byte-deterministic detached replacements", () => {
    const baseline = agentProfileSchema.parse({
      model: { reasoningEffort: "low" },
      metadata: { retained: true },
    });
    const candidateA = agentProfileSchema.parse({
      model: { reasoningEffort: "high", default: "openai/gpt-5" },
      metadata: { zeta: 2, alpha: 1 },
      subagents: {
        zeta: { prompt: "Last." },
        alpha: { prompt: "First." },
      },
    });
    const candidateB = agentProfileSchema.parse({
      subagents: {
        alpha: { prompt: "First." },
        zeta: { prompt: "Last." },
      },
      metadata: { alpha: 1, zeta: 2 },
      model: { default: "openai/gpt-5", reasoningEffort: "high" },
    });

    const diffs = diffAgentProfiles(baseline, candidateA);
    const sameDiffs = diffAgentProfiles(baseline, candidateB);
    expect(JSON.stringify(diffs)).toBe(JSON.stringify(sameDiffs));

    candidateA.metadata!.alpha = 99;
    candidateA.subagents!.alpha!.prompt = "Mutated.";
    expect(diffs).toEqual(sameDiffs);
    expect(applyProfileDiffs(baseline, diffs)).toEqual(candidateB);
  });

  it("distinguishes absent and explicitly empty resource objects", () => {
    const addition = verifiedProfileDiffs({}, { resources: {} });
    const removal = verifiedProfileDiffs({ resources: {} }, {});

    expect(addition).toEqual([
      { kind: "agent-profile-diff", remove: { resources: true } },
      { kind: "agent-profile-diff", set: { resources: {} } },
    ]);
    expect(removal).toEqual([
      { kind: "agent-profile-diff", remove: { resources: true } },
    ]);
    expect(applyProfileDiffs({}, addition)).toEqual({ resources: {} });
    expect(applyProfileDiffs({ resources: {} }, removal)).toEqual({});
  });

  it("preserves an explicitly empty resource object when clearing each resource field", () => {
    for (const [field, resources] of Object.entries(resourceFieldCases)) {
      const baseline = agentProfileSchema.parse({ resources });
      const candidate = agentProfileSchema.parse({ resources: {} });
      const diffs = verifiedProfileDiffs(baseline, candidate);

      expect(diffs, field).toEqual([
        {
          kind: "agent-profile-diff",
          remove: { resources: { [field]: true } },
        },
        { kind: "agent-profile-diff", set: { resources: {} } },
      ]);
      expect(applyProfileDiffs(baseline, diffs), field).toEqual(candidate);
    }
  });

  it("uses profile identity normalization for undefined open-record entries", () => {
    const withUndefined = agentProfileSchema.parse({
      metadata: { optional: undefined },
      extensions: { codex: undefined },
    });
    const normalized = agentProfileSchema.parse({
      metadata: {},
      extensions: {},
    });

    expect(diffAgentProfiles(withUndefined, withUndefined)).toEqual([]);
    expect(diffAgentProfiles(withUndefined, normalized)).toEqual([]);
    expect(diffAgentProfiles(normalized, withUndefined)).toEqual([]);

    const addition = verifiedProfileDiffs({}, withUndefined);
    expect(addition).toEqual([
      {
        kind: "agent-profile-diff",
        remove: { metadata: true, extensions: true },
      },
      {
        kind: "agent-profile-diff",
        set: { metadata: {}, extensions: {} },
      },
    ]);
    expect(applyProfileDiffs({}, addition)).toEqual(normalized);
  });

  it("applies a full-profile overlay and named removals", () => {
    const diff = defineAgentProfileDiff({
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
    expect(profile.harness).toBe("claude-code");
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

  it("reports explicit empty identity values as changes", () => {
    for (const set of [
      { name: "" },
      { description: "" },
      { version: "" },
      { tags: [] },
    ]) {
      expect(changedAgentProfileAxes({ kind: "agent-profile-diff", set })).toEqual([
        "identity",
      ]);
    }
  });

  it("does not report structurally empty removals as changed axes", () => {
    for (const remove of [
      { tags: [] },
      { prompt: {} },
      { model: [] },
      { connections: [] },
      { resources: {} },
      { resources: { tools: [] } },
    ]) {
      expect(
        changedAgentProfileAxes({ kind: "agent-profile-diff", remove }),
      ).toEqual([]);
    }
  });

  it("validates generated diffs with the public schema", () => {
    const parsed = agentProfileDiffSchema.parse({
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

  it("rejects obsolete schema markers", () => {
    expect(
      agentProfileDiffSchema.safeParse({
        schemaVersion: 1,
        kind: "agent-profile-diff",
      }).success,
    ).toBe(false);
  });

  it("sets only the harness axis", () => {
    const diff = defineAgentProfileDiff({
      kind: "agent-profile-diff",
      set: { harness: "codex" },
    });

    const profile = applyAgentProfileDiff(baseProfile, diff);
    const control = applyAgentProfileDiff(baseProfile, {
      kind: "agent-profile-diff",
    });

    expect(changedAgentProfileAxes(diff)).toEqual(["harness"]);
    expect(profile.harness).toBe("codex");
    expect(profile).toEqual({ ...control, harness: "codex" });
    expect(baseProfile.harness).toBe("claude-code");
  });

  it("explicitly removes only the harness axis", () => {
    const diff = agentProfileDiffSchema.parse({
      kind: "agent-profile-diff",
      remove: { harness: true },
    });

    const profile = applyAgentProfileDiff(baseProfile, diff);
    const control = applyAgentProfileDiff(baseProfile, {
      kind: "agent-profile-diff",
    });

    expect(changedAgentProfileAxes(diff)).toEqual(["harness"]);
    expect(profile.harness).toBeUndefined();
    expect(profile).toEqual({ ...control, harness: undefined });
    expect(() =>
      agentProfileDiffSchema.parse({
        kind: "agent-profile-diff",
        remove: { harness: false },
      }),
    ).toThrow();
  });

  it("applies harness removal after a harness overlay", () => {
    const profile = applyAgentProfileDiff(baseProfile, {
      kind: "agent-profile-diff",
      set: { harness: "codex" },
      remove: { harness: true },
    });

    expect(profile.harness).toBeUndefined();
  });

  it("prunes harness set and removal without changing other axes", () => {
    const diff = defineAgentProfileDiff({
      kind: "agent-profile-diff",
      set: {
        harness: "codex",
        tools: { shell: true },
      },
      remove: { harness: true },
    });

    const pruned = pruneAgentProfileDiff(diff, ["harness"]);

    const profile = applyAgentProfileDiff(baseProfile, pruned);
    const toolsOnlyControl = applyAgentProfileDiff(baseProfile, {
      kind: "agent-profile-diff",
      set: { tools: { shell: true } },
    });

    expect(pruned.set).not.toHaveProperty("harness");
    expect(pruned.remove).toBeUndefined();
    expect(changedAgentProfileAxes(pruned)).toEqual(["tools"]);
    expect(profile.harness).toBe("claude-code");
    expect(profile).toEqual(toolsOnlyControl);
  });
});
