import { z } from "zod";
import type { Sha256Digest } from "./agent-candidate.js";
import {
  canonicalCandidateDigest,
  isCanonicalJsonValue,
  isObviouslyPrivateHostname,
  isSafeRelativePath,
  sha256DigestSchema,
} from "./agent-candidate-schema-common.js";

export type CertifiedCapabilityInterface =
  | {
      surface: "context";
      kind: "prompt" | "skill" | "instructions";
      name: string;
    }
  | {
      surface: "tool";
      name: string;
      description?: string;
      parameters: Record<string, unknown>;
      returns?: Record<string, unknown>;
    };

export type CertifiedCapabilityAuth =
  | { mode: "none" }
  | { mode: "tangle-key"; origin: string }
  | {
      mode: "hub-connection";
      providerId: string;
      origin: string;
      scopes?: string[];
    }
  | { mode: "secret-ref"; key: string; origin: string };

export type CertifiedCapabilityBinding =
  | { kind: "inline"; content: string }
  | { kind: "file"; path: string; content: string }
  | {
      kind: "http";
      url: string;
      auth?: CertifiedCapabilityAuth;
    };

export interface CertificationProvenance {
  /** SHA-256 of the capability id, interface, and binding. */
  contentHash: Sha256Digest;
  /** Positive release number, or null when the source has no released version. */
  version: number | null;
  promotedAt: string;
}

export interface CertifiedCapabilityProvenance
  extends CertificationProvenance {
  sourcePath: string | null;
}

export interface CertifiedCapability {
  id: string;
  iface: CertifiedCapabilityInterface;
  binding: CertifiedCapabilityBinding;
  provenance: CertifiedCapabilityProvenance;
}

/**
 * The exact response returned by the certified-profile delivery endpoint.
 * The digest covers the target, lifetime, capabilities, and provenance.
 */
export interface CertifiedProfile {
  target: string;
  generatedAt: string;
  expiresAt: string;
  capabilities: CertifiedCapability[];
  digest: Sha256Digest;
}

const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "value cannot be blank");

const identifierSchema = nonBlankStringSchema.max(256);
const boundedTextSchema = nonBlankStringSchema.max(16_384);
const referenceSchema = nonBlankStringSchema.max(1_024);
const callableNameSchema = nonBlankStringSchema.refine(
  (value) => /^[A-Za-z0-9_-]{1,64}$/.test(value),
  "value must be a portable callable name",
);
const relativePathSchema = nonBlankStringSchema
  .max(1_024)
  .refine(
    (value) => isSafeRelativePath(value, false),
    "value must be a canonical relative path",
  );
const MAX_CERTIFIED_PROFILE_SERIALIZED_CHARS = 16_777_216;
const MAX_CERTIFIED_PROFILE_LIFETIME_MS = 86_400_000;

function parsePublicHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      isObviouslyPrivateHostname(url.hostname)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

const publicHttpsUrlSchema = nonBlankStringSchema
  .max(2_048)
  .refine(
    (value) => parsePublicHttpsUrl(value) !== null,
    "value must be a public HTTPS URL without embedded credentials",
  );

const publicHttpsOriginSchema = publicHttpsUrlSchema.refine((value) => {
  const url = parsePublicHttpsUrl(value);
  return url !== null && url.origin === value;
}, "value must be a canonical public HTTPS origin");

const jsonObjectSchema = z
  .record(z.string(), z.unknown())
  .superRefine((value, context) => {
    if (!isCanonicalJsonValue(value)) {
      context.addIssue({
        code: "custom",
        message: "value must contain only finite, acyclic JSON data",
      });
      return;
    }
    if (JSON.stringify(value).length > 262_144) {
      context.addIssue({
        code: "too_big",
        maximum: 262_144,
        origin: "string",
        inclusive: true,
        message: "serialized value exceeds 262144 characters",
      });
    }
  });

const deliveredContentSchema = z.string().max(1_048_576);

export const certifiedCapabilityInterfaceSchema = z.discriminatedUnion(
  "surface",
  [
    z.strictObject({
      surface: z.literal("context"),
      kind: z.enum(["prompt", "skill", "instructions"]),
      name: identifierSchema,
    }),
    z.strictObject({
      surface: z.literal("tool"),
      name: callableNameSchema,
      description: boundedTextSchema.optional(),
      parameters: jsonObjectSchema,
      returns: jsonObjectSchema.optional(),
    }),
  ],
) satisfies z.ZodType<CertifiedCapabilityInterface>;

export const certifiedCapabilityAuthSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("none") }),
  z.strictObject({
    mode: z.literal("tangle-key"),
    origin: publicHttpsOriginSchema,
  }),
  z.strictObject({
    mode: z.literal("hub-connection"),
    providerId: identifierSchema,
    origin: publicHttpsOriginSchema,
    scopes: z.array(referenceSchema).max(256).optional(),
  }),
  z.strictObject({
    mode: z.literal("secret-ref"),
    key: referenceSchema,
    origin: publicHttpsOriginSchema,
  }),
]) satisfies z.ZodType<CertifiedCapabilityAuth>;

export const certifiedCapabilityBindingSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("inline"),
      content: deliveredContentSchema,
    }),
    z.strictObject({
      kind: z.literal("file"),
      path: relativePathSchema,
      content: deliveredContentSchema,
    }),
    z.strictObject({
      kind: z.literal("http"),
      url: publicHttpsUrlSchema,
      auth: certifiedCapabilityAuthSchema.optional(),
    }),
  ])
  .superRefine((binding, context) => {
    if (
      binding.kind === "http" &&
      binding.auth !== undefined &&
      binding.auth.mode !== "none" &&
      new URL(binding.url).origin !== binding.auth.origin
    ) {
      context.addIssue({
        code: "custom",
        path: ["auth", "origin"],
        message: "credential origin must match the HTTP destination",
      });
    }
  }) satisfies z.ZodType<CertifiedCapabilityBinding>;

export const certificationProvenanceSchema = z.strictObject({
  contentHash: sha256DigestSchema,
  version: z.number().int().positive().nullable(),
  promotedAt: z.iso.datetime(),
}) satisfies z.ZodType<CertificationProvenance>;

export const certifiedCapabilityProvenanceSchema =
  certificationProvenanceSchema.extend({
    sourcePath: relativePathSchema.nullable(),
  }) satisfies z.ZodType<CertifiedCapabilityProvenance>;

function jsonMaterial(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("certified profile material must be JSON serializable");
  }
  return JSON.parse(serialized) as unknown;
}

/** Compute the exact digest stored in a capability's provenance. */
export function certifiedCapabilityContentHash(
  capability: Pick<CertifiedCapability, "id" | "iface" | "binding">,
): Sha256Digest {
  return canonicalCandidateDigest(
    jsonMaterial({
      id: capability.id,
      iface: capability.iface,
      binding: capability.binding,
    }),
  );
}

const bindingKindsBySurface = {
  context: new Set<CertifiedCapabilityBinding["kind"]>(["inline", "file"]),
  tool: new Set<CertifiedCapabilityBinding["kind"]>(["http"]),
} as const;

export const certifiedCapabilitySchema = z
  .strictObject({
    id: identifierSchema,
    iface: certifiedCapabilityInterfaceSchema,
    binding: certifiedCapabilityBindingSchema,
    provenance: certifiedCapabilityProvenanceSchema,
  })
  .superRefine((capability, context) => {
    const supported = bindingKindsBySurface[capability.iface.surface];
    if (!supported.has(capability.binding.kind)) {
      context.addIssue({
        code: "custom",
        path: ["binding", "kind"],
        message: `${capability.iface.surface} capabilities do not support ${capability.binding.kind} bindings`,
      });
    }
    if (
      capability.iface.surface === "context" &&
      (capability.binding.kind === "inline" ||
        capability.binding.kind === "file") &&
      capability.binding.content.trim().length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["binding", "content"],
        message: "context capability content cannot be blank",
      });
    }
    let contentHash: Sha256Digest;
    try {
      contentHash = certifiedCapabilityContentHash(capability);
    } catch {
      context.addIssue({
        code: "custom",
        message: "capability must contain only finite, acyclic JSON data",
      });
      return;
    }
    if (capability.provenance.contentHash !== contentHash) {
      context.addIssue({
        code: "custom",
        path: ["provenance", "contentHash"],
        message: "capability content hash does not match the delivered capability",
      });
    }
  }) satisfies z.ZodType<CertifiedCapability>;

