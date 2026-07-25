import { z } from "zod";
import {
  isCanonicalJsonValue,
  isSafeExecutable,
  isSafeRelativePath,
} from "./agent-candidate-schema-common.js";
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

const identifierSchema = nonBlankStringSchema.max(256);

const callableNameSchema = nonBlankStringSchema.refine(
  (value) => /^[A-Za-z0-9_-]{1,64}$/.test(value),
  "value must be a portable callable name",
);

const relativePathSchema = nonBlankStringSchema
  .max(1024)
  .refine(
    (value) => isSafeRelativePath(value, false),
    "value must be a canonical relative path",
  );

const executableSchema = nonBlankStringSchema
  .max(1024)
  .refine(
    isSafeExecutable,
    "value must be a canonical non-shell executable",
  );

const httpUrlSchema = nonBlankStringSchema
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "value must be an absolute HTTP(S) URL")
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.username === "" && url.password === "";
    } catch {
      return true;
    }
  }, "URL credentials are not allowed");

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

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
      description: nonBlankStringSchema.optional(),
      parameters: jsonObjectSchema,
      returns: jsonObjectSchema.optional(),
    }),
    z.strictObject({
      surface: z.literal("mcp"),
      serverName: callableNameSchema,
      toolset: z
        .array(callableNameSchema)
        .max(256)
        .refine(
          (names) => new Set(names).size === names.length,
          "toolset names must be unique",
        )
        .optional(),
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
      content: deliveredContentSchema,
    }),
    z.strictObject({
      kind: z.literal("file"),
      path: relativePathSchema,
      content: deliveredContentSchema,
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
      command: executableSchema,
      args: z.array(z.string().max(16_384)).max(256).optional(),
      cwd: z
        .string()
        .refine(
          (value) => isSafeRelativePath(value, true),
          "value must be a canonical relative path",
        )
        .optional(),
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
  promotedAt: z.iso.datetime(),
}) satisfies z.ZodType<CertificationProvenance>;

export const certifiedCapabilityProvenanceSchema =
  certificationProvenanceSchema.extend({
    sourcePath: relativePathSchema.nullable(),
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
  }) satisfies z.ZodType<CertifiedCapability>;

export const certifiedProfileDiffSchema = z.strictObject({
  diff: agentProfileDiffSchema,
  provenance: certificationProvenanceSchema,
}) satisfies z.ZodType<CertifiedProfileDiff>;

export const certifiedProfileSchema = z
  .strictObject({
    target: identifierSchema,
    generatedAt: z.iso.datetime(),
    capabilities: z.array(certifiedCapabilitySchema).max(512),
    profileDiffs: z.array(certifiedProfileDiffSchema).max(512),
  })
  .superRefine((profile, context) => {
    const ids = new Set<string>();
    const toolNames = new Set<string>();
    const serverNames = new Set<string>();
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

      if (capability.iface.surface === "mcp") {
        if (serverNames.has(capability.iface.serverName)) {
          context.addIssue({
            code: "custom",
            path: ["capabilities", index, "iface", "serverName"],
            message: `duplicate MCP server name: ${capability.iface.serverName}`,
          });
        }
        serverNames.add(capability.iface.serverName);
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
