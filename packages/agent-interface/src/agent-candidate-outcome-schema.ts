import { z } from "zod";
import type {
  AgentCandidateBenchmarkResultEvidence,
  AgentCandidateBenchmarkResultMaterialV1,
  AgentCandidateFixedSpend,
  AgentCandidateModelSettlementEvidence,
  AgentCandidateModelSettlementMaterial,
  AgentCandidateModelSettlementMaterialV1,
  AgentCandidateModelSettlementMaterialV2,
  AgentCandidateRepositoryState,
  AgentCandidateTaskOutcomeEvidence,
  AgentCandidateTaskOutcomeMaterialV1,
} from "./agent-candidate.js";
import {
  agentCandidateArtifactRefSchema,
  agentCandidateCapturedArtifactSchema,
  agentCandidateWorkspaceSnapshotEvidenceSchema,
} from "./agent-candidate-artifact-schema.js";
import { agentCandidateResolvedModelSchema } from "./agent-candidate-execution-plan-schema.js";
import {
  agentCandidateMediaTypeSchema,
  gitObjectSchema,
  isCanonicalJsonValue,
  sameGitObjectFormat,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";

const safeCountSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "value must be a nonnegative safe integer");

const boundedIdentifierSchema = z.string().min(1).max(256);
const positiveTimestampSchema = safeCountSchema.positive();
const normalizedDimensionNameSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    "dimension names must be normalized lowercase identifiers",
  );
const normalizedScoreSchema = z.number().finite().min(0).max(1);

export const agentCandidateFixedSpendSchema = z
  .object({
    inputTokens: safeCountSchema,
    outputTokens: safeCountSchema,
    cachedInputTokens: safeCountSchema,
    reasoningTokens: safeCountSchema,
    modelCalls: safeCountSchema,
    costUsdNanos: safeCountSchema,
  })
  .strict() satisfies z.ZodType<AgentCandidateFixedSpend>;

export const agentCandidateModelSettlementCallSchema = z
  .object({
    callId: boundedIdentifierSchema,
    traceSpanId: boundedIdentifierSchema,
    model: boundedIdentifierSchema,
    inputTokens: safeCountSchema,
    outputTokens: safeCountSchema,
    cachedInputTokens: safeCountSchema,
    reasoningTokens: safeCountSchema,
    costUsdNanos: safeCountSchema,
  })
  .strict();

export const agentCandidateModelSettlementCallV2Schema = z
  .object({
    callId: boundedIdentifierSchema,
    generationId: boundedIdentifierSchema,
    traceSpanId: boundedIdentifierSchema,
    status: z.enum(["succeeded", "failed"]),
    model: boundedIdentifierSchema,
    startedAtMs: positiveTimestampSchema,
    endedAtMs: positiveTimestampSchema,
    inputTokens: safeCountSchema,
    outputTokens: safeCountSchema,
    cachedInputTokens: safeCountSchema,
    reasoningTokens: safeCountSchema,
    costUsdNanos: safeCountSchema,
  })
  .strict()
  .superRefine((call, ctx) => {
    if (call.traceSpanId !== call.generationId) {
      ctx.addIssue({
        code: "custom",
        path: ["traceSpanId"],
        message: "model settlement trace span id must equal the router generation id",
      });
    }
    if (call.endedAtMs < call.startedAtMs) {
      ctx.addIssue({
        code: "custom",
        path: ["endedAtMs"],
        message: "model settlement call cannot end before it starts",
      });
    }
  });

const modelSettlementMaterialShape = {
    kind: z.literal("agent-candidate-model-settlement-material"),
    executionPlanDigest: sha256DigestSchema,
    preparationId: boundedIdentifierSchema,
    grantDigest: sha256DigestSchema,
    closed: z.literal(true),
    resolved: agentCandidateResolvedModelSchema,
    usage: agentCandidateFixedSpendSchema,
};

export const agentCandidateModelSettlementMaterialV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    ...modelSettlementMaterialShape,
    calls: z.array(agentCandidateModelSettlementCallSchema),
  })
  .strict()
  .superRefine(refineModelSettlementMaterial) satisfies z.ZodType<AgentCandidateModelSettlementMaterialV1>;

export const agentCandidateModelSettlementMaterialV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    ...modelSettlementMaterialShape,
    calls: z.array(agentCandidateModelSettlementCallV2Schema),
  })
  .strict()
  .superRefine(refineModelSettlementMaterial) satisfies z.ZodType<AgentCandidateModelSettlementMaterialV2>;

