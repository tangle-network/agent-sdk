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
import { canonicalCandidateDigest } from "./agent-candidate-schema-common.js";

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
    kind: "agent-candidate-workspace-snapshot" as const,
    digest: candidateSha(digit),
    material: {
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

function materializationReceipt(
  receipt: ReturnType<typeof runReceipt>,
  options: {
    executionId: string;
    experimentDigest: ReturnType<typeof candidateSha>;
    arm: "baseline" | "candidate";
    sourceProfileDigest: ReturnType<typeof candidateSha>;
    repetition?: number;
  },
) {
  const profilePlan = {
    kind: "agent-profile-workspace-plan" as const,
    digest: candidateSha("1"),
    material: {
      sourceProfileDigest: options.sourceProfileDigest,
      harness: "codex" as const,
      files: [],
      env: {},
      flags: [],
      unsupported: [],
    },
    artifact: durableArtifact("plans/profile.json", "1", 72),
  };
  const executionPlanMaterial = {
    kind: "agent-candidate-execution-plan-material" as const,
    runCell: {
      kind: "agent-candidate-run-cell" as const,
      experimentDigest: options.experimentDigest,
      arm: options.arm,
      bundleDigest: receipt.bundleDigest,
      suiteDigest: candidateSha("9"),
      taskDigest: candidateSha("0"),
      taskIndex: 0,
      repetition: options.repetition ?? 0,
      seed: 42 + (options.repetition ?? 0),
      attempt: 1,
      digest: receipt.runCellDigest,
    },
    executionId: options.executionId,
    workspaces: { taskRoot: "/work/task" },
    codeKind: "disabled" as const,
    profile: { planDigest: profilePlan.digest, targetWorkspace: "task" as const, mountPaths: [] },
    harness: "codex" as const,
    harnessVersion: "0.1.0",
    instructionDelivery: { kind: "stdin-utf8" as const },
    limits: {
      timeoutMs: 60_000,
      maxSteps: 20,
      maxModelCalls: 10,
      maxInputTokens: 100_000,
      maxOutputTokens: 20_000,
      maxCostUsd: 5,
    },
    container: {
      source: "evaluator-task-container" as const,
      image: "candidate:1.0.0",
      indexDigest: candidateSha("6"),
      manifestDigest: candidateSha("7"),
      platform: { os: "linux", architecture: "amd64" },
    },
    model: {
      policy: "single" as const,
      resolved: resolvedModel,
      access: {
        kind: "evaluator-mediated" as const,
        grantDigest: candidateSha("4"),
        network: {
          mode: "gateway-only" as const,
          domains: ["router.tangle.tools"],
        },
      },
      routes: [{ kind: "primary" as const, requested: "openai/gpt-5.4" }],
    },
    launch: {
      executable: "node",
      args: [],
      env: {
        PATH: { kind: "public" as const, value: "/usr/local/bin:/usr/bin:/bin" },
      },
      cwd: { workspace: "task" as const, path: "." },
    },
    memory: { mode: "disabled" as const },
    network: { mode: "disabled" as const },
  };
  return {
    kind: "agent-candidate-materialization" as const,
    digestAlgorithm: "rfc8785-sha256" as const,
    bundleDigest: receipt.bundleDigest,
    benchmark: {
      suite: {
        digest: candidateSha("9"),
        material: durableArtifact("benchmarks/suite.json", "9", 100),
      },
      task: {
        digest: candidateSha("0"),
        material: durableArtifact("benchmarks/task-1.json", "0", 100),
      },
    },
    profileActivation: {
      kind: "agent-candidate-profile-activation" as const,
      profilePlan,
      files: [],
      digest: candidateSha(options.arm === "baseline" ? "6" : "7"),
    },
    executionPlan: {
      kind: "agent-candidate-execution-plan" as const,
      digest: receipt.executionPlanDigest,
      material: executionPlanMaterial,
      artifact: {
        ...durableArtifact(`plans/${options.executionId}.json`, "3", 800),
        sha256: receipt.executionPlanDigest,
      },
    },
    codeKind: "disabled" as const,
    harness: "codex" as const,
    harnessVersion: "0.1.0",
    container: executionPlanMaterial.container,
    resolvedModel,
    digest: receipt.materializationReceiptDigest,
  };
}

function runReceipt(options: {
  bundleDigest?: ReturnType<typeof candidateSha>;
  score?: number;
  startedAtMs?: number;
  endedAtMs?: number;
  identityDigit?: string;
} = {}) {
  const executionPlanDigest = candidateSha(options.identityDigit ?? "3");
  const fixedUsage = {
    inputTokens: 30,
    outputTokens: 12,
    cachedInputTokens: 7,
    reasoningTokens: 5,
    modelCalls: 2,
    costUsdNanos: 1_250_000_000,
  };
  const modelSettlementMaterial = {
    kind: "agent-candidate-model-settlement-material" as const,
    executionPlanDigest,
    preparationId: "candidate-preparation.abc123",
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
        startedAtMs: 1_010,
        endedAtMs: 1_030,
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
        startedAtMs: 1_040,
        endedAtMs: 1_060,
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
    kind: "agent-candidate-model-settlement" as const,
    digest: candidateSha("5"),
    material: modelSettlementMaterial,
    artifact: durableArtifact("settlements/run-1.json", "5", 300),
  };
  const taskOutcomeMaterial = {
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
    kind: "agent-candidate-task-outcome" as const,
    digest: candidateSha("8"),
    material: taskOutcomeMaterial,
    artifact: durableArtifact("outcomes/run-1/outcome.json", "8", 500),
  };
  const benchmarkResultMaterial = {
    kind: "agent-candidate-benchmark-result-material" as const,
    executionPlanDigest,
    taskOutcomeDigest: taskOutcome.digest,
    grader: {
      name: "pier-executable-grader",
      version: "0.3.0",
      format: "tangle-grader" as const,
      artifact: durableArtifact("graders/pier-0.3.0.tar", "a", 1_000),
    },
    evidence: durableArtifact("results/run-1/grader-output.json", "c", 500),
    grading: {
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        modelCalls: 1,
        costUsdNanos: 25_000_000,
      },
      timing: { startedAtMs: 1_101, endedAtMs: 1_121, durationMs: 20 },
    },
    score: options.score ?? 0.75,
    passed: true,
    dimensions: [
      { name: "lint", score: 1 },
      { name: "tests", score: 0.5 },
    ],
  };
  const benchmarkResult = {
    kind: "agent-candidate-benchmark-result" as const,
    digest: candidateSha("b"),
    material: benchmarkResultMaterial,
    artifact: durableArtifact("results/run-1.json", "b", 250),
  };

  return {
    kind: "agent-candidate-run" as const,
    digestAlgorithm: "rfc8785-sha256" as const,
    bundleDigest: options.bundleDigest ?? candidateSha("c"),
    runCellDigest: candidateSha(options.identityDigit ?? "4"),
    materializationReceiptDigest: candidateSha(options.identityDigit ?? "d"),
    executionPlanDigest,
    timing: {
      startedAtMs: options.startedAtMs ?? 1_000,
      endedAtMs: options.endedAtMs ?? 1_100,
      durationMs: (options.endedAtMs ?? 1_100) - (options.startedAtMs ?? 1_000),
    },
    memory: { mode: "disabled" as const },
    trace: {
      artifact: durableArtifact("traces/run-1.json", "e", 500),
      eventCount: 8,
      modelCallCount: 2,
    },
    termination: { kind: "exit" as const, exitCode: 0 },
    executorCapture: durableArtifact("captures/run-1.json", "0", 200),
    modelSettlement,
    taskOutcome,
    benchmarkResult,
    digest: candidateSha(options.identityDigit ?? "f"),
  };
}

