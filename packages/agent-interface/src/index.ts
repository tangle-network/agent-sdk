/**
 * Agent Interface
 *
 * Shared types and interfaces for SDK provider adapters.
 * This package defines the contract between the sidecar and provider implementations.
 */

import type { InteractionRequest, InteractionResponse } from "./interaction.js";
import type {
  AgentExecutionOutcome,
  DurablePlan,
  PlanContinuation,
  SdkPlanHost,
} from "./plan.js";
export type * from "./environment-provider.js";
export * from "./plan.js";

// Capabilities describe what a provider supports
export type BackendCapabilities = {
  streaming: boolean;
  toolUse: boolean;
  reasoning: boolean;
  multimodal: boolean;
  contextWindow: number;
  /**
   * Interaction kinds this provider can originate (e.g. `["question",
   * "permission"]`). Empty/undefined means the provider never asks the user.
   * Consumers use this to decide what human-in-the-loop UI to offer.
   */
  interactions?: string[];
};

/**
 * High-signal feature flags surfaced by each provider package. Routes
 * (chat-completions, responses) consume these to fail fast on
 * unsupported request shapes (vision against text-only providers,
 * `logprobs` against providers that never emit them, etc.) rather than
 * forwarding to a CLI that will silently drop the field.
 *
 * Each flag describes the provider's *general* capability — model-level
 * overrides (e.g. a non-vision Sonnet variant) belong on a runtime
 * resolution layer downstream.
 */
export type ProviderCapabilities = {
  /** Provider can accept image inputs (image_url / input_image parts). */
  supportsVision: boolean;
  /** Provider emits per-token logprobs in its event stream. */
  supportsLogprobs: boolean;
  /** Provider supports tool/function calling. */
  supportsToolCalls: boolean;
  /** Provider supports the Anthropic `computer` / OpenAI `computer_use_preview` tool. */
  supportsComputerUse: boolean;
};

// =============================================================================
// Part Types (matching OpenCode SDK)
// =============================================================================

/** Base fields shared by all parts */
export type PartBase = {
  id: string;
  sessionID: string;
  messageID: string;
};

/** Text part - contains message text content */
export type TextPart = PartBase & {
  type: "text";
  text: string;
};

/** Tool state variants - matches OpenCode's ToolState union */
export type ToolStatePending = {
  status: "pending";
  input: Record<string, unknown>;
  raw?: string;
};

export type ToolStateRunning = {
  status: "running";
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start: number };
};

export type ToolStateCompleted = {
  status: "completed";
  input: Record<string, unknown>;
  output: unknown;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: { start: number; end: number };
};

export type ToolStateError = {
  status: "error" | "failed"; // "failed" is our normalized form
  input: Record<string, unknown>;
  error?: string;
  output?: unknown;
  metadata?: Record<string, unknown>;
  time?: { start: number; end?: number };
};

/** Full tool state union */
export type ToolState =
  | ToolStatePending
  | ToolStateRunning
  | ToolStateCompleted
  | ToolStateError;

/** Tool part - contains tool execution state */
export type ToolPart = PartBase & {
  type: "tool";
  callID?: string;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
};

/** Reasoning part - contains model's thinking */
export type ReasoningPart = PartBase & {
  type: "reasoning";
  text: string;
};

/** File part - references a file */
export type FilePart = PartBase & {
  type: "file";
  filename?: string;
  mediaType?: string;
  url?: string;
};

/** Subtask part - represents a spawned sub-agent task */
export type SubtaskPart = PartBase & {
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
};

/** Union of all part types */
export type Part = TextPart | ToolPart | ReasoningPart | FilePart | SubtaskPart;

/** Helper to check part type */
export function isTextPart(part: Part): part is TextPart {
  return part.type === "text";
}

export function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool";
}

export function isReasoningPart(part: Part): part is ReasoningPart {
  return part.type === "reasoning";
}

export function isFilePart(part: Part): part is FilePart {
  return part.type === "file";
}

export function isSubtaskPart(part: Part): part is SubtaskPart {
  return part.type === "subtask";
}