export const agentCandidateModelSettlementMaterialSchema = z.union([
  agentCandidateModelSettlementMaterialV1Schema,
  agentCandidateModelSettlementMaterialV2Schema,
]) satisfies z.ZodType<AgentCandidateModelSettlementMaterial>;

function refineModelSettlementMaterial(
  material: AgentCandidateModelSettlementMaterial,
  ctx: z.RefinementCtx,
): void {
  const callIds = new Set<string>();
  const traceSpanIds = new Set<string>();
  const generationIds = new Set<string>();
  const totals: AgentCandidateFixedSpend = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    modelCalls: material.calls.length,
    costUsdNanos: 0,
  };

  for (const [index, call] of material.calls.entries()) {
    if (callIds.has(call.callId)) {
      ctx.addIssue({
        code: "custom",
        path: ["calls", index, "callId"],
        message: "model settlement call ids must be unique",
      });
    }
    callIds.add(call.callId);
    if (traceSpanIds.has(call.traceSpanId)) {
      ctx.addIssue({
        code: "custom",
        path: ["calls", index, "traceSpanId"],
        message: "model settlement trace span ids must be unique",
      });
    }
    traceSpanIds.add(call.traceSpanId);
    const generationId =
      "generationId" in call && typeof call.generationId === "string"
        ? call.generationId
        : undefined;
    if (generationId !== undefined) {
      if (generationIds.has(generationId)) {
        ctx.addIssue({
          code: "custom",
          path: ["calls", index, "generationId"],
          message: "model settlement generation ids must be unique",
        });
      }
      generationIds.add(generationId);
    }
    if (call.model !== material.resolved.model) {
      ctx.addIssue({
        code: "custom",
        path: ["calls", index, "model"],
        message: "settled call model must match the resolved single model",
      });
    }

    for (const field of [
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "reasoningTokens",
      "costUsdNanos",
    ] as const) {
      const sum = totals[field] + call[field];
      if (!Number.isSafeInteger(sum)) {
        ctx.addIssue({
          code: "custom",
          path: ["calls", index, field],
          message: `model settlement ${field} total exceeds safe integer range`,
        });
      } else {
        totals[field] = sum;
      }
    }
  }

  if (!sameFixedSpend(totals, material.usage)) {
    ctx.addIssue({
      code: "custom",
      path: ["usage"],
      message: "model settlement usage must equal the exact per-call aggregate",
    });
  }
  if (!isCanonicalJsonValue(material)) {
    ctx.addIssue({
      code: "custom",
      message: "model settlement material must contain only RFC 8785 JSON values",
    });
  }
}

export const agentCandidateModelSettlementEvidenceSchema = evidenceSchema(
  "agent-candidate-model-settlement",
  agentCandidateModelSettlementMaterialSchema,
  "model settlement",
) satisfies z.ZodType<AgentCandidateModelSettlementEvidence>;

export const agentCandidateRepositoryStateSchema = z
  .object({
    identity: z.string().min(1),
    rootIdentity: z.string().min(1),
    commit: gitObjectSchema,
    tree: gitObjectSchema,
  })
  .strict()
  .superRefine((state, ctx) => {
    if (!sameGitObjectFormat(state.commit, state.tree)) {
      ctx.addIssue({
        code: "custom",
        path: ["tree"],
        message: "repository commit and tree must use the same Git object format",
      });
    }
  }) satisfies z.ZodType<AgentCandidateRepositoryState>;

export const agentCandidateTaskOutcomeMaterialSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("agent-candidate-task-outcome-material"),
    executionPlanDigest: sha256DigestSchema,
    outcome: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("workspace"),
          baseRepository: agentCandidateRepositoryStateSchema,
          resultRepository: agentCandidateRepositoryStateSchema,
          afterState: agentCandidateWorkspaceSnapshotEvidenceSchema,
          gitDiff: z
            .object({
              format: z.literal("git-diff-binary"),
              artifact: agentCandidateArtifactRefSchema,
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("output"),
          mediaType: agentCandidateMediaTypeSchema,
          maxBytes: z.number().int().positive().max(64 * 1024 * 1024),
          artifact: agentCandidateArtifactRefSchema,
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((material, ctx) => {
    if (
      material.outcome.kind === "workspace" &&
      material.outcome.baseRepository.identity !==
        material.outcome.resultRepository.identity
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["outcome", "resultRepository", "identity"],
        message: "base and result repository identities must match",
      });
    }
    if (
      material.outcome.kind === "workspace" &&
      material.outcome.baseRepository.rootIdentity !==
        material.outcome.resultRepository.rootIdentity
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["outcome", "resultRepository", "rootIdentity"],
        message: "base and result repository roots must match",
      });
    }
    if (material.outcome.kind === "workspace") {
      if (
        !sameGitObjectFormat(
          material.outcome.baseRepository.commit,
          material.outcome.resultRepository.commit,
        ) ||
        !sameGitObjectFormat(
          material.outcome.baseRepository.tree,
          material.outcome.resultRepository.tree,
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["outcome", "resultRepository"],
          message: "base and result repositories must use one Git object format",
        });
      }
    }
    if (
      material.outcome.kind === "output" &&
      material.outcome.artifact.byteLength === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["outcome", "artifact"],
        message: "task outcome artifact cannot be empty",
      });
    }
    if (
      material.outcome.kind === "output" &&
      material.outcome.artifact.byteLength > material.outcome.maxBytes
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["outcome", "artifact", "byteLength"],
        message: "task outcome artifact exceeds its frozen byte maximum",
      });
    }
    if (!isCanonicalJsonValue(material)) {
      ctx.addIssue({
        code: "custom",
        message: "task outcome material must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentCandidateTaskOutcomeMaterialV1>;

export const agentCandidateTaskOutcomeEvidenceSchema = evidenceSchema(
  "agent-candidate-task-outcome",
  agentCandidateTaskOutcomeMaterialSchema,
  "task outcome",
) satisfies z.ZodType<AgentCandidateTaskOutcomeEvidence>;

export const agentCandidateBenchmarkDimensionSchema = z
  .object({
    name: normalizedDimensionNameSchema,
    score: normalizedScoreSchema,
  })
  .strict();

export const agentCandidateBenchmarkResultMaterialSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("agent-candidate-benchmark-result-material"),
    executionPlanDigest: sha256DigestSchema,
    taskOutcomeDigest: sha256DigestSchema,
    benchmark: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        taskId: z.string().min(1),
        splitDigest: sha256DigestSchema,
      })
      .strict(),
    grader: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        artifact: agentCandidateArtifactRefSchema,
      })
      .strict(),
    evidence: agentCandidateArtifactRefSchema,
    score: normalizedScoreSchema,
    passed: z.boolean(),
    dimensions: z.array(agentCandidateBenchmarkDimensionSchema),
  })
  .strict()
  .superRefine((material, ctx) => {
    if (material.grader.artifact.byteLength === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["grader", "artifact", "byteLength"],
        message: "pinned grader artifact must contain executable grader bytes",
      });
    }
    if (material.evidence.byteLength === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence", "byteLength"],
        message: "benchmark result must contain non-empty durable grading evidence",
      });
    }
    if (material.evidence.sha256 === material.grader.artifact.sha256) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence", "sha256"],
        message: "grading evidence must be distinct from the grader implementation",
      });
    }
    for (let index = 1; index < material.dimensions.length; index++) {
      const previous = material.dimensions[index - 1]?.name ?? "";
      const current = material.dimensions[index]?.name ?? "";
      if (previous >= current) {
        ctx.addIssue({
          code: "custom",
          path: ["dimensions", index, "name"],
          message: "benchmark dimensions must be unique and lexicographically sorted",
        });
      }
    }
    if (!isCanonicalJsonValue(material)) {
      ctx.addIssue({
        code: "custom",
        message: "benchmark result material must contain only RFC 8785 JSON values",
      });
    }
  }) satisfies z.ZodType<AgentCandidateBenchmarkResultMaterialV1>;

export const agentCandidateBenchmarkResultEvidenceSchema = evidenceSchema(
  "agent-candidate-benchmark-result",
  agentCandidateBenchmarkResultMaterialSchema,
  "benchmark result",
) satisfies z.ZodType<AgentCandidateBenchmarkResultEvidence>;

export function sameFixedSpend(
  left: AgentCandidateFixedSpend,
  right: AgentCandidateFixedSpend,
): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.reasoningTokens === right.reasoningTokens &&
    left.modelCalls === right.modelCalls &&
    left.costUsdNanos === right.costUsdNanos
  );
}

function evidenceSchema<TKind extends string, TMaterial>(
  kind: TKind,
  material: z.ZodType<TMaterial>,
  label: string,
) {
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
          message: `${label} artifact hash must equal its canonical material digest`,
        });
      }
      if (evidence.artifact.byteLength === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["artifact", "byteLength"],
          message: `${label} artifact must contain canonical material bytes`,
        });
      }
    });
}
