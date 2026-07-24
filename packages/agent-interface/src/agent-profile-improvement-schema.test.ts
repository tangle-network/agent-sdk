import { describe, expect, it } from "vitest";
import { canonicalCandidateDigest } from "./agent-candidate-schema-common.js";
import {
  agentImprovementProposalSchema,
  agentProfileImprovementMeasuredComparisonSchema,
} from "./agent-candidate-promotion-schema.js";

const sha = (digit: string) => `sha256:${digit.repeat(64)}` as const;

function signed<T extends Record<string, unknown>>(material: T) {
  return { ...material, digest: canonicalCandidateDigest(material) };
}

function evidence(kind: string, identity: string) {
  return {
    kind,
    identity,
    digest: canonicalCandidateDigest({ kind, identity }),
  };
}

const grader = {
  name: "profile-quality",
  version: "1",
  format: "tangle-grader" as const,
  artifact: {
    locator: {
      kind: "s3" as const,
      bucket: "agent-eval",
      key: "graders/profile-quality.json",
      region: "us-east-1",
    },
    sha256: sha("f"),
    byteLength: 1,
  },
};

function fixture() {
  const task = signed({
    kind: "agent-profile-improvement-task" as const,
    digestAlgorithm: "rfc8785-sha256" as const,
    scenario: {
      id: "support-case-1",
      kind: "support-case",
      digest: sha("1"),
    },
    grader,
  });
  const suite = signed({
    kind: "agent-profile-improvement-suite" as const,
    digestAlgorithm: "rfc8785-sha256" as const,
    splitDigest: sha("2"),
    taskDigests: [task.digest] as [typeof task.digest],
    reps: 3,
    seeds: [11, 12, 13] as [number, number, number],
  });
  const baselinePrompt = { prompt: { systemPrompt: "Answer directly." } };
  const candidatePrompt = {
    prompt: { systemPrompt: "Answer directly, cite the source, and state uncertainty." },
  };
  const baseline = {
    surfaces: [
      {
        surface: "prompt" as const,
        value: baselinePrompt,
        digest: canonicalCandidateDigest(baselinePrompt),
      },
    ] as const,
  };
  const signedBaseline = {
    ...baseline,
    stateDigest: canonicalCandidateDigest({ surfaces: baseline.surfaces }),
  };
  const candidate = {
    surfaces: [
      {
        surface: "prompt" as const,
        value: candidatePrompt,
        digest: canonicalCandidateDigest(candidatePrompt),
      },
    ] as const,
  };
  const signedCandidate = {
    ...candidate,
    stateDigest: canonicalCandidateDigest({ surfaces: candidate.surfaces }),
  };
  const experiment = signed({
    kind: "agent-profile-improvement-experiment" as const,
    digestAlgorithm: "rfc8785-sha256" as const,
    source: {
      kind: "platform-agent-profile",
      sourceIdentity: "profile-support",
      sourceDigest: sha("5"),
      sourceRevision: 7,
    },
    baseline: signedBaseline,
    candidate: signedCandidate,
    candidateLineage: {
      source: "optimizer" as const,
      parentDigests: [signedBaseline.stateDigest],
      runIds: ["intelligence-run-1"],
      developmentSplitDigest: sha("6"),
    },
    benchmark: { suite, tasks: [task] as [typeof task] },
    policy: {
      confidenceLevel: 0.95,
      resamples: 100,
      bootstrapSeed: 17,
      deltaThreshold: 0,
      minProductiveRuns: 3,
      criticalDimensions: [],
      regressionTolerance: 0,
    },
  });

  const receipt = (
    arm: "baseline" | "candidate",
    repetition: number,
    score: number,
  ) => {
    const runCell = signed({
      kind: "agent-profile-improvement-run-cell" as const,
      experimentDigest: experiment.digest,
      arm,
      stateDigest: experiment[arm].stateDigest,
      suiteDigest: suite.digest,
      taskDigest: task.digest,
      taskIndex: 0,
      repetition,
      seed: suite.seeds[repetition],
    });
    const executionId = `${arm}-${repetition}`;
    return signed({
      kind: "agent-profile-improvement-run" as const,
      digestAlgorithm: "rfc8785-sha256" as const,
      executionId,
      runCell,
      runRecord: evidence("agent-eval-run-record", executionId),
      billing: [evidence("platform-billing", `bill-${executionId}`)] as [ReturnType<typeof evidence>],
      timing: { startedAtMs: repetition * 1_000, endedAtMs: repetition * 1_000 + 100, durationMs: 100 },
      resolvedModel: "anthropic/claude-sonnet-4-6@2026-06-01",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        modelCalls: 1,
        costUsdNanos: 100,
      },
      trace: {
        evidence: evidence("platform-trace", `trace-${executionId}`),
        eventCount: 4,
        modelCallCount: 1,
      },
      output: evidence("platform-output", `output-${executionId}`),
      outcome: { status: "succeeded" as const },
      grading: {
        grader,
        evidence: evidence("agent-eval-grading", `grade-${executionId}`),
        timing: {
          startedAtMs: repetition * 1_000 + 100,
          endedAtMs: repetition * 1_000 + 110,
          durationMs: 10,
        },
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          modelCalls: 1,
          costUsdNanos: 10,
        },
        score,
        passed: true,
        dimensions: [{ name: "quality", score }],
      },
    });
  };

  const measurements = [0, 1, 2].map((repetition) => ({
    baseline: receipt("baseline", repetition, 0.2),
    candidate: receipt("candidate", repetition, 0.6),
  }));
  const estimate = (baselineValue: number, candidateValue: number) => ({
    baseline: baselineValue,
    candidate: candidateValue,
    delta: candidateValue - baselineValue,
    confidenceInterval: {
      level: 0.95,
      lower: candidateValue - baselineValue - 0.1,
      upper: candidateValue - baselineValue + 0.1,
      method: "paired-bootstrap" as const,
      statistic: "mean" as const,
      resamples: 100,
    },
    n: 3,
  });
  const comparison = {
    kind: "agent-profile-improvement-measured-comparison" as const,
    experiment,
    measurements,
    overall: {
      name: "composite" as const,
      ...estimate(0.2, 0.6),
      direction: "higher-is-better" as const,
      unit: "score" as const,
    },
    objectives: [
      {
        kind: "objective" as const,
        name: "quality",
        direction: "higher-is-better" as const,
        unit: "score" as const,
        availability: "measured" as const,
        ...estimate(0.2, 0.6),
      },
      {
        kind: "dimension" as const,
        objective: "quality",
        name: "quality",
        direction: "higher-is-better" as const,
        unit: "score" as const,
        availability: "measured" as const,
        ...estimate(0.2, 0.6),
      },
      {
        kind: "cost" as const,
        name: "cost" as const,
        direction: "lower-is-better" as const,
        unit: "usd" as const,
        availability: "measured" as const,
        ...estimate(0.00000011, 0.00000011),
      },
      {
        kind: "latency" as const,
        name: "latency" as const,
        direction: "lower-is-better" as const,
        unit: "milliseconds" as const,
        availability: "measured" as const,
        ...estimate(110, 110),
      },
    ],
    decision: {
      outcome: "ship" as const,
      reasons: ["paired comparison passed"],
      contributingChecks: [{ name: "paired-significance", passed: true }],
    },
    power: {
      sufficient: true,
      n: 3,
      minimumDetectableDelta: 0.1,
      confidenceLevel: 0.95,
      scaleAssumed: true,
      sharedScorerChannel: true,
      reason: "three paired held-out runs",
    },
    provenance: {
      kind: "agent-eval-loop" as const,
      schema: "agent-eval/profile-matrix/v1",
      runId: "intelligence-run-1",
      recordDigest: sha("7"),
      baselineContentHash: signedBaseline.stateDigest,
      candidateContentHash: signedCandidate.stateDigest,
    },
    diff: "prompt: add source and uncertainty instructions",
    evaluation: {
      generationsExplored: 1,
      searchDurationMs: 0,
      executionDurationMs: 0,
      durationMs: 0,
      searchCostUsd: 0,
      executionCostUsd: 0,
      totalCostUsd: 0,
    },
  };
  const proposalMaterial = {
    kind: "agent-improvement-proposal" as const,
    runId: "intelligence-run-1",
    changedSurfaces: ["prompt"] as ["prompt"],
    proposedAt: "2026-07-24T00:00:00.000Z",
    findings: [{ kind: "failure-mode", message: "missing source qualification" }],
    evaluation: comparison,
  };
  return {
    comparison,
    proposal: { ...proposalMaterial, digest: canonicalCandidateDigest(proposalMaterial) },
  };
}

