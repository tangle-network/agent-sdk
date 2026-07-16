import { describe, expect, it } from "vitest";
import {
  agentCandidateExecutionPlanMaterialSchema,
  agentCandidateProfileActivationSchema,
  agentCandidateProfilePlanMaterialSchema,
  agentCandidateResolvedModelSchema,
} from "./agent-candidate-execution-plan-schema.js";
import { candidateSha } from "./agent-candidate.test-fixture.js";

function workspace(path: string, digit: string) {
  return {
    kind: "agent-candidate-workspace-snapshot" as const,
    digest: candidateSha(digit),
    material: {
      kind: "agent-candidate-workspace-manifest" as const,
      files: [
        {
          path,
          mode: 0o644 as const,
          sha256: candidateSha("a"),
          byteLength: 1,
        },
      ],
    },
    manifest: {
      encoding: "base64" as const,
      content: "e30=",
      sha256: candidateSha(digit),
      byteLength: 2,
    },
    archive: {
      encoding: "base64" as const,
      content: "e30=",
      sha256: candidateSha("b"),
      byteLength: 2,
    },
  };
}

function planFixture() {
  const resolved = {
    requested: "openai/gpt-5.4",
    provider: "openai",
    model: "gpt-5.4",
    snapshot: "gpt-5.4-2026-06-15",
    reasoningEffort: "high" as const,
  };
  return {
    kind: "agent-candidate-execution-plan-material" as const,
    runCell: {
      kind: "agent-candidate-run-cell" as const,
      experimentDigest: candidateSha("0"),
      arm: "candidate" as const,
      bundleDigest: candidateSha("1"),
      suiteDigest: candidateSha("9"),
      taskDigest: candidateSha("2"),
      taskIndex: 0,
      repetition: 0,
      seed: 42,
      attempt: 1,
      digest: candidateSha("3"),
    },
    executionId: "execution-1",
    workspaces: {
      taskRoot: "/work/task",
      candidateRoot: "/work/candidate",
    },
    codeKind: "git-patch" as const,
    candidateWorkspace: workspace("dist/agent.js", "5"),
    profile: {
      planDigest: candidateSha("6"),
      targetWorkspace: "task" as const,
      mountPaths: [],
    },
    harness: "codex" as const,
    harnessVersion: "0.1.0",
    instructionDelivery: {
      kind: "utf8-file" as const,
      env: "TANGLE_CANDIDATE_TASK_PATH" as const,
      path: "/tangle/input/task.txt" as const,
    },
    limits: {
      timeoutMs: 120_000,
      maxSteps: 50,
      maxModelCalls: 12,
      maxInputTokens: 100_000,
      maxOutputTokens: 20_000,
      maxCostUsd: 5,
    },
    container: {
      source: "evaluator-task-container" as const,
      image: "pier-task:0.3",
      indexDigest: candidateSha("7"),
      manifestDigest: candidateSha("8"),
      platform: { os: "linux", architecture: "amd64" },
    },
    model: {
      policy: "single" as const,
      resolved,
      access: {
        kind: "evaluator-mediated" as const,
        grantDigest: candidateSha("9"),
        network: {
          mode: "gateway-only" as const,
          domains: ["router.tangle.tools"],
        },
      },
      routes: [
        { kind: "primary" as const, requested: "openai/gpt-5.4" },
        {
          kind: "subagent" as const,
          name: "reviewer",
          requested: "openai/gpt-5.4",
        },
      ],
    },
    launch: {
      executable: "node",
      args: [{ kind: "public" as const, value: "dist/agent.js" }],
      env: {
        TANGLE_CANDIDATE_TASK_PATH: {
          kind: "public" as const,
          value: "/tangle/input/task.txt",
        },
      },
      cwd: { workspace: "task" as const, path: "." },
    },
    memory: { mode: "disabled" as const },
    network: { mode: "disabled" as const },
  };
}

