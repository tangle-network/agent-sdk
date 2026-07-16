import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Sha256Digest } from "./agent-candidate.js";
import { agentCandidateBundleSchema } from "./agent-candidate-schema.js";
import { agentCandidateMaterializationReceiptSchema } from "./agent-candidate-receipt-schema.js";
import {
  candidateFixture,
  candidateGit,
  candidateSha,
} from "./agent-candidate.test-fixture.js";

describe("agentCandidateBundleSchema", () => {
  it("parses a strict frozen candidate envelope", () => {
    const parsed = agentCandidateBundleSchema.parse(candidateFixture());
    expect(parsed.profile.harness).toBe("codex");
    expect(parsed.code.kind).toBe("git-patch");
    expect(parsed.memory).toEqual({
      mode: "isolated",
      scope: "task",
    });
    expect(
      agentCandidateBundleSchema.safeParse({
        ...candidateFixture(),
        schemaVersion: 2,
      }).success,
    ).toBe(false);
  });

  it("does not require retrieval evidence for a file-backed knowledge candidate", () => {
    const candidate = candidateFixture();
    if (!candidate.knowledge) throw new Error("fixture must include knowledge");
    const { retrievalConfig: _retrievalConfig, ...knowledge } = candidate.knowledge;
    expect(
      agentCandidateBundleSchema.parse({ ...candidate, knowledge }).knowledge,
    ).toEqual(knowledge);
  });

  it("accepts canonical harness aliases but rejects a true mismatch", () => {
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidateFixture(),
        profile: { ...candidateFixture().profile, harness: "claude" },
        execution: {
          ...candidateFixture().execution,
          harness: "claude-code",
        },
      }),
    ).not.toThrow();
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidateFixture(),
        execution: {
          ...candidateFixture().execution,
          harness: "claude-code",
        },
      }),
    ).toThrow(/must match/);
  });

  it("keeps disabled controls out of the candidate workspace", () => {
    const { workspace: _workspace, ...executionWithoutWorkspace } =
      candidateFixture().execution;
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidateFixture(),
        code: { kind: "disabled" },
        execution: {
          ...executionWithoutWorkspace,
          launch: { kind: "container-command", executable: "codex" },
          cwd: { workspace: "task", path: "." },
        },
      }),
    ).not.toThrow();
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidateFixture(),
        code: { kind: "disabled" },
      }),
    ).toThrow(/disabled code controls/);
  });

  it("represents optimized non-code surfaces without inventing a code change", () => {
    const candidate = candidateFixture();
    const { workspace: _workspace, ...executionWithoutWorkspace } =
      candidate.execution;
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidate,
        code: { kind: "disabled" },
        execution: {
          ...executionWithoutWorkspace,
          launch: { kind: "container-command", executable: "codex" },
          cwd: { workspace: "task", path: "." },
        },
      }),
    ).not.toThrow();
  });

  it("requires active code to use its structured candidate entrypoint", () => {
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidateFixture(),
        execution: {
          ...candidateFixture().execution,
          launch: {
            kind: "container-command",
            executable: "echo",
            args: [{ kind: "public", value: "dist/agent.js" }],
          },
        },
      }),
    ).toThrow(/launch its candidate entrypoint/);
  });

  it("requires active code to pin the complete executable workspace", () => {
    const candidate = candidateFixture();
    const { workspace: _workspace, ...executionWithoutWorkspace } =
      candidate.execution;
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidate,
        execution: executionWithoutWorkspace,
      }),
    ).toThrow(/complete candidate workspace/);
  });

  it("requires a direct candidate entrypoint to carry executable mode", () => {
    const candidate = candidateFixture();
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidate,
        execution: {
          ...candidate.execution,
          launch: {
            kind: "candidate-entrypoint",
            entrypoint: "dist/agent.js",
          },
          workspace: {
            ...candidate.execution.workspace,
            material: {
              ...candidate.execution.workspace.material,
              files: candidate.execution.workspace.material.files.map(
                (file) => ({
                  ...file,
                  mode: 0o644,
                }),
              ),
            },
          },
        },
      }),
    ).toThrow(/must be executable/);
  });

  it("allows active candidate code to edit an evaluator-owned task workspace", () => {
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidateFixture(),
        execution: {
          ...candidateFixture().execution,
          cwd: { workspace: "task", path: "." },
          environment: { kind: "evaluator-task-container" },
        },
      }),
    ).not.toThrow();
  });

  it("rejects non-I-JSON values before RFC 8785 hashing", () => {
    for (const systemPrompt of [
      Number.NaN,
      new Date(),
      "\ud800",
    ]) {
      expect(() =>
        agentCandidateBundleSchema.parse({
          ...candidateFixture(),
          profile: {
            ...candidateFixture().profile,
            prompt: { systemPrompt },
          },
        }),
      ).toThrow();
    }
  });

  it("rejects malformed identities and unknown wire fields", () => {
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidateFixture(),
        digest: "sha256:short",
      }),
    ).toThrow();
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidateFixture(),
        ignoredByOldConsumer: true,
      }),
    ).toThrow(/Unrecognized key/);
  });
});

