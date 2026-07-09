import { z } from "zod";
import type {
  AgentCandidateKnowledge,
  AgentCandidateLineage,
  AgentCandidateMemoryPolicy,
  AgentCandidateSpend,
} from "./agent-candidate.js";
import { agentCandidateArtifactRefSchema } from "./agent-candidate-artifact-schema.js";
import {
  addDuplicateIssues,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";

export const agentCandidateKnowledgeSchema = z
  .object({
    snapshotId: z.string().min(1),
    manifest: agentCandidateArtifactRefSchema,
  })
  .strict() satisfies z.ZodType<AgentCandidateKnowledge>;

export const agentCandidateMemoryPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("disabled") }).strict(),
  z
    .object({
      mode: z.literal("isolated"),
      namespace: z.string().min(1),
      seed: agentCandidateArtifactRefSchema.optional(),
      crossTaskWrites: z.literal(false),
    })
    .strict(),
]) satisfies z.ZodType<AgentCandidateMemoryPolicy>;

export const agentCandidateSpendSchema = z
  .object({
    costUsd: z.number().finite().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    modelCalls: z.number().int().nonnegative(),
  })
  .strict() satisfies z.ZodType<AgentCandidateSpend>;

export const agentCandidateLineageSchema = z
  .object({
    source: z.enum(["optimizer", "human", "import", "compound"]),
    parentDigests: z.array(sha256DigestSchema).optional(),
    runIds: z.array(z.string().min(1)).optional(),
    profileDiffIds: z.array(z.string().min(1)).optional(),
    modelSnapshots: z.array(z.string().min(1)).optional(),
    benchmark: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        splitDigest: sha256DigestSchema,
      })
      .strict()
      .optional(),
    spend: z
      .object({
        proposal: agentCandidateSpendSchema,
        evaluation: agentCandidateSpendSchema,
      })
      .strict()
      .optional(),
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
    if (lineage.source === "optimizer" || lineage.source === "compound") {
      if ((lineage.runIds?.length ?? 0) === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["runIds"],
          message: "generated candidates must name their producing run",
        });
      }
      if (lineage.benchmark === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["benchmark"],
          message: "generated candidates must pin their development split",
        });
      }
      if (lineage.spend === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["spend"],
          message: "generated candidates must record proposal and evaluation spend",
        });
      }
    }
  }) satisfies z.ZodType<AgentCandidateLineage>;