function measuredBundle(digit: string, prompt: string) {
  const fixture = candidateFixture();
  const { knowledge: _knowledge, ...withoutKnowledge } = fixture;
  return {
    ...withoutKnowledge,
    profile: {
      ...fixture.profile,
      prompt: { systemPrompt: prompt },
    },
    code: {
      kind: "disabled" as const,
    },
    execution: {
      harness: "codex" as const,
      harnessVersion: "0.1.0",
      launch: {
        kind: "container-command" as const,
        executable: "node",
        args: [],
      },
      instructionDelivery: { kind: "stdin-utf8" as const },
      cwd: { workspace: "task" as const, path: "." },
      env: {
        PATH: { kind: "public" as const, value: "/usr/local/bin:/usr/bin:/bin" },
      },
      environment: { kind: "evaluator-task-container" as const },
      isolation: {
        network: "disabled" as const,
        remoteIntegrations: "disabled" as const,
        candidateSecrets: "disabled" as const,
      },
    },
    memory: { mode: "disabled" as const },
    digest: candidateSha(digit),
  };
}

function executionEvidence(
  experimentDigest: ReturnType<typeof candidateSha>,
  arm: "baseline" | "candidate",
  bundle: ReturnType<typeof measuredBundle>,
  score: number,
  repetition = 0,
) {
  const identityDigit = arm === "baseline" ? String(repetition + 1) : String(repetition + 4);
  const receipt = runReceipt({
    bundleDigest: bundle.digest,
    score,
    identityDigit,
  });
  const executionId = `${arm}-execution-${repetition + 1}`;
  const materialization = materializationReceipt(receipt, {
    executionId,
    experimentDigest,
    arm,
    sourceProfileDigest: canonicalCandidateDigest(bundle.profile),
    repetition,
  });
  return {
    kind: "agent-candidate-execution-evidence" as const,
    materializationReceipt: materialization,
    receipt,
    digest: candidateSha(identityDigit),
  };
}

