import { z } from "zod";
import type {
  AgentCandidateCode,
  AgentCandidateCodeDisabled,
  AgentCandidateCodeNoOp,
  AgentCandidateContainer,
  AgentCandidateContainerLaunch,
  AgentCandidateEntrypointLaunch,
  AgentCandidateExecution,
  AgentCandidateGitPatch,
  AgentCandidateWorkingDirectory,
} from "./agent-candidate.js";
import { agentCandidateEmbeddedArtifactSchema } from "./agent-candidate-artifact-schema.js";
import {
  agentCandidateConfigValueSchema,
  agentCandidateGitHubRepositorySchema,
  environmentConfigSchema,
  gitObjectSchema,
  isObviouslyPrivateHostname,
  isSafeExecutable,
  isSafeRelativePath,
  sameGitObjectFormat,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import { harnessTypeSchema } from "./harness.js";

function isSafeOciImage(value: string): boolean {
  if (
    !/^[A-Za-z0-9._:/-]+$/.test(value) ||
    /\s/.test(value) ||
    value.includes("@") ||
    value.includes("://")
  ) {
    return false;
  }
  const parts = value.split("/");
  if (parts.length < 2) return true;
  const first = parts[0] ?? "";
  const hasExplicitRegistry =
    first.includes(".") || first.includes(":") || first === "localhost";
  if (!hasExplicitRegistry) return true;
  const hostname = first.startsWith("[")
    ? first.slice(1, first.indexOf("]"))
    : first.split(":")[0] ?? "";
  return hostname.length > 0 && !isObviouslyPrivateHostname(hostname);
}

const executableSchema = z
  .string()
  .refine(
    isSafeExecutable,
    "executable must be a canonical non-shell command",
  );

export const agentCandidateCodeDisabledSchema = z
  .object({
    kind: z.literal("disabled"),
    reason: z.enum(["control", "not-applicable"]),
  })
  .strict() satisfies z.ZodType<AgentCandidateCodeDisabled>;

export const agentCandidateCodeNoOpSchema = z
  .object({
    kind: z.literal("no-op"),
    reason: z.literal("proposer-no-change"),
    repository: agentCandidateGitHubRepositorySchema,
    baseCommit: gitObjectSchema,
    baseTree: gitObjectSchema,
  })
  .strict()
  .superRefine((code, ctx) => {
    if (!sameGitObjectFormat(code.baseCommit, code.baseTree)) {
      ctx.addIssue({
        code: "custom",
        message: "Git object ids in one code record must use one object format",
      });
    }
  }) satisfies z.ZodType<AgentCandidateCodeNoOp>;

export const agentCandidateGitPatchSchema = z
  .object({
    kind: z.literal("git-patch"),
    repository: agentCandidateGitHubRepositorySchema,
    baseCommit: gitObjectSchema,
    baseTree: gitObjectSchema,
    candidateTree: gitObjectSchema,
    patch: z
      .object({
        format: z.literal("git-diff-binary"),
        artifact: agentCandidateEmbeddedArtifactSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((code, ctx) => {
    if (
      !sameGitObjectFormat(
        code.baseCommit,
        code.baseTree,
        code.candidateTree,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Git object ids in one code record must use one object format",
      });
    }
    if (code.baseTree === code.candidateTree) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateTree"],
        message: "git-patch must change the tree; use code.kind='no-op'",
      });
    }
    if (code.patch.artifact.byteLength === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["patch", "artifact", "byteLength"],
        message: "git-patch must contain bytes; use code.kind='no-op'",
      });
    }
  }) satisfies z.ZodType<AgentCandidateGitPatch>;

export const agentCandidateCodeSchema = z.discriminatedUnion("kind", [
  agentCandidateCodeDisabledSchema,
  agentCandidateCodeNoOpSchema,
  agentCandidateGitPatchSchema,
]) satisfies z.ZodType<AgentCandidateCode>;

export const agentCandidateContainerSchema = z
  .object({
    image: z
      .string()
      .min(1)
      .refine(
        isSafeOciImage,
        "image must be a non-private OCI reference without credentials or an embedded digest",
      ),
    indexDigest: sha256DigestSchema,
  })
  .strict() satisfies z.ZodType<AgentCandidateContainer>;

export const agentCandidateWorkingDirectorySchema = z
  .object({
    workspace: z.enum(["candidate", "task"]),
    path: z
      .string()
      .refine(
        (value) => isSafeRelativePath(value, true),
        "cwd path must be a canonical workspace-relative path",
      ),
  })
  .strict() satisfies z.ZodType<AgentCandidateWorkingDirectory>;

export const agentCandidateContainerLaunchSchema = z
  .object({
    kind: z.literal("container-command"),
    executable: executableSchema,
    args: z.array(agentCandidateConfigValueSchema).optional(),
  })
  .strict() satisfies z.ZodType<AgentCandidateContainerLaunch>;

export const agentCandidateEntrypointLaunchSchema = z
  .object({
    kind: z.literal("candidate-entrypoint"),
    entrypoint: z
      .string()
      .refine(
        (value) => isSafeRelativePath(value, false),
        "entrypoint must be a canonical candidate-relative path",
      ),
    interpreter: z
      .enum(["node", "python", "python3", "bun", "deno", "tsx", "uv"])
      .optional(),
    args: z.array(agentCandidateConfigValueSchema).optional(),
  })
  .strict() satisfies z.ZodType<AgentCandidateEntrypointLaunch>;

export const agentCandidateLaunchSchema = z.discriminatedUnion("kind", [
  agentCandidateContainerLaunchSchema,
  agentCandidateEntrypointLaunchSchema,
]);

export const agentCandidateExecutionSchema = z
  .object({
    harness: harnessTypeSchema,
    harnessVersion: z.string().min(1),
    launch: agentCandidateLaunchSchema,
    cwd: agentCandidateWorkingDirectorySchema,
    env: environmentConfigSchema.optional(),
    container: agentCandidateContainerSchema,
  })
  .strict() satisfies z.ZodType<AgentCandidateExecution>;