// =============================================================================
// Input Part Types
// =============================================================================

export type InputTextPart = {
  type: "text";
  text: string;
};

export type InputFilePart = {
  type: "file";
  filename?: string;
  mediaType?: string;
  url?: string;
  path?: string;
  content?: string;
};

export type InputImagePart = {
  type: "image";
  filename?: string;
  mediaType?: string;
  url?: string;
  path?: string;
};

export type InputPart = InputTextPart | InputFilePart | InputImagePart;

export function isInputTextPart(part: InputPart): part is InputTextPart {
  return part.type === "text";
}

export function isInputFilePart(part: InputPart): part is InputFilePart {
  return part.type === "file";
}

export function isInputImagePart(part: InputPart): part is InputImagePart {
  return part.type === "image";
}

export function normalizeInputParts(input: {
  message?: string;
  parts?: InputPart[];
}): InputPart[] {
  if (Array.isArray(input.parts) && input.parts.length > 0) {
    return input.parts;
  }
  if (typeof input.message === "string" && input.message.length > 0) {
    return [{ type: "text", text: input.message }];
  }
  return [];
}

export function renderInputPartsAsText(parts: InputPart[]): string {
  const textParts: string[] = [];
  const attachmentRefs: string[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) textParts.push(part.text);
      continue;
    }

    const label =
      part.path ||
      part.filename ||
      part.url ||
      (part.type === "image" ? "image attachment" : "file attachment");
    attachmentRefs.push(
      `[${part.type === "image" ? "Image" : "File"}: ${label}]`,
    );
  }

  if (attachmentRefs.length === 0) {
    return textParts.join("\n\n").trim();
  }

  const text = textParts.join("\n\n").trim();
  const attachmentBlock = `Attached files:\n${attachmentRefs.join("\n")}`;
  return text ? `${text}\n\n${attachmentBlock}` : attachmentBlock;
}

// =============================================================================
// Stream Events
// =============================================================================

/**
 * The primary event for all part updates from OpenCode.
 * This is the canonical event - use this instead of legacy events.
 */
export type MessagePartUpdatedEvent = {
  type: "message.part.updated";
  /** The updated part (text, tool, reasoning, or file) */
  part: Part;
  /** Text delta for incremental updates (for text parts) */
  delta?: string;
};

/**
 * Stream events emitted during execution.
 *
 * PRIMARY: `message.part.updated` - the single canonical event for all part state changes.
 * Contains text deltas, tool state, reasoning content, and file references.
 */
export type StreamEvent =
  // === PRIMARY EVENT ===
  | MessagePartUpdatedEvent
  // === MONITORING EVENTS ===
  | {
      type: "tool-heartbeat";
      toolName: string;
      partId: string;
      elapsedMs: number;
    }
  | {
      type: "tool-slow";
      toolName: string;
      partId: string;
      elapsedMs: number;
      thresholdMs: number;
    }
  | {
      type: "model-processing";
      phase: "tool-result" | "generating" | "thinking";
      toolName?: string;
      elapsedMs?: number;
    }
  // === STATUS EVENTS ===
  | {
      type: "status";
      status: "started" | "processing" | "completed" | "failed";
      detail?: string;
    }
  | {
      type: "warning";
      code: string;
      message: string;
    }
  // === DEBUG EVENTS ===
  | {
      type: "raw";
      backend: string;
      event: unknown;
    }
  // === SESSION EVENTS ===
  | {
      type: "session.updated";
      sessionId: string;
      title?: string;
      time?: { created?: number; updated?: number };
    }
  // === INTERACTIVE EVENTS ===
  /** Agent asks the user; answered via `respondToInteraction`. The generalized
   * human-in-the-loop event (question, permission, plan, …). */
  | {
      type: "interaction";
      request: InteractionRequest;
    }
  /** Agent withdraws an outstanding interaction (no longer needs the answer). */
  | {
      type: "interaction.cancel";
      id: string;
      reason?: string;
    }
  /** A durable plan was committed. This event is observational, not a live ask. */
  | {
      type: "plan.submitted";
      plan: DurablePlan;
    };