describe("agentCandidateExecutionPlanMaterialSchema", () => {
  it("binds native activation paths and modes to the canonical profile plan", () => {
    const profilePlan = {
      kind: "agent-profile-workspace-plan" as const,
      digest: candidateSha("1"),
      material: {
        sourceProfileDigest: candidateSha("0"),
        harness: "codex" as const,
        files: [
          {
            relPath: ".codex/instructions.md",
            mode: 0o664,
            contentSha256:
              "sha256:fa79d4746c21cd960a17b92db8976ddef95a7e20b590721f8e0fa7847a05e486",
          },
        ],
        env: {},
        flags: [],
        unsupported: [],
      },
      artifact: {
        encoding: "base64" as const,
        content: "e30=",
        sha256: candidateSha("1"),
        byteLength: 2,
      },
    };
    const activation = {
      kind: "agent-candidate-profile-activation" as const,
      profilePlan,
      files: [{ path: ".codex/instructions.md", mode: 0o664, content: "exact" }],
      digest: candidateSha("3"),
    };

    expect(agentCandidateProfileActivationSchema.parse(activation)).toEqual(activation);
    expect(
      agentCandidateProfileActivationSchema.safeParse({
        ...activation,
        files: [{ ...activation.files[0], path: ".codex/different.md" }],
      }).success,
    ).toBe(false);
    expect(
      agentCandidateProfileActivationSchema.safeParse({
        ...activation,
        files: [{ ...activation.files[0], mode: 0o755 }],
      }).success,
    ).toBe(false);
    expect(
      agentCandidateProfileActivationSchema.safeParse({
        ...activation,
        files: [{ ...activation.files[0], content: "different" }],
      }).success,
    ).toBe(false);
  });

  it("accepts one complete digest-free per-task identity document", () => {
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse(planFixture()),
    ).not.toThrow();
    expect(
      agentCandidateExecutionPlanMaterialSchema.safeParse({
        ...planFixture(),
        schemaVersion: 2,
      }).success,
    ).toBe(false);
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...planFixture(),
        digest: candidateSha("f"),
      }),
    ).toThrow(/Unrecognized key/);
  });

  it("requires fixed disjoint roots and evaluator model access", () => {
    const plan = planFixture();
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        workspaces: {
          taskRoot: "/work",
          candidateRoot: "/work/candidate",
        },
      }),
    ).toThrow(/disjoint/);
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        workspaces: { ...plan.workspaces, taskRoot: "/tangle/input" },
      }),
    ).toThrow(/task file delivery must be outside/);
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        launch: {
          ...plan.launch,
          env: {
            TANGLE_CANDIDATE_TASK_PATH: {
              kind: "public",
              value: "/tmp/task.txt",
            },
          },
        },
      }),
    ).toThrow(/fixed evaluator-owned path/);
    const { access: _access, ...modelWithoutAccess } = plan.model;
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        model: modelWithoutAccess,
      }),
    ).toThrow();
  });

  it("rejects task-owned fields so they cannot drift from the signed suite", () => {
    const plan = planFixture();
    for (const field of ["task", "grader", "limits"] as const) {
      expect(
        agentCandidateExecutionPlanMaterialSchema.safeParse({
          ...plan,
          [field]: {},
        }).success,
      ).toBe(false);
    }
  });

  it("rejects ambiguous roots and silently omitted profile behavior", () => {
    const plan = planFixture();
    for (const taskRoot of ["/work\\task", "/work/ta\nsk", "/work/../task"]) {
      expect(() =>
        agentCandidateExecutionPlanMaterialSchema.parse({
          ...plan,
          workspaces: { ...plan.workspaces, taskRoot },
        }),
      ).toThrow(/canonical absolute path/);
    }

    const profilePlan = {
      sourceProfileDigest: candidateSha("0"),
      harness: "codex",
      files: [],
      env: {},
      flags: [],
      unsupported: [
        { dimension: "hooks", reason: "backend does not implement hooks" },
      ],
    };
    expect(() =>
      agentCandidateProfilePlanMaterialSchema.parse(profilePlan),
    ).toThrow(/cannot omit profile behavior/);
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        profile: { ...plan.profile, mountPaths: ["z", "a"] },
      }),
    ).toThrow(/lexicographically sorted/);
  });

  it("carries an exact typed system-prompt replacement in profile-plan identity", () => {
    const material = {
      sourceProfileDigest: candidateSha("0"),
      harness: "claude-code",
      files: [],
      env: {},
      flags: [],
      systemPrompt: { kind: "public", value: "Use the repository rules." },
      unsupported: [],
    };
    expect(agentCandidateProfilePlanMaterialSchema.parse(material)).toEqual(
      material,
    );
    expect(() =>
      agentCandidateProfilePlanMaterialSchema.parse({
        ...material,
        systemPrompt: "Use the repository rules.",
      }),
    ).toThrow();
  });

  it("requires a workspace root for candidate-targeted profile files", () => {
    const plan = planFixture();
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        codeKind: "disabled",
        candidateWorkspace: undefined,
        workspaces: { taskRoot: plan.workspaces.taskRoot },
        profile: { ...plan.profile, targetWorkspace: "candidate" },
      }),
    ).toThrow(/candidate-targeted profile files/);
  });

  it("rejects alternate model routes and incomplete resolved identities", () => {
    const plan = planFixture();
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        model: {
          ...plan.model,
          routes: [
            { kind: "primary", requested: "openai/gpt-5.4" },
            {
              kind: "subagent",
              name: "reviewer",
              requested: "openai/gpt-5-mini",
            },
          ],
        },
      }),
    ).toThrow(/one resolved model literal/);
    const { snapshot: _snapshot, ...withoutSnapshot } = plan.model.resolved;
    expect(() => agentCandidateResolvedModelSchema.parse(withoutSnapshot)).toThrow();
    const { reasoningEffort: _reasoningEffort, ...withoutEffort } =
      plan.model.resolved;
    expect(() => agentCandidateResolvedModelSchema.parse(withoutEffort)).toThrow();
  });

  it("freezes only exact model-gateway domains", () => {
    const plan = planFixture();
    for (const domain of [
      "*.tangle.tools",
      ".tangle.tools",
      "https://router.tangle.tools",
      "ROUTER.TANGLE.TOOLS",
      "localhost",
      "10.0.0.1",
    ]) {
      expect(() =>
        agentCandidateExecutionPlanMaterialSchema.parse({
          ...plan,
          model: {
            ...plan.model,
            access: {
              ...plan.model.access,
              network: { mode: "gateway-only", domains: [domain] },
            },
          },
        }),
      ).toThrow();
    }
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        model: {
          ...plan.model,
          access: {
            ...plan.model.access,
            network: {
              mode: "gateway-only",
              domains: ["z.example.com", "a.example.com"],
            },
          },
        },
      }),
    ).toThrow(/lexicographically sorted/);
  });

  it("keeps only the exact attempt number in the run cell", () => {
    const plan = planFixture();
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        runCell: { ...plan.runCell, attempt: 0 },
      }),
    ).toThrow();
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        runCell: { ...plan.runCell, maxAttempts: 2 },
      }),
    ).toThrow(/Unrecognized key/);
  });

  it("requires active workspace bytes and fresh reset evidence", () => {
    const plan = planFixture();
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        candidateWorkspace: undefined,
      }),
    ).toThrow(/complete candidate-workspace snapshot/);
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        memory: {
          mode: "isolated",
          scope: "task",
          effectiveNamespace: "execution-1-memory",
        },
      }),
    ).toThrow();
  });
});
