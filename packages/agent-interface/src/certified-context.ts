import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import {
  canonicalCandidateDigest,
  isSafeRelativePath,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";

export type CertifiedContextKind = "prompt" | "skill" | "instructions";

export type CertifiedContextDelivery =
  | {
      readonly kind: "inline";
      readonly content: string;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly content: string;
    };

export interface CertifiedContextProvenance {
  /** SHA-256 of the entry id, kind, name, and delivery. */
  readonly contentHash: Sha256Digest;
  /** Positive release number, or null when the source has no released version. */
  readonly version: number | null;
  readonly promotedAt: string;
}

export interface CertifiedContextEntry {
  readonly id: string;
  readonly kind: CertifiedContextKind;
  readonly name: string;
  readonly delivery: CertifiedContextDelivery;
  readonly provenance: CertifiedContextProvenance;
}

/**
 * Tenant-bound context delivered by Intelligence.
 *
 * This contract intentionally excludes tools, credentials, executable files,
 * profile patches, MCP servers, and arbitrary network requests.
 */
export interface CertifiedContext {
  readonly tenantId: string;
  readonly target: string;
  readonly state: "active" | "revoked";
  /** Monotonic decimal revision for this tenant and target. */
  readonly revision: string;
  readonly generatedAt: string;
  readonly expiresAt: string;
  readonly entries: readonly CertifiedContextEntry[];
  /** SHA-256 of tenantId, target, state, revision, and entries. */
  readonly contentHash: Sha256Digest;
}

const MAX_INLINE_CONTEXT_BYTES = 65_536;
const MAX_TOTAL_INLINE_CONTEXT_BYTES = 131_072;
const MAX_FILE_CONTEXT_BYTES = 1_048_576;
const MAX_CERTIFIED_CONTEXT_BYTES = 16_777_216;
const MAX_CERTIFIED_CONTEXT_LIFETIME_MS = 900_000;

const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "value cannot be blank");
const identifierSchema = nonBlankStringSchema.max(256);
const relativePathSchema = nonBlankStringSchema
  .max(1_024)
  .refine(
    (value) => isSafeRelativePath(value, false),
    "value must be a canonical relative path",
  );
const inlineContentSchema = z
  .string()
  .max(MAX_INLINE_CONTEXT_BYTES)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= MAX_INLINE_CONTEXT_BYTES,
    `inline content exceeds ${MAX_INLINE_CONTEXT_BYTES} UTF-8 bytes`,
  );
const fileContentSchema = z
  .string()
  .max(MAX_FILE_CONTEXT_BYTES)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= MAX_FILE_CONTEXT_BYTES,
    `file content exceeds ${MAX_FILE_CONTEXT_BYTES} UTF-8 bytes`,
  );

export const certifiedContextDeliverySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("inline"),
    content: inlineContentSchema,
  }),
  z.strictObject({
    kind: z.literal("file"),
    path: relativePathSchema,
    content: fileContentSchema,
  }),
]) satisfies z.ZodType<CertifiedContextDelivery>;

export const certifiedContextProvenanceSchema = z.strictObject({
  contentHash: sha256DigestSchema,
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  promotedAt: z.iso.datetime(),
}) satisfies z.ZodType<CertifiedContextProvenance>;

function jsonMaterial(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("certified context material must be JSON serializable");
  }
  return JSON.parse(serialized) as unknown;
}

/** Compute the exact digest stored in an entry's provenance. */
export function certifiedContextEntryContentHash(
  entry: Pick<CertifiedContextEntry, "id" | "kind" | "name" | "delivery">,
): Sha256Digest {
  return canonicalCandidateDigest(
    jsonMaterial({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      delivery: entry.delivery,
    }),
  );
}

export const certifiedContextEntrySchema = z
  .strictObject({
    id: identifierSchema,
    kind: z.enum(["prompt", "skill", "instructions"]),
    name: identifierSchema,
    delivery: certifiedContextDeliverySchema,
    provenance: certifiedContextProvenanceSchema,
  })
  .superRefine((entry, context) => {
    if (entry.kind === "skill" && entry.delivery.kind !== "file") {
      context.addIssue({
        code: "custom",
        path: ["delivery", "kind"],
        message: "skills must be delivered as files",
      });
    }
    if (entry.kind !== "skill" && entry.delivery.kind !== "inline") {
      context.addIssue({
        code: "custom",
        path: ["delivery", "kind"],
        message: "prompts and instructions must be delivered inline",
      });
    }
    if (
      entry.delivery.kind === "inline" &&
      entry.delivery.content.trim().length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["delivery", "content"],
        message: "inline context cannot be blank",
      });
    }
    if (
      entry.provenance.contentHash !== certifiedContextEntryContentHash(entry)
    ) {
      context.addIssue({
        code: "custom",
        path: ["provenance", "contentHash"],
        message: "entry content hash does not match the delivered context",
      });
    }
  }) satisfies z.ZodType<CertifiedContextEntry>;