export type ToolInvocation = {
  toolName: string;
  input: unknown;
  result?: unknown;
  /**
   * True when the tool call failed (errored, timed out, or was rejected).
   * Failed tools are recorded — not dropped — so the run outcome can reflect
   * them. Consumers deriving success must treat any `isError: true` invocation
   * as a failure signal.
   */
  isError?: boolean;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Reasoning/thinking tokens (separate from output tokens) */
  reasoningTokens?: number;
  /** Direct cost in USD from the provider (if available) */
  cost?: number;
};

export type ExecutionTiming = {
  startedAt: number;
  completedAt: number;
  durationMs: number;
};

export type AgentExecutionInput = {
  message?: string;
  parts?: InputPart[];
  systemPrompt: string;
  userId?: string;
  traceId?: string;
  sessionId?: string;
  workspaceRoot?: string;
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
  model?: ProviderConfig["model"];
  /**
   * Caller-supplied idempotency key for this turn. When set, the adapter
   * persists it on the assistant message and caches the final result; a
   * subsequent execute() with the same turnId returns the cached result
   * instead of re-issuing the upstream LLM call. Callers should generate a
   * fresh turnId per logical attempt and reuse the same id only for
   * client-initiated retries of the same intent.
   */
  turnId?: string;
  /** Server-owned continuation of a previously committed plan decision. */
  planContinuation?: PlanContinuation;
};

export type AgentExecutionResult = {
  outcome: AgentExecutionOutcome;
  text: string;
  toolInvocations: ToolInvocation[];
  reasoning?: string[];
  sessionId?: string;
  metadata?: Record<string, unknown>;
  tokenUsage?: TokenUsage;
  timing?: ExecutionTiming;
};

export type CliAuthFile = {
  /** Relative path under the runtime home directory, for example `.codex/auth.json`. */
  path: string;
  /** UTF-8 file content. */
  content: string;
  /** Optional file mode, defaults to 0600 when materialized. */
  mode?: number;
};

// Provider configuration - model and workspace settings
export type ProviderConfig = {
  model: {
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    maxThinkingTokens?: number;
    mode?: "api" | "cli";
    /** CLI auth mode for providers that support both API-key and OAuth flows. */
    authMode?: "api-key" | "oauth";
    /** Optional auth payloads to materialize under the runtime home directory. */
    authFiles?: CliAuthFile[];
  };
  server?: {
    port?: number;
    hostname?: string;
  };
  workspace?: {
    rootPath: string;
  };
  metadata?: Record<string, unknown>;
  /**
   * Inline profile configuration for agent customization.
   * Takes precedence over type-based profile resolution.
   * Uses Record<string, unknown> to avoid circular dependency with sdk-provider-opencode.
   */
  profile?: Record<string, unknown>;
};

/**
 * OpenAI-compatible model gateway defaults that a harness adapter can project
 * into its own env vars or config file without coupling to one concrete CLI.
 * Explicit user config must be applied before these defaults so customer-owned
 * workspace files and request fields keep precedence.
 */
export type ModelGatewayDefaults = {
  /** Stable provider id used by harness config files. */
  provider: string;
  /** Human-readable provider name. */
  name: string;
  /** Root router URL without an API-version suffix. */
  rootUrl: string;
  /** OpenAI-compatible base URL including the API-version suffix. */
  baseUrl: string;
  /** Default model id exposed by the gateway. */
  model: string;
  /** Env var read by generated config files for gateway auth. */
  apiKeyEnvVar: string;
};

export const TANGLE_ROUTER_DEFAULT_ROOT_URL = "https://router.tangle.tools";
export const TANGLE_ROUTER_DEFAULT_MODEL = "zai/glm-4.7";

/**
 * Normalizes an OpenAI-compatible base URL for SDKs that append
 * `/chat/completions` to the configured base. Existing `/vN` suffixes are
 * preserved so explicit `/v2` endpoints do not become `/v2/v1`.
 */
