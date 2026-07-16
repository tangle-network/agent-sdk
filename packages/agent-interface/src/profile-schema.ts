import { z } from "zod";
import type {
  AgentProfile,
  AgentProfileMcpServer,
} from "./agent-profile.js";
import type { AgentProfileDiff } from "./profile-diff.js";
import { harnessTypeSchema } from "./harness.js";
import {
  SANDBOX_SIZE_PRESET_NAMES,
  type SandboxSizePreset,
} from "./sandbox-size.js";

export const agentProfilePermissionValueSchema = z.enum([
  "allow",
  "deny",
  "ask",
]);

export const agentProfilePermissionSchema = z.union([
  agentProfilePermissionValueSchema,
  z.record(z.string(), agentProfilePermissionValueSchema),
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

export const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
]);

export const agentProfileModelHintsSchema = z.strictObject({
  default: z.string().optional(),
  small: z.string().optional(),
  provider: z.string().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const agentProfilePromptSchema = z.strictObject({
  systemPrompt: z.string().optional(),
  instructions: z.array(z.string()).optional(),
});

export const agentSubagentProfileSchema = z.strictObject({
  description: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  permissions: z.record(z.string(), agentProfilePermissionSchema).optional(),
  maxSteps: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const agentProfileHookCommandSchema = z.strictObject({
  command: z.string(),
  timeoutMs: z.number().positive().optional(),
  blocking: z.boolean().optional(),
  matcher: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const agentProfileModeSchema = z.strictObject({
  description: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  permissions: z.record(z.string(), agentProfilePermissionSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
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
}, "remote MCP url must be an absolute HTTP(S) URL");

const agentProfileLocalMcpServerSchema = z.strictObject({
  transport: z.literal("stdio").optional(),
  command: nonBlankMcpValueSchema,
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  url: z.undefined().optional(),
  headers: z.undefined().optional(),
  enabled: z.literal(true).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const agentProfileRemoteMcpServerSchema = z.strictObject({
  transport: z.enum(["sse", "http"]).optional(),
  command: z.undefined().optional(),
  args: z.undefined().optional(),
  env: z.undefined().optional(),
  cwd: z.undefined().optional(),
  url: remoteMcpUrlSchema,
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.literal(true).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
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
  metadata: z.record(z.string(), z.unknown()).optional(),
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
export const agentProfileSchema = z.strictObject({
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  tags: z.array(z.string()).optional(),
  prompt: agentProfilePromptSchema.optional(),
  model: agentProfileModelHintsSchema.optional(),
  harness: harnessTypeSchema.optional(),
  permissions: z.record(z.string(), agentProfilePermissionSchema).optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  mcp: z.record(z.string(), agentProfileMcpServerSchema).optional(),
  connections: z.array(agentProfileConnectionSchema).optional(),
  subagents: z.record(z.string(), agentSubagentProfileSchema).optional(),
  resources: agentProfileResourcesSchema.optional(),
  hooks: z
    .record(z.string(), z.array(agentProfileHookCommandSchema))
    .optional(),
  modes: z.record(z.string(), agentProfileModeSchema).optional(),
  confidential: agentProfileConfidentialSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  extensions: z
    .record(
      z.string(),
      z.union([z.record(z.string(), z.unknown()), z.undefined()]),
    )
    .optional(),
});

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
    metadata: z.record(z.string(), z.unknown()).optional(),
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