/** Compute the stable hash for one context revision. */
export function certifiedContextContentHash(
  context: Pick<
    CertifiedContext,
    "tenantId" | "target" | "state" | "revision" | "entries"
  >,
): Sha256Digest {
  return canonicalCandidateDigest(jsonMaterial(context));
}

export const certifiedContextSchema = z
  .strictObject({
    tenantId: identifierSchema,
    target: identifierSchema,
    state: z.enum(["active", "revoked"]),
    revision: z
      .string()
      .regex(/^(0|[1-9]\d{0,18})$/)
      .refine(
        (value) => BigInt(value) <= 9_223_372_036_854_775_807n,
        "revision exceeds signed 64-bit range",
      ),
    generatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    entries: z.array(certifiedContextEntrySchema).max(128),
    contentHash: sha256DigestSchema,
  })
  .superRefine((context, refinement) => {
    const generatedAt = Date.parse(context.generatedAt);
    const expiresAt = Date.parse(context.expiresAt);
    if (expiresAt <= generatedAt) {
      refinement.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt must be after generatedAt",
      });
    } else if (
      expiresAt - generatedAt >
      MAX_CERTIFIED_CONTEXT_LIFETIME_MS
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "certified context cannot live longer than 15 minutes",
      });
    }

    const serialized = JSON.stringify(context);
    if (
      new TextEncoder().encode(serialized).byteLength >
      MAX_CERTIFIED_CONTEXT_BYTES
    ) {
      refinement.addIssue({
        code: "too_big",
        maximum: MAX_CERTIFIED_CONTEXT_BYTES,
        origin: "string",
        inclusive: true,
        message: `serialized context exceeds ${MAX_CERTIFIED_CONTEXT_BYTES} UTF-8 bytes`,
      });
    }

    const ids = new Set<string>();
    const filePaths = new Set<string>();
    let inlineBytes = 0;
    for (const [index, entry] of context.entries.entries()) {
      if (ids.has(entry.id)) {
        refinement.addIssue({
          code: "custom",
          path: ["entries", index, "id"],
          message: `duplicate context id: ${entry.id}`,
        });
      }
      ids.add(entry.id);

      if (entry.delivery.kind === "file") {
        if (filePaths.has(entry.delivery.path)) {
          refinement.addIssue({
            code: "custom",
            path: ["entries", index, "delivery", "path"],
            message: `duplicate file path: ${entry.delivery.path}`,
          });
        }
        filePaths.add(entry.delivery.path);
      } else {
        inlineBytes += new TextEncoder().encode(
          entry.delivery.content,
        ).byteLength;
      }

      if (Date.parse(entry.provenance.promotedAt) > generatedAt) {
        refinement.addIssue({
          code: "custom",
          path: ["entries", index, "provenance", "promotedAt"],
          message: "context cannot be promoted after bundle generation",
        });
      }
    }

    if (inlineBytes > MAX_TOTAL_INLINE_CONTEXT_BYTES) {
      refinement.addIssue({
        code: "custom",
        path: ["entries"],
        message: `inline context exceeds ${MAX_TOTAL_INLINE_CONTEXT_BYTES} UTF-8 bytes`,
      });
    }

    if (
      (context.state === "active" && context.entries.length === 0) ||
      (context.state === "revoked" && context.entries.length !== 0)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["entries"],
        message: "active context requires entries and revoked context requires none",
      });
    }

    const material = {
      tenantId: context.tenantId,
      target: context.target,
      state: context.state,
      revision: context.revision,
      entries: context.entries,
    };
    if (context.contentHash !== certifiedContextContentHash(material)) {
      refinement.addIssue({
        code: "custom",
        path: ["contentHash"],
        message: "context content hash does not match the delivered context",
      });
    }
  }) satisfies z.ZodType<CertifiedContext>;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

const _certifiedContextDeliverySchemaMatches: MutuallyAssignable<
  DeepReadonly<z.infer<typeof certifiedContextDeliverySchema>>,
  CertifiedContextDelivery
> = true;
const _certifiedContextProvenanceSchemaMatches: MutuallyAssignable<
  DeepReadonly<z.infer<typeof certifiedContextProvenanceSchema>>,
  CertifiedContextProvenance
> = true;
const _certifiedContextEntrySchemaMatches: MutuallyAssignable<
  DeepReadonly<z.infer<typeof certifiedContextEntrySchema>>,
  CertifiedContextEntry
> = true;
const _certifiedContextSchemaMatches: MutuallyAssignable<
  DeepReadonly<z.infer<typeof certifiedContextSchema>>,
  CertifiedContext
> = true;
void [
  _certifiedContextDeliverySchemaMatches,
  _certifiedContextProvenanceSchemaMatches,
  _certifiedContextEntrySchemaMatches,
  _certifiedContextSchemaMatches,
];

/** Parse, clone, and recursively freeze one untrusted context response. */
export function parseCertifiedContext(value: unknown): CertifiedContext {
  return deepFreeze(certifiedContextSchema.parse(value));
}
