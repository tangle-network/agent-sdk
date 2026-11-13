import { z } from "zod";
import { sha256DigestSchema, relativePathSafetyIssues } from "./agent-candidate-schema-common.js";
import type { Sha256Digest } from "./agent-candidate.js";
import { boundedIdentifierSchema, boundedJsonRecordSchema, boundedStringSchema } from "./contract-limits.js";
import { AgentExactRunControlRefSchema, type AgentExactRunControlRef } from "./runtime-control.js";

/** One caller-declared output, relative to the managed workspace root, not a process cwd. */
export interface AgentFileOutputPolicy {
  name: string;
  path: string;
}

export const AgentFileOutputPolicySchema = z.strictObject({
  name: boundedIdentifierSchema,
  path: boundedStringSchema.refine((path) =>
    path.length > 0 && relativePathSafetyIssues(path).length === 0 &&
    path.split("/").every((part) => part.length > 0 && part !== "."),
  "File output must name one canonical relative managed-workspace path"),
}) satisfies z.ZodType<AgentFileOutputPolicy>;

/** Provider evidence for one stopped, immutable, preserved regular-file publication.
 * The provider reference is an address, never authority; only that provider's authorized
 * reader may interpret it, and must verify the selected revision and bytes to EOF.
 */
export interface AgentRetainedFilePublication {
  controlRef: AgentExactRunControlRef;
  policy: AgentFileOutputPolicy;
  source: {
    environmentId: string;
    createdAt: string;
    filesystemIncarnationId: string;
    workspaceSnapshot: string;
  };
  file: { path: string; kind: "regular"; sha256: Sha256Digest; byteLength: number };
  /** The actual provider-owned receipt, not a reconstructed latest-file descriptor. */
  providerReference: Record<string, unknown>;
  preserved: true;
}

export const AgentRetainedFilePublicationSchema = z.strictObject({
  controlRef: AgentExactRunControlRefSchema,
  policy: AgentFileOutputPolicySchema,
  source: z.strictObject({
    environmentId: boundedIdentifierSchema,
    createdAt: boundedStringSchema,
    filesystemIncarnationId: boundedIdentifierSchema,
    workspaceSnapshot: boundedIdentifierSchema,
  }),
  file: z.strictObject({
    path: AgentFileOutputPolicySchema.shape.path,
    kind: z.literal("regular"),
    sha256: sha256DigestSchema,
    byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  providerReference: boundedJsonRecordSchema,
  preserved: z.literal(true),
}).superRefine((publication, ctx) => {
  if (publication.source.environmentId !== publication.controlRef.environmentId)
    ctx.addIssue({ code: "custom", path: ["source", "environmentId"], message: "Publication belongs to another environment" });
  if (publication.file.path !== publication.policy.path)
    ctx.addIssue({ code: "custom", path: ["file", "path"], message: "Publication does not contain the declared output" });
}) satisfies z.ZodType<AgentRetainedFilePublication>;

export interface AgentRetainedFileOutputRequest {
  controlRef: AgentExactRunControlRef;
  policy: AgentFileOutputPolicy;
}

export const AgentRetainedFileOutputRequestSchema = z.strictObject({
  controlRef: AgentExactRunControlRefSchema,
  policy: AgentFileOutputPolicySchema,
}) satisfies z.ZodType<AgentRetainedFileOutputRequest>;

/** Unavailable is an evidence gap, never a quality verdict or permission to substitute a later file. */
export type AgentRetainedFileOutputResult =
  | { status: "published"; publication: AgentRetainedFilePublication }
  | { status: "unavailable"; reason: string };

export const AgentRetainedFileOutputResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("published"), publication: AgentRetainedFilePublicationSchema }),
  z.strictObject({ status: z.literal("unavailable"), reason: boundedStringSchema }),
]) satisfies z.ZodType<AgentRetainedFileOutputResult>;

/** Stop and preserve the declared file through this exact execution's physical owner.
 * A successful JSON submission is separate. Retain the original association before continuation
 * or release; a lost receipt stays unknown.
 */
export type AgentRetainedFileOutputOperation = (
  request: AgentRetainedFileOutputRequest,
  options?: { signal?: AbortSignal; idempotencyKey?: string },
) => Promise<AgentRetainedFileOutputResult>;
