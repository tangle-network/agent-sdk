import { z } from "zod";
import {
  REASONING_EFFORTS,
  type AgentProfile,
  type AgentProfileConfigValue,
  type AgentProfileMcpServer,
} from "./agent-profile.js";
import type { AgentProfileDiff } from "./profile-diff.js";
import {
  environmentNameSchema,
  headerNameSchema,
  isSafeExecutable,
  isSafeRelativePath,
  isWellFormedUnicode,
  looksLikeCredential,
} from "./agent-candidate-schema-common.js";
import { harnessTypeSchema } from "./harness.js";
import {
  SANDBOX_SIZE_PRESET_NAMES,
  type SandboxSizePreset,
} from "./sandbox-size.js";

/**
 * Zod records currently assign parsed values onto an ordinary object. The
 * special own key `__proto__` therefore invokes the legacy prototype setter
 * and disappears instead of being validated. Encode every own key before Zod
 * sees it, then restore the exact UTF-16 key with defineProperty so all string
 * keys allowed by `Record<string, ...>` remain data rather than object syntax.
 */
function ownPropertyRecordSchema<ValueSchema extends z.ZodType>(
  valueSchema: ValueSchema,
): z.ZodType<Record<string, z.output<ValueSchema>>> {
  return z.preprocess(
    encodeOwnRecordKeys,
    z.record(
      z
        .string()
        .regex(
          /^u(?:[0-9a-f]{4})*$/,
          "record keys must contain valid Unicode",
        ),
      valueSchema,
    ).transform((record) => {
      const restored: Record<string, z.output<ValueSchema>> = {};
      for (const [encodedKey, value] of Object.entries(record)) {
        Object.defineProperty(restored, decodeRecordKey(encodedKey), {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return restored;
    }),
  ) as z.ZodType<Record<string, z.output<ValueSchema>>>;
}

function encodeOwnRecordKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const encoded: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    encoded[encodeRecordKey(key)] = entry;
  }
  return encoded;
}

function encodeRecordKey(value: string): string {
  let encoded = isWellFormedUnicode(value) ? "u" : "i";
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

function decodeRecordKey(value: string): string {
  let decoded = "";
  for (let index = 1; index < value.length; index += 4) {
    decoded += String.fromCharCode(
      Number.parseInt(value.slice(index, index + 4), 16),
    );
  }
  return decoded;
}

export const agentProfilePermissionValueSchema = z.enum([
  "allow",
  "deny",
  "ask",
]);

export const agentProfilePermissionSchema = z.union([
  agentProfilePermissionValueSchema,
  ownPropertyRecordSchema(agentProfilePermissionValueSchema),
]);

// Mirrors the canonical AgentProfileResourceRef (inline | github), kind-discriminated.
export const agentProfileResourceRefSchema = z.union([
  z.strictObject({
    kind: z.literal("inline"),
    name: z.string(),
    content: z.string(),
  }),
  z.strictObject({
    kind: z.literal("github"),
    repository: z.string().optional(),
    path: z.string(),
    ref: z.string().optional(),
    name: z.string().optional(),
  }),
]);

export const agentProfileFileMountSchema = z.strictObject({
  path: z.string(),
  resource: agentProfileResourceRefSchema,
  executable: z.boolean().optional(),
});

export const agentProfileResourcesSchema = z.strictObject({
  files: z.array(agentProfileFileMountSchema).optional(),
  tools: z.array(agentProfileResourceRefSchema).optional(),
  skills: z.array(agentProfileResourceRefSchema).optional(),
  agents: z.array(agentProfileResourceRefSchema).optional(),
  commands: z.array(agentProfileResourceRefSchema).optional(),
  instructions: z
    .union([z.string(), agentProfileResourceRefSchema])
    .optional(),
  failOnError: z.boolean().optional(),
});

export const reasoningEffortSchema = z.enum(REASONING_EFFORTS);

export const agentProfileModelHintsSchema = z.strictObject({
  default: z.string().optional(),
  small: z.string().optional(),
  provider: z.string().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  metadata: ownPropertyRecordSchema(z.unknown()).optional(),
});

export const agentProfilePromptSchema = z.strictObject({
  systemPrompt: z.string().optional(),
  instructions: z.array(z.string()).optional(),
});

const controlCharacterPattern = /[\u0000-\u001f\u007f]/;
const secretCapableNamePattern =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|credentials?|authorization|cookie|database[_-]?url|dsn|pat)(?:[_-]|$)/i;

const publicProfileConfigStringSchema = z
  .string()
  .refine(
    (value) =>
      isWellFormedUnicode(value) &&
      !controlCharacterPattern.test(value) &&
      !looksLikeCredential(value),
    "public profile config cannot carry credential-like material",
  );

const secretReferenceKeySchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      isWellFormedUnicode(value) &&
      !controlCharacterPattern.test(value) &&
      !looksLikeCredential(value),
    "secret reference key must be a public non-credential identity",
  );

