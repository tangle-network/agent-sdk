import { z } from "zod";
import type {
  AgentCandidateHookCommand,
  AgentCandidateMcpServer,
  AgentCandidateProfile,
} from "./agent-candidate.js";
import { agentCandidateResourcesSchema } from "./agent-candidate-artifact-schema.js";
import {
  agentCandidateConfigValueSchema,
  environmentConfigSchema,
  isCanonicalJsonValue,
  isSafeExecutable,
  isSafeRelativePath,
  isWellFormedUnicode,
} from "./agent-candidate-schema-common.js";
import { harnessTypeSchema } from "./harness.js";
import {
  agentProfileConfidentialSchema,
  agentProfileModeSchema,
  agentProfileModelHintsSchema,
  agentProfilePermissionSchema,
  agentProfilePromptSchema,
  agentSubagentProfileSchema,
} from "./profile-schema.js";

const executableSchema = z
  .string()
  .refine(isSafeExecutable, "executable must be a canonical non-shell command");

const agentCandidateLocalMcpServerSchema = z.strictObject({
  transport: z.literal("stdio").optional(),
  command: executableSchema,
  args: z.array(agentCandidateConfigValueSchema).optional(),
  env: environmentConfigSchema.optional(),
  cwd: z
    .string()
    .refine(
      (value) => isSafeRelativePath(value, true),
      "MCP cwd must be a canonical workspace-relative path",
    )
    .optional(),
  enabled: z.literal(true).optional(),
});

const agentCandidateDisabledMcpServerSchema = z.strictObject({
  enabled: z.literal(false),
  transport: z.undefined().optional(),
  command: z.undefined().optional(),
  args: z.undefined().optional(),
  env: z.undefined().optional(),
  cwd: z.undefined().optional(),
});

export const agentCandidateMcpServerSchema: z.ZodType<AgentCandidateMcpServer> =
  z.union([
    agentCandidateLocalMcpServerSchema,
    agentCandidateDisabledMcpServerSchema,
  ]);

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
  .omit({ metadata: true })
  .extend({
    default: z.string().min(1).optional(),
    small: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
  })
  .strict();
const candidateSubagentSchema = agentSubagentProfileSchema
  .omit({ metadata: true })
  .extend({
    model: z.string().min(1).optional(),
    maxSteps: z.number().int().positive().optional(),
  })
  .strict();
const candidateModeSchema = agentProfileModeSchema
  .omit({ metadata: true })
  .extend({ model: z.string().min(1).optional() })
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
    subagents: z.record(z.string(), candidateSubagentSchema).optional(),
    resources: agentCandidateResourcesSchema.optional(),
    hooks: z
      .record(z.string(), z.array(agentCandidateHookCommandSchema))
      .optional(),
    modes: z.record(z.string(), candidateModeSchema).optional(),
    confidential: agentProfileConfidentialSchema.strict().optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    if (!isCanonicalJsonValue(profile)) {
      ctx.addIssue({
        code: "custom",
        message: "candidate profile must contain only RFC 8785 JSON values",
      });
    }
    const primaryModel = profile.model?.default;
    const alternateRoutes = [
      ...(profile.model?.small === undefined
        ? []
        : [["model", "small", profile.model.small] as const]),
      ...Object.entries(profile.subagents ?? {}).flatMap(([name, subagent]) =>
        subagent.model === undefined
          ? []
          : [["subagents", name, "model", subagent.model] as const],
      ),
      ...Object.entries(profile.modes ?? {}).flatMap(([name, mode]) =>
        mode.model === undefined
          ? []
          : [["modes", name, "model", mode.model] as const],
      ),
    ];
    for (const route of alternateRoutes) {
      const routeModel = route.at(-1);
      if (primaryModel === undefined || routeModel !== primaryModel) {
        ctx.addIssue({
          code: "custom",
          path: route.slice(0, -1),
          message: "sealed candidates require every model route to use the exact primary model",
        });
      }
    }
  }) satisfies z.ZodType<AgentCandidateProfile>;
