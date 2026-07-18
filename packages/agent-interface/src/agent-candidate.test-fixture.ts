import { defineAgentCandidateBundle } from "./agent-candidate.js";

export const candidateSha = (digit: string) =>
  `sha256:${digit.repeat(64)}` as const;
export const candidateGit = (digit: string) => digit.repeat(40);

export function candidateFixture() {
  return defineAgentCandidateBundle({
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
        PATH: { kind: "public", value: "/usr/local/bin:/usr/bin:/bin" },
      },
      environment: {
        kind: "pinned-container",
        container: { image: "node:22", indexDigest: candidateSha("6") },
      },
      workspace: {
        kind: "agent-candidate-workspace-snapshot",
        digest: candidateSha("c"),
        material: {
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
      candidate: {
        kind: "knowledge-improvement-candidate",
        runId: "knowledge-run-17",
        candidateId: "knowledge-17",
        goalHash: candidateSha("5"),
        baseHash: candidateSha("6"),
        candidateHash: candidateSha("7"),
        evidenceHash: candidateSha("8"),
        promotionPlanHash: candidateSha("9"),
      },
      snapshot: {
        kind: "agent-candidate-workspace-snapshot",
        digest: candidateSha("7"),
        material: {
          kind: "agent-candidate-workspace-manifest",
          files: [],
        },
        manifest: {
          encoding: "base64",
          content: "e30=",
          sha256: candidateSha("7"),
          byteLength: 2,
        },
        archive: {
          encoding: "base64",
          content: "e30=",
          sha256: candidateSha("8"),
          byteLength: 2,
        },
      },
      retrievalConfig: {
        encoding: "base64",
        content: "e30=",
        sha256: candidateSha("9"),
        byteLength: 2,
      },
      evaluation: {
        encoding: "base64",
        content: "e30=",
        sha256: candidateSha("a"),
        byteLength: 2,
      },
    },
    memory: {
      mode: "isolated",
      scope: "task",
    },
    digest: candidateSha("a"),
  });
}
