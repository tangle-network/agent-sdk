import { describe, expect, it } from "vitest";
import { WorkspaceRequestSchema, agentEnvironmentCreateInputDigest } from "./index.js";

const digest = (value: string) => `sha256:${value.repeat(64)}` as const;
const artifact = (value: string) => ({
  locator: { kind: "private-cas" as const, namespace: "transfer-operation", digest: digest(value) },
  sha256: digest(value),
  byteLength: 128,
});
const snapshot = {
  kind: "agent-candidate-workspace-snapshot" as const,
  digest: digest("a"),
  manifest: artifact("a"),
  archive: artifact("b"),
  source: {
    leaseId: "lease-source",
    leaseRecordDigest: digest("c"),
    workspace: { provider: "local", root: "/workspace/source", identityDigest: digest("d") },
    sourceSnapshotDigest: digest("e"),
    sourceSnapshotPolicy: { kind: "provider-declared" as const, name: "git-working-tree", version: 1, digest: digest("f") },
  },
};

describe("portable workspace snapshot", () => {
  it("accepts closed artifact references and exact source lease binding", () => {
    const request = { snapshot, cwd: { base: "repository" as const, path: "." } };
    expect(WorkspaceRequestSchema.parse(request)).toEqual(request);
  });

  it("refuses embedded artifacts, inline material and arbitrary URLs", () => {
    for (const patch of [
      { archive: { encoding: "base64", content: "c2VjcmV0", sha256: digest("b"), byteLength: 6 } },
      { material: { kind: "agent-candidate-workspace-manifest", files: [] } },
      { archive: { ...artifact("b"), locator: { kind: "url", url: "https://example.com/archive" } } },
    ]) expect(() => WorkspaceRequestSchema.parse({ snapshot: { ...snapshot, ...patch } })).toThrow();
  });

  it("refuses competing workspace sources and host paths", () => {
    for (const extra of [
      { repoUrl: "https://example.com/repo.git" },
      { gitRef: "main" },
      { checkpoint: {} },
      { cwd: { base: "host", path: "/occupied" } },
    ]) expect(() => WorkspaceRequestSchema.parse({ snapshot, ...extra })).toThrow();
  });

  it("refuses mismatched, empty and unsafe artifact bounds", () => {
    for (const patch of [
      { digest: digest("c") },
      { manifest: { ...artifact("a"), byteLength: 0 } },
      { archive: { ...artifact("b"), byteLength: Number.MAX_SAFE_INTEGER + 1 } },
    ]) expect(() => WorkspaceRequestSchema.parse({ snapshot: { ...snapshot, ...patch } })).toThrow();
  });

  it("binds archive and source policy changes even when file bytes stay identical", () => {
    const input = { profile: { name: "worker" }, workspace: { snapshot } };
    const expected = agentEnvironmentCreateInputDigest(input);
    for (const changed of [
      { ...snapshot, archive: artifact("c") },
      { ...snapshot, source: { ...snapshot.source, sourceSnapshotPolicy: { ...snapshot.source.sourceSnapshotPolicy, digest: digest("c") } } },
      { ...snapshot, source: { ...snapshot.source, workspace: { ...snapshot.source.workspace, identityDigest: digest("c") } } },
    ]) expect(agentEnvironmentCreateInputDigest({ ...input, workspace: { snapshot: changed } })).not.toBe(expected);
  });
});
