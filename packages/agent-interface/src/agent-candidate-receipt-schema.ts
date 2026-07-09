import { z } from "zod";
import type {
  AgentCandidateMaterializationReceipt,
  AgentCandidateRunReceipt,
  AgentCandidateTermination,
} from "./agent-candidate.js";
import { agentCandidateArtifactRefSchema } from "./agent-candidate-artifact-schema.js";
import {
  agentCandidateMemoryPolicySchema,
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

const resolvedModelSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    snapshot: z.string().min(1).optional(),
  })
  .strict();

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
    profilePlanDigest: sha256DigestSchema,
    executionPlanDigest: sha256DigestSchema,
    codeKind: z.enum(["disabled", "no-op", "git-patch"]),
    materializedTree: gitObjectSchema.optional(),
    harness: harnessTypeSchema,
    harnessVersion: z.string().min(1),
    container: z
      .object({
        source: z.enum(["pinned-container", "evaluator-task-container"]),
        indexDigest: sha256DigestSchema,
        manifestDigest: sha256DigestSchema,
        platform: ociPlatformSchema,
      })
      .strict(),
    resolvedModel: resolvedModelSchema,
    knowledgeManifestDigest: sha256DigestSchema.optional(),
    entrypoint: entrypointReceiptSchema.optional(),
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (receipt.codeKind === "disabled") {
      if (
        receipt.materializedTree !== undefined ||
        receipt.entrypoint !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message: "disabled code must not claim a materialized tree or entrypoint",
        });
      }
    } else if (
      receipt.materializedTree === undefined ||
      receipt.entrypoint === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "active code requires a materialized tree and entrypoint receipt",
      });
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
    memory: agentCandidateMemoryPolicySchema,
    usage: agentCandidateSpendSchema,
    trace: agentCandidateArtifactRefSchema,
    termination: agentCandidateTerminationSchema,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
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
