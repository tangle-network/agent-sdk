import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Sha256Digest } from "./agent-candidate.js";
import { agentCandidateBundleSchema } from "./agent-candidate-schema.js";
import {
  agentCandidateMaterializationReceiptSchema,
  agentCandidateRunReceiptSchema,
} from "./agent-candidate-receipt-schema.js";
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
        code: { kind: "disabled", reason: "control" },
        execution: {
          ...executionWithoutWorkspace,
          launch: { kind: "container-command", executable: "codex" },
          cwd: { workspace: "task", path: "." },
        },
        lineage: { source: "human" },
      }),
    ).not.toThrow();
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidateFixture(),
        code: { kind: "disabled", reason: "control" },
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
        code: { kind: "disabled", reason: "not-applicable" },
        execution: {
          ...executionWithoutWorkspace,
          launch: { kind: "container-command", executable: "codex" },
          cwd: { workspace: "task", path: "." },
        },
      }),
    ).not.toThrow();
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidate,
        code: { kind: "disabled", reason: "control" },
        execution: {
          ...executionWithoutWorkspace,
          launch: { kind: "container-command", executable: "codex" },
          cwd: { workspace: "task", path: "." },
        },
      }),
    ).toThrow(/fixed controls cannot claim proposer lineage/);
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

  it("requires compound lineage to retain distinct parents", () => {
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidateFixture(),
        lineage: {
          ...candidateFixture().lineage,
          source: "compound",
          parentDigests: [candidateSha("1")],
        },
      }),
    ).toThrow(/at least two/);
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidateFixture(),
        lineage: {
          ...candidateFixture().lineage,
          source: "compound",
          parentDigests: [candidateSha("1"), candidateSha("1")],
        },
      }),
    ).toThrow(/duplicate/);
  });

  it("fails closed when a generated candidate omits run, split, or spend", () => {
    for (const lineage of [
      {
        ...candidateFixture().lineage,
        parentDigests: [],
      },
      {
        ...candidateFixture().lineage,
        runIds: [],
      },
      {
        ...candidateFixture().lineage,
        benchmark: undefined,
      },
      {
        ...candidateFixture().lineage,
        spend: undefined,
      },
    ]) {
      expect(() =>
        agentCandidateBundleSchema.parse({ ...candidateFixture(), lineage }),
      ).toThrow(/generated candidates/);
    }
  });

  it("keeps proposer no-ops and parent identities honest", () => {
    const candidate = candidateFixture();
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidate,
        code: {
          kind: "no-op",
          reason: "proposer-no-change",
          repository: candidate.code.repository,
          baseCommit: candidate.code.baseCommit,
          baseTree: candidate.code.baseTree,
        },
        lineage: { source: "human" },
      }),
    ).toThrow(/proposer no-op/);
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidate,
        lineage: {
          ...candidate.lineage,
          parentDigests: [candidate.digest],
        },
      }),
    ).toThrow(/cannot name itself/);
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
      schemaVersion: 1 as const,
      kind: "agent-candidate-workspace-manifest" as const,
      files,
    };
    const manifest = capturedMaterial(material);
    return {
      schemaVersion: 1 as const,
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
    version: 1 as const,
    harness: "codex" as const,
    files: [],
    env: {},
    flags: [],
    unsupported: [],
  };
  const capturedProfilePlan = capturedMaterial(profilePlanMaterial);
  const profilePlan = {
    schemaVersion: 1 as const,
    kind: "agent-profile-workspace-plan" as const,
    digest: capturedProfilePlan.digest,
    material: profilePlanMaterial,
    artifact: capturedProfilePlan.artifact,
  };
  const resetEvidence = embeddedBytes("fresh-memory-reset");
  const executionPlanMaterial = {
    schemaVersion: 1 as const,
    kind: "agent-candidate-execution-plan-material" as const,
    bundleDigest: candidateSha("1"),
    executionId: "run-1",
    attempt: {
      number: 1,
      maxAttempts: 1,
      retryPolicy: "pre-model-infrastructure-only" as const,
    },
    task: {
      benchmark: "pier",
      benchmarkVersion: "0.3",
      taskId: "pier-task-1",
      splitDigest: candidateSha("f"),
      instruction: {
        encoding: "utf8" as const,
        sha256: candidateSha("e"),
        byteLength: 37,
        delivery: { kind: "argv-append" as const },
      },
      repository: {
        identity: "r360/pier-synthetic-task-1",
        rootIdentity: "r360/pier-synthetic",
        baseCommit: candidateGit("a"),
        baseTree: candidateGit("b"),
      },
      workspace: taskWorkspace,
    },
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
    limits: {
      timeoutMs: 600_000,
      maxSteps: 500,
      maxModelCalls: 100,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 100_000,
      maxCostUsd: 100,
    },
    network: { mode: "disabled" as const },
  };
  const capturedExecutionPlan = capturedMaterial(executionPlanMaterial);
  const materialization = {
    schemaVersion: 1,
    kind: "agent-candidate-materialization",
    digestAlgorithm: "rfc8785-sha256",
    bundleDigest: candidateSha("1"),
    profilePlan,
    executionPlan: {
      schemaVersion: 1,
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
        profilePlan: {
          ...materialization.profilePlan,
          artifact: {
            ...materialization.profilePlan.artifact,
            content: "",
            byteLength: 0,
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

  it("records the launched plan, isolated memory, trace, and exit status", () => {
    expect(() =>
      agentCandidateRunReceiptSchema.parse({
        schemaVersion: 1,
        kind: "agent-candidate-run",
        digestAlgorithm: "rfc8785-sha256",
        bundleDigest: candidateSha("1"),
        materializationReceiptDigest: materialization.digest,
        executionPlanDigest: materialization.executionPlan.digest,
        memory: {
          mode: "isolated",
          scope: "task",
          effectiveNamespace: "run-1-memory",
          resetEvidenceDigest: resetEvidence.sha256,
          beforeStateDigest: memoryWorkspace.digest,
          afterState: memoryWorkspace,
        },
        usage: {
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          modelCalls: 0,
        },
        modelUsage: {
          resolved: resolvedModel,
          usage: {
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            modelCalls: 0,
          },
        },
        trace: {
          schemaVersion: 1,
          artifact: {
            encoding: "base64",
            content: "e30=",
            sha256: candidateSha("a"),
            byteLength: 2,
          },
          eventCount: 1,
          modelCallCount: 0,
        },
        termination: { kind: "exit", exitCode: 0 },
        digest: candidateSha("b"),
      }),
    ).not.toThrow();
  });

  it("records timeout, signal, and cancellation without inventing exit codes", () => {
    for (const termination of [
      { kind: "timeout", timeoutMs: 600_000 },
      { kind: "signal", signal: "SIGTERM" },
      { kind: "cancelled" },
    ] as const) {
      expect(() =>
        agentCandidateRunReceiptSchema.parse({
          schemaVersion: 1,
          kind: "agent-candidate-run",
          digestAlgorithm: "rfc8785-sha256",
          bundleDigest: candidateSha("1"),
          materializationReceiptDigest: materialization.digest,
          executionPlanDigest: materialization.executionPlan.digest,
          memory: { mode: "disabled" },
          usage: {
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            modelCalls: 0,
          },
          modelUsage: {
            resolved: resolvedModel,
            usage: {
              costUsd: 0,
              inputTokens: 0,
              outputTokens: 0,
              modelCalls: 0,
            },
          },
          trace: {
            schemaVersion: 1,
            artifact: {
              locator: {
                kind: "s3",
                bucket: "agent-candidate-artifacts",
                key: "traces/termination.jsonl",
              },
              sha256: candidateSha("a"),
              byteLength: 1,
            },
            eventCount: 1,
            modelCallCount: 0,
          },
          termination,
          digest: candidateSha("b"),
        }),
      ).not.toThrow();
    }
  });

  it("rejects empty traces and model-call counts that disagree with usage", () => {
    const receipt = {
      schemaVersion: 1,
      kind: "agent-candidate-run",
      digestAlgorithm: "rfc8785-sha256",
      bundleDigest: candidateSha("1"),
      materializationReceiptDigest: materialization.digest,
      executionPlanDigest: materialization.executionPlan.digest,
      memory: { mode: "disabled" },
      usage: {
        costUsd: 1,
        inputTokens: 10,
        outputTokens: 2,
        modelCalls: 1,
      },
      modelUsage: {
        resolved: resolvedModel,
        usage: {
          costUsd: 1,
          inputTokens: 10,
          outputTokens: 2,
          modelCalls: 1,
        },
      },
      trace: {
        schemaVersion: 1,
        artifact: {
          encoding: "base64",
          content: "e30=",
          sha256: candidateSha("a"),
          byteLength: 2,
        },
        eventCount: 1,
        modelCallCount: 1,
      },
      termination: { kind: "exit", exitCode: 0 },
      digest: candidateSha("b"),
    } as const;

    expect(() => agentCandidateRunReceiptSchema.parse(receipt)).not.toThrow();
    expect(() =>
      agentCandidateRunReceiptSchema.parse({
        ...receipt,
        trace: { ...receipt.trace, eventCount: 0 },
      }),
    ).toThrow();
    expect(() =>
      agentCandidateRunReceiptSchema.parse({
        ...receipt,
        usage: { ...receipt.usage, modelCalls: 2 },
      }),
    ).toThrow(/single-model usage/);
    expect(() =>
      agentCandidateRunReceiptSchema.parse({
        ...receipt,
        trace: { ...receipt.trace, modelCallCount: 2 },
      }),
    ).toThrow(/model-call count/);
    expect(() =>
      agentCandidateRunReceiptSchema.parse({
        ...receipt,
        usage: { ...receipt.usage, modelCalls: 2 },
        modelUsage: {
          ...receipt.modelUsage,
          usage: { ...receipt.modelUsage.usage, modelCalls: 2 },
        },
        trace: { ...receipt.trace, modelCallCount: 2 },
      }),
    ).toThrow(/one event for every model call/);
  });
});