describe("agentProfileImprovementMeasuredComparisonSchema", () => {
  it("accepts an exact paid profile comparison without retaining its full profile", () => {
    const { comparison, proposal } = fixture();

    expect(agentProfileImprovementMeasuredComparisonSchema.parse(comparison)).toEqual(comparison);
    expect(agentImprovementProposalSchema.parse(proposal)).toEqual(proposal);
  });

  it("rejects a raw profile even when its digest is present", () => {
    const { comparison } = fixture();
    const input = {
      ...comparison,
      experiment: {
        ...comparison.experiment,
        baseline: {
          ...comparison.experiment.baseline,
          profile: { mcp: { private: { headers: { Authorization: "secret" } } } },
        },
      },
    };

    expect(agentProfileImprovementMeasuredComparisonSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a state digest that does not match the retained surfaces", () => {
    const { comparison } = fixture();
    const input = {
      ...comparison,
      experiment: {
        ...comparison.experiment,
        candidate: {
          ...comparison.experiment.candidate,
          stateDigest: sha("9"),
        },
      },
    };

    expect(agentProfileImprovementMeasuredComparisonSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a proposal whose displayed surfaces differ from its measured profile values", () => {
    const { proposal } = fixture();
    const input = {
      ...proposal,
      changedSurfaces: ["skills"],
    };

    expect(agentImprovementProposalSchema.safeParse(input).success).toBe(false);
  });
});
