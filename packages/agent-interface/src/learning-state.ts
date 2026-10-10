/** Optional protected-home-compatible text interchange, not a universal native-memory format.
 * Native harness memory, optional provider adapters, AgentProfile and session history retain their owners.
 * The host authenticates identity and resolves opaque references; schemas confer no authority.
 */
import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import { canonicalCandidateDigest, isWellFormedUnicode, sha256DigestSchema } from "./agent-candidate-schema-common.js";
import { harnessTypeSchema } from "./harness.js";
import { deepFreeze } from "./deep-freeze.js";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const revision = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const adapter = z.strictObject({ id, revision });

export const AgentLearningIdentitySchema = z.strictObject({
  workspaceId: id,
  stateId: id,
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("personal"), memberId: id, agentId: id }),
    z.strictObject({ kind: z.literal("shared"), groupId: id, agentId: id }),
  ]),
});
export type AgentLearningIdentity = z.infer<typeof AgentLearningIdentitySchema>;

export const AGENT_LEARNING_FILE_KINDS = ["fact", "preference", "note", "skill-source"] as const;
export type AgentLearningFileKind = (typeof AGENT_LEARNING_FILE_KINDS)[number];
const fileKind = z.enum(AGENT_LEARNING_FILE_KINDS);

/** Exact allowlist, never a general filesystem or configuration mount. */
export function agentLearningFileKind(path: string): AgentLearningFileKind | null {
  if (path === "MEMORY.md") return "fact";
  if (path === "USER.md") return "preference";
  if (/^skills\/[a-z0-9][a-z0-9-]{0,63}\/SKILL\.md$/.test(path)) return "skill-source";
  const note = /^memory\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path);
  if (note) {
    const date = new Date(`${note[1]}T00:00:00.000Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === note[1]) return "note";
  }
  return null;
}

export const AgentLearningFileSchema = z.strictObject({
  path: z.string().min(1).max(100),
  kind: fileKind,
  /** Null is an explicit tombstone. Omission from an export never deletes a file. */
  content: z.string().max(131_072).refine(isWellFormedUnicode).nullable(),
  source: z.strictObject({
    harness: harnessTypeSchema,
    revision,
    /** Origin metadata is evidence of provenance, not truth or trusted instructions. */
    trust: z.literal("untrusted"),
  }),
}).superRefine((file, ctx) => {
  if (agentLearningFileKind(file.path) !== file.kind) {
    ctx.addIssue({ code: "custom", path: ["path"], message: "learned file path does not match its portable kind" });
  }
  const limits = { fact: 16_000, preference: 4_000, note: 12_000, "skill-source": 32_000 };
  if (file.content !== null && [...file.content].length > limits[file.kind]) {
    ctx.addIssue({ code: "custom", path: ["content"], message: "learned file exceeds its character budget" });
  }
});
export type AgentLearningFile = z.infer<typeof AgentLearningFileSchema>;

/** A host-resolved reference to exact native state, never a path or credential value. */
export const AgentLearningNativeRefSchema = z.strictObject({
  harness: harnessTypeSchema,
  format: id,
  revision,
  reference: id,
  digest: sha256DigestSchema,
});
export type AgentLearningNativeRef = z.infer<typeof AgentLearningNativeRefSchema>;

const files = z.array(AgentLearningFileSchema).max(1_024).superRefine((value, ctx) => {
  if (new Set(value.map((file) => file.path)).size !== value.length) {
    ctx.addIssue({ code: "custom", message: "learned file paths must be unique" });
  }
  if (value.reduce((size, file) => size + new TextEncoder().encode(file.content ?? "").length, 0) > 8 * 1024 * 1024) {
    ctx.addIssue({ code: "custom", message: "learned state exceeds its byte budget" });
  }
});
const native = z.array(AgentLearningNativeRefSchema).max(64).superRefine((value, ctx) => {
  if (new Set(value.map((ref) => `${ref.harness}:${ref.format}`)).size !== value.length) {
    ctx.addIssue({ code: "custom", message: "native state references must be unique by harness and format" });
  }
});
const materialSchema = z.strictObject({
  version: z.literal(1),
  identity: AgentLearningIdentitySchema,
  /** Exact existing owner revision (e.g. protected-home Git commit), not a second revision store. */
  revision,
  files,
  native,
});
export type AgentLearningManifestMaterial = z.infer<typeof materialSchema>;

/** Canonical digest ignores inventory order; file bytes and provenance remain exact. */
export function agentLearningManifestDigest(value: AgentLearningManifestMaterial): Sha256Digest {
  const parsed = materialSchema.parse(value);
  return canonicalCandidateDigest({ ...parsed,
    files: [...parsed.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    native: [...parsed.native].sort((a, b) => `${a.harness}:${a.format}` < `${b.harness}:${b.format}` ? -1 : 1),
  });
}
export const AgentLearningManifestSchema = materialSchema.extend({ digest: sha256DigestSchema })
  .superRefine(({ digest, ...material }, ctx) => {
    if (ctx.issues.length) return;
    if (digest !== agentLearningManifestDigest(material)) {
      ctx.addIssue({ code: "custom", path: ["digest"], message: "learned manifest digest does not match its material" });
    }
  });
export type AgentLearningManifest = z.infer<typeof AgentLearningManifestSchema>;

/** Detach and freeze an exact turn pin. A retry must persist/reuse this pin, not reread head. */
export function snapshotAgentLearningManifest(value: unknown): AgentLearningManifest {
  return deepFreeze(AgentLearningManifestSchema.parse(structuredClone(value)));
}

const exportMaterialSchema = z.strictObject({
  version: z.literal(1),
  operationId: id,
  identity: AgentLearningIdentitySchema,
  baseDigest: sha256DigestSchema,
  harness: harnessTypeSchema,
  adapter,
  /** Explicit deltas only. Never infer deletion from absence or a partial native listing. */
  files,
  native,
});
export type AgentLearningExportMaterial = z.infer<typeof exportMaterialSchema>;
export function agentLearningExportDigest(value: AgentLearningExportMaterial): Sha256Digest {
  const parsed = exportMaterialSchema.parse(value);
  return canonicalCandidateDigest({ ...parsed,
    files: [...parsed.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    native: [...parsed.native].sort((a, b) => `${a.harness}:${a.format}` < `${b.harness}:${b.format}` ? -1 : 1),
  });
}
export const AgentLearningExportSchema = exportMaterialSchema.extend({ digest: sha256DigestSchema })
  .superRefine(({ digest, ...material }, ctx) => {
    if (ctx.issues.length) return;
    if (digest !== agentLearningExportDigest(material)) {
      ctx.addIssue({ code: "custom", path: ["digest"], message: "learned export digest does not match its material" });
    }
    if (material.files.some((file) => file.source.harness !== material.harness) || material.native.some((ref) => ref.harness !== material.harness)) {
      ctx.addIssue({ code: "custom", message: "export provenance must name its declared harness" });
    }
  });
export type AgentLearningExport = z.infer<typeof AgentLearningExportSchema>;

const kinds = z.array(fileKind).max(AGENT_LEARNING_FILE_KINDS.length).refine((value) => new Set(value).size === value.length);
/** Capabilities are properties of a particular adapter and tested format, not harness folklore. */
export const AgentLearningCapabilitiesSchema = z.strictObject({
  version: z.literal(1),
  harness: harnessTypeSchema,
  adapter,
  importKinds: kinds,
  exportKinds: kinds,
  nativeState: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("unsupported"), reason: z.string().min(1).max(512) }),
    z.strictObject({ status: z.literal("preserved"), format: id, conformanceDigest: sha256DigestSchema,
      qualification: z.enum(["fixture", "native-binary"]) }),
  ]),
});
export type AgentLearningCapabilities = z.infer<typeof AgentLearningCapabilitiesSchema>;

/** No capability by omission. Text preservation does not activate executable skills or profile authority. */
export function unsupportedAgentLearningCapabilities(input: Pick<AgentLearningCapabilities, "harness" | "adapter"> & { reason: string }): AgentLearningCapabilities {
  return deepFreeze(AgentLearningCapabilitiesSchema.parse({ version: 1, harness: input.harness, adapter: input.adapter, importKinds: [], exportKinds: [],
    nativeState: { status: "unsupported", reason: input.reason } }));
}