export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * Returns the platform model gateway defaults. Env overrides are read here so
 * every harness adapter shares the same dynamic seam.
 */
export function resolveTangleRouterDefaults(
  env: Record<string, string | undefined> = process.env,
): ModelGatewayDefaults {
  const rootUrl = env.TANGLE_ROUTER_URL || TANGLE_ROUTER_DEFAULT_ROOT_URL;
  return {
    provider: "openai-compat",
    name: env.TANGLE_ROUTER_PROVIDER_NAME || "Tangle Router",
    rootUrl,
    baseUrl: normalizeOpenAiCompatibleBaseUrl(
      env.TANGLE_ROUTER_BASE_URL || rootUrl,
    ),
    model: env.TANGLE_ROUTER_MODEL || TANGLE_ROUTER_DEFAULT_MODEL,
    apiKeyEnvVar: env.TANGLE_ROUTER_API_KEY_ENV || "OPENCODE_MODEL_API_KEY",
  };
}

/**
 * Applies gateway defaults to a provider model config. Existing fields win.
 */
export function withModelGatewayDefaults<T extends ProviderConfig["model"]>(
  model: T,
  defaults = resolveTangleRouterDefaults(),
): T {
  return {
    ...model,
    provider: model.provider || defaults.provider,
    model: model.model || defaults.model,
    baseUrl: model.baseUrl || defaults.baseUrl,
  };
}

/**
 * Enable/disable posture for a harness's built-in (native) web tools,
 * resolved from an AgentProfile `tools` map. `undefined` leaves the harness
 * default; an explicit boolean forces the tool on/off. Adapters translate
 * this into their native control so one profile directive governs native web
 * access uniformly: claude `--disallowed-tools WebSearch,WebFetch`, codex
 * `-c tools.web_search=<bool>`, opencode `tools.{websearch,webfetch}`.
 */
export type NativeWebToolPosture = {
  /** Web search tool (claude WebSearch, codex web_search, opencode websearch). */
  search?: boolean;
  /** Web fetch tool (claude WebFetch, opencode webfetch). codex has none. */
  fetch?: boolean;
};

// Canonical and per-harness spellings collapse to these, separator/case-insensitive.
const nativeWebSearchKeys = new Set(["websearch"]);
const nativeWebFetchKeys = new Set(["webfetch", "fetch"]);

/**
 * Map an AgentProfile `tools` map to a {@link NativeWebToolPosture}. Accepts
 * the canonical `web_search`/`web_fetch` as well as each harness's native
 * spelling (`WebSearch`, `webfetch`, …) — keys are normalized by stripping
 * non-alphanumerics and lowercasing, so a single directive works everywhere.
 * Non-boolean and unrelated tool entries are ignored.
 */
export function resolveNativeWebTools(
  tools: Record<string, boolean> | undefined,
): NativeWebToolPosture {
  if (!tools) return {};
  const posture: NativeWebToolPosture = {};
  for (const [key, value] of Object.entries(tools)) {
    if (typeof value !== "boolean") continue;
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (nativeWebSearchKeys.has(normalized)) posture.search = value;
    else if (nativeWebFetchKeys.has(normalized)) posture.fetch = value;
  }
  return posture;
}

export type BackendMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  parts: Array<Part | InputPart | unknown>;
  timestamp: string;
  metadata?: Record<string, unknown>;
};

export type GetMessagesOptions = {
  sessionId: string;
  limit?: number;
  offset?: number;
  since?: number;
};

// Memory system interfaces
export type MemoryEntry = {
  id: string;
  type: "summary" | "fact" | "note";
  content: string;
  createdAt: string;
};

export type MemoryEntryInput = Omit<MemoryEntry, "id" | "createdAt">;

export interface SdkMemoryHost {
  list(sessionId: string): Promise<MemoryEntry[]>;
  remember(sessionId: string, entry: MemoryEntryInput): Promise<void>;
  format(entries: MemoryEntry[]): string;
}

