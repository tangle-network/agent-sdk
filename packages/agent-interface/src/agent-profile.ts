/**
 * Provider-neutral agent profile types for public SDK consumers.
 *
 * These model portable agent intent at the application boundary. Individual
 * backends translate this shape into their own native profile/configuration
 * formats internally. Profile content participates in unsalted public identity.
 * Prompts, resources, metadata, commands, paths, and secret-reference keys are
 * caller-declared public data; recognizable credential patterns are refused as
 * defense in depth, not as proof that arbitrary text is non-secret. MCP and hook
 * secret-capable fields structurally require tagged public values or opaque
 * secret references, which a private executor resolves only after identity is
 * fixed. This package is the canonical public home for these symbols.
 */

import type { HarnessType } from "./harness.js";

/**
 * Permission policy value for a capability.
 */
export type AgentProfilePermissionValue = "allow" | "ask" | "deny";

export type AgentProfilePermission =
  | AgentProfilePermissionValue
  | Record<string, AgentProfilePermissionValue>;

/**
 * Generic resource reference that can be resolved into a file or instruction.
 */
export type AgentProfileResourceRef =
  | {
      kind: "inline";
      name: string;
      content: string;
    }
  | {
      kind: "github";
      /**
       * Optional repository in "owner/repo" form. When omitted, providers may
       * only resolve the path if they have an ambient repository context.
       */
      repository?: string;
      path: string;
      ref?: string;
      name?: string;
    };

/**
 * Helper for creating typed inline resource refs.
 */
export function defineInlineResource(
  name: string,
  content: string,
): AgentProfileResourceRef {
  return { kind: "inline", name, content };
}

/**
 * Helper for creating typed GitHub-backed resource refs.
 */
export function defineGitHubResource(
  path: string,
  options: { repository?: string; ref?: string; name?: string } = {},
): AgentProfileResourceRef {
  return {
    kind: "github",
    path,
    ...(options.repository === undefined
      ? {}
      : { repository: options.repository }),
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    ...(options.name === undefined ? {} : { name: options.name }),
  };
}

/**
 * Resource mounted into a backend workspace.
 */
export interface AgentProfileFileMount {
  path: string;
  resource: AgentProfileResourceRef;
  executable?: boolean;
}

/**
 * Provider-neutral resource bundle.
 */
export interface AgentProfileResources {
  /**
   * Generic files to materialize into the agent workspace before execution.
   */
  files?: AgentProfileFileMount[];
  /**
   * Provider-native tool files. Backends materialize these into their standard
   * discovery location when they support file-based tools.
   */
  tools?: AgentProfileResourceRef[];
  /**
   * Agent Skills (`SKILL.md`) packages. Supported by Cursor, Claude Code,
   * Codex-compatible layouts, OpenCode, and Hermes-style skill harnesses.
   */
  skills?: AgentProfileResourceRef[];
  /**
   * Provider-native subagent definition files.
   */
  agents?: AgentProfileResourceRef[];
  /**
   * Provider-native slash command files.
   */
  commands?: AgentProfileResourceRef[];
  /**
   * Additional instructions injected into the agent context.
   */
  instructions?: string | AgentProfileResourceRef;
  /**
   * Fail initialization when a provider cannot materialize a resource.
   */
  failOnError?: boolean;
}

/**
 * Portable reasoning/thinking effort. Backends map it to their native control at materialization:
 * codex `model_reasoning_effort`, kimi `--thinking`/`--no-thinking`, claude thinking budget.
 * Ordered low→high:
 *   - `none`     — extended thinking OFF (no reasoning budget at all)
 *   - `minimal`  — thinking ON, the lowest budget (distinct from `none`)
 *   - `low` / `medium` / `high` / `xhigh`
 *   - `ultracode` — maximum (Claude Code's `max` and Codex's `ultra` reconcile here).
 * A backend without a matching native tier may clamp down to its strongest supported level, but it
 * must never turn reasoning on for `none` or silently increase a requested effort.
 */
export const REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
] as const);

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Model selection hints for backends.
 */
