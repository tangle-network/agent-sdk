import { z } from "zod";
import {
  MAX_PROFILE_KNOWLEDGE_SOURCES,
  type AgentProfileKnowledgeRef,
} from "./agent-profile.js";

/** Immutable Hub generation identities, never aliases such as latest or a caller's scope. */
export const agentProfileKnowledgeRefSchema = z.strictObject({
  sourceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  generation: z.string().regex(/^kg_[a-f0-9]{64}$/),
}) satisfies z.ZodType<AgentProfileKnowledgeRef>;

export const agentProfileKnowledgeRefsSchema = z
  .array(agentProfileKnowledgeRefSchema)
  .max(MAX_PROFILE_KNOWLEDGE_SOURCES)
  .superRefine((refs, context) => {
    const seen = new Set<string>();
    refs.forEach((ref, index) => {
      if (seen.has(ref.sourceId))
        context.addIssue({
          code: "custom",
          path: [index, "sourceId"],
          message:
            "A profile must pin exactly one generation per knowledge source",
        });
      seen.add(ref.sourceId);
    });
  });