describe("candidate receipts", () => {
  const sha256 = (bytes: string | Uint8Array): Sha256Digest =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const canonicalJson = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  };
  const embeddedBytes = (bytes: string) => ({
    encoding: "base64" as const,
    content: Buffer.from(bytes).toString("base64"),
    sha256: sha256(bytes),
    byteLength: Buffer.byteLength(bytes),
  });
  const capturedMaterial = (material: unknown) => {
    const bytes = canonicalJson(material);
    return { digest: sha256(bytes), artifact: embeddedBytes(bytes) };
  };
  const workspaceSnapshot = (
    files: Array<{
      path: string;
      mode: 0o644 | 0o755;
      sha256: Sha256Digest;
      byteLength: number;
    }>,
    archiveName: string,
  ) => {
    const material = {
      kind: "agent-candidate-workspace-manifest" as const,
      files,
    };
    const manifest = capturedMaterial(material);
    return {
      kind: "agent-candidate-workspace-snapshot" as const,
      digest: manifest.digest,
      material,
      manifest: manifest.artifact,
      archive: embeddedBytes(`${archiveName}-archive`),
    };
  };

  const candidateWorkspace = workspaceSnapshot(
    [
      {
        path: "dist/agent.js",
        mode: 0o755,
        sha256: candidateSha("8"),
        byteLength: 42,
      },
    ],
    "candidate",
  );
  const taskWorkspace = workspaceSnapshot(
    [
      {
        path: "src/task.ts",
        mode: 0o644,
        sha256: candidateSha("0"),
        byteLength: 12,
      },
    ],
    "task",
  );
  const memoryWorkspace = workspaceSnapshot([], "memory");
  const resolvedModel = {
    requested: "openai/gpt-5.4",
    provider: "openai",
    model: "gpt-5.4",
    snapshot: "gpt-5.4-2026-06-15",
    reasoningEffort: "high" as const,
  };
  const profilePlanMaterial = {
    sourceProfileDigest: candidateSha("f"),
    harness: "codex" as const,
    files: [],
    env: {},
    flags: [],
    unsupported: [],
  };
  const capturedProfilePlan = capturedMaterial(profilePlanMaterial);
  const profilePlan = {
    kind: "agent-profile-workspace-plan" as const,
    digest: capturedProfilePlan.digest,
    material: profilePlanMaterial,
    artifact: capturedProfilePlan.artifact,
  };
  const resetEvidence = embeddedBytes("fresh-memory-reset");
  const capturedSuite = capturedMaterial({
    kind: "agent-candidate-benchmark-suite",
    digestAlgorithm: "rfc8785-sha256",
    taskDigests: [candidateSha("0")],
    reps: 1,
    seeds: [42],
  });
  const capturedTask = capturedMaterial({
    kind: "agent-candidate-benchmark-task",
    taskId: "pier-task-1",
  });
  const executionPlanMaterial = {
    kind: "agent-candidate-execution-plan-material" as const,
    runCell: {
      kind: "agent-candidate-run-cell" as const,
      experimentDigest: candidateSha("e"),
      arm: "candidate" as const,
      bundleDigest: candidateSha("1"),
      suiteDigest: capturedSuite.digest,
      taskDigest: capturedTask.digest,
      taskIndex: 0,
      repetition: 0,
      seed: 42,
      attempt: 1,
      digest: candidateSha("d"),
    },
    executionId: "run-1",
    workspaces: {
      taskRoot: "/work/task",
      candidateRoot: "/work/candidate",
    },
    codeKind: "git-patch" as const,
    candidateWorkspace,
    profile: {
      planDigest: profilePlan.digest,
      targetWorkspace: "task" as const,
      mountPaths: [],
    },
    harness: "codex" as const,
    harnessVersion: "0.1.0",
    instructionDelivery: { kind: "stdin-utf8" as const },
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
      indexDigest: candidateSha("5"),
      manifestDigest: candidateSha("6"),
      platform: { os: "linux", architecture: "amd64" },
    },
    model: {
      policy: "single" as const,
      resolved: resolvedModel,
      access: {
        kind: "evaluator-mediated" as const,
        grantDigest: candidateSha("d"),
        network: {
          mode: "gateway-only" as const,
          domains: ["router.tangle.tools"],
        },
      },
      routes: [{ kind: "primary" as const, requested: "openai/gpt-5.4" }],
    },
    launch: {
      executable: "node",
      args: [{ kind: "public" as const, value: "dist/agent.js" }],
      env: {},
      cwd: { workspace: "task" as const, path: "." },
    },
    knowledgeManifestDigest: candidateSha("7"),
    memory: {
      mode: "isolated" as const,
      scope: "task" as const,
      effectiveNamespace: "run-1-memory",
      reset: {
        kind: "fresh" as const,
        evidence: resetEvidence,
        emptyStateDigest: memoryWorkspace.digest,
      },
      beforeState: memoryWorkspace,
    },
    network: { mode: "disabled" as const },
  };
  const capturedExecutionPlan = capturedMaterial(executionPlanMaterial);
  const materialization = {
    kind: "agent-candidate-materialization",
    digestAlgorithm: "rfc8785-sha256",
    bundleDigest: candidateSha("1"),
    benchmark: {
      suite: {
        digest: capturedSuite.digest,
        material: capturedSuite.artifact,
      },
      task: {
        digest: capturedTask.digest,
        material: capturedTask.artifact,
      },
    },
    profileActivation: {
      kind: "agent-candidate-profile-activation",
      profilePlan,
      files: [],
      digest: candidateSha("c"),
    },
    executionPlan: {
      kind: "agent-candidate-execution-plan",
      digest: capturedExecutionPlan.digest,
      material: executionPlanMaterial,
      artifact: capturedExecutionPlan.artifact,
    },
    candidateWorkspace,
    codeKind: "git-patch",
    materializedTree: candidateGit("4"),
    harness: "codex",
    harnessVersion: "0.1.0",
    container: {
      source: "evaluator-task-container",
      image: "pier-task:0.3",
      indexDigest: candidateSha("5"),
      manifestDigest: candidateSha("6"),
      platform: { os: "linux", architecture: "amd64" },
    },
    resolvedModel,
    knowledgeManifestDigest: candidateSha("7"),
    entrypoint: {
      path: "dist/agent.js",
      sha256: candidateSha("8"),
      byteLength: 42,
    },
    digest: candidateSha("9"),
  } as const;

  it("binds selected OCI bytes, model, tree, entrypoint, and execution plan", () => {
    expect(() =>
      agentCandidateMaterializationReceiptSchema.parse(materialization),
    ).not.toThrow();
    expect(() =>
      agentCandidateMaterializationReceiptSchema.parse({
        ...materialization,
        codeKind: "disabled",
      }),
    ).toThrow(/disabled code/);
    expect(() =>
      agentCandidateMaterializationReceiptSchema.parse({
        ...materialization,
        entrypoint: {
          ...materialization.entrypoint,
          sha256: candidateSha("f"),
        },
      }),
    ).toThrow(/exact candidate-workspace bytes/);
    expect(() =>
      agentCandidateMaterializationReceiptSchema.parse({
        ...materialization,
        executionPlan: {
          ...materialization.executionPlan,
          material: {
            ...materialization.executionPlan.material,
            profile: {
              ...materialization.executionPlan.material.profile,
              mountPaths: ["AGENTS.md"],
            },
          },
        },
      }),
    ).toThrow(/every profile mount path/);
  });

  it("requires captured canonical bytes for both materialization plans", () => {
    const executionBytes = Buffer.from(
      materialization.executionPlan.artifact.content,
      "base64",
    ).toString("utf8");
    expect(executionBytes).toBe(canonicalJson(executionPlanMaterial));
    expect(sha256(executionBytes)).toBe(materialization.executionPlan.digest);
    expect(() =>
      agentCandidateMaterializationReceiptSchema.parse({
        ...materialization,
        executionPlan: {
          ...materialization.executionPlan,
          artifact: {
            ...materialization.executionPlan.artifact,
            sha256: candidateSha("f"),
          },
        },
      }),
    ).toThrow(/canonical material digest/);
    expect(() =>
      agentCandidateMaterializationReceiptSchema.parse({
        ...materialization,
        profileActivation: {
          ...materialization.profileActivation,
          profilePlan: {
            ...materialization.profileActivation.profilePlan,
            artifact: {
              ...materialization.profileActivation.profilePlan.artifact,
              content: "",
              byteLength: 0,
            },
          },
        },
      }),
    ).toThrow(/canonical material bytes/);
  });

  it("records whether the candidate or evaluator selected the executed image", () => {
    expect(materialization.container.source).toBe("evaluator-task-container");
    expect(() =>
      agentCandidateMaterializationReceiptSchema.parse({
        ...materialization,
        container: { ...materialization.container, source: "unknown" },
      }),
    ).toThrow();
    expect(() =>
      agentCandidateMaterializationReceiptSchema.parse({
        ...materialization,
        container: { ...materialization.container, image: "other-task:0.3" },
      }),
    ).toThrow(/selected container bytes/);
    expect(() =>
      agentCandidateMaterializationReceiptSchema.parse({
        ...materialization,
        resolvedModel: { ...resolvedModel, snapshot: "different-snapshot" },
      }),
    ).toThrow(/exact resolved model/);
  });

});
