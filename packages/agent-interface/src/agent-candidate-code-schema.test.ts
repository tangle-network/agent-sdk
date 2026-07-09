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

describe("candidate code and execution schemas", () => {
  it("distinguishes disabled, proposer no-op, and real changes", () => {
    expect(() =>
      agentCandidateCodeSchema.parse({ kind: "disabled", reason: "control" }),
    ).not.toThrow();
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
        cwd: { workspace: "candidate", path: "." },
        container: { image: "node:22", indexDigest: candidateSha("1") },
      }),
    ).not.toThrow();
    expect(() =>
      agentCandidateExecutionSchema.parse({
        harness: "codex",
        harnessVersion: "0.1.0",
        launch: { kind: "container-command", executable: "bash", args: [] },
        cwd: { workspace: "task", path: "." },
        container: { image: "node:22", indexDigest: candidateSha("1") },
      }),
    ).toThrow(/non-shell/);
  });

  it("rejects container references that bypass the separately pinned index", () => {
    for (const image of [
      "registry.example/image@sha256:abcd",
      "https://registry.example/image",
      "user:password@registry.example/image",
      "127.0.0.1/image",
      "169.254.169.254/image",
      "localhost/image",
    ]) {
      expect(() =>
        agentCandidateExecutionSchema.parse({
          harness: "codex",
          harnessVersion: "0.1.0",
          launch: { kind: "container-command", executable: "codex" },
          cwd: { workspace: "task", path: "." },
          container: { image, indexDigest: candidateSha("1") },
        }),
      ).toThrow();
    }
  });
});
