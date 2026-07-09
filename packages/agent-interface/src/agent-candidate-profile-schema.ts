import { z } from "zod";
import type {
  AgentCandidateHookCommand,
  AgentCandidateHttpsEndpoint,
  AgentCandidateMcpServer,
  AgentCandidateProfile,
} from "./agent-candidate.js";
import { agentCandidateResourcesSchema } from "./agent-candidate-artifact-schema.js";
import {
  agentCandidateConfigValueSchema,
  candidateMetadataSchema,
  environmentConfigSchema,
  headerConfigSchema,
  isCanonicalJsonValue,
  isObviouslyPrivateHostname,
  isSafeExecutable,
  isSafeRelativePath,
  isWellFormedUnicode,
  looksLikeCredential,
} from "./agent-candidate-schema-common.js";
import { harnessTypeSchema } from "./harness.js";
import {
  agentProfileConfidentialSchema,
  agentProfileConnectionSchema,
  agentProfileModeSchema,
  agentProfileModelHintsSchema,
  agentProfilePermissionSchema,
  agentProfilePromptSchema,
  agentSubagentProfileSchema,
} from "./profile-schema.js";

function isSafeHttpsEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      !isObviouslyPrivateHostname(hostname) &&
      !looksLikeCredential(value)
    );
  } catch {
    return false;
  }
}

const executableSchema = z
  .string()
  .refine(isSafeExecutable, "executable must be a canonical non-shell command");

export const agentCandidateHttpsEndpointSchema = z
  .object({
    kind: z.literal("https"),
    url: z
      .string()
      .refine(
        isSafeHttpsEndpoint,
        "HTTPS endpoint must be credential-free and not target an obvious private address",
      ),
  })
  .strict() satisfies z.ZodType<AgentCandidateHttpsEndpoint>;

export const agentCandidateMcpServerSchema = z
  .object({
    transport: z.enum(["stdio", "sse", "http"]).optional(),
    command: executableSchema.optional(),
    args: z.array(agentCandidateConfigValueSchema).optional(),
    env: environmentConfigSchema.optional(),
    cwd: z
      .string()
      .refine(
        (value) => isSafeRelativePath(value, true),
        "MCP cwd must be a canonical workspace-relative path",
      )
      .optional(),
    url: agentCandidateHttpsEndpointSchema.optional(),
    headers: headerConfigSchema.optional(),
    enabled: z.boolean().optional(),
    metadata: candidateMetadataSchema.optional(),
  })
  .strict() satisfies z.ZodType<AgentCandidateMcpServer>;

export const agentCandidateHookCommandSchema = z
  .object({
    executable: executableSchema,
    args: z.array(agentCandidateConfigValueSchema).optional(),
    timeoutMs: z.number().positive().optional(),
    blocking: z.boolean().optional(),
    matcher: z.string().refine(isWellFormedUnicode).optional(),
    env: environmentConfigSchema.optional(),
  })
  .strict() satisfies z.ZodType<AgentCandidateHookCommand>;

const candidateModelHintsSchema = agentProfileModelHintsSchema
  .extend({ metadata: candidateMetadataSchema.optional() })
  .strict();
const candidateSubagentSchema = agentSubagentProfileSchema
  .extend({ metadata: candidateMetadataSchema.optional() })
  .strict();
const candidateModeSchema = agentProfileModeSchema
  .extend({ metadata: candidateMetadataSchema.optional() })
  .strict();

export const agentCandidateProfileSchema = z
  .object({
    name: z.string().refine(isWellFormedUnicode).optional(),
    description: z.string().refine(isWellFormedUnicode).optional(),
    version: z.string().refine(isWellFormedUnicode).optional(),
    tags: z.array(z.string().refine(isWellFormedUnicode)).optional(),
    prompt: agentProfilePromptSchema.strict().optional(),
    model: candidateModelHintsSchema.optional(),
    harness: harnessTypeSchema.optional(),
    permissions: z
      .record(z.string(), agentProfilePermissionSchema)
      .optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    mcp: z.record(z.string(), agentCandidateMcpServerSchema).optional(),
    connections: z.array(agentProfileConnectionSchema.strict()).optional(),
    subagents: z.record(z.string(), candidateSubagentSchema).optional(),
    resources: agentCandidateResourcesSchema.optional(),
    hooks: z
      .record(z.string(), z.array(agentCandidateHookCommandSchema))
      .optional(),
    modes: z.record(z.string(), candidateModeSchema).optional(),
    confidential: agentProfileConfidentialSchema.strict().optional(),
    metadata: candidateMetadataSchema.optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (!isCanonicalJsonValue(profile)) {
      ctx.addIssue({
        code: "custom",
        message: "candidate profile must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentCandidateProfile>;
