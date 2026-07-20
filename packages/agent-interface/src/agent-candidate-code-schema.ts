import { z } from "zod";
import type {
  AgentCandidateCode,
  AgentCandidateCodeDisabled,
  AgentCandidateCodeNoOp,
  AgentCandidateContainer,
  AgentCandidateContainerLaunch,
  AgentCandidateEntrypointLaunch,
  AgentCandidateEvaluatorTaskEnvironment,
  AgentCandidateExecution,
  AgentCandidateExecutionEnvironment,
  AgentCandidateGitPatch,
  AgentCandidateInstructionDelivery,
  AgentCandidatePinnedContainerEnvironment,
  AgentCandidateWorkingDirectory,
} from "./agent-candidate.js";
import {
  agentCandidateEmbeddedArtifactSchema,
  agentCandidateWorkspaceSnapshotEvidenceSchema,
} from "./agent-candidate-artifact-schema.js";
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

export const agentCandidatePinnedContainerEnvironmentSchema = z
  .object({
    kind: z.literal("pinned-container"),
    container: agentCandidateContainerSchema,
  })
  .strict() satisfies z.ZodType<AgentCandidatePinnedContainerEnvironment>;

export const agentCandidateEvaluatorTaskEnvironmentSchema = z
  .object({
    kind: z.literal("evaluator-task-container"),
  })
  .strict() satisfies z.ZodType<AgentCandidateEvaluatorTaskEnvironment>;

export const agentCandidateExecutionEnvironmentSchema = z.discriminatedUnion(
  "kind",
  [
    agentCandidatePinnedContainerEnvironmentSchema,
    agentCandidateEvaluatorTaskEnvironmentSchema,
  ],
) satisfies z.ZodType<AgentCandidateExecutionEnvironment>;

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

export const agentCandidateInstructionDeliverySchema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("argv-append") }).strict(),
    z.object({ kind: z.literal("stdin-utf8") }).strict(),
    z
      .object({
        kind: z.literal("utf8-file"),
        env: z.literal("TANGLE_CANDIDATE_TASK_PATH"),
        path: z.literal("/tangle/input/task.txt"),
      })
      .strict(),
  ],
) satisfies z.ZodType<AgentCandidateInstructionDelivery>;

export const agentCandidateExecutionSchema = z
  .object({
    harness: harnessTypeSchema,
    harnessVersion: z.string().min(1),
    launch: agentCandidateLaunchSchema,
    instructionDelivery: agentCandidateInstructionDeliverySchema,
    cwd: agentCandidateWorkingDirectorySchema,
    env: environmentConfigSchema.optional(),
    environment: agentCandidateExecutionEnvironmentSchema,
    workspace: agentCandidateWorkspaceSnapshotEvidenceSchema.optional(),
    isolation: z
      .object({
        network: z.literal("disabled"),
        remoteIntegrations: z.literal("disabled"),
        candidateSecrets: z.literal("disabled"),
      })
      .strict(),
  })
  .strict()
  .superRefine((execution, ctx) => {
    const requiresPath =
      execution.launch.kind === "container-command"
        ? !execution.launch.executable.startsWith("/")
        : execution.launch.interpreter !== undefined;
    if (requiresPath && !execution.env?.PATH?.value.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["env", "PATH"],
        message: "relative candidate executables require an explicit public PATH",
      });
    }
    if (execution.env?.TANGLE_CANDIDATE_TASK_PATH !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["env", "TANGLE_CANDIDATE_TASK_PATH"],
        message: "the evaluator exclusively owns task-instruction delivery",
      });
    }
  }) satisfies z.ZodType<AgentCandidateExecution>;
