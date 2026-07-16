import { z } from "zod";
import type {
  AgentCandidateBenchmarkCellRef,
  AgentCandidateBenchmarkGraderIdentity,
  AgentCandidateEffectiveMemory,
  AgentCandidateExecutionLimits,
  AgentCandidateExecutionPlanEvidence,
  AgentCandidateExecutionPlanMaterial,
  AgentCandidateInstructionDelivery,
  AgentCandidateModelAccessNetwork,
  AgentCandidateProfileActivation,
  AgentCandidateProfilePlanEvidence,
  AgentCandidateProfilePlanMaterial,
  AgentCandidateResolvedModel,
  AgentCandidateResolvedTaskContainer,
  AgentCandidateRunCell,
  AgentCandidateRunCellMaterial,
  AgentCandidateTaskRepository,
  AgentCandidateTaskOutcomeSpec,
} from "./agent-candidate.js";
import {
  agentCandidateArtifactRefSchema,
  agentCandidateCapturedArtifactSchema,
  agentCandidateWorkspaceSnapshotEvidenceSchema,
} from "./agent-candidate-artifact-schema.js";
import {
  agentCandidateContainerSchema,
  agentCandidateInstructionDeliverySchema,
  agentCandidateWorkingDirectorySchema,
} from "./agent-candidate-code-schema.js";
import { reasoningEffortSchema } from "./profile-schema.js";
import {
  addDuplicateIssues,
  agentCandidateConfigValueSchema,
  agentCandidateMediaTypeSchema,
  environmentConfigSchema,
  gitObjectSchema,
  isCanonicalJsonValue,
  isObviouslyPrivateHostname,
  isSafeExecutable,
  isSafeRelativePath,
  isWellFormedUnicode,
  sameGitObjectFormat,
  sha256Utf8,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import { harnessTypeSchema } from "./harness.js";

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

function isExactPublicGatewayDomain(value: string): boolean {
  if (
    value.length > 253 ||
    value !== value.toLowerCase() ||
    value.endsWith(".") ||
    value.includes(":") ||
    isObviouslyPrivateHostname(value)
  ) {
    return false;
  }
  const labels = value.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    ) &&
    /[a-z]/.test(labels.at(-1) ?? "")
  );
}

export const agentCandidateModelAccessNetworkSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("disabled") }).strict(),
  z
    .object({
      mode: z.literal("gateway-only"),
      domains: z
        .array(
          z
            .string()
            .refine(
              isExactPublicGatewayDomain,
              "model gateway must be an exact lowercase public DNS name",
            ),
        )
        .min(1),
    })
    .strict(),
]) satisfies z.ZodType<AgentCandidateModelAccessNetwork>;

export const agentCandidateResolvedModelSchema = z
  .object({
    requested: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    snapshot: z.string().min(1),
    reasoningEffort: reasoningEffortSchema,
  })
  .strict() satisfies z.ZodType<AgentCandidateResolvedModel>;

export const agentCandidateBenchmarkGraderIdentitySchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    format: z.literal("tangle-grader"),
    artifact: agentCandidateArtifactRefSchema,
  })
  .strict()
  .superRefine((grader, ctx) => {
    if (grader.artifact.byteLength === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["artifact", "byteLength"],
        message: "pinned grader artifact must contain executable grader bytes",
      });
    }
  }) satisfies z.ZodType<AgentCandidateBenchmarkGraderIdentity>;

export const agentCandidateTaskRepositorySchema = z
  .object({
    identity: z.string().min(1).max(512),
    rootIdentity: z.string().min(1).max(512),
    baseCommit: gitObjectSchema,
    baseTree: gitObjectSchema,
  })
  .strict()
  .superRefine((repository, ctx) => {
    if (!sameGitObjectFormat(repository.baseCommit, repository.baseTree)) {
      ctx.addIssue({
        code: "custom",
        message: "task Git object ids must use one object format",
      });
    }
  }) satisfies z.ZodType<AgentCandidateTaskRepository>;

export const agentCandidateResolvedTaskContainerSchema =
  agentCandidateContainerSchema
    .extend({
      source: z.literal("evaluator-task-container"),
      manifestDigest: sha256DigestSchema,
      platform: z
        .object({
          os: z.string().min(1).max(100),
          architecture: z.string().min(1).max(100),
          variant: z.string().min(1).max(100).optional(),
        })
        .strict(),
    })
    .strict() satisfies z.ZodType<AgentCandidateResolvedTaskContainer>;

export const agentCandidateRetryPolicySchema = z.enum([
  "pre-model-infrastructure-only",
  "none",
]);

export const agentCandidateProfilePlanMaterialSchema = z
  .object({
    sourceProfileDigest: sha256DigestSchema,
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
  }) satisfies z.ZodType<AgentCandidateProfilePlanMaterial>;

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

export const agentCandidateTaskOutcomeSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace") }).strict(),
  z
    .object({
      kind: z.literal("output"),
      mediaType: agentCandidateMediaTypeSchema,
      maxBytes: z.number().int().positive().max(64 * 1024 * 1024),
    })
    .strict(),
]) satisfies z.ZodType<AgentCandidateTaskOutcomeSpec>;

