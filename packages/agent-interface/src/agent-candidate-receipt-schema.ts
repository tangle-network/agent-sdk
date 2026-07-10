import { z } from "zod";
import type {
  AgentCandidateMaterializationReceipt,
  AgentCandidateMemoryReceipt,
  AgentCandidateModelUsage,
  AgentCandidateRunReceipt,
  AgentCandidateTermination,
  AgentCandidateTraceEvidence,
} from "./agent-candidate.js";
import {
  agentCandidateCapturedArtifactSchema,
  agentCandidateWorkspaceSnapshotEvidenceSchema,
} from "./agent-candidate-artifact-schema.js";
import {
  agentCandidateExecutionPlanEvidenceSchema,
  agentCandidateProfilePlanEvidenceSchema,
  agentCandidateResolvedModelSchema,
} from "./agent-candidate-execution-plan-schema.js";
import {
  agentCandidateSpendSchema,
} from "./agent-candidate-lineage-schema.js";
import {
  gitObjectSchema,
  isCanonicalJsonValue,
  isSafeRelativePath,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import { harnessTypeSchema } from "./harness.js";

const entrypointReceiptSchema = z
  .object({
    path: z
      .string()
      .refine(
        (value) => isSafeRelativePath(value, false),
        "entrypoint path must be a canonical candidate-relative path",
      ),
    sha256: sha256DigestSchema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict();

const ociPlatformSchema = z
  .object({
    os: z.string().min(1),
    architecture: z.string().min(1),
    variant: z.string().min(1).optional(),
  })
  .strict();

export const agentCandidateTraceEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifact: agentCandidateCapturedArtifactSchema,
    eventCount: z.number().int().positive(),
    modelCallCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((trace, ctx) => {
    if (trace.artifact.byteLength === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["artifact", "byteLength"],
        message: "trace artifact must contain captured events",
      });
    }
    if (trace.eventCount < trace.modelCallCount) {
      ctx.addIssue({
        code: "custom",
        path: ["eventCount"],
        message: "trace must contain at least one event for every model call",
      });
    }
  }) satisfies z.ZodType<AgentCandidateTraceEvidence>;

export const agentCandidateModelUsageSchema = z
  .object({
    resolved: agentCandidateResolvedModelSchema,
    usage: agentCandidateSpendSchema,
  })
  .strict() satisfies z.ZodType<AgentCandidateModelUsage>;

export const agentCandidateMemoryReceiptSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("disabled") }).strict(),
  z
    .object({
      mode: z.literal("isolated"),
      scope: z.literal("task"),
      effectiveNamespace: z.string().min(1),
      resetEvidenceDigest: sha256DigestSchema,
      beforeStateDigest: sha256DigestSchema,
      afterState: agentCandidateWorkspaceSnapshotEvidenceSchema,
    })
    .strict(),
]) satisfies z.ZodType<AgentCandidateMemoryReceipt>;

export const agentCandidateTerminationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exit"), exitCode: z.number().int() }).strict(),
  z
    .object({
      kind: z.literal("timeout"),
      timeoutMs: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("signal"),
      signal: z.string().regex(/^SIG[A-Z0-9]+$/),
    })
    .strict(),
  z.object({ kind: z.literal("cancelled") }).strict(),
]) satisfies z.ZodType<AgentCandidateTermination>;

