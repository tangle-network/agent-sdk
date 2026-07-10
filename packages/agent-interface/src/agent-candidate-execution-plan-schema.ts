import { z } from "zod";
import type {
  AgentCandidateEffectiveMemory,
  AgentCandidateExecutionLimits,
  AgentCandidateExecutionPlanEvidence,
  AgentCandidateExecutionPlanMaterialV1,
  AgentCandidateProfilePlanEvidence,
  AgentCandidateProfilePlanMaterialV1,
  AgentCandidateResolvedModel,
} from "./agent-candidate.js";
import {
  agentCandidateCapturedArtifactSchema,
  agentCandidateWorkspaceSnapshotEvidenceSchema,
} from "./agent-candidate-artifact-schema.js";
import {
  agentCandidateContainerSchema,
  agentCandidateWorkingDirectorySchema,
} from "./agent-candidate-code-schema.js";
import {
  addDuplicateIssues,
  agentCandidateConfigValueSchema,
  environmentConfigSchema,
  gitObjectSchema,
  isCanonicalJsonValue,
  isSafeExecutable,
  isSafeRelativePath,
  sameGitObjectFormat,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import { harnessTypeSchema } from "./harness.js";

const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
]);

function isCanonicalAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/") &&
    value !== "/" &&
    !value.includes("//") &&
    isSafeRelativePath(value.slice(1), false)
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export const agentCandidateResolvedModelSchema = z
  .object({
    requested: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    snapshot: z.string().min(1),
    reasoningEffort: reasoningEffortSchema,
  })
  .strict() satisfies z.ZodType<AgentCandidateResolvedModel>;

export const agentCandidateProfilePlanMaterialSchema = z
  .object({
    version: z.literal(1),
    harness: harnessTypeSchema,
    files: z.array(
      z
        .object({
          relPath: z
            .string()
            .refine(
              (value) => isSafeRelativePath(value, false),
              "profile-plan file must use a canonical relative path",
            ),
          mode: z.number().int().min(0).max(0o777),
          contentSha256: sha256DigestSchema,
        })
        .strict(),
    ),
    env: environmentConfigSchema,
    flags: z.array(agentCandidateConfigValueSchema),
    unsupported: z
      .array(
        z
          .object({
            dimension: z.string().min(1),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .length(
        0,
        "sealed candidate materialization cannot omit profile behavior",
      ),
  })
  .strict()
  .superRefine((material, ctx) => {
    addDuplicateIssues(
      material.files.map((file) => file.relPath),
      ["files"],
      ctx,
    );
    for (let index = 1; index < material.files.length; index++) {
      if (
        (material.files[index - 1]?.relPath ?? "") >=
        (material.files[index]?.relPath ?? "")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["files", index, "relPath"],
          message: "profile-plan files must be lexicographically sorted",
        });
      }
    }
    if (!isCanonicalJsonValue(material)) {
      ctx.addIssue({
        code: "custom",
        message: "profile-plan material must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentCandidateProfilePlanMaterialV1>;

export const agentCandidateEffectiveMemorySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("disabled") }).strict(),
  z
    .object({
      mode: z.literal("isolated"),
      scope: z.literal("task"),
      effectiveNamespace: z.string().min(1),
      reset: z
        .object({
          kind: z.literal("fresh"),
          evidence: agentCandidateCapturedArtifactSchema,
          emptyStateDigest: sha256DigestSchema,
        })
        .strict(),
      beforeState: agentCandidateWorkspaceSnapshotEvidenceSchema,
      seedDigest: sha256DigestSchema.optional(),
    })
    .strict()
    .superRefine((memory, ctx) => {
      if (memory.reset.evidence.byteLength === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["reset", "evidence", "byteLength"],
          message: "task-scoped memory requires non-empty fresh-reset evidence",
        });
      }
    }),
]) satisfies z.ZodType<AgentCandidateEffectiveMemory>;

export const agentCandidateExecutionLimitsSchema = z
  .object({
    timeoutMs: z.number().int().positive(),
    maxSteps: z.number().int().positive(),
    maxModelCalls: z.number().int().nonnegative(),
    maxInputTokens: z.number().int().nonnegative(),
    maxOutputTokens: z.number().int().nonnegative(),
    maxCostUsd: z.number().finite().nonnegative(),
  })
  .strict() satisfies z.ZodType<AgentCandidateExecutionLimits>;

export const agentCandidateExecutionPlanMaterialSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("agent-candidate-execution-plan-material"),
    bundleDigest: sha256DigestSchema,
    executionId: z.string().min(1),
    attempt: z
      .object({
        number: z.number().int().min(1),
        maxAttempts: z.number().int().min(1),
        retryPolicy: z.enum(["pre-model-infrastructure-only", "none"]),
      })
      .strict(),
    task: z
      .object({
        benchmark: z.string().min(1),
        benchmarkVersion: z.string().min(1),
        taskId: z.string().min(1),
        splitDigest: sha256DigestSchema,
        instruction: z
          .object({
            encoding: z.literal("utf8"),
            sha256: sha256DigestSchema,
            byteLength: z.number().int().positive(),
          })
          .strict(),
        repository: z
          .object({
            identity: z.string().min(1),
            rootIdentity: z.string().min(1),
            baseCommit: gitObjectSchema,
            baseTree: gitObjectSchema,
          })
          .strict(),
        workspace: agentCandidateWorkspaceSnapshotEvidenceSchema,
      })
      .strict(),
    workspaces: z
      .object({
        taskRoot: z
          .string()
          .refine(isCanonicalAbsolutePath, "task root must be a canonical absolute path"),
        candidateRoot: z
          .string()
          .refine(
            isCanonicalAbsolutePath,
            "candidate root must be a canonical absolute path",
          )
          .optional(),
      })
      .strict(),
    codeKind: z.enum(["disabled", "no-op", "git-patch"]),
    candidateWorkspace: agentCandidateWorkspaceSnapshotEvidenceSchema.optional(),
    profile: z
      .object({
        planDigest: sha256DigestSchema,
        targetWorkspace: z.enum(["task", "candidate"]),
        mountPaths: z.array(
          z
            .string()
            .refine(
              (value) => isSafeRelativePath(value, false),
              "profile mount paths must be canonical and relative",
            ),
        ),
      })
      .strict(),
    harness: harnessTypeSchema,
    harnessVersion: z.string().min(1),
    container: agentCandidateContainerSchema
      .extend({
        source: z.enum(["pinned-container", "evaluator-task-container"]),
        manifestDigest: sha256DigestSchema,
        platform: z
          .object({
            os: z.string().min(1),
            architecture: z.string().min(1),
            variant: z.string().min(1).optional(),
          })
          .strict(),
      })
      .strict(),
    model: z
      .object({
        policy: z.literal("single"),
        resolved: agentCandidateResolvedModelSchema,
        access: z
          .object({
            kind: z.literal("evaluator-mediated"),
            grantDigest: sha256DigestSchema,
          })
          .strict(),
        routes: z
          .array(
            z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("primary"),
                  requested: z.string().min(1).optional(),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("small"),
                  requested: z.string().min(1),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("mode"),
                  name: z.string().min(1),
                  requested: z.string().min(1),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("subagent"),
                  name: z.string().min(1),
                  requested: z.string().min(1),
                })
                .strict(),
            ]),
          )
          .min(1),
      })
      .strict(),
    launch: z
      .object({
        executable: z
          .string()
          .refine(isSafeExecutable, "execution plan requires a non-shell executable"),
        args: z.array(agentCandidateConfigValueSchema),
        env: environmentConfigSchema,
        cwd: agentCandidateWorkingDirectorySchema,
      })
      .strict(),
    knowledgeManifestDigest: sha256DigestSchema.optional(),
    memory: agentCandidateEffectiveMemorySchema,
    limits: agentCandidateExecutionLimitsSchema,
    network: z.object({ mode: z.literal("disabled") }).strict(),
  })
  .strict()
  .superRefine((material, ctx) => {
    if (
      !sameGitObjectFormat(
        material.task.repository.baseCommit,
        material.task.repository.baseTree,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["task", "repository"],
        message: "task Git object ids must use one object format",
      });
    }
    if (material.attempt.number > material.attempt.maxAttempts) {
      ctx.addIssue({
        code: "custom",
        path: ["attempt", "number"],
        message: "attempt number cannot exceed the frozen maximum",
      });
    }
    if (
      material.attempt.retryPolicy === "none" &&
      material.attempt.maxAttempts !== 1
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["attempt", "maxAttempts"],
        message: "a no-retry plan must allow exactly one attempt",
      });
    }
    const routeIds = material.model.routes.map((route) =>
      route.kind === "mode" || route.kind === "subagent"
        ? `${route.kind}:${route.name}`
        : route.kind,
    );
    addDuplicateIssues(routeIds, ["model", "routes"], ctx);
    addDuplicateIssues(
      material.profile.mountPaths,
      ["profile", "mountPaths"],
      ctx,
    );
    for (let index = 1; index < material.profile.mountPaths.length; index++) {
      if (
        (material.profile.mountPaths[index - 1] ?? "") >=
        (material.profile.mountPaths[index] ?? "")
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["profile", "mountPaths", index],
          message: "profile mount paths must be lexicographically sorted",
        });
      }
    }
    if (!material.model.routes.some((route) => route.kind === "primary")) {
      ctx.addIssue({
        code: "custom",
        path: ["model", "routes"],
        message: "single-model plans must include the primary route",
      });
    }
    for (const [index, route] of material.model.routes.entries()) {
      if (
        route.requested !== undefined &&
        route.requested !== material.model.resolved.requested
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["model", "routes", index, "requested"],
          message: "every route must request the one resolved model literal",
        });
      }
    }
    const activeCode = material.codeKind !== "disabled";
    if (activeCode !== (material.candidateWorkspace !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateWorkspace"],
        message: "active code requires a complete candidate-workspace snapshot",
      });
    }
    if (activeCode !== (material.workspaces.candidateRoot !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["workspaces", "candidateRoot"],
        message: "active code requires a fixed candidate workspace root",
      });
    }
    if (
      material.workspaces.candidateRoot !== undefined &&
      pathsOverlap(material.workspaces.taskRoot, material.workspaces.candidateRoot)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["workspaces"],
        message: "task and candidate workspace roots must be disjoint",
      });
    }
    if (
      material.launch.cwd.workspace === "candidate" &&
      material.workspaces.candidateRoot === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["launch", "cwd", "workspace"],
        message: "candidate cwd requires a pinned candidate workspace root",
      });
    }
    if (
      material.profile.targetWorkspace === "candidate" &&
      material.workspaces.candidateRoot === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["profile", "targetWorkspace"],
        message:
          "candidate-targeted profile files require a candidate workspace root",
      });
    }
    if (activeCode && material.candidateWorkspace?.material.files.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["candidateWorkspace", "material", "files"],
        message: "active candidate workspaces cannot be empty",
      });
    }
    if (material.task.workspace.material.files.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["task", "workspace", "material", "files"],
        message: "task workspace snapshots cannot be empty",
      });
    }
    if (!isCanonicalJsonValue(material)) {
      ctx.addIssue({
        code: "custom",
        message: "execution-plan material must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentCandidateExecutionPlanMaterialV1>;

function planEvidenceSchema<
  TKind extends string,
  TMaterial,
>(kind: TKind, material: z.ZodType<TMaterial>) {
  return z
    .object({
      schemaVersion: z.literal(1),
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
          message: "plan artifact hash must equal its canonical material digest",
        });
      }
      if (evidence.artifact.byteLength === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["artifact", "byteLength"],
          message: "plan artifact must contain canonical material bytes",
        });
      }
    });
}

export const agentCandidateProfilePlanEvidenceSchema = planEvidenceSchema(
  "agent-profile-workspace-plan",
  agentCandidateProfilePlanMaterialSchema,
) satisfies z.ZodType<AgentCandidateProfilePlanEvidence>;

export const agentCandidateExecutionPlanEvidenceSchema = planEvidenceSchema(
  "agent-candidate-execution-plan",
  agentCandidateExecutionPlanMaterialSchema,
) satisfies z.ZodType<AgentCandidateExecutionPlanEvidence>;
