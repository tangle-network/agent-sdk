import { z } from "zod";
import type { AgentProfileMcpServer } from "./agent-profile.js";
import { agentProfileSchema } from "./profile-schema.js";
import { boundedIdentifierSchema, boundedJsonSchema } from "./contract-limits.js";

/** Runtime-owned bindings do not alter the authored AgentProfile or candidate identity. */
export interface AgentRuntimeAttachments {
  mcp: Record<string, AgentProfileMcpServer>;
}

export const AgentRuntimeAttachmentsSchema: z.ZodType<AgentRuntimeAttachments> =
  boundedJsonSchema.pipe(z.strictObject({
    mcp: agentProfileSchema.shape.mcp.unwrap().superRefine((servers, context) => {
      for (const alias of Object.keys(servers)) {
        const result = boundedIdentifierSchema.safeParse(alias);
        if (!result.success) {
          for (const issue of result.error.issues) {
            context.addIssue({ ...issue, path: [alias, ...issue.path] });
          }
        }
      }
    }),
  }));
