import { z } from "zod";
import type { AgentCandidateBundle } from "./agent-candidate.js";
import { agentCandidateCodeSchema, agentCandidateExecutionSchema } from "./agent-candidate-code-schema.js";
import { agentCandidateProfileSchema } from "./agent-candidate-profile-schema.js";
import {
  agentCandidateKnowledgeSchema,
  agentCandidateLineageSchema,
  agentCandidateMemoryPolicySchema,
} from "./agent-candidate-lineage-schema.js";
import {
  isCanonicalJsonValue,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";
import { canonicalizeHarness } from "./harness.js";

/**
 * Structural parser for a frozen candidate.
 *
 * This does not verify any carried digest or fetch any artifact. The runtime
 * verifier removes only the top-level `digest` field, serializes the remaining
 * object with RFC 8785 to UTF-8 bytes, hashes those bytes with SHA-256, and
 * compares lowercase `sha256:<hex>` identities before materialization.
 */
export const agentCandidateBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("agent-candidate-bundle"),
    digestAlgorithm: z.literal("rfc8785-sha256"),
    profile: agentCandidateProfileSchema,
    code: agentCandidateCodeSchema,
    execution: agentCandidateExecutionSchema,
    knowledge: agentCandidateKnowledgeSchema.optional(),
    memory: agentCandidateMemoryPolicySchema,
    lineage: agentCandidateLineageSchema,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine((bundle, ctx) => {
    if (!isCanonicalJsonValue(bundle)) {
      ctx.addIssue({
        code: "custom",
        message: "candidate bundle must contain only finite, acyclic RFC 8785 JSON values",
      });
    }
    if (
      bundle.profile.harness !== undefined &&
      canonicalizeHarness(bundle.profile.harness) !==
        canonicalizeHarness(bundle.execution.harness)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["execution", "harness"],
        message: "execution harness must match the candidate profile preference",
      });
    }

    if (bundle.code.kind === "disabled") {
      if (bundle.execution.cwd.workspace !== "task") {
        ctx.addIssue({
          code: "custom",
          path: ["execution", "cwd", "workspace"],
          message: "disabled code controls must execute in the task workspace",
        });
      }
      if (bundle.execution.launch.kind !== "container-command") {
        ctx.addIssue({
          code: "custom",
          path: ["execution", "launch"],
          message: "disabled code controls must use a container command",
        });
      }
    } else {
      if (bundle.execution.launch.kind !== "candidate-entrypoint") {
        ctx.addIssue({
          code: "custom",
          path: ["execution", "launch"],
          message: "an active code surface must launch its candidate entrypoint",
        });
      }
    }
  }) satisfies z.ZodType<AgentCandidateBundle>;

type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

const _bundleSchemaMatchesType: MutuallyAssignable<
  z.infer<typeof agentCandidateBundleSchema>,
  AgentCandidateBundle
> = true;
void _bundleSchemaMatchesType;

export * from "./agent-candidate-artifact-schema.js";
export * from "./agent-candidate-code-schema.js";
export * from "./agent-candidate-lineage-schema.js";
export * from "./agent-candidate-profile-schema.js";
export * from "./agent-candidate-receipt-schema.js";
export { sha256DigestSchema } from "./agent-candidate-schema-common.js";
