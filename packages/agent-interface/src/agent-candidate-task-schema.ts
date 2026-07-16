import { z } from "zod";
import type {
  AgentCandidateBenchmarkSuite,
  AgentCandidateBenchmarkSuiteInputs,
  AgentCandidateBenchmarkSuiteMaterial,
  AgentCandidateBenchmarkTask,
  AgentCandidateBenchmarkTaskMaterial,
} from "./agent-candidate.js";
import {
  agentCandidateArtifactRefSchema,
  agentCandidateWorkspaceSnapshotEvidenceSchema,
} from "./agent-candidate-artifact-schema.js";
import {
  agentCandidateBenchmarkGraderIdentitySchema,
  agentCandidateBenchmarkCellRefSchema,
  agentCandidateExecutionLimitsSchema,
  agentCandidateResolvedModelSchema,
  agentCandidateResolvedTaskContainerSchema,
  agentCandidateRetryPolicySchema,
  agentCandidateTaskRepositorySchema,
  agentCandidateTaskOutcomeSpecSchema,
} from "./agent-candidate-execution-plan-schema.js";
import {
  isCanonicalJsonValue,
  isWellFormedUnicode,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";

export const agentCandidateBenchmarkTaskMaterialSchema = z
  .object({
    kind: z.literal("agent-candidate-benchmark-task"),
    digestAlgorithm: z.literal("rfc8785-sha256"),
    benchmark: z
      .object({
        name: z.string().min(1).max(512),
        version: z.string().min(1).max(256),
        splitDigest: sha256DigestSchema,
      })
      .strict(),
    scenario: z
      .object({
        id: z.string().min(1).max(512),
        kind: z.string().min(1).max(512),
        scenarioDigest: sha256DigestSchema,
      })
      .strict(),
    datasetSnapshot: agentCandidateArtifactRefSchema.optional(),
    instruction: z
      .string()
      .min(1)
      .max(4 * 1024 * 1024)
      .refine(isWellFormedUnicode, "task instruction must be well-formed Unicode"),
    repository: agentCandidateTaskRepositorySchema.optional(),
    outcome: agentCandidateTaskOutcomeSpecSchema,
    workspace: agentCandidateWorkspaceSnapshotEvidenceSchema,
    grader: agentCandidateBenchmarkGraderIdentitySchema,
    model: agentCandidateResolvedModelSchema,
    attempt: z
      .object({
        maxAttempts: z.number().int().min(1),
        retryPolicy: agentCandidateRetryPolicySchema,
      })
      .strict(),
    evaluatorTaskContainer: agentCandidateResolvedTaskContainerSchema.optional(),
    limits: agentCandidateExecutionLimitsSchema,
  })
  .strict()
  .superRefine((task, ctx) => {
    if (!isCanonicalJsonValue(task)) {
      ctx.addIssue({
        code: "custom",
        message: "candidate benchmark task must contain finite, acyclic canonical JSON",
      });
    }
    if (task.outcome.kind === "workspace" && task.repository === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["repository"],
        message: "workspace outcomes require an exact source repository",
      });
    }
    if (task.attempt.retryPolicy === "none" && task.attempt.maxAttempts !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["attempt", "maxAttempts"],
        message: "a no-retry task must allow exactly one attempt",
      });
    }
    if (task.datasetSnapshot?.byteLength === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["datasetSnapshot", "byteLength"],
        message: "dataset snapshot provenance must contain bytes",
      });
    }
  }) satisfies z.ZodType<AgentCandidateBenchmarkTaskMaterial>;

/** Structural parse only; Runtime recomputes the canonical digest before use. */
export const agentCandidateBenchmarkTaskSchema =
  agentCandidateBenchmarkTaskMaterialSchema
    .extend({ digest: sha256DigestSchema })
    .strict() satisfies z.ZodType<AgentCandidateBenchmarkTask>;

export const agentCandidateBenchmarkSuiteMaterialSchema = z
  .object({
    kind: z.literal("agent-candidate-benchmark-suite"),
    digestAlgorithm: z.literal("rfc8785-sha256"),
    taskDigests: z
      .tuple([sha256DigestSchema])
      .rest(sha256DigestSchema),
    reps: z.number().int().positive(),
    seeds: z
      .tuple([
        z
          .number()
          .int()
          .min(Number.MIN_SAFE_INTEGER)
          .max(Number.MAX_SAFE_INTEGER),
      ])
      .rest(
        z
          .number()
          .int()
          .min(Number.MIN_SAFE_INTEGER)
          .max(Number.MAX_SAFE_INTEGER),
      ),
  })
  .strict()
  .superRefine((suite, ctx) => {
    const taskDigests = new Set<string>();
    for (const [index, digest] of suite.taskDigests.entries()) {
      if (taskDigests.has(digest)) {
        ctx.addIssue({
          code: "custom",
          path: ["taskDigests", index],
          message: "benchmark suite task digests must be unique",
        });
      }
      taskDigests.add(digest);
    }
    const expectedSeeds = suite.taskDigests.length * suite.reps;
    if (suite.seeds.length !== expectedSeeds) {
      ctx.addIssue({
        code: "custom",
        path: ["seeds"],
        message: "benchmark suite must provide one seed per task repetition",
      });
    }
    if (!isCanonicalJsonValue(suite)) {
      ctx.addIssue({
        code: "custom",
        message: "benchmark suite must contain finite, acyclic canonical JSON",
      });
    }
  }) satisfies z.ZodType<AgentCandidateBenchmarkSuiteMaterial>;

export const agentCandidateBenchmarkSuiteSchema =
  agentCandidateBenchmarkSuiteMaterialSchema
    .extend({ digest: sha256DigestSchema })
    .strict() satisfies z.ZodType<AgentCandidateBenchmarkSuite>;

export const agentCandidateBenchmarkSuiteInputsSchema = z
  .object({
    suite: agentCandidateBenchmarkSuiteSchema,
    tasks: z
      .tuple([agentCandidateBenchmarkTaskSchema])
      .rest(agentCandidateBenchmarkTaskSchema),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.tasks.length !== input.suite.taskDigests.length) {
      ctx.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "benchmark suite inputs must contain every signed task exactly once",
      });
    }
    const taskIds = new Set<string>();
    const scenarioDigests = new Set<string>();
    const benchmark = input.tasks[0]?.benchmark;
    for (const [index, task] of input.tasks.entries()) {
      if (task.digest !== input.suite.taskDigests[index]) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index, "digest"],
          message: "benchmark task order must match the signed suite",
        });
      }
      if (taskIds.has(task.scenario.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index, "scenario", "id"],
          message: "benchmark suite task ids must be unique",
        });
      }
      taskIds.add(task.scenario.id);
      if (scenarioDigests.has(task.scenario.scenarioDigest)) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index, "scenario", "scenarioDigest"],
          message: "benchmark suite scenario digests must be unique",
        });
      }
      scenarioDigests.add(task.scenario.scenarioDigest);
      if (
        benchmark &&
        (task.benchmark.name !== benchmark.name ||
          task.benchmark.version !== benchmark.version ||
          task.benchmark.splitDigest !== benchmark.splitDigest)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index, "benchmark"],
          message: "benchmark suite tasks must share one benchmark identity",
        });
      }
    }
    if (!isCanonicalJsonValue(input)) {
      ctx.addIssue({
        code: "custom",
        message: "benchmark suite inputs must contain finite, acyclic canonical JSON",
      });
    }
  }) satisfies z.ZodType<AgentCandidateBenchmarkSuiteInputs>;

export { agentCandidateBenchmarkCellRefSchema };
