import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import {
  isSafeRelativePath,
  isWellFormedUnicode,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";

/** One exact native file applied before an agent process starts. */
export interface AgentProfileActivationFileEvidence {
  path: string;
  mode: number;
  content: string;
}

/**
 * Shared evidence carried by every exact profile activation.
 *
 * The plan type remains owned by the producer because ordinary agent runs and
 * sealed benchmark runs have different plan contracts. The applied file bytes
 * and activation identity are shared so those producers cannot invent
 * competing activation evidence.
 */
export interface AgentProfileActivationEvidence<TProfilePlan = unknown> {
  profilePlan: TProfilePlan;
  files: AgentProfileActivationFileEvidence[];
  digest: Sha256Digest;
}

/** Runtime validator for one exact native profile file. */
export const agentProfileActivationFileEvidenceSchema = z.strictObject({
  path: z
    .string()
    .refine(
      (value) => isSafeRelativePath(value, false),
      "profile activation file must use a canonical relative path",
    ),
  mode: z.number().int().min(0).max(0o777),
  content: z
    .string()
    .refine(
      isWellFormedUnicode,
      "profile activation content must be valid Unicode",
    ),
}) satisfies z.ZodType<AgentProfileActivationFileEvidence>;

/**
 * Compose the shared activation evidence with a producer-owned exact plan.
 * Candidate materialization uses this factory and adds its stronger plan/file
 * consistency checks around the resulting schema.
 */
export function createAgentProfileActivationEvidenceSchema<TProfilePlan>(
  profilePlanSchema: z.ZodType<TProfilePlan>,
) {
  return z.strictObject({
    profilePlan: profilePlanSchema,
    files: z.array(agentProfileActivationFileEvidenceSchema),
    digest: sha256DigestSchema,
  });
}
