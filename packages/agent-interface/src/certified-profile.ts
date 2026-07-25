import { z } from "zod";
import type { AgentProfileDiff } from "./profile-diff.js";
import { agentProfileDiffSchema } from "./profile-schema.js";

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
    }
  | {
      surface: "mcp";
      serverName: string;
      toolset?: string[];
    };

export type CertifiedCapabilityAuth =
  | { mode: "none" }
  | { mode: "tangle-key" }
  | { mode: "hub-connection"; providerId: string; scopes?: string[] }
  | { mode: "secret-ref"; key: string };

export type CertifiedCapabilityBinding =
  | { kind: "inline"; content: string }
  | { kind: "file"; path: string; content: string; executable?: boolean }
  | {
      kind: "http";
      url: string;
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      auth?: CertifiedCapabilityAuth;
    }
  | {
      kind: "mcp-stdio";
      command: string;
      args?: string[];
      cwd?: string;
    }
  | {
      kind: "mcp-remote";
      url: string;
      transport: "http" | "sse";
      auth?: CertifiedCapabilityAuth;
    };

export interface CertificationProvenance {
  contentHash: string;
  /** Positive release number, or null when the source has no released version. */
  version: number | null;
  lift: string | null;
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

export interface CertifiedProfileDiff {
  diff: AgentProfileDiff;
  provenance: CertificationProvenance;
}

/**
 * The exact response returned by the certified-profile delivery endpoint.
 * It contains only the current capability representation.
 */
export interface CertifiedProfile {
  target: string;
  generatedAt: string;
  capabilities: CertifiedCapability[];
  profileDiffs: CertifiedProfileDiff[];
}

const nonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "value cannot be blank");

const httpUrlSchema = nonBlankStringSchema.refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}, "value must be an absolute HTTP(S) URL");

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const certifiedCapabilityInterfaceSchema = z.discriminatedUnion(
  "surface",
  [
    z.strictObject({
      surface: z.literal("context"),
      kind: z.enum(["prompt", "skill", "instructions"]),
      name: nonBlankStringSchema,
    }),
    z.strictObject({
      surface: z.literal("tool"),
      name: nonBlankStringSchema,
      description: nonBlankStringSchema.optional(),
      parameters: jsonObjectSchema,
      returns: jsonObjectSchema.optional(),
    }),
    z.strictObject({
      surface: z.literal("mcp"),
      serverName: nonBlankStringSchema,
      toolset: z.array(nonBlankStringSchema).optional(),
    }),
  ],
) satisfies z.ZodType<CertifiedCapabilityInterface>;

export const certifiedCapabilityAuthSchema = z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("none") }),
    z.strictObject({ mode: z.literal("tangle-key") }),
    z.strictObject({
      mode: z.literal("hub-connection"),
      providerId: nonBlankStringSchema,
      scopes: z.array(nonBlankStringSchema).optional(),
    }),
    z.strictObject({
      mode: z.literal("secret-ref"),
      key: nonBlankStringSchema,
    }),
  ]) satisfies z.ZodType<CertifiedCapabilityAuth>;

export const certifiedCapabilityBindingSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("inline"),
      content: z.string(),
    }),
    z.strictObject({
      kind: z.literal("file"),
      path: nonBlankStringSchema,
      content: z.string(),
      executable: z.boolean().optional(),
    }),
    z.strictObject({
      kind: z.literal("http"),
      url: httpUrlSchema,
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      auth: certifiedCapabilityAuthSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal("mcp-stdio"),
      command: nonBlankStringSchema,
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
    }),
    z.strictObject({
      kind: z.literal("mcp-remote"),
      url: httpUrlSchema,
      transport: z.enum(["http", "sse"]),
      auth: certifiedCapabilityAuthSchema.optional(),
    }),
  ])
  .superRefine((binding, context) => {
    if (
      (binding.kind === "http" || binding.kind === "mcp-remote") &&
      binding.auth !== undefined &&
      binding.auth.mode !== "none" &&
      !isHttpsUrl(binding.url)
    ) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "authenticated remote bindings require HTTPS",
      });
    }
  }) satisfies z.ZodType<CertifiedCapabilityBinding>;

export const certificationProvenanceSchema = z.strictObject({
  contentHash: nonBlankStringSchema,
  version: z.number().int().positive().nullable(),
  lift: nonBlankStringSchema.nullable(),
  promotedAt: z.iso.datetime(),
}) satisfies z.ZodType<CertificationProvenance>;

export const certifiedCapabilityProvenanceSchema =
  certificationProvenanceSchema.extend({
    sourcePath: nonBlankStringSchema.nullable(),
  }) satisfies z.ZodType<CertifiedCapabilityProvenance>;

const bindingKindsBySurface = {
  context: new Set<CertifiedCapabilityBinding["kind"]>(["inline", "file"]),
  tool: new Set<CertifiedCapabilityBinding["kind"]>(["http"]),
  mcp: new Set<CertifiedCapabilityBinding["kind"]>([
    "mcp-stdio",
    "mcp-remote",
  ]),
} as const;

export const certifiedCapabilitySchema = z
  .strictObject({
    id: nonBlankStringSchema,
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
  }) satisfies z.ZodType<CertifiedCapability>;

export const certifiedProfileDiffSchema = z.strictObject({
  diff: agentProfileDiffSchema,
  provenance: certificationProvenanceSchema,
}) satisfies z.ZodType<CertifiedProfileDiff>;

export const certifiedProfileSchema = z
  .strictObject({
    target: nonBlankStringSchema,
    generatedAt: z.iso.datetime(),
    capabilities: z.array(certifiedCapabilitySchema),
    profileDiffs: z.array(certifiedProfileDiffSchema),
  })
  .superRefine((profile, context) => {
    const ids = new Set<string>();
    for (const [index, capability] of profile.capabilities.entries()) {
      if (ids.has(capability.id)) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", index, "id"],
          message: `duplicate capability id: ${capability.id}`,
        });
      }
      ids.add(capability.id);
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
const _certifiedProfileDiffSchemaMatches: MutuallyAssignable<
  z.infer<typeof certifiedProfileDiffSchema>,
  CertifiedProfileDiff
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
  _certifiedProfileDiffSchemaMatches,
  _certifiedProfileSchemaMatches,
];

export function parseCertifiedProfile(value: unknown): CertifiedProfile {
  return certifiedProfileSchema.parse(value);
}
