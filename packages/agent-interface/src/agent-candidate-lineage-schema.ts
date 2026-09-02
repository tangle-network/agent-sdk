import { z } from "zod";
import type {
  AgentCandidateKnowledge,
  AgentCandidateLineage,
  AgentCandidateMemoryPolicy,
} from "./agent-candidate.js";
import {
  agentCandidateArtifactRefSchema,
  agentCandidateCapturedArtifactSchema,
  agentCandidateWorkspaceSnapshotEvidenceSchema,
} from "./agent-candidate-artifact-schema.js";
import {
  addDuplicateIssues,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";

export const agentCandidateKnowledgeSchema = z
  .object({
    candidate: z
      .object({
        kind: z.literal("knowledge-improvement-candidate"),
        runId: z.string().min(1),
        candidateId: z.string().min(1),
        goalHash: sha256DigestSchema,
        baseHash: sha256DigestSchema,
        candidateHash: sha256DigestSchema,
        evidenceHash: sha256DigestSchema,
        promotionPlanHash: sha256DigestSchema,
      })
      .strict(),
    snapshot: agentCandidateWorkspaceSnapshotEvidenceSchema,
    retrievalConfig: agentCandidateCapturedArtifactSchema.optional(),
    evaluation: agentCandidateCapturedArtifactSchema,
  })
  .strict() satisfies z.ZodType<AgentCandidateKnowledge>;

export const agentCandidateMemoryPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("disabled") }).strict(),
  z
    .object({
      mode: z.literal("isolated"),
      scope: z.literal("task"),
      seed: agentCandidateArtifactRefSchema.optional(),
    })
    .strict(),
]) satisfies z.ZodType<AgentCandidateMemoryPolicy>;

/**
 * Sources whose candidate was PRODUCED from a parent rather than supplied whole.
 *
 * One list, read by the lineage schema and by every experiment schema that gates on it. Three
 * call sites branched on `optimizer || compound` independently, so adding a fourth generated
 * source silently exempted it from the "name your baseline" rule in two of them.
 */
export const generatedCandidateSources = [
  "optimizer",
  "compound",
  "frontier-author",
] as const;

export function isGeneratedCandidateSource(
  source: AgentCandidateLineage["source"],
): boolean {
  return (generatedCandidateSources as readonly string[]).includes(source);
}

export const agentCandidateLineageSchema = z
  .object({
    source: z.enum([
      "optimizer",
      "human",
      "import",
      "compound",
      "frontier-author",
    ]),
    parentDigests: z.array(sha256DigestSchema).optional(),
    runIds: z.array(z.string().min(1)).optional(),
    profileDiffIds: z.array(z.string().min(1)).optional(),
    modelSnapshots: z.array(z.string().min(1)).optional(),
    developmentSplitDigest: sha256DigestSchema.optional(),
  })
  .strict()
  .superRefine((lineage, ctx) => {
    addDuplicateIssues(lineage.parentDigests, ["parentDigests"], ctx);
    addDuplicateIssues(lineage.runIds, ["runIds"], ctx);
    addDuplicateIssues(lineage.profileDiffIds, ["profileDiffIds"], ctx);
    addDuplicateIssues(lineage.modelSnapshots, ["modelSnapshots"], ctx);
    if (
      lineage.source === "compound" &&
      (lineage.parentDigests?.length ?? 0) < 2
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["parentDigests"],
        message: "compound candidates must name at least two distinct parents",
      });
    }
    // Every generated lineage names what it came from and the run that produced
    // it, whoever generated it.
    if (isGeneratedCandidateSource(lineage.source)) {
      if ((lineage.parentDigests?.length ?? 0) === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["parentDigests"],
          message: "generated candidates must name at least one parent",
        });
      }
      if ((lineage.runIds?.length ?? 0) === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["runIds"],
          message: "generated candidates must name their producing run",
        });
      }
    }
    // A development split exists only when an offline search produced the
    // candidate. An agent that authors a profile inside a run has no held-out
    // set to pin, so requiring one would force a fabricated digest into the
    // evidence record. This branch is deliberately NOT the generated-source
    // list above.
    if (lineage.source === "optimizer" || lineage.source === "compound") {
      if (lineage.developmentSplitDigest === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["developmentSplitDigest"],
          message: "generated candidates must pin their development split",
        });
      }
    }
  }) satisfies z.ZodType<AgentCandidateLineage>;
