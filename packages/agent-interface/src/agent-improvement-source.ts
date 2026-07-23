import { z } from "zod";
import type { AgentCandidateJsonValue } from "./agent-candidate.js";
import { sha256DigestSchema } from "./agent-candidate-schema-common.js";

/** Metadata key that binds a measured improvement to its exact external source. */
export const AGENT_IMPROVEMENT_SOURCE_METADATA_KEY = "agentImprovementSource";

/**
 * Stable reference for the state from which an improvement candidate was made.
 * `sourceIdentity` identifies the provider object; `sourceDigest` is the exact
 * measured source state; `sourceRevision` is an
 * opaque provider version retained to make stale-source errors intelligible to
 * callers. A revision may be numeric or textual because providers use both
 * counters and immutable revision identifiers.
 */
export const agentImprovementSourceSchema = z
  .object({
    kind: z.string().trim().min(1).max(100).regex(/^[a-z][a-z0-9-]*$/),
    sourceIdentity: z.string().trim().min(1).max(256),
    sourceDigest: sha256DigestSchema,
    sourceRevision: z.union([
      z.string().trim().min(1).max(256),
      z.number().int().nonnegative(),
    ]),
  })
  .strict();

export type AgentImprovementSource = z.infer<
  typeof agentImprovementSourceSchema
>;

/** Attach one validated source reference to signed improvement metadata. */
export function agentImprovementSourceMetadata(
  source: AgentImprovementSource,
): Record<string, AgentCandidateJsonValue> {
  return {
    [AGENT_IMPROVEMENT_SOURCE_METADATA_KEY]:
      agentImprovementSourceSchema.parse(source),
  };
}

/** Read the exact source reference from a signed improvement proposal. */
export function readAgentImprovementSource(
  metadata: unknown,
): AgentImprovementSource {
  const record = z.record(z.string(), z.unknown()).parse(metadata);
  const source = record[AGENT_IMPROVEMENT_SOURCE_METADATA_KEY];
  if (source === undefined) {
    throw new Error("signed improvement proposal is missing its source reference");
  }
  return agentImprovementSourceSchema.parse(source);
}
