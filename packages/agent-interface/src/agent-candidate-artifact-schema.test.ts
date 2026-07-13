import { describe, expect, it } from "vitest";
import type { AgentCandidateResources } from "./agent-candidate.js";
import {
  agentCandidateArtifactRefSchema,
  agentCandidateEmbeddedArtifactSchema,
  agentCandidateFileMountSchema,
  agentCandidateGitHubResourceSchema,
  agentCandidateInlineResourceSchema,
  agentCandidateResourcesSchema,
  agentCandidateWorkspaceManifestMaterialSchema,
  agentCandidateWorkspaceSnapshotEvidenceSchema,
} from "./agent-candidate-artifact-schema.js";
import { candidateGit, candidateSha } from "./agent-candidate.test-fixture.js";

const failClosedResources: AgentCandidateResources = { failOnError: true };
// @ts-expect-error Candidate resources may never silently degrade.
const missingFailClosedPolicy: AgentCandidateResources = {};
void failClosedResources;
void missingFailClosedPolicy;

describe("candidate artifact schemas", () => {
  it("accepts only closed, non-URL artifact locators", () => {
    expect(() =>
      agentCandidateArtifactRefSchema.parse({
        locator: {
          kind: "s3",
          bucket: "agent-candidate-artifacts",
          key: "runs/r360/trace.json",
          region: "us-east-1",
        },
        sha256: candidateSha("1"),
        byteLength: 42,
      }),
    ).not.toThrow();

    for (const uri of [
      "file:///etc/passwd",
      "http://169.254.169.254/latest/meta-data",
      "javascript:alert(1)",
      "data:text/plain,secret",
      "gopher://127.0.0.1",
    ]) {
      expect(() =>
        agentCandidateArtifactRefSchema.parse({
          locator: { kind: "url", uri },
          sha256: candidateSha("1"),
          byteLength: 42,
        }),
      ).toThrow();
    }
  });

  it("rejects traversal-shaped artifact keys and reserved roots", () => {
    for (const key of [
      "../secret",
      "/absolute",
      ".git/config",
      "nested/.git/config",
      ".sidecar/state",
      "tokens/sk-live-abcdefghijkl",
    ]) {
      expect(() =>
        agentCandidateArtifactRefSchema.parse({
          locator: {
            kind: "s3",
            bucket: "agent-candidate-artifacts",
            key,
          },
          sha256: candidateSha("1"),
          byteLength: 42,
        }),
      ).toThrow();
    }
  });

  it("requires canonical base64 and its exact decoded byte length", () => {
    expect(() =>
      agentCandidateEmbeddedArtifactSchema.parse({
        encoding: "base64",
        content: "ZGlmZiAtLWdpdA==",
        sha256: candidateSha("1"),
        byteLength: 10,
      }),
    ).not.toThrow();
    expect(() =>
      agentCandidateEmbeddedArtifactSchema.parse({
        encoding: "base64",
        content: "Zh==",
        sha256: candidateSha("1"),
        byteLength: 1,
      }),
    ).toThrow(/canonical zero padding/);
    expect(() =>
      agentCandidateEmbeddedArtifactSchema.parse({
        encoding: "base64",
        content: "ZGlmZiAtLWdpdA==",
        sha256: candidateSha("1"),
        byteLength: 11,
      }),
    ).toThrow(/decoded base64/);
  });

  it("checks UTF-8 inline byte length and well-formed Unicode", () => {
    expect(() =>
      agentCandidateInlineResourceSchema.parse({
        kind: "inline",
        name: "policy",
        content: "é",
        sha256: candidateSha("1"),
        byteLength: 2,
      }),
    ).not.toThrow();
    expect(() =>
      agentCandidateInlineResourceSchema.parse({
        kind: "inline",
        name: "policy",
        content: "é",
        sha256: candidateSha("1"),
        byteLength: 1,
      }),
    ).toThrow(/UTF-8/);
    expect(() =>
      agentCandidateInlineResourceSchema.parse({
        kind: "inline",
        name: "policy",
        content: "\ud800",
        sha256: candidateSha("1"),
        byteLength: 3,
      }),
    ).toThrow();
  });

  it("requires a pinned GitHub component identity and content hash", () => {
    const frozen = {
      kind: "github",
      repository: { kind: "github", owner: "tangle-network", repo: "agent-runtime" },
      path: "skills/review/SKILL.md",
      commit: candidateGit("1"),
      sha256: candidateSha("2"),
      byteLength: 42,
    };
    expect(() => agentCandidateGitHubResourceSchema.parse(frozen)).not.toThrow();

    for (const repository of [
      { kind: "github", owner: "..", repo: "agent-runtime" },
      { kind: "github", owner: "tangle-network", repo: ".." },
      "../..",
    ]) {
      expect(() =>
        agentCandidateGitHubResourceSchema.parse({ ...frozen, repository }),
      ).toThrow();
    }
    expect(() =>
      agentCandidateGitHubResourceSchema.parse({
        ...frozen,
        commit: undefined,
        ref: "main",
      }),
    ).toThrow();
  });

  it("rejects reserved mount targets before the materializer sees them", () => {
    const resource = {
      kind: "inline",
      name: "policy",
      content: "{}",
      sha256: candidateSha("1"),
      byteLength: 2,
    };
    for (const path of [
      "../escape",
      ".git/config",
      "nested/.git/config",
      ".sidecar/secrets.json",
    ]) {
      expect(() =>
        agentCandidateFileMountSchema.parse({ path, resource }),
      ).toThrow();
    }
  });

  it("makes fail-closed profile materialization mandatory", () => {
    expect(() =>
      agentCandidateResourcesSchema.parse({ files: [], failOnError: true }),
    ).not.toThrow();
    expect(() =>
      agentCandidateResourcesSchema.parse({ files: [] }),
    ).toThrow();
    expect(() =>
      agentCandidateResourcesSchema.parse({ files: [], failOnError: false }),
    ).toThrow();
  });

  it("binds a sorted regular-file-only workspace manifest", () => {
    const files = [
      {
        path: "dist/agent.js",
        mode: 0o755,
        sha256: candidateSha("1"),
        byteLength: 42,
      },
      {
        path: "dist/lib.js",
        mode: 0o664,
        sha256: candidateSha("2"),
        byteLength: 10,
      },
    ];
    expect(() =>
      agentCandidateWorkspaceManifestMaterialSchema.parse({
        schemaVersion: 2,
        kind: "agent-candidate-workspace-manifest",
        files,
      }),
    ).not.toThrow();
    expect(
      agentCandidateWorkspaceManifestMaterialSchema.safeParse({
        schemaVersion: 1,
        kind: "agent-candidate-workspace-manifest",
        files,
      }).success,
    ).toBe(false);
    for (const invalidFiles of [
      [...files].reverse(),
      [files[0], files[0]],
      [{ ...files[0], path: "../escape" }],
      [{ ...files[0], mode: 0o1000 }],
      [{ ...files[0], kind: "symlink", target: "/etc/passwd" }],
    ]) {
      expect(() =>
        agentCandidateWorkspaceManifestMaterialSchema.parse({
          schemaVersion: 2,
          kind: "agent-candidate-workspace-manifest",
          files: invalidFiles,
        }),
      ).toThrow();
    }
  });

  it("requires workspace manifest and archive evidence", () => {
    const evidence = {
      schemaVersion: 2,
      kind: "agent-candidate-workspace-snapshot",
      digest: candidateSha("1"),
      material: {
        schemaVersion: 2,
        kind: "agent-candidate-workspace-manifest",
        files: [],
      },
      manifest: {
        encoding: "base64",
        content: "e30=",
        sha256: candidateSha("1"),
        byteLength: 2,
      },
      archive: {
        encoding: "base64",
        content: "e30=",
        sha256: candidateSha("2"),
        byteLength: 2,
      },
    };
    expect(() =>
      agentCandidateWorkspaceSnapshotEvidenceSchema.parse(evidence),
    ).not.toThrow();
    expect(
      agentCandidateWorkspaceSnapshotEvidenceSchema.safeParse({
        ...evidence,
        schemaVersion: 1,
      }).success,
    ).toBe(false);
    expect(() =>
      agentCandidateWorkspaceSnapshotEvidenceSchema.parse({
        ...evidence,
        manifest: { ...evidence.manifest, sha256: candidateSha("3") },
      }),
    ).toThrow(/canonical manifest hash/);
    expect(() =>
      agentCandidateWorkspaceSnapshotEvidenceSchema.parse({
        ...evidence,
        archive: { ...evidence.archive, content: "", byteLength: 0 },
      }),
    ).toThrow(/non-empty/);
  });
});
