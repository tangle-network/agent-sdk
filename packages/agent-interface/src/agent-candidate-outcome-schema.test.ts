import { describe, expect, it } from "vitest";
import {
  agentCandidateBenchmarkDimensionSchema,
  agentCandidateBenchmarkResultEvidenceSchema,
  agentCandidateBenchmarkResultMaterialSchema,
  agentCandidateFixedSpendSchema,
  agentCandidateModelSettlementCallSchema,
  agentCandidateModelSettlementEvidenceSchema,
  agentCandidateModelSettlementMaterialSchema,
  agentCandidateTaskOutcomeEvidenceSchema,
  agentCandidateTaskOutcomeMaterialSchema,
} from "./agent-candidate-outcome-schema.js";
import {
  agentCandidateMaterializationReceiptSchema,
  agentCandidateRunReceiptSchema,
} from "./agent-candidate-receipt-schema.js";
import {
  agentImprovementProposalSchema,
  agentImprovementReviewSchema,
  candidateExecutionEvidenceSchema,
} from "./agent-candidate-promotion-schema.js";
import {
  candidateFixture,
  candidateGit,
  candidateSha,
} from "./agent-candidate.test-fixture.js";

function durableArtifact(key: string, digit: string, byteLength = 1) {
  return {
    locator: {
      kind: "s3" as const,
      bucket: "agent-candidate-artifacts",
      key,
      region: "us-east-1",
    },
    sha256: candidateSha(digit),
    byteLength,
  };
}

function workspaceSnapshot(name: string, digit: string) {
  return {
    schemaVersion: 2 as const,
    kind: "agent-candidate-workspace-snapshot" as const,
    digest: candidateSha(digit),
    material: {
      schemaVersion: 2 as const,
      kind: "agent-candidate-workspace-manifest" as const,
      files: [
        {
          path: "src/result.ts",
          mode: 0o644 as const,
          sha256: candidateSha("1"),
          byteLength: 17,
        },
      ],
    },
    manifest: durableArtifact(`outcomes/${name}/manifest.json`, digit, 42),
    archive: durableArtifact(`outcomes/${name}/workspace.tar`, "2", 100),
  };
}

const resolvedModel = {
  requested: "openai/gpt-5.4",
  provider: "openai",
  model: "gpt-5.4",
  snapshot: "gpt-5.4-2026-06-15",
  reasoningEffort: "high" as const,
};

