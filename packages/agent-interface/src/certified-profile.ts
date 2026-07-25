import { z } from "zod";
import type { AgentProfile } from "./agent-profile.js";
import type { AgentProfileDiff } from "./profile-diff.js";
import {
  agentProfileDiffSchema,
  agentProfileSchema,
} from "./profile-schema.js";

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
  agentProfileDiffs: CertifiedProfileDiff[];
  agentProfile: AgentProfile | null;
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

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const certifiedCapabilityInterfaceSchema: z.ZodType<CertifiedCapabilityInterface> =
  z.discriminatedUnion("surface", [
    z.strictObject({
      surface: z.literal("context"),
      kind: z.enum(["prompt", "skill", "instructions"]),
      name: nonBlankStringSchema,
    }),
    z.strictObject({
      surface: z.literal("tool"),
      name: nonBlankStringSchema,
      description: z.string().optional(),
      parameters: jsonObjectSchema,
      returns: jsonObjectSchema.optional(),
    }),
    z.strictObject({
      surface: z.literal("mcp"),
      serverName: nonBlankStringSchema,
      toolset: z.array(nonBlankStringSchema).optional(),
    }),
  ]);

export const certifiedCapabilityAuthSchema: z.ZodType<CertifiedCapabilityAuth> =
  z.discriminatedUnion("mode", [
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
  ]);

export const certifiedCapabilityBindingSchema: z.ZodType<CertifiedCapabilityBinding> =
  z.discriminatedUnion("kind", [
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
  ]);

export const certificationProvenanceSchema = z.strictObject({
  contentHash: nonBlankStringSchema,
  version: z.number().int().positive().nullable(),
  lift: z.string().nullable(),
  promotedAt: z.iso.datetime(),
});

export const certifiedCapabilityProvenanceSchema =
  certificationProvenanceSchema.extend({
    sourcePath: z.string().nullable(),
  });

const bindingKindsBySurface = {
  context: new Set<CertifiedCapabilityBinding["kind"]>(["inline", "file"]),
  tool: new Set<CertifiedCapabilityBinding["kind"]>(["http"]),
  mcp: new Set<CertifiedCapabilityBinding["kind"]>([
    "mcp-stdio",
    "mcp-remote",
  ]),
} as const;

export const certifiedCapabilitySchema: z.ZodType<CertifiedCapability> =
  z
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
    });

export const certifiedProfileDiffSchema: z.ZodType<CertifiedProfileDiff> =
  z.strictObject({
    diff: agentProfileDiffSchema,
    provenance: certificationProvenanceSchema,
  });

export const certifiedProfileSchema: z.ZodType<CertifiedProfile> = z
  .strictObject({
    target: nonBlankStringSchema,
    generatedAt: z.iso.datetime(),
    capabilities: z.array(certifiedCapabilitySchema),
    agentProfileDiffs: z.array(certifiedProfileDiffSchema),
    agentProfile: agentProfileSchema.nullable(),
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

    if (
      (profile.agentProfileDiffs.length === 0) !==
      (profile.agentProfile === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["agentProfile"],
        message:
          "agentProfile must be null exactly when agentProfileDiffs is empty",
      });
    }
  });

export function parseCertifiedProfile(value: unknown): CertifiedProfile {
  return certifiedProfileSchema.parse(value);
}