export const agentProfilePublicConfigValueSchema = z.strictObject({
  kind: z.literal("public"),
  value: publicProfileConfigStringSchema,
});

export const agentProfileSecretRefSchema = z.strictObject({
  kind: z.literal("secret-ref"),
  key: secretReferenceKeySchema,
  format: z.enum(["raw", "bearer"]).optional(),
});

export const agentProfileConfigValueSchema = z.discriminatedUnion("kind", [
  agentProfilePublicConfigValueSchema,
  agentProfileSecretRefSchema,
]) satisfies z.ZodType<AgentProfileConfigValue>;

function profileConfigRecordSchema(keySchema: z.ZodString) {
  return ownPropertyRecordSchema(agentProfileConfigValueSchema).superRefine(
    (record, context) => {
      for (const [name, value] of Object.entries(record)) {
        const keyResult = keySchema.safeParse(name);
        if (!keyResult.success) {
          context.addIssue({
            code: "custom",
            path: [name],
            message: "profile config key is invalid for this field",
          });
        }
        if (
          value.kind === "public" &&
          secretCapableNamePattern.test(name)
        ) {
          context.addIssue({
            code: "custom",
            path: [name],
            message: "credential-bearing config names require a secret-ref",
          });
        }
      }
    },
  );
}

export const agentProfileEnvironmentSchema = profileConfigRecordSchema(
  environmentNameSchema,
);

export const agentProfileHeaderSchema = profileConfigRecordSchema(
  headerNameSchema,
);

export const agentSubagentProfileSchema = z.strictObject({
  description: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  tools: ownPropertyRecordSchema(z.boolean()).optional(),
  permissions: ownPropertyRecordSchema(agentProfilePermissionSchema).optional(),
  maxSteps: z.number().optional(),
  metadata: ownPropertyRecordSchema(z.unknown()).optional(),
});

export const agentProfileHookCommandSchema = z.strictObject({
  command: z.string(),
  timeoutMs: z.number().positive().optional(),
  blocking: z.boolean().optional(),
  matcher: z.string().optional(),
  env: agentProfileEnvironmentSchema.optional(),
});

export const agentProfileModeSchema = z.strictObject({
  description: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  tools: ownPropertyRecordSchema(z.boolean()).optional(),
  permissions: ownPropertyRecordSchema(agentProfilePermissionSchema).optional(),
  metadata: ownPropertyRecordSchema(z.unknown()).optional(),
});

export const agentProfileConfidentialSchema = z.strictObject({
  tee: z.string().optional(),
  attestationNonce: z.string().optional(),
  sealed: z.boolean().optional(),
  attestationRefresh: z.boolean().optional(),
});

const nonBlankMcpValueSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "value cannot be blank");

const remoteMcpUrlSchema = nonBlankMcpValueSchema.refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}, "remote MCP url must be an absolute HTTP(S) URL").refine(
  (value) => !looksLikeCredential(value),
  "remote MCP url cannot contain credentials or credential-named query parameters",
);