function materializationReceipt(receipt: ReturnType<typeof runReceipt>) {
  const profilePlan = {
    schemaVersion: 1 as const,
    kind: "agent-profile-workspace-plan" as const,
    digest: candidateSha("1"),
    material: {
      version: 1 as const,
      harness: "codex" as const,
      files: [],
      env: {},
      flags: [],
      unsupported: [],
    },
    artifact: durableArtifact("plans/profile.json", "1", 72),
  };
  const executionPlanMaterial = {
    schemaVersion: 2 as const,
    kind: "agent-candidate-execution-plan-material" as const,
    bundleDigest: receipt.bundleDigest,
    executionId: "candidate-execution-1",
    attempt: { number: 1, maxAttempts: 1, retryPolicy: "none" as const },
    task: {
      benchmark: "output",
      benchmarkVersion: "1.0.0",
      taskId: "task-1",
      splitDigest: candidateSha("2"),
      instruction: {
        encoding: "utf8" as const,
        sha256: candidateSha("3"),
        byteLength: 1,
        delivery: { kind: "stdin-utf8" as const },
      },
      repository: {
        identity: receipt.taskOutcome.material.outcome.baseRepository.identity,
        rootIdentity: receipt.taskOutcome.material.outcome.baseRepository.rootIdentity,
        baseCommit: receipt.taskOutcome.material.outcome.baseRepository.commit,
        baseTree: receipt.taskOutcome.material.outcome.baseRepository.tree,
      },
      outcome: { kind: "workspace" as const },
      workspace: workspaceSnapshot("input", "4"),
    },
    workspaces: { taskRoot: "/work/task" },
    codeKind: "disabled" as const,
    profile: { planDigest: profilePlan.digest, targetWorkspace: "task" as const, mountPaths: [] },
    harness: "codex" as const,
    harnessVersion: "0.1.0",
    container: {
      source: "evaluator-task-container" as const,
      image: "candidate:1.0.0",
      indexDigest: candidateSha("5"),
      manifestDigest: candidateSha("6"),
      platform: { os: "linux", architecture: "amd64" },
    },
    model: {
      policy: "single" as const,
      resolved: resolvedModel,
      access: {
        kind: "evaluator-mediated" as const,
        grantDigest: candidateSha("7"),
        network: { mode: "disabled" as const },
      },
      routes: [{ kind: "primary" as const, requested: "openai/gpt-5.4" }],
    },
    grader: {
      name: "output-grader",
      version: "1.0.0",
      artifact: durableArtifact("graders/output.tar", "8", 100),
    },
    launch: {
      executable: "node",
      args: [],
      env: {},
      cwd: { workspace: "task" as const, path: "." },
    },
    memory: { mode: "disabled" as const },
    limits: {
      timeoutMs: 1_000,
      maxSteps: 1,
      maxModelCalls: 0,
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxCostUsd: 0,
    },
    network: { mode: "disabled" as const },
  };
  return {
    schemaVersion: 2 as const,
    kind: "agent-candidate-materialization" as const,
    digestAlgorithm: "rfc8785-sha256" as const,
    bundleDigest: receipt.bundleDigest,
    profilePlan,
    executionPlan: {
      schemaVersion: 2 as const,
      kind: "agent-candidate-execution-plan" as const,
      digest: receipt.executionPlanDigest,
      material: executionPlanMaterial,
      artifact: durableArtifact("plans/execution.json", "3", 800),
    },
    codeKind: "disabled" as const,
    harness: "codex" as const,
    harnessVersion: "0.1.0",
    container: executionPlanMaterial.container,
    resolvedModel,
    digest: receipt.materializationReceiptDigest,
  };
}