// Tool system interfaces
export type ToolExecutionContext = {
  workspaceRoot?: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  instruction?: string;
  inputSchema: unknown;
  inputSchemaJson: Record<string, unknown>;
  outputSchema?: unknown;
  outputSchemaJson?: Record<string, unknown>;
  handler: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
};

export interface SdkToolHost {
  buildPromptBlock(): string;
  registerInstruction?(instruction: string, key?: string): void;
  clear?(): void;
  getRegisteredTools(): ToolDefinition[];
}

// Recording interface for message persistence
export interface SdkRecorder {
  recordUserMessage(parts: BackendMessage["parts"]): Promise<void>;
  appendAssistantParts(parts: BackendMessage["parts"]): Promise<void>;
  setSessionId(sessionId?: string): Promise<void>;
  /**
   * Persist a streaming assistant part as it arrives. Called for every
   * `message.part.updated` event during a turn so partial content survives
   * a sidecar crash or abort. Implementations must dedupe per-part to
   * avoid quadratic write amplification (the same part snapshot can be
   * re-emitted across providers).
   */
  recordAssistantPartUpdate?(part: Part, delta?: string): Promise<void>;
  /** Carry the caller-supplied turnId; written into the assistant message
   * metadata when that message is first persisted. */
  setTurnId?(turnId: string): void;
  /**
   * Stamp the in-flight assistant message as completed and optionally cache
   * the run result under `turnId` for idempotent retry.
   */
  markTurnCompleted?(payload?: {
    result?: Record<string, unknown>;
    [extra: string]: unknown;
  }): Promise<void>;
  /**
   * Stamp the in-flight assistant message as interrupted (graceful abort,
   * upstream error, timeout). SIGKILL on the sidecar process bypasses this
   * call — consumers must treat "assistant message exists with neither
   * `completed` nor `interrupted` set" as the SIGKILL case.
   */
  markTurnInterrupted?(payload?: {
    reason?: string;
    [extra: string]: unknown;
  }): Promise<void>;
  /**
   * Look up the cached result of a previously-completed turn with this id.
   * Returns null if no such turn has completed (yet) on the recorder's
   * configured session. Adapters call this at execute() entry to short-
   * circuit idempotent retries without re-issuing the upstream LLM call.
   */
  findCompletedTurn?(turnId: string): Promise<AgentExecutionResult | null>;
}

// Telemetry interfaces
export type TraceEventInput =
  | {
      type: "message.part.updated";
      part: Part;
      delta?: string;
    }
  | {
      type: "message.updated";
      text?: string;
      finalText?: string;
      tokenUsage?: Record<string, unknown>;
      timing?: Record<string, unknown>;
      toolInvocations?: unknown[];
      metadata?: Record<string, unknown>;
    }
  | {
      type: "error";
      category:
        | "runtime"
        | "syntax"
        | "type"
        | "network"
        | "timeout"
        | "unknown";
      message: string;
      stack?: string;
      code?: string;
      source?: string;
    }
  | { type: "custom"; name: string; data: Record<string, unknown> };

export interface SdkTraceContext {
  addEvent(event: TraceEventInput): void;
  addSignal(signal: string, metadata?: Record<string, unknown>): void;
  complete(metadata?: Record<string, unknown>): void;
  fail(error: string | Error, metadata?: Record<string, unknown>): void;
  trackSubAgent?(childSessionId: string, agentType?: string): void;
}

// Host services provided to SDK providers
export type SdkHostServices = {
  memoryHost: SdkMemoryHost;
  toolHost: SdkToolHost;
  planHost: SdkPlanHost;
  recorder: SdkRecorder;
  providerConfig: ProviderConfig;
  traceContext?: SdkTraceContext;
};

// ============================================================================
// MCP (Model Context Protocol) Types
// ============================================================================

/**
 * Local/stdio MCP server configuration.
 * Runs a command locally that communicates via stdio.
 */
export type LocalMcpConfig = {
  type: "local" | "stdio";
  /** Command to run (string or array) */
  command: string | string[];
  /** Additional arguments (when command is string) */
  args?: string[];
  /** Environment variables for the process */
  env?: Record<string, string>;
  /** Enable/disable on startup */
  enabled?: boolean;
  /** Timeout in ms */
  timeout?: number;
};

