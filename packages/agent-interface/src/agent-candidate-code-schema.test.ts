import { describe, expect, it } from "vitest";
import {
  agentCandidateCodeSchema,
  agentCandidateExecutionSchema,
} from "./agent-candidate-code-schema.js";
import { candidateGit, candidateSha } from "./agent-candidate.test-fixture.js";

const repository = {
  kind: "github" as const,
  owner: "tangle-network",
  repo: "agent-runtime",
};

const isolation = {
  network: "disabled" as const,
  remoteIntegrations: "disabled" as const,
  candidateSecrets: "disabled" as const,
};

const instructionDelivery = { kind: "argv-append" as const };

describe("candidate code and execution schemas", () => {
  it("distinguishes disabled, proposer no-op, and real changes", () => {
    expect(() => agentCandidateCodeSchema.parse({ kind: "disabled" })).not.toThrow();
    expect(() =>
      agentCandidateCodeSchema.parse({
        kind: "no-op",
        reason: "proposer-no-change",
        repository,
        baseCommit: candidateGit("1"),
        baseTree: candidateGit("2"),
      }),
    ).not.toThrow();
    expect(() =>
      agentCandidateCodeSchema.parse({
        kind: "git-patch",
        repository,
        baseCommit: candidateGit("1"),
        baseTree: candidateGit("2"),
        candidateTree: candidateGit("3"),
        patch: {
          format: "git-diff-binary",
          artifact: {
            encoding: "base64",
            content: "ZGlmZiAtLWdpdA==",
            sha256: candidateSha("4"),
            byteLength: 10,
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects empty real patches and unchanged trees", () => {
    const code = {
      kind: "git-patch",
      repository,
      baseCommit: candidateGit("1"),
      baseTree: candidateGit("2"),
      candidateTree: candidateGit("2"),
      patch: {
        format: "git-diff-binary",
        artifact: {
          encoding: "base64",
          content: "",
          sha256: candidateSha("4"),
          byteLength: 0,
        },
      },
    };
    expect(() => agentCandidateCodeSchema.parse(code)).toThrow(
      /use code.kind='no-op'/,
    );
  });

  it("rejects mixed SHA-1 and SHA-256 object formats", () => {
    expect(() =>
      agentCandidateCodeSchema.parse({
        kind: "git-patch",
        repository,
        baseCommit: candidateGit("1"),
        baseTree: candidateGit("2"),
        candidateTree: "3".repeat(64),
        patch: {
          format: "git-diff-binary",
          artifact: {
            encoding: "base64",
            content: "ZGlmZiAtLWdpdA==",
            sha256: candidateSha("4"),
            byteLength: 10,
          },
        },
      }),
    ).toThrow(/one object format/);
  });

  it("expresses shell-free direct and candidate-entrypoint launches", () => {
    expect(() =>
      agentCandidateExecutionSchema.parse({
        harness: "codex",
        harnessVersion: "0.1.0",
        launch: {
          kind: "candidate-entrypoint",
          interpreter: "node",
          entrypoint: "dist/agent.js",
        },
        instructionDelivery,
        cwd: { workspace: "candidate", path: "." },
        environment: {
          kind: "pinned-container",
          container: { image: "node:22", indexDigest: candidateSha("1") },
        },
        isolation,
      }),
    ).not.toThrow();
    expect(() =>
      agentCandidateExecutionSchema.parse({
        harness: "codex",
        harnessVersion: "0.1.0",
        launch: { kind: "container-command", executable: "bash", args: [] },
        instructionDelivery,
        cwd: { workspace: "task", path: "." },
        environment: { kind: "evaluator-task-container" },
        isolation,
      }),
    ).toThrow(/non-shell/);
  });

  it("lets an evaluator select a different pinned task container per task", () => {
    expect(() =>
      agentCandidateExecutionSchema.parse({
        harness: "codex",
        harnessVersion: "0.1.0",
        launch: {
          kind: "candidate-entrypoint",
          interpreter: "node",
          entrypoint: "dist/agent.js",
        },
        instructionDelivery: { kind: "stdin-utf8" },
        cwd: { workspace: "task", path: "." },
        environment: { kind: "evaluator-task-container" },
        isolation,
      }),
    ).not.toThrow();
  });

  it("rejects container references that bypass the separately pinned index", () => {
    for (const image of [
      "registry.example/image@sha256:abcd",
      "https://registry.example/image",
      "user:password@registry.example/image",
      "127.0.0.1/image",
      "127.1/image",
      "2130706433:5000/image",
      "0x7f000001:5000/image",
      "169.254.169.254/image",
      "localhost/image",
    ]) {
      expect(() =>
        agentCandidateExecutionSchema.parse({
          harness: "codex",
          harnessVersion: "0.1.0",
          launch: { kind: "container-command", executable: "codex" },
          instructionDelivery,
          cwd: { workspace: "task", path: "." },
          environment: {
            kind: "pinned-container",
            container: { image, indexDigest: candidateSha("1") },
          },
          isolation,
        }),
      ).toThrow();
    }

    expect(() =>
      agentCandidateExecutionSchema.parse({
        harness: "codex",
        harnessVersion: "0.1.0",
        launch: { kind: "container-command", executable: "codex" },
        instructionDelivery,
        cwd: { workspace: "task", path: "." },
        environment: {
          kind: "pinned-container",
          container: {
            image: "fcorp.example/image",
            indexDigest: candidateSha("1"),
          },
        },
        isolation,
      }),
    ).not.toThrow();
  });

  it("freezes task-instruction delivery without an evaluator env override", () => {
    const base = {
      harness: "codex" as const,
      harnessVersion: "0.1.0",
      launch: { kind: "container-command" as const, executable: "codex" },
      cwd: { workspace: "task" as const, path: "." },
      environment: { kind: "evaluator-task-container" as const },
      isolation,
    };
    for (const delivery of [
      { kind: "argv-append" },
      { kind: "stdin-utf8" },
      {
        kind: "utf8-file",
        env: "TANGLE_CANDIDATE_TASK_PATH",
        path: "/tangle/input/task.txt",
      },
    ]) {
      expect(() =>
        agentCandidateExecutionSchema.parse({
          ...base,
          instructionDelivery: delivery,
        }),
      ).not.toThrow();
    }
    expect(() =>
      agentCandidateExecutionSchema.parse({
        ...base,
        instructionDelivery: {
          kind: "utf8-file",
          env: "TASK_PATH",
          path: "/tmp/task.txt",
        },
      }),
    ).toThrow();
    expect(() =>
      agentCandidateExecutionSchema.parse({
        ...base,
        instructionDelivery,
        env: {
          TANGLE_CANDIDATE_TASK_PATH: {
            kind: "public",
            value: "/tmp/override.txt",
          },
        },
      }),
    ).toThrow(/evaluator exclusively owns/);
  });
});