describe("candidate outcome contracts", () => {
  it("owns the current proposal, review, and receipt-bearing execution evidence", () => {
    const baselineBundle = measuredBundle("b", "Solve the task.");
    const candidateBundle = measuredBundle(
      "a",
      "Solve the task and verify the result.",
    );
    const benchmarkTask = {
      kind: "agent-candidate-benchmark-task" as const,
      digestAlgorithm: "rfc8785-sha256" as const,
      benchmark: {
        name: "pier",
        version: "0.3",
        splitDigest: candidateSha("9"),
      },
      scenario: {
        id: "task-1",
        kind: "repository-task",
        scenarioDigest: candidateSha("1"),
      },
      instruction: "Implement the requested repository change.",
      repository: {
        identity: "pier/task-1",
        rootIdentity: "pier",
        baseCommit: candidateGit("1"),
        baseTree: candidateGit("2"),
      },
      outcome: { kind: "workspace" as const },
      workspace: workspaceSnapshot("benchmark-task", "4"),
      grader: {
        name: "pier-executable-grader",
        version: "0.3.0",
        format: "tangle-grader" as const,
        artifact: durableArtifact("graders/pier-0.3.0.tar", "a", 1_000),
      },
      model: resolvedModel,
      attempt: { maxAttempts: 1, retryPolicy: "none" as const },
      evaluatorTaskContainer: {
        source: "evaluator-task-container" as const,
        image: "candidate:1.0.0",
        indexDigest: candidateSha("6"),
        manifestDigest: candidateSha("7"),
        platform: { os: "linux", architecture: "amd64" },
      },
      limits: {
        timeoutMs: 60_000,
        maxSteps: 20,
        maxModelCalls: 10,
        maxInputTokens: 100_000,
        maxOutputTokens: 20_000,
        maxCostUsd: 5,
      },
      digest: candidateSha("0"),
    };
    const suite = {
        kind: "agent-candidate-benchmark-suite" as const,
        digestAlgorithm: "rfc8785-sha256" as const,
        taskDigests: [benchmarkTask.digest] as const,
        reps: 3,
        seeds: [42, 43, 44] as const,
        digest: candidateSha("9"),
      };
    const experimentDigest = candidateSha("e");
    const experiment = {
      kind: "agent-candidate-experiment" as const,
      digestAlgorithm: "rfc8785-sha256" as const,
      baseline: baselineBundle,
      candidate: candidateBundle,
      candidateLineage: {
        source: "optimizer" as const,
        parentDigests: [baselineBundle.digest],
        runIds: ["eval-1"],
        developmentSplitDigest: candidateSha("8"),
      },
      benchmark: { suite, tasks: [benchmarkTask] as const },
      policy: {
        confidenceLevel: 0.95,
        resamples: 2_000,
        bootstrapSeed: 1_337,
        deltaThreshold: 0,
        minProductiveRuns: 3,
        budgetUsd: 10,
        criticalDimensions: ["tests"],
        regressionTolerance: 0.05,
      },
      digest: experimentDigest,
    };
    const baselineEvidence = executionEvidence(
      experimentDigest,
      "baseline",
      baselineBundle,
      0.5,
    );
    const candidateEvidence = executionEvidence(
      experimentDigest,
      "candidate",
      candidateBundle,
      0.75,
    );
    const evaluation = {
      kind: "agent-improvement-measured-comparison" as const,
      experiment,
      measurements: [
        {
          baseline: baselineEvidence,
          candidate: candidateEvidence,
        },
        {
          baseline: executionEvidence(experimentDigest, "baseline", baselineBundle, 0.5, 1),
          candidate: executionEvidence(experimentDigest, "candidate", candidateBundle, 0.75, 1),
        },
        {
          baseline: executionEvidence(experimentDigest, "baseline", baselineBundle, 0.5, 2),
          candidate: executionEvidence(experimentDigest, "candidate", candidateBundle, 0.75, 2),
        },
      ],
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
        n: 3,
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
          n: 3,
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
          n: 3,
          direction: "higher-is-better" as const,
          unit: "score" as const,
        },
        {
          kind: "cost" as const,
          name: "cost",
          availability: "measured" as const,
          baseline: 1.275,
          candidate: 1.275,
          delta: 0,
          confidenceInterval: {
            level: 0.95,
            lower: 0,
            upper: 0,
            method: "paired-bootstrap" as const,
            statistic: "mean" as const,
            resamples: 2_000,
          },
          n: 3,
          direction: "lower-is-better" as const,
          unit: "usd" as const,
        },
        {
          kind: "latency" as const,
          name: "latency",
          availability: "measured" as const,
          baseline: 120,
          candidate: 120,
          delta: 0,
          confidenceInterval: {
            level: 0.95,
            lower: 0,
            upper: 0,
            method: "paired-bootstrap" as const,
            statistic: "mean" as const,
            resamples: 2_000,
          },
          n: 3,
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
        n: 3,
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
      evaluation: {
        generationsExplored: 1,
        searchDurationMs: 40,
        executionDurationMs: 60,
        durationMs: 100,
        searchCostUsd: 0.2,
        executionCostUsd: 0.3,
        totalCostUsd: 0.5,
      },
    };
    const proposal = {
      kind: "agent-improvement-proposal" as const,
      runId: "eval-1",
      changedSurfaces: ["prompt"] as const,
      proposedAt: "2026-07-13T00:00:00.000Z",
      findings: [{ claim: "prompt omitted the requirement" }],
      evaluation,
      digest: candidateSha("2"),
    };
    expect(agentImprovementProposalSchema.parse(proposal)).toEqual(proposal);
    const firstCandidate = evaluation.measurements[0]!.candidate;
    expect(
      candidateExecutionEvidenceSchema.safeParse({
        ...firstCandidate,
        receipt: {
          ...firstCandidate.receipt,
          modelSettlement: {
            ...firstCandidate.receipt.modelSettlement,
            material: {
              ...firstCandidate.receipt.modelSettlement.material,
              grantDigest: candidateSha("f"),
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          objectives: evaluation.objectives.map((objective) =>
            objective.kind === "cost"
              ? { ...objective, candidate: 0.02, delta: 0.02 }
              : objective,
          ),
        },
      }).success,
    ).toBe(false);
    for (const materialMutation of [
      {
        limits: {
          ...firstCandidate.materializationReceipt.executionPlan.material.limits,
          maxCostUsd: 4,
        },
      },
      {
        container: {
          ...firstCandidate.materializationReceipt.executionPlan.material.container,
          manifestDigest: candidateSha("f"),
        },
      },
      {
        runCell: {
          ...firstCandidate.materializationReceipt.executionPlan.material.runCell,
          attempt: 2,
        },
      },
    ]) {
      expect(
        agentImprovementProposalSchema.safeParse({
          ...proposal,
          evaluation: {
            ...evaluation,
            measurements: evaluation.measurements.map((measurement, index) =>
              index === 0
                ? {
                    ...measurement,
                    candidate: {
                      ...measurement.candidate,
                      materializationReceipt: {
                        ...measurement.candidate.materializationReceipt,
                        executionPlan: {
                          ...measurement.candidate.materializationReceipt.executionPlan,
                          material: {
                            ...measurement.candidate.materializationReceipt.executionPlan.material,
                            ...materialMutation,
                          },
                        },
                      },
                    },
                  }
                : measurement,
            ),
          },
        }).success,
      ).toBe(false);
    }
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          measurements: evaluation.measurements.map((measurement, index) =>
            index === 1
              ? {
                  ...measurement,
                  candidate: {
                    ...measurement.candidate,
                    receipt: {
                      ...measurement.candidate.receipt,
                      digest: evaluation.measurements[0]!.candidate.receipt.digest,
                    },
                  },
                }
              : measurement,
          ),
        },
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          experiment: {
            ...experiment,
            policy: { ...experiment.policy, confidenceLevel: 0.99 },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          measurements: evaluation.measurements.map((measurement, index) =>
            index === 0
              ? {
                  ...measurement,
                  candidate: {
                    ...measurement.candidate,
                    receipt: {
                      ...measurement.candidate.receipt,
                      benchmarkResult: {
                        ...measurement.candidate.receipt.benchmarkResult,
                        material: {
                          ...measurement.candidate.receipt.benchmarkResult.material,
                          grader: {
                            ...measurement.candidate.receipt.benchmarkResult.material.grader,
                            version: "0.4.0",
                          },
                        },
                      },
                    },
                  },
                }
              : measurement,
          ),
        },
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          experiment: {
            ...experiment,
            candidateLineage: {
              source: "optimizer",
              parentDigests: [baselineBundle.digest],
              runIds: ["eval-1"],
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          experiment: {
            ...experiment,
            candidateLineage: {
              ...experiment.candidateLineage,
              developmentSplitDigest: benchmarkTask.benchmark.splitDigest,
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          measurements: evaluation.measurements.map((measurement) => ({
            ...measurement,
            candidate: {
              ...measurement.candidate,
              materializationReceipt: {
                ...measurement.candidate.materializationReceipt,
                executionPlan: {
                  ...measurement.candidate.materializationReceipt.executionPlan,
                  material: {
                    ...measurement.candidate.materializationReceipt.executionPlan.material,
                    model: {
                      ...measurement.candidate.materializationReceipt.executionPlan.material.model,
                      access: {
                        ...measurement.candidate.materializationReceipt.executionPlan.material.model
                          .access,
                        network: { mode: "disabled" as const },
                      },
                    },
                  },
                },
              },
            },
          })),
        },
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          overall: { ...evaluation.overall, n: 12 },
        },
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          measurements: [
            {
              ...evaluation.measurements[0],
              candidate: {
                ...candidateEvidence,
                materializationReceipt: {
                  ...candidateEvidence.materializationReceipt,
                  codeKind: "patch" as const,
                  executionPlan: {
                    ...candidateEvidence.materializationReceipt.executionPlan,
                    material: {
                      ...candidateEvidence.materializationReceipt.executionPlan.material,
                      codeKind: "patch" as const,
                    },
                  },
                },
              },
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          experiment: {
            ...experiment,
            benchmark: {
              ...experiment.benchmark,
              tasks: [
                {
                  ...benchmarkTask,
                  repository: {
                    ...benchmarkTask.repository,
                    baseCommit: candidateGit("5"),
                  },
                },
              ] as const,
            },
          },
        },
      }).success,
    ).toBe(false);
    const outputEvidence = (
      evidence: typeof baselineEvidence | typeof candidateEvidence,
      mediaType: string,
    ) => ({
      ...evidence,
      receipt: {
        ...evidence.receipt,
        taskOutcome: {
          ...evidence.receipt.taskOutcome,
          material: {
            ...evidence.receipt.taskOutcome.material,
            outcome: {
              kind: "output" as const,
              spec: { mediaType, maxBytes: 100 },
              artifact: durableArtifact("outcomes/run-1/output.json", "7", 50),
            },
          },
        },
      },
    });
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          experiment: {
            ...experiment,
            benchmark: {
              ...experiment.benchmark,
              tasks: [
                {
                  ...benchmarkTask,
                  repository: undefined,
                  outcome: {
                    kind: "output" as const,
                    mediaType: "application/json",
                    maxBytes: 100,
                  },
                },
              ] as const,
            },
          },
          measurements: [
            {
              ...evaluation.measurements[0],
              baseline: outputEvidence(baselineEvidence, "application/json"),
              candidate: outputEvidence(candidateEvidence, "text/plain"),
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          overall: { ...evaluation.overall, baseline: 0.9, delta: -0.15 },
        },
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          measurements: [
            {
              ...evaluation.measurements[0],
              candidate: { ...baselineEvidence, arm: "candidate" as const },
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          measurements: [
            {
              ...evaluation.measurements[0],
              candidate: {
                ...candidateEvidence,
                experimentDigest: candidateSha("0"),
              },
            },
          ],
        },
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
    ).toBe(false);
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
      kind: "agent-improvement-review" as const,
      proposalDigest: proposal.digest,
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
        proposalDigest: undefined,
      }).success,
    ).toBe(false);
    expect(
      agentImprovementReviewSchema.safeParse({
        ...review,
        candidateBundleDigest: candidateBundle.digest,
      }).success,
    ).toBe(false);

    const evidence = candidateEvidence;
    const receipt = evidence.receipt;
    expect(candidateExecutionEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(
      candidateExecutionEvidenceSchema.safeParse({
        ...evidence,
        receipt: { ...receipt, termination: { kind: "timeout", timeoutMs: 1_000 } },
      }).success,
    ).toBe(true);
    expect(
      agentImprovementProposalSchema.safeParse({
        ...proposal,
        evaluation: {
          ...evaluation,
          measurements: [
            {
              ...evaluation.measurements[0],
              candidate: {
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
                        artifact: durableArtifact(
                          "outcomes/run-1/output.txt",
                          "7",
                          10,
                        ),
                      },
                    },
                  },
                },
              },
            },
          ],
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

  it("rejects obsolete schema version markers", () => {
    const receipt = runReceipt();
    const materialization = materializationReceipt(receipt, {
      executionId: "candidate-execution-1",
      experimentDigest: candidateSha("e"),
      arm: "candidate",
      sourceProfileDigest: candidateSha("f"),
    });
    expect(
      agentCandidateRunReceiptSchema.safeParse({ ...receipt, schemaVersion: 3 }).success,
    ).toBe(false);
    expect(
      agentCandidateMaterializationReceiptSchema.safeParse({
        ...materialization,
        schemaVersion: 2,
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
    expect(() =>
      agentCandidateRunReceiptSchema.parse({
        ...receipt,
        modelSettlement: {
          ...receipt.modelSettlement,
          material: {
            ...receipt.modelSettlement.material,
            calls: [
              { ...receipt.modelSettlement.material.calls[0], startedAtMs: 999 },
              receipt.modelSettlement.material.calls[1],
            ],
          },
        },
      }),
    ).toThrow(/within the recorded run/);
    expect(() =>
      agentCandidateRunReceiptSchema.parse({
        ...receipt,
        benchmarkResult: {
          ...receipt.benchmarkResult,
          material: {
            ...receipt.benchmarkResult.material,
            grading: {
              ...receipt.benchmarkResult.material.grading,
              timing: {
                startedAtMs: 1_099,
                endedAtMs: 1_119,
                durationMs: 20,
              },
            },
          },
        },
      }),
    ).toThrow(/after candidate execution/);
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