const agentProfileLocalMcpServerSchema = z.strictObject({
  transport: z.literal("stdio").optional(),
  command: nonBlankMcpValueSchema.refine(
    isSafeExecutable,
    "local MCP command must be a canonical public executable",
  ),
  args: z.array(agentProfileConfigValueSchema).optional(),
  env: agentProfileEnvironmentSchema.optional(),
  cwd: z
    .string()
    .refine(
      (value) => isSafeRelativePath(value, true),
      "local MCP cwd must be a canonical workspace-relative path",
    )
    .optional(),
  url: z.undefined().optional(),
  headers: z.undefined().optional(),
  enabled: z.literal(true).optional(),
  metadata: ownPropertyRecordSchema(z.unknown()).optional(),
});

const agentProfileRemoteMcpServerSchema = z.strictObject({
  transport: z.enum(["sse", "http"]).optional(),
  command: z.undefined().optional(),
  args: z.undefined().optional(),
  env: z.undefined().optional(),
  cwd: z.undefined().optional(),
  url: remoteMcpUrlSchema,
  headers: agentProfileHeaderSchema.optional(),
  enabled: z.literal(true).optional(),
  metadata: ownPropertyRecordSchema(z.unknown()).optional(),
});

const agentProfileDisabledMcpServerSchema = z.strictObject({
  enabled: z.literal(false),
  transport: z.undefined().optional(),
  command: z.undefined().optional(),
  args: z.undefined().optional(),
  env: z.undefined().optional(),
  cwd: z.undefined().optional(),
  url: z.undefined().optional(),
  headers: z.undefined().optional(),
  metadata: ownPropertyRecordSchema(z.unknown()).optional(),
});

export const agentProfileMcpServerSchema: z.ZodType<AgentProfileMcpServer> =
  z.union([
    agentProfileLocalMcpServerSchema,
    agentProfileRemoteMcpServerSchema,
    agentProfileDisabledMcpServerSchema,
  ]);

export const agentProfileConnectionSchema = z.strictObject({
  connectionId: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  alias: z.string().min(1).optional(),
});

const removeListSchema = z.union([z.literal(true), z.array(z.string().min(1))]);

export const agentProfilePromptRemovalSchema = z.strictObject({
  systemPrompt: z.literal(true).optional(),
  instructions: removeListSchema.optional(),
});

export const agentProfileResourceRemovalSchema = z.strictObject({
  files: removeListSchema.optional(),
  tools: removeListSchema.optional(),
  skills: removeListSchema.optional(),
  agents: removeListSchema.optional(),
  commands: removeListSchema.optional(),
  instructions: z.literal(true).optional(),
  failOnError: z.literal(true).optional(),
});

export const agentProfileDiffRemovalSchema = z.strictObject({
  identity: z.literal(true).optional(),
  tags: removeListSchema.optional(),
  prompt: z
    .union([z.literal(true), agentProfilePromptRemovalSchema])
    .optional(),
  model: removeListSchema.optional(),
  harness: z.literal(true).optional(),
  permissions: removeListSchema.optional(),
  tools: removeListSchema.optional(),
  mcp: removeListSchema.optional(),
  connections: removeListSchema.optional(),
  subagents: removeListSchema.optional(),
  resources: z
    .union([z.literal(true), agentProfileResourceRemovalSchema])
    .optional(),
  hooks: removeListSchema.optional(),
  modes: removeListSchema.optional(),
  confidential: z.literal(true).optional(),
  metadata: removeListSchema.optional(),
  extensions: removeListSchema.optional(),
});

/**
 * The complete provider-neutral agent profile schema — the runtime validator for
 * the canonical {@link AgentProfile} TS contract. Kept structurally in lock-step
 * with that interface by the compile-time guard at the bottom of this file.
 */
