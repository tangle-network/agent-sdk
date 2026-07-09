import { describe, expect, it } from "vitest";
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
      namespace: "candidate-run",
      crossTaskWrites: false,
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
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidateFixture(),
        code: { kind: "disabled", reason: "control" },
        execution: {
          ...candidateFixture().execution,
          launch: { kind: "container-command", executable: "codex" },
          cwd: { workspace: "task", path: "." },
        },
      }),
    ).not.toThrow();
    expect(() =>
      agentCandidateBundleSchema.parse({
        ...candidateFixture(),
        code: { kind: "disabled", reason: "control" },
      }),
    ).toThrow(/disabled code controls/);
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

  it("rejects non-I-JSON values and property names before RFC 8785 hashing", () => {
    for (const metadata of [
      { invalid: Number.NaN },
      { invalid: new Date() },
      { invalid: "\ud800" },
      { ["\udc00"]: "invalid-key" },
    ]) {
      expect(() =>
        agentCandidateBundleSchema.parse({
          ...candidateFixture(),
          profile: { ...candidateFixture().profile, metadata },
        }),
      ).toThrow(/RFC 8785/);
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
  const materialization = {
    schemaVersion: 1,
    kind: "agent-candidate-materialization",
    digestAlgorithm: "rfc8785-sha256",
    bundleDigest: candidateSha("1"),
    profilePlanDigest: candidateSha("2"),
    executionPlanDigest: candidateSha("3"),
    codeKind: "git-patch",
    materializedTree: candidateGit("4"),
    harness: "codex",
    harnessVersion: "0.1.0",
    container: {
      source: "evaluator-task-container",
      indexDigest: candidateSha("5"),
      manifestDigest: candidateSha("6"),
      platform: { os: "linux", architecture: "amd64" },
    },
    resolvedModel: {
      provider: "openai",
      model: "gpt-5.4",
      snapshot: "gpt-5.4-2026-06-15",
    },
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
  });

  it("records whether the candidate or evaluator selected the executed image", () => {
    expect(materialization.container.source).toBe("evaluator-task-container");
    expect(() =>
      agentCandidateMaterializationReceiptSchema.parse({
        ...materialization,
        container: { ...materialization.container, source: "unknown" },
      }),
    ).toThrow();
  });

  it("records the launched plan, isolated memory, trace, and exit status", () => {
    expect(() =>
      agentCandidateRunReceiptSchema.parse({
        schemaVersion: 1,
        kind: "agent-candidate-run",
        digestAlgorithm: "rfc8785-sha256",
        bundleDigest: candidateSha("1"),
        materializationReceiptDigest: materialization.digest,
        executionPlanDigest: materialization.executionPlanDigest,
        memory: {
          mode: "isolated",
          namespace: "run-1",
          crossTaskWrites: false,
        },
        usage: {
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          modelCalls: 0,
        },
        trace: {
          locator: {
            kind: "s3",
            bucket: "agent-candidate-artifacts",
            key: "traces/run-1.json",
          },
          sha256: candidateSha("a"),
          byteLength: 100,
        },
        exitCode: 0,
        digest: candidateSha("b"),
      }),
    ).not.toThrow();
  });
});
