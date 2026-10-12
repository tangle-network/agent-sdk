import { z } from "zod";
import type { AgentCandidateArtifactRef, Sha256Digest } from "./agent-candidate.js";
import { agentCandidateArtifactRefSchema } from "./agent-candidate-artifact-schema.js";
import { canonicalCandidateDigest, sha256DigestSchema } from "./agent-candidate-schema-common.js";
import {
  agentWorkspaceAllocationIdentitySchema,
  type AgentWorkspaceLeaseRecord,
} from "./agent-workspace-lease.js";
import {
  agentWorkspacePublicIdentifierSchema,
  agentWorkspaceSourceSnapshotPolicySchema,
} from "./agent-workspace-source-snapshot.js";

/** Public source binding. A lease identifier or artifact locator grants no authority. */
export type AgentWorkspaceSnapshotSource = Pick<
  AgentWorkspaceLeaseRecord,
  "leaseId" | "workspace" | "sourceSnapshotDigest" | "sourceSnapshotPolicy"
> & { leaseRecordDigest: Sha256Digest };

/**
 * Reference-only projection of the canonical candidate workspace archive.
 * Runtime resolves and verifies the canonical manifest and archive before restore. The manifest
 * digest binds file bytes and modes; the archive hash additionally binds Git HEAD and index state.
 * Capture requires the source owner's private lease. Acceptance binds this complete value, not
 * only `digest`. Receivers authorize each closed artifact reference for the accepted operation.
 */
export interface AgentWorkspaceSnapshotRef {
  kind: "agent-candidate-workspace-snapshot";
  digest: Sha256Digest;
  manifest: AgentCandidateArtifactRef;
  archive: AgentCandidateArtifactRef;
  source: AgentWorkspaceSnapshotSource;
}

const nonemptyArtifactRefSchema = agentCandidateArtifactRefSchema.superRefine((ref, ctx) => {
  if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 1) {
    ctx.addIssue({ code: "custom", path: ["byteLength"], message: "workspace artifact length must be a positive safe integer" });
  }
});

export const AgentWorkspaceSnapshotRefSchema = z.strictObject({
  kind: z.literal("agent-candidate-workspace-snapshot"),
  digest: sha256DigestSchema,
  manifest: nonemptyArtifactRefSchema,
  archive: nonemptyArtifactRefSchema,
  source: z.strictObject({
    leaseId: agentWorkspacePublicIdentifierSchema,
    leaseRecordDigest: sha256DigestSchema,
    workspace: agentWorkspaceAllocationIdentitySchema,
    sourceSnapshotDigest: sha256DigestSchema,
    sourceSnapshotPolicy: agentWorkspaceSourceSnapshotPolicySchema,
  }),
}).superRefine((snapshot, ctx) => {
  if (snapshot.digest !== snapshot.manifest.sha256) {
    ctx.addIssue({ code: "custom", path: ["manifest", "sha256"], message: "workspace digest must equal the canonical manifest hash" });
  }
}) satisfies z.ZodType<AgentWorkspaceSnapshotRef>;

/** Acceptance identity of the complete reference, including Git archive and source binding. */
export function agentWorkspaceSnapshotRefDigest(snapshot: AgentWorkspaceSnapshotRef): Sha256Digest {
  return canonicalCandidateDigest(AgentWorkspaceSnapshotRefSchema.parse(snapshot));
}