export interface AgentProfileModelHints {
  /**
   * Preferred default model (format depends on backend, commonly "provider/model").
   */
  default?: string;
  /**
   * Preferred small/cheap model for lightweight work.
   */
  small?: string;
  /**
   * Optional provider preference hint.
   */
  provider?: string;
  /**
   * Reasoning/thinking effort hint — a first-class, portable model dimension (not buried in
   * `extensions`). Backends map it to their native control at materialization.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Backend-agnostic model metadata/hints.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Prompt shaping for an agent.
 *
 * Replacement and addition are two different intents against the same channel
 * and are never interchangeable. A backend that can only do one of them must
 * refuse the other rather than substituting it, which is why
 * {@link AgentProfileCapabilities.systemPrompt} carries a separate bit for each.
 *
 * Setting `systemPrompt` and `appendSystemPrompt` together is legal and ordered:
 * the replacement is installed first and the addition composes on top of it, so
 * the effective prompt is `systemPrompt` then `appendSystemPrompt`. The pair is
 * deliberately allowed because {@link mergeAgentProfiles} composes the two
 * fields independently — refusing it would let two individually valid profiles
 * merge into an invalid one.
 */
export interface AgentProfilePrompt {
  /**
   * REPLACE the harness's own system prompt with this text.
   *
   * The harness's built-in prompt is DELETED, not extended: the model stops
   * receiving the tool descriptions, output conventions, refusal rules, and
   * workflow scaffolding it was tuned against, so behavior can move far beyond
   * the words written here. Supply a prompt that stands on its own.
   *
   * Honored only where {@link AgentProfileSystemPromptCapability.replace} is
   * true — a harness that exposes a real replacement control (`pi
   * --system-prompt <file>` with context files, skills, and prompt templates
   * off; gemini `.gemini/system.md` with `GEMINI_SYSTEM_MD=1`). A backend that
   * can only add text must reject this field. Folding it into an addition is a
   * silent semantic downgrade: the instructions the caller asked to delete stay
   * in force, and nothing in the result says so.
   */
  systemPrompt?: string;
  /**
   * ADD this text to the harness's own system prompt, which stays intact.
   *
   * The model keeps everything it was tuned against and receives this on top,
   * in the same privileged position as the system prompt. Maps to claude-code
   * `--append-system-prompt`, and to a leading `role: "system"` message on
   * harnesses that take a message list.
   *
   * Distinct from {@link AgentProfilePrompt.instructions}, which harnesses
   * materialize into their lower-privilege project-instruction surface.
   *
   * Honored only where {@link AgentProfileSystemPromptCapability.append} is
   * true.
   */
  appendSystemPrompt?: string;
  /**
   * Additional instruction lines composed into the agent's project-instruction
   * surface — the harness's `AGENTS.md` / `CLAUDE.md`-style files or its own
   * caller-instruction preamble. Lower privilege than
   * {@link AgentProfilePrompt.appendSystemPrompt} and placed wherever the
   * harness keeps caller instructions rather than in the system prompt.
   */
  instructions?: string[];
}

/** Deliberately public configuration included in profile identity. */
export interface AgentProfilePublicConfigValue {
  kind: "public";
  value: string;
}

/**
 * Opaque reference resolved only inside the private prepared executor.
 * `key` is caller-declared public identity naming provider/operator-owned
 * secret material; callers must not put the secret value in it.
 */
export interface AgentProfileSecretRef {
  kind: "secret-ref";
  key: string;
  /** Apply no decoration or a `Bearer ` prefix after private resolution. */
  format?: "raw" | "bearer";
}

/** A configuration value is public bytes or an opaque secret identity. */
export type AgentProfileConfigValue =
  | AgentProfilePublicConfigValue
  | AgentProfileSecretRef;

/**
 * Private executor port for resolving one public secret-reference identity.
 * Implementations return the raw undecorated value. Consumers must fail
 * preparation on missing or blank values and must keep resolved values out of
 * profiles, public plans, digests, receipts, diagnostics, and logs.
 */
export interface AgentProfileSecretProvider {
  get(key: string): Promise<string | undefined>;
}

/** Mark an exact configuration value as public profile material. */
export function defineAgentProfilePublicConfig(
  value: string,
): AgentProfilePublicConfigValue {
  return { kind: "public", value };
}

/** Create a secret reference whose key is caller-declared public identity. */
export function defineAgentProfileSecretRef(
  key: string,
  format?: AgentProfileSecretRef["format"],
): AgentProfileSecretRef {
  return {
    kind: "secret-ref",
    key,
    ...(format === undefined ? {} : { format }),
  };
}

/**
 * Generic subagent definition.
 */
export interface AgentSubagentProfile {
  description?: string;
  prompt?: string;
  model?: string;
  tools?: Record<string, boolean>;
  permissions?: Record<string, AgentProfilePermission>;
  maxSteps?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentProfileHookCommand {
  command: string;
  timeoutMs?: number;
  blocking?: boolean;
  matcher?: string;
  env?: Record<string, AgentProfileConfigValue>;
}

export interface AgentProfileMode {
  description?: string;
  model?: string;
  prompt?: string;
  tools?: Record<string, boolean>;
  permissions?: Record<string, AgentProfilePermission>;
  metadata?: Record<string, unknown>;
}

/**
 * Confidential-execution options for sandbox backends.
 *
 * The Tangle blueprint path translates this into TEE job parameters and fails
 * closed when the requested TEE is unavailable. Callers should verify returned
 * attestation evidence before treating a session as confidential.
 */
export interface AgentProfileConfidential {
  /**
   * TEE variant requested from the operator.
   */
  tee?: "tdx" | "nitro" | "phala-dstack" | "sev-snp" | "any" | (string & {});
  /**
   * Optional hex-encoded 32-64 byte challenge for deploy-time report data.
   */
  attestationNonce?: string;
  /**
   * Require no persistence across session end when supported by the backend.
   */
  sealed?: boolean;
  /**
   * Ask the SDK/backend to create or require a fresh attestation challenge.
   */
  attestationRefresh?: boolean;
}

/**
 * Generic MCP server configuration.
 */
interface AgentProfileMcpServerBase {
  metadata?: Record<string, unknown>;
}

interface AgentProfileLocalMcpServer extends AgentProfileMcpServerBase {
  enabled?: true;
  transport?: "stdio";
  command: string;
  args?: AgentProfileConfigValue[];
  env?: Record<string, AgentProfileConfigValue>;
  cwd?: string;
  url?: never;
  headers?: never;
}

interface AgentProfileRemoteMcpServer extends AgentProfileMcpServerBase {
  enabled?: true;
  transport?: "sse" | "http";
  command?: never;
  args?: never;
  env?: never;
  cwd?: never;
  url: string;
  headers?: Record<string, AgentProfileConfigValue>;
}

interface AgentProfileDisabledMcpServer extends AgentProfileMcpServerBase {
  enabled: false;
  transport?: never;
  command?: never;
  args?: never;
  env?: never;
  cwd?: never;
  url?: never;
  headers?: never;
}

export type AgentProfileMcpServer =
  | AgentProfileLocalMcpServer
  | AgentProfileRemoteMcpServer
  | AgentProfileDisabledMcpServer;

/**
 * Hub-managed integration grant. The sandbox runtime resolves each declared
 * connection/capability pair into an MCP tool backed by Tangle Hub policy.
 */
export interface AgentProfileConnection {
  /**
   * Hub connection id selected by the user, for example a connected Gmail
   * account.
   */
  connectionId: string;
  /**
   * Capability paths explicitly granted to the agent.
   */
  capabilities: string[];
  /**
   * Optional MCP server alias. Must be unique after profile merge.
   */
  alias?: string;
}

/**
 * Public provider-neutral agent profile contract.
 */
export interface AgentProfile {
  name?: string;
  description?: string;
  version?: string;
  tags?: string[];
  prompt?: AgentProfilePrompt;
  model?: AgentProfileModelHints;
  /**
   * Preferred execution harness for this profile — the coding-CLI runtime that
   * materializes and runs it (`claude-code`, `codex`, `opencode`, `pi`, …).
   *
   * This optional authored preference participates in canonical profile
   * identity. An executor MAY override it for one run; the effective profile and
   * execution receipt then bind that override without changing what was
   * authored. When unset, the caller/executor chooses. Formalizes what runtimes
   * already read as `profile.harness`; making it typed also lets an improvement
   * loop optimize harness routing as a first-class lever.
   */
  harness?: HarnessType;
  permissions?: Record<string, AgentProfilePermission>;
  tools?: Record<string, boolean>;
  mcp?: Record<string, AgentProfileMcpServer>;
  connections?: AgentProfileConnection[];
  subagents?: Record<string, AgentSubagentProfile>;
  resources?: AgentProfileResources;
  hooks?: Record<string, AgentProfileHookCommand[]>;
  modes?: Record<string, AgentProfileMode>;
  confidential?: AgentProfileConfidential;
  metadata?: Record<string, unknown>;
  /**
   * Non-portable backend-specific extensions.
   *
   * Use this only for features that cannot be expressed generically.
   * SDK consumers should treat extension keys as backend namespaces.
   */
  extensions?: Record<string, Record<string, unknown> | undefined>;
}

/**
 * Helper for declaring typed profiles in application code.
 */
export function defineAgentProfile<T extends AgentProfile>(profile: T): T {
  return profile;
}

/**
 * What a backend can do to the harness's system prompt.
 *
 * Two independent bits, because most harnesses can do exactly one of them. A
 * single boolean cannot separate "I delete the built-in prompt and install
 * yours" from "I keep the built-in prompt and add yours to it", so a caller
 * reading it has no way to tell whether a requested replacement will actually
 * happen. Neither bit implies the other: declare each from what the backend's
 * materialization really does, not from whether it accepts the field.
 */
export interface AgentProfileSystemPromptCapability {
  /**
   * The backend honors {@link AgentProfilePrompt.systemPrompt} by deleting the
   * harness's own system prompt and installing the caller's. `false` means a
   * profile carrying `systemPrompt` must be REFUSED — never quietly added to
   * the built-in prompt instead.
   */
  replace: boolean;
  /**
   * The backend honors {@link AgentProfilePrompt.appendSystemPrompt} by keeping
   * the harness's own system prompt and adding the caller's text to it.
   */
  append: boolean;
}

/**
 * Capabilities describing how a backend interprets AgentProfile.
 */
export interface AgentProfileCapabilities {
  namedProfiles: boolean;
  systemPrompt: AgentProfileSystemPromptCapability;
  instructions: boolean;
  tools: boolean;
  permissions: boolean;
  mcp: boolean;
  subagents: boolean;
  resources: {
    files: boolean;
    instructions: boolean;
    tools?: boolean;
    skills?: boolean;
    agents?: boolean;
    commands?: boolean;
  };
  hooks?: boolean;
  modes?: boolean;
  runtimeUpdate: boolean;
  validation: boolean;
  /**
   * Backend extension namespaces understood by this backend.
   */
  extensions?: string[];
}

/**
 * Validation issue for a profile/backend pairing.
 */
export interface AgentProfileValidationIssue {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
}

/**
 * Validation output for a provider adapter.
 */
export interface AgentProfileValidationResult {
  ok: boolean;
  issues: AgentProfileValidationIssue[];
  normalizedProfile?: AgentProfile;
}

/**
 * Layer objects the way a spread would, except that an `undefined` entry means
 * "not specified" and is never written to the result.
 *
 * Profile identity is an RFC 8785 digest over the profile, and canonicalization
 * enumerates own keys: `{ tools: undefined }` is a different document from `{}`,
 * so writing a key with no value moves the digest of a profile whose content did
 * not change, or is refused outright by the canonical JSON domain. Later sources
 * therefore win only where they carry a value; removal is expressed through
 * {@link AgentProfileDiff}'s `remove` channel, never by overlaying `undefined`.
 */
function assignDefined<T extends object>(
  ...sources: readonly (Partial<T> | undefined)[]
): Partial<T> {
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    if (source === undefined) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged as Partial<T>;
}

function mergeStringArrays(
  base: string[] | undefined,
  overlay: string[] | undefined,
): string[] | undefined {
  if (!base && !overlay) return undefined;
  return [...(base ?? []), ...(overlay ?? [])];
}

/**
 * Additive prompt text composes instead of overwriting: an overlay that adds
 * one line must not delete what the base added. `systemPrompt` keeps
 * overlay-wins semantics because two replacements cannot both apply, while two
 * additions always can. An explicitly empty addition contributes no separator.
 */
function mergeAppendedSystemPrompts(
  base: string | undefined,
  overlay: string | undefined,
): string | undefined {
  if (base === undefined || base === "") return overlay ?? base;
  if (overlay === undefined || overlay === "") return base;
  return `${base}\n\n${overlay}`;
}

function mergeRecord<T extends Record<string, unknown>>(
  base: T | undefined,
  overlay: T | undefined,
): T | undefined {
  if (!base && !overlay) return undefined;
  return assignDefined<T>(base, overlay) as T;
}

function mergeOptionalArrays<T>(
  base: T[] | undefined,
  overlay: T[] | undefined,
): T[] | undefined {
  if (!base && !overlay) return undefined;
  return [...(base ?? []), ...(overlay ?? [])];
}

/**
 * Merge two public AgentProfile values.
 *
 * Overlay fields win on conflicts, but only where they carry a value: an
 * `undefined` entry reads as "not specified" and keeps the base value, because
 * removal is the `remove` channel's job on {@link AgentProfileDiff}. Keys that
 * resolve to nothing are omitted rather than written as `undefined` — RFC 8785
 * canonicalization enumerates own keys, so a present-but-undefined key is a
 * different document from an absent one.
 *
 * Additive fields compose instead of overwriting: array-like instruction sets
 * are concatenated, and `prompt.appendSystemPrompt` values are joined
 * base-first with a blank line between them.
 */
export function mergeAgentProfiles(
  base: AgentProfile | undefined,
  overlay: AgentProfile | undefined,
): AgentProfile | undefined {
  if (!base && !overlay) return undefined;

  const mergedPrompt =
    base?.prompt || overlay?.prompt
      ? assignDefined<AgentProfilePrompt>(base?.prompt, overlay?.prompt, {
          appendSystemPrompt: mergeAppendedSystemPrompts(
            base?.prompt?.appendSystemPrompt,
            overlay?.prompt?.appendSystemPrompt,
          ),
          instructions: mergeStringArrays(
            base?.prompt?.instructions,
            overlay?.prompt?.instructions,
          ),
        })
      : undefined;

  const mergedResources =
    base?.resources || overlay?.resources
      ? assignDefined<AgentProfileResources>(
          base?.resources,
          overlay?.resources,
          {
            files: mergeOptionalArrays(
              base?.resources?.files,
              overlay?.resources?.files,
            ),
            tools: mergeOptionalArrays(
              base?.resources?.tools,
              overlay?.resources?.tools,
            ),
            skills: mergeOptionalArrays(
              base?.resources?.skills,
              overlay?.resources?.skills,
            ),
            agents: mergeOptionalArrays(
              base?.resources?.agents,
              overlay?.resources?.agents,
            ),
            commands: mergeOptionalArrays(
              base?.resources?.commands,
              overlay?.resources?.commands,
            ),
            instructions:
              overlay?.resources?.instructions ?? base?.resources?.instructions,
          },
        )
      : undefined;

  return assignDefined<AgentProfile>(base, overlay, {
    prompt: mergedPrompt,
    permissions: mergeRecord(base?.permissions, overlay?.permissions),
    tools: mergeRecord(base?.tools, overlay?.tools),
    mcp: mergeRecord(base?.mcp, overlay?.mcp),
    connections: mergeOptionalArrays(base?.connections, overlay?.connections),
    subagents: mergeRecord(base?.subagents, overlay?.subagents),
    resources: mergedResources,
    hooks: mergeRecord(base?.hooks, overlay?.hooks),
    modes: mergeRecord(base?.modes, overlay?.modes),
    metadata: mergeRecord(base?.metadata, overlay?.metadata),
    extensions: mergeRecord(base?.extensions, overlay?.extensions),
  });
}