export const agentCandidateBenchmarkCellRefSchema = z
  .object({
    suiteDigest: sha256DigestSchema,
    taskIndex: z.number().int().nonnegative(),
    repetition: z.number().int().nonnegative(),
  })
  .strict() satisfies z.ZodType<AgentCandidateBenchmarkCellRef>;

export const agentCandidateRunCellMaterialSchema = z
  .object({
    kind: z.literal("agent-candidate-run-cell"),
    experimentDigest: sha256DigestSchema,
    arm: z.enum(["baseline", "candidate"]),
    bundleDigest: sha256DigestSchema,
    suiteDigest: sha256DigestSchema,
    taskDigest: sha256DigestSchema,
    taskIndex: z.number().int().nonnegative(),
    repetition: z.number().int().nonnegative(),
    seed: z.number().int().safe(),
    attempt: z.number().int().positive(),
  })
  .strict() satisfies z.ZodType<AgentCandidateRunCellMaterial>;

export const agentCandidateRunCellSchema = agentCandidateRunCellMaterialSchema
  .extend({ digest: sha256DigestSchema })
  .strict() satisfies z.ZodType<AgentCandidateRunCell>;

export const agentCandidateExecutionPlanMaterialSchema = z
  .object({
    kind: z.literal("agent-candidate-execution-plan-material"),
    runCell: agentCandidateRunCellSchema,
    executionId: z.string().min(1),
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
    instructionDelivery:
      agentCandidateInstructionDeliverySchema satisfies z.ZodType<AgentCandidateInstructionDelivery>,
    limits: agentCandidateExecutionLimitsSchema,
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
            network: agentCandidateModelAccessNetworkSchema,
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
    network: z.object({ mode: z.literal("disabled") }).strict(),
  })
  .strict()
  .superRefine((material, ctx) => {
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
    const modelNetwork = material.model.access.network;
    if (modelNetwork.mode === "gateway-only") {
      addDuplicateIssues(
        modelNetwork.domains,
        ["model", "access", "network", "domains"],
        ctx,
      );
      for (let index = 1; index < modelNetwork.domains.length; index++) {
        if ((modelNetwork.domains[index - 1] ?? "") >= (modelNetwork.domains[index] ?? "")) {
          ctx.addIssue({
            code: "custom",
            path: ["model", "access", "network", "domains", index],
            message: "model gateway domains must be lexicographically sorted",
          });
        }
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
    const taskPath = material.launch.env.TANGLE_CANDIDATE_TASK_PATH;
    if (taskPath !== undefined) {
      if (taskPath.value !== "/tangle/input/task.txt") {
        ctx.addIssue({
          code: "custom",
          path: ["launch", "env", "TANGLE_CANDIDATE_TASK_PATH"],
          message: "task file delivery must use the fixed evaluator-owned path",
        });
      }
      if (
        pathsOverlap(taskPath.value, material.workspaces.taskRoot) ||
        (material.workspaces.candidateRoot !== undefined &&
          pathsOverlap(taskPath.value, material.workspaces.candidateRoot))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["launch", "env", "TANGLE_CANDIDATE_TASK_PATH"],
          message: "task file delivery must be outside both workspaces",
        });
      }
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
    if (!isCanonicalJsonValue(material)) {
      ctx.addIssue({
        code: "custom",
        message: "execution-plan material must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentCandidateExecutionPlanMaterial>;

function planEvidenceSchema<TKind extends string, TMaterial>(
  kind: TKind,
  material: z.ZodType<TMaterial>,
) {
  return z
    .object({
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

export const agentCandidateProfileActivationSchema = z
  .object({
    kind: z.literal("agent-candidate-profile-activation"),
    profilePlan: agentCandidateProfilePlanEvidenceSchema,
    files: z.array(
      z
        .object({
          path: z
            .string()
            .refine(
              (value) => isSafeRelativePath(value, false),
              "profile activation file must use a canonical relative path",
            ),
          mode: z.number().int().min(0).max(0o777),
          content: z
            .string()
            .refine(isWellFormedUnicode, "profile activation content must be valid Unicode"),
        })
        .strict(),
    ),
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((activation, ctx) => {
    const planned = activation.profilePlan.material.files;
    if (activation.files.length !== planned.length) {
      ctx.addIssue({
        code: "custom",
        path: ["files"],
        message: "profile activation must contain every planned native file",
      });
    }
    for (let index = 0; index < planned.length; index++) {
      const expected = planned[index];
      const actual = activation.files[index];
      if (
        expected === undefined ||
        actual === undefined ||
        actual.path !== expected.relPath ||
        actual.mode !== expected.mode ||
        sha256Utf8(actual.content) !== expected.contentSha256
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["files", index],
          message: "profile activation file path, mode, and content must match the canonical plan",
        });
      }
    }
    if (!isCanonicalJsonValue(activation)) {
      ctx.addIssue({
        code: "custom",
        message: "profile activation must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentCandidateProfileActivation>;

export const agentCandidateExecutionPlanEvidenceSchema = planEvidenceSchema(
  "agent-candidate-execution-plan",
  agentCandidateExecutionPlanMaterialSchema,
) satisfies z.ZodType<AgentCandidateExecutionPlanEvidence>;
