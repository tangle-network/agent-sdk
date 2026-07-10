import { defineAgentCandidateBundle } from "./agent-candidate.js";

export const candidateSha = (digit: string) =>
  `sha256:${digit.repeat(64)}` as const;
export const candidateGit = (digit: string) => digit.repeat(40);

export function candidateFixture() {
  return defineAgentCandidateBundle({
    schemaVersion: 1,
    kind: "agent-candidate-bundle",
    digestAlgorithm: "rfc8785-sha256",
    profile: {
      name: "repository-agent",
      harness: "codex",
      model: {
        default: "openai/gpt-5.4",
        reasoningEffort: "high",
      },
      prompt: { systemPrompt: "Solve the repository task." },
      resources: {
        files: [
          {
            path: ".agent/policy.json",
            resource: {
              kind: "inline",
              name: "policy",
              content: "{}",
              sha256: candidateSha("b"),
              byteLength: 2,
            },
          },
        ],
        failOnError: true,
      },
    },
    code: {
      kind: "git-patch",
      repository: {
        kind: "github",
        owner: "tangle-network",
        repo: "agent-runtime",
      },
      baseCommit: candidateGit("1"),
      baseTree: candidateGit("2"),
      candidateTree: candidateGit("4"),
      patch: {
        format: "git-diff-binary",
        artifact: {
          encoding: "base64",
          content: "ZGlmZiAtLWdpdA==",
          sha256: candidateSha("5"),
          byteLength: 10,
        },
      },
    },
    execution: {
      harness: "codex",
      harnessVersion: "0.1.0",
      launch: {
        kind: "candidate-entrypoint",
        interpreter: "node",
        entrypoint: "dist/agent.js",
        args: [{ kind: "public", value: "--mode=benchmark" }],
      },
      instructionDelivery: { kind: "argv-append" },
      cwd: { workspace: "candidate", path: "." },
      env: {
        NODE_ENV: { kind: "public", value: "production" },
      },
      environment: {
        kind: "pinned-container",
        container: { image: "node:22", indexDigest: candidateSha("6") },
      },
      workspace: {
        schemaVersion: 1,
        kind: "agent-candidate-workspace-snapshot",
        digest: candidateSha("c"),
        material: {
          schemaVersion: 1,
          kind: "agent-candidate-workspace-manifest",
          files: [
            {
              path: "dist/agent.js",
              mode: 0o755,
              sha256: candidateSha("d"),
              byteLength: 42,
            },
          ],
        },
        manifest: {
          encoding: "base64",
          content: "e30=",
          sha256: candidateSha("c"),
          byteLength: 2,
        },
        archive: {
          encoding: "base64",
          content: "e30=",
          sha256: candidateSha("e"),
          byteLength: 2,
        },
      },
      isolation: {
        network: "disabled",
        remoteIntegrations: "disabled",
        candidateSecrets: "disabled",
      },
    },
    knowledge: {
      snapshotId: "knowledge-17",
      manifest: {
        locator: {
          kind: "s3",
          bucket: "agent-candidate-artifacts",
          key: "knowledge/knowledge-17.json",
          region: "us-east-1",
        },
        sha256: candidateSha("7"),
        byteLength: 42,
      },
    },
    memory: {
      mode: "isolated",
      scope: "task",
    },
    lineage: {
      source: "optimizer",
      parentDigests: [candidateSha("8")],
      runIds: ["r360-search"],
      profileDiffIds: ["profile-diff-3"],
      modelSnapshots: ["openai/gpt-5.4-2026-06-15"],
      benchmark: {
        name: "pier",
        version: "0.3",
        splitDigest: candidateSha("9"),
      },
      spend: {
        proposal: {
          costUsd: 3.5,
          inputTokens: 100,
          outputTokens: 20,
          modelCalls: 2,
        },
        evaluation: {
          costUsd: 9,
          inputTokens: 900,
          outputTokens: 200,
          modelCalls: 8,
        },
      },
    },
    digest: candidateSha("a"),
  });
}