function runReceipt() {
  const executionPlanDigest = candidateSha("3");
  const fixedUsage = {
    inputTokens: 30,
    outputTokens: 12,
    cachedInputTokens: 7,
    reasoningTokens: 5,
    modelCalls: 2,
    costUsdNanos: 1_250_000_000,
  };
  const modelSettlementMaterial = {
    schemaVersion: 2 as const,
    kind: "agent-candidate-model-settlement-material" as const,
    executionPlanDigest,
    preparationId: "candidate-preparation-v1.abc123",
    grantDigest: candidateSha("4"),
    closed: true as const,
    resolved: resolvedModel,
    calls: [
      {
        callId: "call-1",
        generationId: "span-1",
        traceSpanId: "span-1",
        status: "succeeded" as const,
        model: "gpt-5.4",
        startedAtMs: 120,
        endedAtMs: 180,
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 3,
        reasoningTokens: 2,
        costUsdNanos: 500_000_000,
      },
      {
        callId: "call-2",
        generationId: "span-2",
        traceSpanId: "span-2",
        status: "succeeded" as const,
        model: "gpt-5.4",
        startedAtMs: 220,
        endedAtMs: 280,
        inputTokens: 20,
        outputTokens: 7,
        cachedInputTokens: 4,
        reasoningTokens: 3,
        costUsdNanos: 750_000_000,
      },
    ],
    usage: fixedUsage,
  };
  const modelSettlement = {
    schemaVersion: 2 as const,
    kind: "agent-candidate-model-settlement" as const,
    digest: candidateSha("5"),
    material: modelSettlementMaterial,
    artifact: durableArtifact("settlements/run-1.json", "5", 300),
  };
  const taskOutcomeMaterial = {
    schemaVersion: 2 as const,
    kind: "agent-candidate-task-outcome-material" as const,
    executionPlanDigest,
    outcome: {
      kind: "workspace" as const,
      baseRepository: {
        identity: "pier/task-1",
        rootIdentity: "pier",
        commit: candidateGit("1"),
        tree: candidateGit("2"),
      },
      resultRepository: {
        identity: "pier/task-1",
        rootIdentity: "pier",
        commit: candidateGit("3"),
        tree: candidateGit("4"),
      },
      afterState: workspaceSnapshot("run-1", "6"),
      gitDiff: {
        format: "git-diff-binary" as const,
        artifact: durableArtifact("outcomes/run-1/result.diff", "7", 50),
      },
    },
  };
  const taskOutcome = {
    schemaVersion: 2 as const,
    kind: "agent-candidate-task-outcome" as const,
    digest: candidateSha("8"),
    material: taskOutcomeMaterial,
    artifact: durableArtifact("outcomes/run-1/outcome.json", "8", 500),
  };
  const benchmarkResultMaterial = {
    schemaVersion: 1 as const,
    kind: "agent-candidate-benchmark-result-material" as const,
    executionPlanDigest,
    taskOutcomeDigest: taskOutcome.digest,
    benchmark: {
      name: "pier",
      version: "0.3.0",
      taskId: "task-1",
      splitDigest: candidateSha("9"),
    },
    grader: {
      name: "pier-executable-grader",
      version: "0.3.0",
      artifact: durableArtifact("graders/pier-0.3.0.tar", "a", 1_000),
    },
    evidence: durableArtifact("results/run-1/grader-output.json", "c", 500),
    score: 0.75,
    passed: true,
    dimensions: [
      { name: "lint", score: 1 },
      { name: "tests", score: 0.5 },
    ],
  };
  const benchmarkResult = {
    schemaVersion: 1 as const,
    kind: "agent-candidate-benchmark-result" as const,
    digest: candidateSha("b"),
    material: benchmarkResultMaterial,
    artifact: durableArtifact("results/run-1.json", "b", 250),
  };

  return {
    schemaVersion: 3 as const,
    kind: "agent-candidate-run" as const,
    digestAlgorithm: "rfc8785-sha256" as const,
    bundleDigest: candidateSha("c"),
    materializationReceiptDigest: candidateSha("d"),
    executionPlanDigest,
    memory: { mode: "disabled" as const },
    trace: {
      schemaVersion: 1 as const,
      artifact: durableArtifact("traces/run-1.json", "e", 500),
      eventCount: 8,
      modelCallCount: 2,
    },
    termination: { kind: "exit" as const, exitCode: 0 },
    executorCapture: durableArtifact("captures/run-1.json", "0", 200),
    modelSettlement,
    taskOutcome,
    benchmarkResult,
    digest: candidateSha("f"),
  };
}

