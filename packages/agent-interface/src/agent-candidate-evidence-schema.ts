import { z } from "zod";
import { agentCandidateCapturedArtifactSchema } from "./agent-candidate-artifact-schema.js";
import { sha256DigestSchema } from "./agent-candidate-schema-common.js";

/**
 * Evidence that one captured artifact is the canonical bytes of its material.
 *
 * The artifact's hash must equal the digest the material canonicalizes to, and
 * the artifact must actually carry bytes. Both are integrity claims: a record
 * whose artifact hash names something other than its material is evidence for
 * a different value, and a zero-length artifact is a claim with nothing behind
 * it. `label` names the evidence in the refusal so a reader knows which record
 * failed.
 */
export function agentCandidateEvidenceSchema<TKind extends string, TMaterial>(
  kind: TKind,
  material: z.ZodType<TMaterial>,
  label: string,
) {
  return z
    .object({
      kind: z.literal(kind),
      digest: sha256DigestSchema,
      material,
      artifact: agentCandidateCapturedArtifactSchema,
    })
    .strict()
    .superRefine((evidence, ctx) => {
      if (evidence.artifact.sha256 !== evidence.digest) {
        ctx.addIssue({
          code: "custom",
          path: ["artifact", "sha256"],
          message: `${label} artifact hash must equal its canonical material digest`,
        });
      }
      if (evidence.artifact.byteLength === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["artifact", "byteLength"],
          message: `${label} artifact must contain canonical material bytes`,
        });
      }
    });
}
