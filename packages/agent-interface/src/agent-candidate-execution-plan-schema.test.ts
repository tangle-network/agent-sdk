import { describe, expect, it } from "vitest";
import {
  agentCandidateExecutionPlanMaterialSchema,
  agentCandidateProfilePlanMaterialSchema,
  agentCandidateResolvedModelSchema,
} from "./agent-candidate-execution-plan-schema.js";
import { candidateSha } from "./agent-candidate.test-fixture.js";

function workspace(path: string, digit: string) {
  return {
    schemaVersion: 1 as const,
    kind: "agent-candidate-workspace-snapshot" as const,
    digest: candidateSha(digit),
    material: {
      schemaVersion: 1 as const,
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
    schemaVersion: 1 as const,
    kind: "agent-candidate-execution-plan-material" as const,
    bundleDigest: candidateSha("1"),
    executionId: "execution-1",
    attempt: {
      number: 1,
      maxAttempts: 1,
      retryPolicy: "pre-model-infrastructure-only" as const,
    },
    task: {
      benchmark: "pier",
      benchmarkVersion: "0.3",
      taskId: "task-1",
      splitDigest: candidateSha("2"),
      inputDigest: candidateSha("3"),
      repository: {
        identity: "tangle-network/agent-runtime",
        rootIdentity: "tangle-network/agent-runtime",
        baseCommit: "1".repeat(40),
        baseTree: "2".repeat(40),
      },
      workspace: workspace("src/task.ts", "4"),
    },
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
      env: {},
      cwd: { workspace: "task" as const, path: "." },
    },
    memory: { mode: "disabled" as const },
    limits: {
      timeoutMs: 60_000,
      maxSteps: 200,
      maxModelCalls: 20,
      maxInputTokens: 200_000,
      maxOutputTokens: 20_000,
      maxCostUsd: 20,
    },
    network: { mode: "disabled" as const },
  };
}

describe("agentCandidateExecutionPlanMaterialSchema", () => {
  it("accepts one complete digest-free per-task identity document", () => {
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse(planFixture()),
    ).not.toThrow();
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...planFixture(),
        digest: candidateSha("f"),
      }),
    ).toThrow(/Unrecognized key/);
  });

  it("requires the split, fixed disjoint roots, and evaluator model access", () => {
    const plan = planFixture();
    const { splitDigest: _splitDigest, ...taskWithoutSplit } = plan.task;
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        task: taskWithoutSplit,
      }),
    ).toThrow();
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        task: {
          ...plan.task,
          repository: {
            ...plan.task.repository,
            baseTree: "2".repeat(64),
          },
        },
      }),
    ).toThrow(/one object format/);
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        workspaces: {
          taskRoot: "/work",
          candidateRoot: "/work/candidate",
        },
      }),
    ).toThrow(/disjoint/);
    const { access: _access, ...modelWithoutAccess } = plan.model;
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        model: modelWithoutAccess,
      }),
    ).toThrow();
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
      version: 1,
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

  it("freezes counted attempts, retry policy, and tool-loop steps", () => {
    const plan = planFixture();
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        attempt: { ...plan.attempt, number: 2 },
      }),
    ).toThrow(/cannot exceed/);
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        attempt: { number: 1, maxAttempts: 2, retryPolicy: "none" },
      }),
    ).toThrow(/exactly one attempt/);
    expect(() =>
      agentCandidateExecutionPlanMaterialSchema.parse({
        ...plan,
        limits: { ...plan.limits, maxSteps: 0 },
      }),
    ).toThrow();
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