describe("candidate outcome contracts", () => {
  it("owns the current proposal, review, and receipt-bearing execution evidence", () => {
    const bundle = candidateFixture();
    const evaluation = {
      schemaVersion: 1 as const,
      kind: "agent-improvement-measured-comparison" as const,
      benchmark: { name: "pier", version: "0.3", splitDigest: candidateSha("9") },
      baselineProfileDigest: candidateSha("8"),
      candidateBundleDigest: bundle.digest,
      overall: {
        name: "composite" as const,
        baseline: 0.5,
        candidate: 0.75,
        delta: 0.25,
        confidenceInterval: {
          level: 0.95,
          lower: 0.1,
          upper: 0.4,
          method: "paired-bootstrap" as const,
          statistic: "mean" as const,
          resamples: 2_000,
        },
        n: 12,
        direction: "higher-is-better" as const,
        unit: "score" as const,
      },
      objectives: [
        {
          kind: "objective" as const,
          name: "judge-quality",
          availability: "measured" as const,
          baseline: 0.5,
          candidate: 0.75,
          delta: 0.25,
          confidenceInterval: {
            level: 0.95,
            lower: 0.1,
            upper: 0.4,
            method: "paired-bootstrap" as const,
            statistic: "mean" as const,
            resamples: 2_000,
          },
          n: 12,
          direction: "higher-is-better" as const,
          unit: "score" as const,
        },
        {
          kind: "dimension" as const,
          objective: "judge-quality",
          name: "quality",
          availability: "measured" as const,
          baseline: 0.5,
          candidate: 0.75,
          delta: 0.25,
          confidenceInterval: {
            level: 0.95,
            lower: 0.1,
            upper: 0.4,
            method: "paired-bootstrap" as const,
            statistic: "mean" as const,
            resamples: 2_000,
          },
          n: 12,
          direction: "higher-is-better" as const,
          unit: "score" as const,
        },
        {
          kind: "cost" as const,
          name: "cost",
          availability: "measured" as const,
          baseline: 0.01,
          candidate: 0.02,
          delta: 0.01,
          confidenceInterval: {
            level: 0.95,
            lower: 0,
            upper: 0.02,
            method: "paired-bootstrap" as const,
            statistic: "mean" as const,
            resamples: 2_000,
          },
          n: 12,
          direction: "lower-is-better" as const,
          unit: "usd" as const,
        },
        {
          kind: "latency" as const,
          name: "latency",
          availability: "measured" as const,
          baseline: 100,
          candidate: 90,
          delta: -10,
          confidenceInterval: {
            level: 0.95,
            lower: -20,
            upper: 0,
            method: "paired-bootstrap" as const,
            statistic: "mean" as const,
            resamples: 2_000,
          },
          n: 12,
          direction: "lower-is-better" as const,
          unit: "milliseconds" as const,
        },
      ],
      candidate: {
        label: "improved prompt",
      },
      decision: {
        outcome: "ship" as const,
        reasons: ["paired held-out interval cleared the promotion threshold"],
        contributingChecks: [{ name: "heldout", passed: true }],
      },
      power: {
        sufficient: true,
        n: 12,
        minimumDetectableDelta: 0.1,
        confidenceLevel: 0.95,
        scaleAssumed: true,
        sharedScorerChannel: true,
        reason: "paired holdout is sufficiently powered",
      },
      provenance: {
        kind: "agent-eval-loop" as const,
        schema: "tangle.loop-provenance.v2",
        runId: "eval-1",
        recordDigest: candidateSha("1"),
        baselineContentHash: candidateSha("2"),
        candidateContentHash: candidateSha("3"),
      },
      diff: "-old\n+new",
      evaluation: { generationsExplored: 1, durationMs: 100, totalCostUsd: 0.5 },
    };
    const proposal = {
      schemaVersion: 1 as const,
      kind: "agent-improvement-proposal" as const,
      runId: "eval-1",
      changedSurfaces: ["prompt"] as const,
      proposedAt: "2026-07-13T00:00:00.000Z",
      baselineProfile: { name: "candidate" },
      findings: [{ claim: "prompt omitted the requirement" }],
      evaluation,
      candidateBundle: bundle,
      digest: candidateSha("2"),
    };
    expect(agentImprovementProposalSchema.parse(proposal)).toEqual(proposal);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: { ...evaluation, candidateBundleDigest: candidateSha("0") },
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          objectives: evaluation.objectives.map((objective) =>
            objective.kind === "cost"
              ? {
                  kind: "cost" as const,
                  name: "cost",
                  availability: "unavailable" as const,
                  reason: "provider did not report cost",
                  direction: "lower-is-better" as const,
                  unit: "usd" as const,
                }
              : objective,
          ),
        },
      }).success,
    ).toBe(true);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          objectives: evaluation.objectives.map((objective) =>
            objective.kind === "latency"
              ? {
                  ...objective,
                  availability: "unavailable" as const,
                  reason: "clock evidence was not captured",
                }
              : objective,
          ),
        },
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          objectives: evaluation.objectives.map((objective) =>
            objective.kind === "dimension"
              ? { ...objective, objective: "missing-parent" }
              : objective,
          ),
        },
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        changedSurfaces: ["research"],
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({ ...proposal, changedSurfaces: [] }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        changedSurfaces: ["prompt", "prompt"],
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        candidateProfile: { name: "duplicate" },
        candidateProfileHash: candidateSha("3"),
      }).success,
    ).toBe(false);
    const review = {
      schemaVersion: 1 as const,
      kind: "agent-improvement-review" as const,
      proposalDigest: proposal.digest,
      candidateBundleDigest: proposal.candidateBundle.digest,
      decision: "approve" as const,
      reviewedBy: "operator@example.com",
      reviewedAt: "2026-07-13T00:01:00.000Z",
      reason: "Measured winner passed review.",
      digest: candidateSha("4"),
    };
    expect(agentImprovementReviewSchema.parse(review)).toEqual(review);
    expect(
      agentImprovementReviewSchema.safeParse({
        ...review,
        candidateBundleDigest: undefined,
      }).success,
    ).toBe(false);

    const receipt = runReceipt();
    const materialization = materializationReceipt(receipt);
    const evidence = {
      schemaVersion: 1 as const,
      kind: "agent-candidate-execution-evidence" as const,
      proposalDigest: proposal.digest,
      reviewDigest: review.digest,
      executionId: "candidate-execution-1",
      succeeded: true as const,
      materializationReceipt: materialization,
      profileActivation: {
        schemaVersion: 1 as const,
        kind: "agent-candidate-profile-activation" as const,
        profilePlan: materialization.profilePlan,
        files: [],
        digest: candidateSha("6"),
      },
      receipt,
      digest: candidateSha("5"),
    };
    expect(candidateExecutionEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(
      candidateExecutionEvidenceSchema.safeParse({
        ...evidence,
        receipt: { ...receipt, termination: { kind: "timeout", timeoutMs: 1_000 } },
      }).success,
    ).toBe(false);
    expect(
      candidateExecutionEvidenceSchema.safeParse({
        ...evidence,
        receipt: {
          ...receipt,
          taskOutcome: {
            ...receipt.taskOutcome,
            material: {
              ...receipt.taskOutcome.material,
              outcome: {
                kind: "output",
                spec: { mediaType: "text/plain", maxBytes: 1024 },
                artifact: durableArtifact("outcomes/run-1/output.txt", "7", 10),
              },
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      candidateExecutionEvidenceSchema.safeParse({
        ...evidence,
        receipt: undefined,
        runReceiptDigest: evidence.receipt.digest,
      }).success,
    ).toBe(false);
  });

  it("accepts a receipt with exact spend and all three evidence surfaces", () => {
    const receipt = runReceipt();
    expect(agentCandidateRunReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it("rejects record versions already published with different shapes", () => {
    const receipt = runReceipt();
    const materialization = materializationReceipt(receipt);
    expect(
      agentCandidateRunReceiptSchema.safeParse({ ...receipt, schemaVersion: 1 }).success,
    ).toBe(false);
    expect(
      agentCandidateRunReceiptSchema.safeParse({ ...receipt, schemaVersion: 2 }).success,
    ).toBe(false);
    expect(
      agentCandidateModelSettlementMaterialSchema.safeParse({
        ...receipt.modelSettlement.material,
        schemaVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      agentCandidateModelSettlementEvidenceSchema.safeParse({
        ...receipt.modelSettlement,
        schemaVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      agentCandidateTaskOutcomeMaterialSchema.safeParse({
        ...receipt.taskOutcome.material,
        schemaVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      agentCandidateTaskOutcomeEvidenceSchema.safeParse({
        ...receipt.taskOutcome,
        schemaVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      agentCandidateMaterializationReceiptSchema.safeParse({
        ...materialization,
        schemaVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      agentCandidateMaterializationReceiptSchema.safeParse({
        ...materialization,
        executionPlan: { ...materialization.executionPlan, schemaVersion: 1 },
      }).success,
    ).toBe(false);
  });

  it("accepts every terminal result and rejects impossible trace counts", () => {
    const receipt = runReceipt();
    for (const termination of [
      { kind: "exit", exitCode: 0 },
      { kind: "timeout", timeoutMs: 60_000 },
      { kind: "signal", signal: "SIGTERM" },
      { kind: "cancelled" },
    ] as const) {
      expect(
        agentCandidateRunReceiptSchema.parse({ ...receipt, termination }).termination,
      ).toEqual(termination);
    }
    expect(() =>
      agentCandidateRunReceiptSchema.parse({
        ...receipt,
        trace: { ...receipt.trace, eventCount: 0 },
      }),
    ).toThrow();
    expect(() =>
      agentCandidateRunReceiptSchema.parse({
        ...receipt,
        trace: { ...receipt.trace, modelCallCount: 3 },
      }),
    ).toThrow(/model-call count/);
  });

  it("requires router provenance in every model settlement", () => {
    const current = runReceipt().modelSettlement.material;
    expect(agentCandidateModelSettlementMaterialSchema.parse(current)).toEqual(current);
    expect(() =>
      agentCandidateModelSettlementMaterialSchema.parse({
        ...current,
        calls: [{ ...current.calls[0], traceSpanId: "caller-chosen" }, current.calls[1]],
      }),
    ).toThrow(/router generation id/);
    expect(() =>
      agentCandidateModelSettlementMaterialSchema.parse({
        ...current,
        calls: [{ ...current.calls[0], endedAtMs: 119 }, current.calls[1]],
      }),
    ).toThrow(/cannot end before/);
  });

  it("requires safe fixed-point usage and exact per-call aggregates", () => {
    const receipt = runReceipt();
    expect(() =>
      agentCandidateFixedSpendSchema.parse({
        ...receipt.modelSettlement.material.usage,
        inputTokens: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow(/safe integer/);
    expect(() =>
      agentCandidateModelSettlementMaterialSchema.parse({
        ...receipt.modelSettlement.material,
        usage: {
          ...receipt.modelSettlement.material.usage,
          outputTokens: 13,
        },
      }),
    ).toThrow(/exact per-call aggregate/);
    expect(() =>
      agentCandidateRunReceiptSchema.parse({
        ...receipt,
        modelSettlement: {
          ...receipt.modelSettlement,
          material: {
            ...receipt.modelSettlement.material,
            usage: {
              ...receipt.modelSettlement.material.usage,
              reasoningTokens: 6,
            },
          },
        },
      }),
    ).toThrow(/exact per-call aggregate/);
  });

  it("rejects duplicate call and trace-span identities", () => {
    const material = runReceipt().modelSettlement.material;
    expect(() =>
      agentCandidateModelSettlementMaterialSchema.parse({
        ...material,
        calls: [material.calls[0], { ...material.calls[1], callId: "call-1" }],
      }),
    ).toThrow(/call ids must be unique/);
    expect(() =>
      agentCandidateModelSettlementMaterialSchema.parse({
        ...material,
        calls: [
          material.calls[0],
          { ...material.calls[1], generationId: "span-1", traceSpanId: "span-1" },
        ],
      }),
    ).toThrow(/trace span ids must be unique/);
  });

  it("binds base and result states to one repository identity", () => {
    const material = runReceipt().taskOutcome.material;
    expect(() =>
      agentCandidateTaskOutcomeMaterialSchema.parse({
        ...material,
        outcome: {
          ...material.outcome,
          resultRepository: {
            ...material.outcome.resultRepository,
            identity: "pier/different-task",
          },
        },
      }),
    ).toThrow(/repository identities must match/);
    expect(() =>
      agentCandidateTaskOutcomeMaterialSchema.parse({
        ...material,
        outcome: {
          ...material.outcome,
          resultRepository: {
            ...material.outcome.resultRepository,
            rootIdentity: "different-root",
          },
        },
      }),
    ).toThrow(/repository roots must match/);
  });

  it("requires a durable git-diff-binary artifact reference", () => {
    const material = runReceipt().taskOutcome.material;
    expect(() =>
      agentCandidateTaskOutcomeMaterialSchema.parse({
        ...material,
        outcome: {
          ...material.outcome,
          gitDiff: {
            format: "git-diff-binary",
            artifact: {
              encoding: "base64",
              content: "",
              sha256: candidateSha("1"),
              byteLength: 0,
            },
          },
        },
      }),
    ).toThrow();
  });

  it("accepts exact non-code output evidence", () => {
    const material = runReceipt().taskOutcome.material;
    const outputMaterial = {
      ...material,
      outcome: {
        kind: "output" as const,
        spec: { mediaType: "application/json", maxBytes: 100 },
        artifact: durableArtifact("outcomes/run-1/output.json", "7", 50),
      },
    };
    expect(agentCandidateTaskOutcomeMaterialSchema.parse(outputMaterial)).toEqual(
      outputMaterial,
    );
    expect(() =>
      agentCandidateTaskOutcomeMaterialSchema.parse({
        ...outputMaterial,
        outcome: {
          ...outputMaterial.outcome,
          artifact: { ...outputMaterial.outcome.artifact, byteLength: 0 },
        },
      }),
    ).toThrow(/cannot be empty/);
    expect(() =>
      agentCandidateTaskOutcomeMaterialSchema.parse({
        ...outputMaterial,
        outcome: {
          ...outputMaterial.outcome,
          spec: { ...outputMaterial.outcome.spec, maxBytes: 49 },
        },
      }),
    ).toThrow(/exceeds its signed byte limit/);
  });

  it("accepts a complete receipt for exact non-code output", () => {
    const receipt = runReceipt();
    const outputReceipt = {
      ...receipt,
      taskOutcome: {
        ...receipt.taskOutcome,
        material: {
          ...receipt.taskOutcome.material,
          outcome: {
            kind: "output" as const,
            spec: { mediaType: "application/json", maxBytes: 100 },
            artifact: durableArtifact("outcomes/run-1/output.json", "7", 50),
          },
        },
      },
    };
    expect(agentCandidateRunReceiptSchema.parse(outputReceipt)).toEqual(outputReceipt);
  });

  it("requires normalized, sorted, unique dimensions and bounded scores", () => {
    const material = runReceipt().benchmarkResult.material;
    expect(() =>
      agentCandidateBenchmarkResultMaterialSchema.parse({
        ...material,
        dimensions: [...material.dimensions].reverse(),
      }),
    ).toThrow(/lexicographically sorted/);
    expect(() =>
      agentCandidateBenchmarkResultMaterialSchema.parse({
        ...material,
        dimensions: [material.dimensions[0], material.dimensions[0]],
      }),
    ).toThrow(/unique/);
    expect(() =>
      agentCandidateBenchmarkResultMaterialSchema.parse({
        ...material,
        dimensions: [{ name: "Not Normalized", score: 1 }],
      }),
    ).toThrow(/normalized lowercase/);
    expect(() =>
      agentCandidateBenchmarkResultMaterialSchema.parse({
        ...material,
        score: 1.01,
      }),
    ).toThrow();
    expect(() =>
      agentCandidateBenchmarkResultMaterialSchema.parse({
        ...material,
        dimensions: [{ name: "tests", score: -0.01 }],
      }),
    ).toThrow();
    expect(() =>
      agentCandidateBenchmarkResultMaterialSchema.parse({
        ...material,
        score: 0,
        passed: true,
      }),
    ).not.toThrow();
    expect(() =>
      agentCandidateBenchmarkResultMaterialSchema.parse({
        ...material,
        score: 1,
        passed: false,
      }),
    ).not.toThrow();
    expect(() =>
      agentCandidateBenchmarkResultMaterialSchema.parse({
        ...material,
        grader: {
          ...material.grader,
          artifact: { ...material.grader.artifact, byteLength: 0 },
        },
      }),
    ).toThrow(/grader bytes/);
    const { evidence: _evidence, ...withoutEvidence } = material;
    expect(() =>
      agentCandidateBenchmarkResultMaterialSchema.parse(withoutEvidence),
    ).toThrow();
    expect(() =>
      agentCandidateBenchmarkResultMaterialSchema.parse({
        ...material,
        evidence: { ...material.evidence, byteLength: 0 },
      }),
    ).toThrow(/non-empty durable grading evidence/);
    expect(() =>
      agentCandidateBenchmarkResultMaterialSchema.parse({
        ...material,
        evidence: {
          ...material.evidence,
          sha256: material.grader.artifact.sha256,
        },
      }),
    ).toThrow(/distinct from the grader implementation/);
    expect(() =>
      agentCandidateBenchmarkResultMaterialSchema.parse({
        ...material,
        evidence: {
          encoding: "base64",
          content: "e30=",
          sha256: candidateSha("c"),
          byteLength: 2,
        },
      }),
    ).toThrow();
  });

  it("rejects unknown keys at every new contract boundary", () => {
    const receipt = runReceipt();
    const strictCases: Array<[{ parse(value: unknown): unknown }, unknown]> = [
      [
        agentCandidateFixedSpendSchema,
        { ...receipt.modelSettlement.material.usage, unexpected: true },
      ],
      [
        agentCandidateModelSettlementCallSchema,
        { ...receipt.modelSettlement.material.calls[0], unexpected: true },
      ],
      [
        agentCandidateModelSettlementMaterialSchema,
        { ...receipt.modelSettlement.material, unexpected: true },
      ],
      [
        agentCandidateModelSettlementEvidenceSchema,
        { ...receipt.modelSettlement, unexpected: true },
      ],
      [
        agentCandidateTaskOutcomeMaterialSchema,
        { ...receipt.taskOutcome.material, unexpected: true },
      ],
      [
        agentCandidateTaskOutcomeMaterialSchema,
        {
          ...receipt.taskOutcome.material,
          outcome: {
            ...receipt.taskOutcome.material.outcome,
            gitDiff: {
              ...receipt.taskOutcome.material.outcome.gitDiff,
              unexpected: true,
            },
          },
        },
      ],
      [
        agentCandidateTaskOutcomeEvidenceSchema,
        { ...receipt.taskOutcome, unexpected: true },
      ],
      [
        agentCandidateBenchmarkDimensionSchema,
        { ...receipt.benchmarkResult.material.dimensions[0], unexpected: true },
      ],
      [
        agentCandidateBenchmarkResultMaterialSchema,
        { ...receipt.benchmarkResult.material, unexpected: true },
      ],
      [
        agentCandidateBenchmarkResultMaterialSchema,
        {
          ...receipt.benchmarkResult.material,
          grader: {
            ...receipt.benchmarkResult.material.grader,
            unexpected: true,
          },
        },
      ],
      [
        agentCandidateBenchmarkResultEvidenceSchema,
        { ...receipt.benchmarkResult, unexpected: true },
      ],
    ];
    for (const [schema, value] of strictCases) {
      expect(() => schema.parse(value)).toThrow();
    }
    expect(() =>
      agentCandidateRunReceiptSchema.parse({ ...receipt, unexpected: true }),
    ).toThrow();
  });

  it("binds outcome and benchmark evidence to the exact run", () => {
    const receipt = runReceipt();
    expect(() =>
      agentCandidateRunReceiptSchema.parse({
        ...receipt,
        modelSettlement: {
          ...receipt.modelSettlement,
          material: {
            ...receipt.modelSettlement.material,
            executionPlanDigest: candidateSha("0"),
          },
        },
      }),
    ).toThrow(/model settlement must bind/);
    expect(() =>
      agentCandidateRunReceiptSchema.parse({
        ...receipt,
        taskOutcome: {
          ...receipt.taskOutcome,
          material: {
            ...receipt.taskOutcome.material,
            executionPlanDigest: candidateSha("0"),
          },
        },
      }),
    ).toThrow(/task outcome must bind/);
    expect(() =>
      agentCandidateRunReceiptSchema.parse({
        ...receipt,
        benchmarkResult: {
          ...receipt.benchmarkResult,
          material: {
            ...receipt.benchmarkResult.material,
            taskOutcomeDigest: candidateSha("0"),
          },
        },
      }),
    ).toThrow(/exact task outcome/);
  });

});
