import { z } from "zod";
import type { AgentProfileCapabilities } from "./agent-profile.js";
import {
  boundedIdentifierSchema,
  CONTRACT_MAX_ARRAY_LENGTH,
} from "./contract-limits.js";

export const AgentProfileCapabilitiesSchema = z.strictObject({
  namedProfiles: z.boolean(),
  /*
   * Replacement and addition are independent provider capabilities. Require
   * both declarations so an omitted bit cannot be mistaken for support.
   */
  systemPrompt: z.strictObject({
    replace: z.boolean(),
    append: z.boolean(),
  }),
  instructions: z.boolean(),
  tools: z.boolean(),
  permissions: z.boolean(),
  mcp: z.boolean(),
  subagents: z.boolean(),
  resources: z.strictObject({
    files: z.boolean(),
    instructions: z.boolean(),
    tools: z.boolean().optional(),
    skills: z.boolean().optional(),
    agents: z.boolean().optional(),
    commands: z.boolean().optional(),
  }),
  hooks: z.boolean().optional(),
  modes: z.boolean().optional(),
  runtimeUpdate: z.boolean(),
  validation: z.boolean(),
  extensions: z
    .array(boundedIdentifierSchema)
    .max(CONTRACT_MAX_ARRAY_LENGTH)
    .optional(),
}) satisfies z.ZodType<AgentProfileCapabilities>;
