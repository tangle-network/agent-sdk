import { z } from "zod";
import {
  canonicalCandidateDigest,
  isCanonicalJsonValue,
  looksLikeCredential,
  omitTopLevelDigest,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import { AGENT_PROFILE_MATERIALIZATION_AXES } from "./agent-profile-materialization.js";
import { harnessTypeSchema } from "./harness.js";
import { reasoningEffortSchema } from "./profile-schema.js";
import { agentWorkspaceSourceSnapshotPolicySchema } from "./agent-workspace-lease.js";
import { assertBoundedAgentProfileJson } from "./agent-profile-safe-json.js";
import type {
  AgentExecutionPreparationAxisResult,
  AgentExecutionPreparationReasoningEffort,
  AgentExecutionPreparationReceipt,
} from "./agent-execution-preparation-types.js";
import {
  axisResultKey,
  canonicalRowsEqual,
  compareAxisResults,
  isCanonicalJsonPointer,
  isDownwardReasoningClamp,
} from "./agent-execution-preparation-utils.js";

const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "value cannot be blank");

const publicMechanismIdentifierSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/,
    "mechanism must be a public identifier, not launch arguments",
  )
  .refine(
    (value) => !looksLikeCredential(value),
    "mechanism cannot carry credential-like material",
  );

const publicLifecycleIdentifierSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._~:/+-]{0,499}$/,
    "lifecycle identity must be a public identifier",
  )
  .refine(
    (value) => !looksLikeCredential(value),
    "lifecycle identity cannot carry credential-like material",
  );

const publicReasonSchema = nonBlankStringSchema
  .max(4_000)
  .refine(
    (value) => !looksLikeCredential(value),
    "reason cannot carry credential-like material",
  );

const jsonPointerSchema = z
  .string()
  .refine(isCanonicalJsonPointer, "path must be a canonical RFC 6901 JSON Pointer");

export const agentExecutionPreparationAxisResultSchema = z
  .strictObject({
    axis: z.enum(AGENT_PROFILE_MATERIALIZATION_AXES),
    disposition: z.enum([
      "behavior",
      "control",
      "overridden",
      "unsupported",
    ]),
    owner: z.enum(["runtime", "executor"]),
    mechanism: publicMechanismIdentifierSchema,
    evidenceDigest: sha256DigestSchema.optional(),
    path: jsonPointerSchema.optional(),
    reason: publicReasonSchema.optional(),
  })
  .superRefine((result, context) => {
    const requiresReason =
      result.disposition === "overridden" ||
      result.disposition === "unsupported";
    if (requiresReason && result.reason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: `${result.disposition} profile coverage requires a reason`,
      });
    }
    if (!requiresReason && result.reason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: `${result.disposition} profile coverage cannot carry an override reason`,
      });
    }
  }) satisfies z.ZodType<AgentExecutionPreparationAxisResult>;

export const agentExecutionPreparationReasoningEffortSchema = z
  .strictObject({
    requested: reasoningEffortSchema,
    resolved: reasoningEffortSchema.optional(),
    fidelity: z.enum(["exact", "clamped", "unsupported"]),
  })
  .superRefine((effort, context) => {
    if (effort.fidelity === "unsupported") {
      if (effort.resolved !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["resolved"],
          message: "unsupported reasoning effort cannot claim a resolved value",
        });
      }
      return;
    }
    if (effort.resolved === undefined) {
      context.addIssue({
        code: "custom",
        path: ["resolved"],
        message: `${effort.fidelity} reasoning fidelity requires a resolved value`,
      });
      return;
    }
    if (effort.fidelity === "exact" && effort.resolved !== effort.requested) {
      context.addIssue({
        code: "custom",
        path: ["resolved"],
        message: "exact reasoning fidelity must preserve the requested effort",
      });
    }
    if (effort.fidelity === "clamped") {
      if (effort.resolved === effort.requested) {
        context.addIssue({
          code: "custom",
          path: ["resolved"],
          message: "clamped reasoning fidelity must change the requested effort",
        });
      } else if (!isDownwardReasoningClamp(effort.requested, effort.resolved)) {
        context.addIssue({
          code: "custom",
          path: ["resolved"],
          message: "reasoning effort may clamp down but must never increase",
        });
      }
    }
  }) satisfies z.ZodType<AgentExecutionPreparationReasoningEffort>;

export const agentExecutionPreparationReceiptSchema = z
  .strictObject({
    kind: z.literal("agent-execution-preparation"),
    schemaVersion: z.literal(1),
    preparationId: nonBlankStringSchema.max(500),
    requestDigest: sha256DigestSchema,
    authoredProfileDigest: sha256DigestSchema,
    effectiveProfileDigest: sha256DigestSchema,
    backend: nonBlankStringSchema.max(200),
    harness: harnessTypeSchema,
    harnessVersion: nonBlankStringSchema.max(200),
    resolvedModel: z.strictObject({
      requested: z.string().max(500),
      resolved: nonBlankStringSchema.max(500),
      provider: z.string().max(200).optional(),
      reasoningEffort: agentExecutionPreparationReasoningEffortSchema.optional(),
    }),
    workspace: z.strictObject({
      leaseId: publicLifecycleIdentifierSchema,
      provider: publicLifecycleIdentifierSchema,
      identityDigest: sha256DigestSchema,
      isolation: z.enum(["per-run", "shared"]),
      sourceSnapshotDigest: sha256DigestSchema,
      sourceSnapshotPolicy: agentWorkspaceSourceSnapshotPolicySchema,
      preparedWorkspaceDigest: sha256DigestSchema,
      profileActivationDigest: sha256DigestSchema,
    }),
    axisResults: z.array(agentExecutionPreparationAxisResultSchema),
    executionPlanDigest: sha256DigestSchema,
    materializer: z.strictObject({
      name: nonBlankStringSchema.max(200),
      version: nonBlankStringSchema.max(200),
    }),
    expiresAtMs: z.number().int().positive().safe(),
    digest: sha256DigestSchema,
  })
  .superRefine((receipt, context) => {
    try {
      assertBoundedAgentProfileJson(receipt);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const seen = new Map<string, AgentExecutionPreparationAxisResult>();
    for (const [index, result] of receipt.axisResults.entries()) {
      const key = axisResultKey(result.axis, result.path);
      const previous = seen.get(key);
      if (previous !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["axisResults", index],
          message: canonicalRowsEqual(previous, result)
            ? "duplicate profile axis/path result"
            : "conflicting profile axis/path results",
        });
      } else {
        seen.set(key, result);
      }
      if (
        index > 0 &&
        compareAxisResults(receipt.axisResults[index - 1]!, result) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["axisResults", index],
          message: "profile axis/path results must be canonically sorted",
        });
      }
    }
    if (!isCanonicalJsonValue(receipt)) {
      context.addIssue({
        code: "custom",
        message: "execution preparation receipt must contain only RFC 8785 JSON values",
      });
    } else if (
      canonicalCandidateDigest(omitTopLevelDigest(receipt)) !== receipt.digest
    ) {
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "execution preparation receipt digest is invalid",
      });
    }
  }) satisfies z.ZodType<AgentExecutionPreparationReceipt>;
