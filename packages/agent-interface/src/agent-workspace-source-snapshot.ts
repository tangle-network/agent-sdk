import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import {
  isWellFormedUnicode,
  looksLikeCredential,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";

const controlCharacterPattern = /[\u0000-\u001f\u007f]/;

/** Shared public identifier used by workspace lifecycle contracts. */
export const agentWorkspacePublicIdentifierSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      isWellFormedUnicode(value) &&
      !controlCharacterPattern.test(value) &&
      !looksLikeCredential(value),
    "public workspace identity cannot carry credential-like material"
  );

/**
 * Public identity of the provider-owned rules used to capture workspace state.
 * The digest binds the exact canonical policy document retained by the provider;
 * this descriptor does not claim that every provider captures the same fields.
 */
export interface AgentWorkspaceSourceSnapshotPolicy {
  kind: "provider-declared";
  name: string;
  version: number;
  digest: Sha256Digest;
}

export const agentWorkspaceSourceSnapshotPolicySchema = z.strictObject({
  kind: z.literal("provider-declared"),
  name: agentWorkspacePublicIdentifierSchema,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  digest: sha256DigestSchema,
}) satisfies z.ZodType<AgentWorkspaceSourceSnapshotPolicy>;