/**
 * Remote/http MCP server configuration.
 * Connects to a remote MCP server via HTTP.
 */
export type RemoteMcpConfig = {
  type: "remote" | "http";
  /** URL of the remote MCP server */
  url: string;
  /** HTTP headers to send with requests */
  headers?: Record<string, string>;
  /** Enable/disable on startup */
  enabled?: boolean;
  /** Timeout in ms */
  timeout?: number;
};

/**
 * MCP server configuration (local/stdio or remote/http).
 */
export type McpConfig = LocalMcpConfig | RemoteMcpConfig;

/**
 * MCP server status entry.
 */
export type McpServerStatus = {
  name: string;
  status: "connected" | "disconnected" | "error" | "unknown";
  type?: "local" | "remote" | "stdio" | "http";
  error?: string;
};

/**
 * MCP status response from getMcpStatus.
 */
export type McpStatusResponse = {
  servers: Record<string, McpServerStatus>;
};

export type BackendListOptions = {
  limit?: number;
  cursor?: string;
};

export type BackendListResult<TItem> = {
  items: TItem[];
  nextCursor?: string;
};

export type BackendArtifact = {
  path: string;
  sizeBytes?: number;
  updatedAt?: string;
};

// The main provider adapter interface
export interface SdkProviderAdapter {
  readonly provider: string;
  getCapabilities(): BackendCapabilities;
  initialize(config: ProviderConfig): Promise<void>;
  createSession?(options?: { workspaceRoot?: string }): Promise<string>;
  forkSession?(options: {
    sessionId: string;
    messageId?: string;
    workspaceRoot?: string;
  }): Promise<string>;
  execute(
    input: AgentExecutionInput,
    services: SdkHostServices,
    onEvent?: (event: StreamEvent) => void,
  ): Promise<AgentExecutionResult>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<boolean>;
  getMessages?(options: GetMessagesOptions): Promise<BackendMessage[]>;
  // Optional MCP management methods
  addMcp?(name: string, config: McpConfig): Promise<void>;
  getMcpStatus?(): Promise<McpStatusResponse>;
  ensureMcps?(required: Record<string, McpConfig>): Promise<void>;
  // Optional configuration update (provider-specific config type)
  updateConfig?(config: unknown): Promise<unknown>;
  // Optional provider catalog/control-plane methods
  getAccount?(): Promise<unknown>;
  listModels?(): Promise<unknown>;
  listRepositories?(): Promise<unknown>;
  listAgents?(options?: BackendListOptions): Promise<unknown>;
  getAgent?(agentId: string): Promise<unknown>;
  archiveAgent?(agentId: string): Promise<void>;
  unarchiveAgent?(agentId: string): Promise<void>;
  deleteAgent?(agentId: string): Promise<void>;
  listRuns?(agentId: string, options?: BackendListOptions): Promise<unknown>;
  getRun?(runId: string, agentId?: string): Promise<unknown>;
  listAgentMessages?(
    agentId: string,
    options?: BackendListOptions,
  ): Promise<unknown>;
  listArtifacts?(sessionId: string): Promise<BackendArtifact[]>;
  downloadArtifact?(sessionId: string, path: string): Promise<Uint8Array>;
  /**
   * Respond to an outstanding interaction (question, permission, …). The
   * generalized inbound channel; the adapter translates the response into the
   * provider's native control call to unblock the agent.
   */
  respondToInteraction?(response: InteractionResponse): Promise<void>;
}
export * from "./interaction.js";
export * from "./agent-candidate.js";
export * from "./agent-candidate-schema.js";
export * from "./agent-candidate-promotion-schema.js";
export * from "./agent-candidate-compat.js";
export * from "./agent-profile.js";
export * from "./profile-diff.js";
export * from "./harness.js";
export * from "./harness-capabilities.js";
export * from "./profile-schema.js";
export * from "./profile-security.js";
export * from "./sandbox-size.js";
