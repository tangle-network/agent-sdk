import { describe, expect, it } from "vitest";
import { candidateSha } from "./agent-candidate.test-fixture.js";
import {
  agentCandidateBenchmarkSuiteInputsSchema,
  agentCandidateBenchmarkSuiteSchema,
  agentCandidateBenchmarkTaskSchema,
} from "./agent-candidate-task-schema.js";

function artifact(key: string, digit: string) {
  return {
    locator: { kind: "s3" as const, bucket: "candidate-artifacts", key },
    sha256: candidateSha(digit),
    byteLength: 2,
  };
}

function task() {
  return {
    kind: "agent-candidate-benchmark-task" as const,
    digestAlgorithm: "rfc8785-sha256" as const,
    benchmark: {
      name: "support-agent",
      version: "2026-07-15",
      splitDigest: candidateSha("3"),
    },
    scenario: {
      id: "case-17",
      kind: "support-ticket",
      scenarioDigest: candidateSha("2"),
    },
    datasetSnapshot: artifact("datasets/support.json", "1"),
    instruction: "Resolve the customer request using the available tools.",
    outcome: {
      kind: "output" as const,
      mediaType: "text/plain",
      maxBytes: 64_000,
    },
    workspace: {
      kind: "agent-candidate-workspace-snapshot" as const,
      digest: candidateSha("4"),
      material: {
        kind: "agent-candidate-workspace-manifest" as const,
        files: [],
      },
      manifest: artifact("tasks/case-17.manifest", "4"),
      archive: artifact("tasks/case-17.tar", "6"),
    },
    grader: {
      name: "exact-reference",
      version: "1.0.0",
      format: "tangle-grader" as const,
      artifact: artifact("graders/case-17.json", "7"),
    },
    model: {
      requested: "openai/gpt-5.4",
      provider: "openai",
      model: "gpt-5.4",
      snapshot: "gpt-5.4-2026-07-15",
      reasoningEffort: "high" as const,
    },
    attempt: {
      maxAttempts: 2,
      retryPolicy: "pre-model-infrastructure-only" as const,
    },
    evaluatorTaskContainer: {
      source: "evaluator-task-container" as const,
      image: "ghcr.io/tangle-network/agent:sha-abc",
      indexDigest: candidateSha("8"),
      manifestDigest: candidateSha("9"),
      platform: { os: "linux", architecture: "amd64" },
    },
    limits: {
      timeoutMs: 120_000,
      maxSteps: 50,
      maxModelCalls: 12,
      maxInputTokens: 100_000,
      maxOutputTokens: 20_000,
      maxCostUsd: 5,
    },
    digest: candidateSha("a"),
  };
}

function suite() {
  const benchmarkTask = task();
  return {
    kind: "agent-candidate-benchmark-suite" as const,
    digestAlgorithm: "rfc8785-sha256" as const,
    taskDigests: [benchmarkTask.digest] as const,
    reps: 2,
    seeds: [42, 43] as const,
    digest: candidateSha("f"),
  };
}

describe("agent candidate benchmark task", () => {
  it("parses one exact output task shared by evaluation and execution", () => {
    expect(agentCandidateBenchmarkTaskSchema.parse(task())).toEqual(task());
  });

  it("requires workspace tasks to pin their source repository", () => {
    const value = task();
    const invalid = {
      ...value,
      outcome: { kind: "workspace" as const },
    };
    expect(agentCandidateBenchmarkTaskSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects unbounded or unknown execution policy", () => {
    const value = task();
    expect(
      agentCandidateBenchmarkTaskSchema.safeParse({
        ...value,
        limits: { ...value.limits, maxCostUsd: Number.POSITIVE_INFINITY },
      }).success,
    ).toBe(false);
    expect(
      agentCandidateBenchmarkTaskSchema.safeParse({
        ...value,
        funding: { owner: "platform" },
      }).success,
    ).toBe(false);
    expect(
      agentCandidateBenchmarkTaskSchema.safeParse({
        ...value,
        attempt: { maxAttempts: 2, retryPolicy: "none" },
      }).success,
    ).toBe(false);
    expect(
      agentCandidateBenchmarkTaskSchema.safeParse({
        ...value,
        grader: {
          ...value.grader,
          artifact: { ...value.grader.artifact, byteLength: 0 },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects mixed repository object formats", () => {
    const value = task();
    expect(
      agentCandidateBenchmarkTaskSchema.safeParse({
        ...value,
        repository: {
          identity: "owner/repository",
          rootIdentity: "owner/repository",
          baseCommit: "a".repeat(40),
          baseTree: "b".repeat(64),
        },
        outcome: { kind: "workspace" },
      }).success,
    ).toBe(false);
  });

  it("reuses the candidate container safety policy", () => {
    const value = task();
    expect(
      agentCandidateBenchmarkTaskSchema.safeParse({
        ...value,
        evaluatorTaskContainer: {
          ...value.evaluatorTaskContainer,
          image: "http://127.0.0.1/private",
        },
      }).success,
    ).toBe(false);
  });
});

describe("agent candidate benchmark suite", () => {
  it("enumerates the complete ordered task and repetition denominator", () => {
    expect(agentCandidateBenchmarkSuiteSchema.parse(suite())).toEqual(suite());
    expect(
      agentCandidateBenchmarkSuiteInputsSchema.parse({ suite: suite(), tasks: [task()] }),
    ).toEqual({ suite: suite(), tasks: [task()] });
  });

  it("rejects omitted seeds, duplicate tasks, or substituted task documents", () => {
    const value = suite();
    expect(
      agentCandidateBenchmarkSuiteSchema.safeParse({
        ...value,
        seeds: value.seeds.slice(0, 1),
      }).success,
    ).toBe(false);
    expect(
      agentCandidateBenchmarkSuiteSchema.safeParse({
        ...value,
        taskDigests: [task().digest, task().digest],
        seeds: [42, 43, 44, 45],
      }).success,
    ).toBe(false);
    expect(
      agentCandidateBenchmarkSuiteInputsSchema.safeParse({
        suite: value,
        tasks: [{ ...task(), digest: candidateSha("e") }],
      }).success,
    ).toBe(false);
    const alias = {
      ...task(),
      digest: candidateSha("e"),
      scenario: { ...task().scenario, id: "case-18" },
    };
    expect(
      agentCandidateBenchmarkSuiteInputsSchema.safeParse({
        suite: {
          ...value,
          taskDigests: [task().digest, alias.digest],
          seeds: [42, 43, 44, 45],
        },
        tasks: [task(), alias],
      }).success,
    ).toBe(false);
  });
});
