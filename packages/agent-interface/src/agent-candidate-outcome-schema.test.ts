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
import { agentCandidateRunReceiptSchema } from "./agent-candidate-receipt-schema.js";
import { candidateGit, candidateSha } from "./agent-candidate.test-fixture.js";

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
    schemaVersion: 1 as const,
    kind: "agent-candidate-workspace-snapshot" as const,
    digest: candidateSha(digit),
    material: {
      schemaVersion: 1 as const,
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
    schemaVersion: 1 as const,
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
    schemaVersion: 1 as const,
    kind: "agent-candidate-model-settlement" as const,
    digest: candidateSha("5"),
    material: modelSettlementMaterial,
    artifact: durableArtifact("settlements/run-1.json", "5", 300),
  };
  const taskOutcomeMaterial = {
    schemaVersion: 1 as const,
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
    schemaVersion: 1 as const,
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
    schemaVersion: 1 as const,
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
    modelSettlement,
    taskOutcome,
    benchmarkResult,
    digest: candidateSha("f"),
  };
}

describe("candidate outcome contracts", () => {
  it("accepts a receipt with exact spend and all three evidence surfaces", () => {
    const receipt = runReceipt();
    expect(agentCandidateRunReceiptSchema.parse(receipt)).toEqual(receipt);
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