export const agentCandidateMaterializationReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("agent-candidate-materialization"),
    digestAlgorithm: z.literal("rfc8785-sha256"),
    bundleDigest: sha256DigestSchema,
    profilePlan: agentCandidateProfilePlanEvidenceSchema,
    executionPlan: agentCandidateExecutionPlanEvidenceSchema,
    candidateWorkspace: agentCandidateWorkspaceSnapshotEvidenceSchema.optional(),
    codeKind: z.enum(["disabled", "no-op", "git-patch"]),
    materializedTree: gitObjectSchema.optional(),
    harness: harnessTypeSchema,
    harnessVersion: z.string().min(1),
    container: z
      .object({
        source: z.enum(["pinned-container", "evaluator-task-container"]),
        image: z.string().min(1),
        indexDigest: sha256DigestSchema,
        manifestDigest: sha256DigestSchema,
        platform: ociPlatformSchema,
      })
      .strict(),
    resolvedModel: agentCandidateResolvedModelSchema,
    knowledgeManifestDigest: sha256DigestSchema.optional(),
    entrypoint: entrypointReceiptSchema.optional(),
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const plan = receipt.executionPlan.material;
    if (receipt.codeKind === "disabled") {
      if (
        receipt.materializedTree !== undefined ||
        receipt.entrypoint !== undefined ||
        receipt.candidateWorkspace !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message: "disabled code must not claim a materialized tree, entrypoint, or workspace",
        });
      }
    } else if (
      receipt.materializedTree === undefined ||
      receipt.entrypoint === undefined ||
      receipt.candidateWorkspace === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "active code requires a materialized tree, entrypoint, and workspace receipt",
      });
    } else {
      const entrypoint = receipt.candidateWorkspace.material.files.find(
        (file) => file.path === receipt.entrypoint?.path,
      );
      if (
        entrypoint === undefined ||
        entrypoint.sha256 !== receipt.entrypoint.sha256 ||
        entrypoint.byteLength !== receipt.entrypoint.byteLength
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["entrypoint"],
          message: "entrypoint receipt must identify exact candidate-workspace bytes",
        });
      }
    }
    const checks: Array<[boolean, (string | number)[], string]> = [
      [
        receipt.bundleDigest === plan.bundleDigest,
        ["executionPlan", "material", "bundleDigest"],
        "execution plan must bind the receipt bundle",
      ],
      [
        receipt.profilePlan.digest === plan.profilePlanDigest,
        ["executionPlan", "material", "profilePlanDigest"],
        "execution plan must bind the exact profile plan",
      ],
      [
        receipt.codeKind === plan.codeKind,
        ["executionPlan", "material", "codeKind"],
        "execution plan code kind must match materialization",
      ],
      [
        receipt.harness === plan.harness &&
          receipt.harnessVersion === plan.harnessVersion,
        ["executionPlan", "material", "harness"],
        "execution plan must bind the exact harness and version",
      ],
      [
        receipt.container.source === plan.container.source &&
          receipt.container.image === plan.container.image &&
          receipt.container.indexDigest === plan.container.indexDigest &&
          receipt.container.manifestDigest === plan.container.manifestDigest &&
          receipt.container.platform.os === plan.container.platform.os &&
          receipt.container.platform.architecture ===
            plan.container.platform.architecture &&
          receipt.container.platform.variant === plan.container.platform.variant,
        ["executionPlan", "material", "container"],
        "execution plan must bind the selected container bytes",
      ],
      [
        JSON.stringify(receipt.resolvedModel) ===
          JSON.stringify(plan.model.resolved),
        ["executionPlan", "material", "model", "resolved"],
        "execution plan must bind the exact resolved model",
      ],
      [
        receipt.knowledgeManifestDigest === plan.knowledgeManifestDigest,
        ["executionPlan", "material", "knowledgeManifestDigest"],
        "execution plan knowledge must match materialization",
      ],
      [
        JSON.stringify(receipt.candidateWorkspace) ===
          JSON.stringify(plan.candidateWorkspace),
        ["executionPlan", "material", "candidateWorkspace"],
        "execution plan must bind the exact uploaded candidate workspace",
      ],
      [
        receipt.profilePlan.material.harness === receipt.harness,
        ["profilePlan", "material", "harness"],
        "profile plan harness must match materialization",
      ],
    ];
    for (const [valid, path, message] of checks) {
      if (!valid) ctx.addIssue({ code: "custom", path, message });
    }
    if (!isCanonicalJsonValue(receipt)) {
      ctx.addIssue({
        code: "custom",
        message: "materialization receipt must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentCandidateMaterializationReceipt>;

export const agentCandidateRunReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("agent-candidate-run"),
    digestAlgorithm: z.literal("rfc8785-sha256"),
    bundleDigest: sha256DigestSchema,
    materializationReceiptDigest: sha256DigestSchema,
    executionPlanDigest: sha256DigestSchema,
    memory: agentCandidateMemoryReceiptSchema,
    usage: agentCandidateSpendSchema,
    modelUsage: agentCandidateModelUsageSchema,
    trace: agentCandidateTraceEvidenceSchema,
    termination: agentCandidateTerminationSchema,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const usageMatchesModel =
      receipt.usage.costUsd === receipt.modelUsage.usage.costUsd &&
      receipt.usage.inputTokens === receipt.modelUsage.usage.inputTokens &&
      receipt.usage.outputTokens === receipt.modelUsage.usage.outputTokens &&
      receipt.usage.cachedInputTokens ===
        receipt.modelUsage.usage.cachedInputTokens &&
      receipt.usage.modelCalls === receipt.modelUsage.usage.modelCalls;
    if (!usageMatchesModel) {
      ctx.addIssue({
        code: "custom",
        path: ["modelUsage", "usage"],
        message: "single-model usage must equal aggregate protected usage",
      });
    }
    if (receipt.trace.modelCallCount !== receipt.modelUsage.usage.modelCalls) {
      ctx.addIssue({
        code: "custom",
        path: ["trace", "modelCallCount"],
        message: "trace model-call count must match protected single-model usage",
      });
    }
    if (!isCanonicalJsonValue(receipt)) {
      ctx.addIssue({
        code: "custom",
        message: "run receipt must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentCandidateRunReceipt>;

type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

const _materializationReceiptSchemaMatchesType: MutuallyAssignable<
  z.infer<typeof agentCandidateMaterializationReceiptSchema>,
  AgentCandidateMaterializationReceipt
> = true;
const _runReceiptSchemaMatchesType: MutuallyAssignable<
  z.infer<typeof agentCandidateRunReceiptSchema>,
  AgentCandidateRunReceipt
> = true;
void _materializationReceiptSchemaMatchesType;
void _runReceiptSchemaMatchesType;
