import parseSpdxExpression from "spdx-expression-parse";
import { z } from "zod";
import type { AgentCandidateJsonValue } from "./agent-candidate.js";
import { sha256DigestSchema } from "./agent-candidate-schema-common.js";

/** Metadata key that binds a measured improvement to its exact external source. */
export const AGENT_IMPROVEMENT_SOURCE_METADATA_KEY = "agentImprovementSource";

const sourceIdentitySchema = z.string().trim().min(1).max(256);
const sourceRevisionSchema = z.union([
  z.string().trim().min(1).max(256),
  z.number().int().nonnegative(),
]);
const sourceStatementSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "statement cannot be blank")
  .max(16_384);
const sourceStatementListSchema = z
  .array(sourceStatementSchema)
  .min(1)
  .max(128)
  .refine(
    (values) => new Set(values).size === values.length,
    "statements must be unique",
  );

function containsCustomLicenseReference(
  expression: ReturnType<typeof parseSpdxExpression>,
): boolean {
  if ("license" in expression) {
    return (
      expression.license.startsWith("LicenseRef-") ||
      expression.license.includes(":LicenseRef-")
    );
  }
  return (
    containsCustomLicenseReference(expression.left) ||
    containsCustomLicenseReference(expression.right)
  );
}

/** License terms retained with an imported source. */
export const agentSourceLicenseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("spdx"),
      expression: z
        .string()
        .trim()
        .min(1)
        .max(1_024)
        .refine((expression) => {
          try {
            return !containsCustomLicenseReference(
              parseSpdxExpression(expression),
            );
          } catch {
            return false;
          }
        },
        "license expression must use standard SPDX identifiers; content-pin custom terms with kind=custom",
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom"),
      name: sourceIdentitySchema,
      /** URL or repository-relative path from which the exact terms can be recovered. */
      reference: z.string().trim().min(1).max(2_048),
      /** Digest of the custom license text, not of its URL or file name. */
      termsDigest: sha256DigestSchema,
    })
    .strict(),
]);

export type AgentSourceLicense = z.infer<typeof agentSourceLicenseSchema>;

/**
 * One content transition applied while importing a source.
 *
 * `identity` and `revision` pin the transformer. Input/output digests make the
 * ordered chain auditable without embedding executable transformation code.
 * `procedureDigest` pins the implementation and non-secret configuration used
 * for that step.
 */
export const agentSourceTransformationSchema = z
  .object({
    kind: z.enum(["normalization", "transformation"]),
    identity: sourceIdentitySchema,
    revision: sourceRevisionSchema,
    procedureDigest: sha256DigestSchema,
    inputDigest: sha256DigestSchema,
    outputDigest: sha256DigestSchema,
  })
  .strict();

export type AgentSourceTransformation = z.infer<
  typeof agentSourceTransformationSchema
>;

/**
 * Stable reference for the state from which an improvement candidate was made.
 * `sourceIdentity` identifies the provider object; `sourceDigest` is the exact
 * measured source state consumed by the candidate; `sourceRevision` is an
 * opaque provider version retained to make stale-source errors intelligible to
 * callers. A revision may be numeric or textual because providers use both
 * counters and immutable revision identifiers.
 *
 * Optional license, attribution, and notice fields preserve obligations when a
 * public source becomes an improvement input. When transformations are
 * present, their first input pins the fetched source bytes, every adjacent
 * digest must join, and the final output must equal `sourceDigest`.
 */
export const agentImprovementSourceSchema = z
  .object({
    kind: z.string().trim().min(1).max(100).regex(/^[a-z][a-z0-9-]*$/),
    sourceIdentity: sourceIdentitySchema,
    sourceDigest: sha256DigestSchema,
    sourceRevision: sourceRevisionSchema,
    license: agentSourceLicenseSchema.optional(),
    attribution: sourceStatementListSchema.optional(),
    notices: sourceStatementListSchema.optional(),
    transformations: z
      .array(agentSourceTransformationSchema)
      .min(1)
      .max(128)
      .optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    const transformations = source.transformations;
    if (transformations === undefined) return;

    for (let index = 1; index < transformations.length; index++) {
      if (
        transformations[index]?.inputDigest !==
        transformations[index - 1]?.outputDigest
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["transformations", index, "inputDigest"],
          message: "transformation input must equal the previous output",
        });
      }
    }

    if (transformations.at(-1)?.outputDigest !== source.sourceDigest) {
      ctx.addIssue({
        code: "custom",
        path: ["sourceDigest"],
        message: "source digest must equal the final transformation output",
      });
    }
  });

export type AgentImprovementSource = z.infer<
  typeof agentImprovementSourceSchema
>;

/** Attach one validated source reference to signed improvement metadata. */
export function agentImprovementSourceMetadata(
  source: AgentImprovementSource,
): Record<string, AgentCandidateJsonValue> {
  return {
    [AGENT_IMPROVEMENT_SOURCE_METADATA_KEY]:
      agentImprovementSourceSchema.parse(source),
  };
}

/** Read the exact source reference from a signed improvement proposal. */
export function readAgentImprovementSource(
  metadata: unknown,
): AgentImprovementSource {
  const record = z.record(z.string(), z.unknown()).parse(metadata);
  const source = record[AGENT_IMPROVEMENT_SOURCE_METADATA_KEY];
  if (source === undefined) {
    throw new Error("signed improvement proposal is missing its source reference");
  }
  return agentImprovementSourceSchema.parse(source);
}
