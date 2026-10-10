import { describe, expect, it } from "vitest";
import {
  AgentLearningCapabilitiesSchema, AgentLearningExportSchema, AgentLearningIdentitySchema,
  AgentLearningManifestSchema, agentLearningExportDigest, agentLearningFileKind,
  agentLearningManifestDigest, snapshotAgentLearningManifest, unsupportedAgentLearningCapabilities,
  type AgentLearningManifestMaterial,
} from "./learning-state.js";

const identity = { workspaceId: "workspace-1", stateId: "agent-1", scope: { kind: "personal" as const, memberId: "member-1", agentId: "agent-1" } };
const adapter = { id: "optional-text-files", revision: "fixture-v1" };
const source = { harness: "hermes" as const, revision: "turn-1", trust: "untrusted" as const };
const material = (): AgentLearningManifestMaterial => ({ version: 1, identity: structuredClone(identity), revision: "commit-1",
  files: [{ path: "USER.md", kind: "preference", content: "2000-01-01: Brief answers.\n", source: structuredClone(source) }], native: [] });
const manifest = () => ({ ...material(), digest: agentLearningManifestDigest(material()) });

describe("optional learned-state interchange", () => {
  it("keeps personal identity stable independently of a session and rejects caller paths", () => {
    expect(AgentLearningIdentitySchema.parse(identity)).toEqual(identity);
    expect(AgentLearningIdentitySchema.safeParse({ ...identity, sessionId: "session-2" }).success).toBe(false);
    expect(AgentLearningIdentitySchema.safeParse({ ...identity, stateId: "../../other" }).success).toBe(false);
    expect(AgentLearningIdentitySchema.safeParse({ workspaceId: "w", stateId: "s", scope: { kind: "personal" } }).success).toBe(false);
  });
  it("binds exact content, scope and revision while accepting inventory reordering", () => {
    const input = material();
    input.files.push({ path: "MEMORY.md", kind: "fact", content: "A source-backed observation.", source });
    const digest = agentLearningManifestDigest(input);
    expect(agentLearningManifestDigest({ ...input, files: [...input.files].reverse() })).toBe(digest);
    for (const changed of [ { ...input, revision: "commit-2" }, { ...input, identity: { ...identity, stateId: "other" } },
      { ...input, files: input.files.map((f) => ({ ...f, content: "changed" })) } ]) {
      expect(agentLearningManifestDigest(changed)).not.toBe(digest);
      expect(AgentLearningManifestSchema.safeParse({ ...changed, digest }).success).toBe(false);
    }
  });
  it("detaches and freezes the complete turn snapshot", () => {
    const input = manifest();
    const pinned = snapshotAgentLearningManifest(input);
    input.files[0]!.content = "later turn";
    if (input.identity.scope.kind === "personal") input.identity.scope.memberId = "other";
    expect(pinned.files[0]!.content).toContain("Brief answers");
    expect(pinned.identity.scope).toEqual(identity.scope);
    expect(() => { pinned.files[0]!.content = "mutated"; }).toThrow();
  });
  it.each(["AGENTS.md", "SOUL.md", "IDENTITY.md", "config.json", ".env", "auth.json", "../MEMORY.md", "memory/2026-02-30.md", "memory/9999-99-99.md", "skills/a/run.sh", "skills/a/../b/SKILL.md"])("refuses nonportable or invalid path %s", (path) => {
    expect(agentLearningFileKind(path)).toBeNull();
    const input = material(); input.files[0]!.path = path;
    expect(() => agentLearningManifestDigest(input)).toThrow();
    expect(AgentLearningManifestSchema.safeParse({ ...input, digest: `sha256:${"a".repeat(64)}` }).success).toBe(false);
  });
  it("preserves exact Unicode and explicit tombstones, with bounded bytes and distinct provenance", () => {
    const input = material();
    input.files = [{ path: "skills/research/SKILL.md", kind: "skill-source", content: "🧭".repeat(32_000), source }];
    expect(AgentLearningManifestSchema.parse({ ...input, digest: agentLearningManifestDigest(input) }).files[0]!.content).toBe(input.files[0]!.content);
    input.files[0]!.content = "🧭".repeat(32_001);
    expect(() => agentLearningManifestDigest(input)).toThrow();
    input.files[0]!.content = null;
    expect(AgentLearningManifestSchema.parse({ ...input, digest: agentLearningManifestDigest(input) }).files[0]!.content).toBeNull();
  });
  it("rejects duplicate paths, executable flags, authority fields and false trust", () => {
    const input = material(); input.files.push(input.files[0]!);
    expect(() => agentLearningManifestDigest(input)).toThrow();
    for (const extra of [{ permissions: { shell: "allow" } }, { credentials: "secret" }, { executable: true }]) {
      expect(AgentLearningManifestSchema.safeParse({ ...manifest(), ...extra }).success).toBe(false);
    }
    const forged = manifest(); (forged.files[0]!.source as { trust: string }).trust = "verified";
    expect(AgentLearningManifestSchema.safeParse(forged).success).toBe(false);
  });
  it("exports explicit deltas with exact base and emitting harness provenance", () => {
    const input = { version: 1 as const, operationId: "export-1", identity, baseDigest: manifest().digest, adapter, harness: "hermes" as const, files: material().files, native: [] };
    expect(AgentLearningExportSchema.parse({ ...input, digest: agentLearningExportDigest(input) }).files).toEqual(input.files);
    const crossed = { ...input, harness: "codex" as const };
    expect(AgentLearningExportSchema.safeParse({ ...crossed, digest: agentLearningExportDigest(crossed) }).success).toBe(false);
    expect(AgentLearningExportSchema.safeParse({ ...input, digest: agentLearningExportDigest(input), deletedPaths: ["USER.md"] }).success).toBe(false);
  });
  it("declares unsupported explicitly without enabling native memory from a harness name", () => {
    const unsupported = unsupportedAgentLearningCapabilities({ harness: "hermes", adapter, reason: "No qualified adapter configured" });
    expect(unsupported.importKinds).toEqual([]);
    expect(unsupported.nativeState.status).toBe("unsupported");
    expect(AgentLearningCapabilitiesSchema.safeParse({ version: 1, harness: "hermes", adapter, importKinds: [], exportKinds: [], nativeState: { status: "preserved" } }).success).toBe(false);
    expect(AgentLearningCapabilitiesSchema.safeParse({ ...unsupported, importKinds: ["fact", "fact"] }).success).toBe(false);
  });
  it("rejects changed kinds, malformed digests, duplicate native references and unknown versions", () => {
    const input = manifest();
    expect(AgentLearningManifestSchema.safeParse({ ...input, version: 2 }).success).toBe(false);
    expect(AgentLearningManifestSchema.safeParse({ ...input, digest: "sha256:bad" }).success).toBe(false);
    expect(AgentLearningManifestSchema.safeParse({ ...input, files: [{ ...input.files[0], kind: "fact" }] }).success).toBe(false);
    const reference = { harness: "hermes" as const, format: "v1", revision: "r1", reference: "state1", digest: `sha256:${"a".repeat(64)}` };
    expect(AgentLearningManifestSchema.safeParse({ ...input, native: [reference, reference] }).success).toBe(false);
  });
  it("keeps native state opaque and identity-bound without copying credentials or choosing a filesystem path", () => {
    const input = material(); input.native = [{ harness: "hermes", format: "hermes-memory-v1", revision: "native-1", reference: "retained-state-1", digest: `sha256:${"a".repeat(64)}` }];
    expect(AgentLearningManifestSchema.parse({ ...input, digest: agentLearningManifestDigest(input) }).native[0]).toEqual(input.native[0]);
    input.native[0]!.reference = "/home/other/.hermes";
    expect(() => agentLearningManifestDigest(input)).toThrow();
  });
});