/** Compute the digest over a certified profile without its digest field. */
export function certifiedProfileDigest(
  profile: Omit<CertifiedProfile, "digest">,
): Sha256Digest {
  return canonicalCandidateDigest(jsonMaterial(profile));
}

export const certifiedProfileSchema = z
  .strictObject({
    target: identifierSchema,
    generatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    capabilities: z.array(certifiedCapabilitySchema).max(128),
    digest: sha256DigestSchema,
  })
  .superRefine((profile, context) => {
    const generatedAt = Date.parse(profile.generatedAt);
    const expiresAt = Date.parse(profile.expiresAt);
    if (expiresAt <= generatedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt must be after generatedAt",
      });
    } else if (expiresAt - generatedAt > MAX_CERTIFIED_PROFILE_LIFETIME_MS) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "certified profiles cannot live longer than 24 hours",
      });
    }

    let serializedLength: number;
    try {
      serializedLength = JSON.stringify(profile).length;
    } catch {
      context.addIssue({
        code: "custom",
        message: "profile must be JSON serializable",
      });
      return;
    }
    if (serializedLength > MAX_CERTIFIED_PROFILE_SERIALIZED_CHARS) {
      context.addIssue({
        code: "too_big",
        maximum: MAX_CERTIFIED_PROFILE_SERIALIZED_CHARS,
        origin: "string",
        inclusive: true,
        message: "serialized profile exceeds 16777216 characters",
      });
    }

    const ids = new Set<string>();
    const toolNames = new Set<string>();
    const filePaths = new Set<string>();
    for (const [index, capability] of profile.capabilities.entries()) {
      if (ids.has(capability.id)) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", index, "id"],
          message: `duplicate capability id: ${capability.id}`,
        });
      }
      ids.add(capability.id);

      if (capability.iface.surface === "tool") {
        if (toolNames.has(capability.iface.name)) {
          context.addIssue({
            code: "custom",
            path: ["capabilities", index, "iface", "name"],
            message: `duplicate tool name: ${capability.iface.name}`,
          });
        }
        toolNames.add(capability.iface.name);
      }

      if (capability.binding.kind === "file") {
        if (filePaths.has(capability.binding.path)) {
          context.addIssue({
            code: "custom",
            path: ["capabilities", index, "binding", "path"],
            message: `duplicate file path: ${capability.binding.path}`,
          });
        }
        filePaths.add(capability.binding.path);
      }

      if (Date.parse(capability.provenance.promotedAt) > generatedAt) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", index, "provenance", "promotedAt"],
          message: "capability cannot be promoted after profile generation",
        });
      }
    }

    const { digest: _digest, ...material } = profile;
    if (profile.digest !== certifiedProfileDigest(material)) {
      context.addIssue({
        code: "custom",
        path: ["digest"],
        message: "profile digest does not match the delivered profile",
      });
    }
  }) satisfies z.ZodType<CertifiedProfile>;

type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

const _certifiedCapabilityInterfaceSchemaMatches: MutuallyAssignable<
  z.infer<typeof certifiedCapabilityInterfaceSchema>,
  CertifiedCapabilityInterface
> = true;
const _certifiedCapabilityAuthSchemaMatches: MutuallyAssignable<
  z.infer<typeof certifiedCapabilityAuthSchema>,
  CertifiedCapabilityAuth
> = true;
const _certifiedCapabilityBindingSchemaMatches: MutuallyAssignable<
  z.infer<typeof certifiedCapabilityBindingSchema>,
  CertifiedCapabilityBinding
> = true;
const _certifiedCapabilitySchemaMatches: MutuallyAssignable<
  z.infer<typeof certifiedCapabilitySchema>,
  CertifiedCapability
> = true;
const _certifiedProfileSchemaMatches: MutuallyAssignable<
  z.infer<typeof certifiedProfileSchema>,
  CertifiedProfile
> = true;
void [
  _certifiedCapabilityInterfaceSchemaMatches,
  _certifiedCapabilityAuthSchemaMatches,
  _certifiedCapabilityBindingSchemaMatches,
  _certifiedCapabilitySchemaMatches,
  _certifiedProfileSchemaMatches,
];

export function parseCertifiedProfile(value: unknown): CertifiedProfile {
  return certifiedProfileSchema.parse(value);
}
