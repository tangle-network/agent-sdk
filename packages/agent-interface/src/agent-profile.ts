/**
 * Provider-neutral agent profile types for public SDK consumers.
 *
 * These model portable agent intent at the application boundary. Individual
 * backends translate this shape into their own native profile/configuration
 * formats internally. This is the canonical home; `@tangle-network/sandbox`
 * re-exports these symbols for backward compatibility.
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
    repository: options.repository,
    path,
    ref: options.ref,
    name: options.name,
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
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "ultracode";

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
 */
export interface AgentProfilePrompt {
  /**
   * Full system prompt replacement, when supported.
   */
  systemPrompt?: string;
  /**
   * Additional instruction lines appended to the active prompt.
   */
  instructions?: string[];
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
  env?: Record<string, string>;
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
  args?: string[];
  env?: Record<string, string>;
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
  headers?: Record<string, string>;
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
   * This is an optional PREFERENCE, not part of profile IDENTITY: the same
   * profile still runs on any harness, and an executor MAY override it (e.g. the
   * leaderboard's `harness × model` axis sweeps a profile across every harness,
   * and a supervisor spawning a worker may pick a harness per subtask). When
   * unset, the caller/executor chooses. Formalizes what runtimes already read as
   * `profile.harness`; making it typed also lets an improvement loop optimize
   * harness routing as a first-class lever.
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
 * Capabilities describing how a backend interprets AgentProfile.
 */
export interface AgentProfileCapabilities {
  namedProfiles: boolean;
  systemPrompt: boolean;
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

function mergeStringArrays(
  base: string[] | undefined,
  overlay: string[] | undefined,
): string[] | undefined {
  if (!base && !overlay) return undefined;
  return [...(base ?? []), ...(overlay ?? [])];
}

function mergeRecord<T extends Record<string, unknown>>(
  base: T | undefined,
  overlay: T | undefined,
): T | undefined {
  if (!base && !overlay) return undefined;
  return {
    ...(base ?? {}),
    ...(overlay ?? {}),
  } as T;
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
 * Overlay fields win on conflicts. Array-like instruction sets are appended.
 */
export function mergeAgentProfiles(
  base: AgentProfile | undefined,
  overlay: AgentProfile | undefined,
): AgentProfile | undefined {
  if (!base && !overlay) return undefined;

  const mergedPrompt =
    base?.prompt || overlay?.prompt
      ? {
          ...(base?.prompt ?? {}),
          ...(overlay?.prompt ?? {}),
          instructions: mergeStringArrays(
            base?.prompt?.instructions,
            overlay?.prompt?.instructions,
          ),
        }
      : undefined;

  const mergedResources =
    base?.resources || overlay?.resources
      ? {
          ...(base?.resources ?? {}),
          ...(overlay?.resources ?? {}),
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
        }
      : undefined;

  return {
    ...(base ?? {}),
    ...(overlay ?? {}),
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
  };
}