export const agentProfileSchema = z
  .strictObject({
    name: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
    tags: z.array(z.string()).optional(),
    prompt: agentProfilePromptSchema.optional(),
    model: agentProfileModelHintsSchema.optional(),
    harness: harnessTypeSchema.optional(),
    permissions: ownPropertyRecordSchema(agentProfilePermissionSchema).optional(),
    tools: ownPropertyRecordSchema(z.boolean()).optional(),
    mcp: ownPropertyRecordSchema(agentProfileMcpServerSchema).optional(),
    connections: z.array(agentProfileConnectionSchema).optional(),
    subagents: ownPropertyRecordSchema(agentSubagentProfileSchema).optional(),
    resources: agentProfileResourcesSchema.optional(),
    hooks: ownPropertyRecordSchema(
      z.array(agentProfileHookCommandSchema),
    ).optional(),
    modes: ownPropertyRecordSchema(agentProfileModeSchema).optional(),
    confidential: agentProfileConfidentialSchema.optional(),
    metadata: ownPropertyRecordSchema(z.unknown()).optional(),
    extensions: ownPropertyRecordSchema(
      z.union([ownPropertyRecordSchema(z.unknown()), z.undefined()]),
    ).optional(),
  })
  .superRefine((profile, context) => {
    validateNestedRecordKeys(profile, context, [], new Set<object>());
  });

function validateNestedRecordKeys(
  value: unknown,
  context: z.RefinementCtx,
  path: PropertyKey[],
  seen: Set<object>,
): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    if (!isWellFormedUnicode(key)) {
      context.addIssue({
        code: "custom",
        path: [...path, key],
        message: "record keys must contain valid Unicode",
      });
    }
    validateNestedRecordKeys(entry, context, [...path, key], seen);
  }
}

export const agentProfileDiffSchema: z.ZodType<AgentProfileDiff> = z.strictObject(
  {
    kind: z.literal("agent-profile-diff"),
    id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    rationale: z.string().optional(),
    source: z
      .strictObject({
        kind: z.enum([
          "trace",
          "frontier-author",
          "human",
          "optimizer",
          "compound",
        ]),
        artifacts: z.array(z.string().min(1)).optional(),
        notes: z.array(z.string()).optional(),
      })
      .optional(),
    set: agentProfileSchema.optional(),
    remove: agentProfileDiffRemovalSchema.optional(),
    metadata: ownPropertyRecordSchema(z.unknown()).optional(),
  },
);

// ── Compile-time drift guard ──────────────────────────────────────────────────
// The Zod schema and the hand-written {@link AgentProfile} interface must agree in
// BOTH directions. If either drifts (a field added to one only, an incompatible
// type), `tsc` fails here — the guard that was missing when the two silently
// diverged. Bidirectional assignability (not nominal identity) is the contract.
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const _agentProfileSchemaMatchesInterface: MutuallyAssignable<
  z.infer<typeof agentProfileSchema>,
  AgentProfile
> = true;
void _agentProfileSchemaMatchesInterface;

/**
 * A registered capability: a stable id paired with its canonical
 * {@link AgentProfile}. `definition` is the full profile (prompt/model/tools/
 * mcp/permissions), so a capability carries the whole agent shape, not just a
 * system prompt. The platform capability registry validates and stores these.
 */
export interface Capability {
  /** Stable, deterministic id — the key a workflow's `agent.run.profile` names. */
  id: string;
  /** The canonical agent profile (prompt/model/tools/mcp/permissions). */
  definition: AgentProfile;
  /**
   * Recommended compute tier for a sandbox running this capability. A dispatcher
   * uses it as the size DEFAULT when the caller does not pick one — so a
   * capability that only ever does thin work defaults to a small box instead of
   * a maxed one. The caller may always override it per dispatch. Omitted → the
   * dispatcher's own default tier.
   */
  recommendedSize?: SandboxSizePreset;
}

export const capabilitySchema: z.ZodType<Capability> = z.strictObject({
    id: z.string().min(1),
    definition: agentProfileSchema as z.ZodType<AgentProfile>,
    recommendedSize: z.enum(SANDBOX_SIZE_PRESET_NAMES).optional(),
});
