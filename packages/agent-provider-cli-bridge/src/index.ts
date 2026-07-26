import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentEnvironmentProvider,
  AgentEnvironmentStatus,
  AgentProfileRef,
  AgentTurnInput,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentProfile,
  InputPart,
  MessagePartUpdatedEvent,
  TextPart,
  TokenUsage,
  ToolPart,
} from "@tangle-network/agent-interface";
import { Agent, fetch as undiciFetch } from "undici";

export interface CliBridgeProviderOptions {
  baseUrl: string;
  bearerToken?: string;
  defaultModel?: string;
  defaultMode?: "byob" | "hosted-safe" | "hosted-sandboxed";
  defaultExecution?: { kind: "host" } | {
    kind: "sandbox";
    repoUrl?: string;
    gitRef?: string;
    capability?: string;
    ttlSeconds?: number;
  };
  /** Maximum wait for response headers. Defaults to no timeout. */
  headersTimeoutMs?: number;
  /** Maximum idle time between response body chunks. Defaults to no timeout. */
  bodyTimeoutMs?: number;
  fetch?: typeof fetch;
  name?: string;
  capabilities?: AgentEnvironmentCapabilities;
}

export function createCliBridgeProvider(options: CliBridgeProviderOptions): AgentEnvironmentProvider {
  assertTimeout(options.headersTimeoutMs, "headersTimeoutMs");
  assertTimeout(options.bodyTimeoutMs, "bodyTimeoutMs");
  const name = options.name ?? "cli-bridge";
  return {
    name,
    capabilities: () => options.capabilities ?? defaultCliBridgeCapabilities(),
    async create(input) {
      const transport = createTransport(options);
      let destroyed = false;
      let closePromise: Promise<void> | undefined;
      return {
        id: input.idempotencyKey ?? input.name ?? crypto.randomUUID(),
        provider: name,
        ...(input.name ? { name: input.name } : {}),
        status: async () => (destroyed ? "stopped" : "running"),
        stream: (turn) => {
          if (destroyed) throw new Error("cli-bridge environment is destroyed");
          return streamCliBridgeTurn(options, input, turn, transport);
        },
        placement: async () => ({
          kind: options.defaultExecution?.kind === "sandbox" ? "sandbox" : "local",
          providerMetadata: { baseUrl: options.baseUrl },
        }),
        destroy: () => {
          destroyed = true;
          closePromise ??= transport.close();
          return closePromise;
        },
      } satisfies AgentEnvironment;
    },
  };
}

async function* streamCliBridgeTurn(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  turn: AgentTurnInput,
  transport: CliBridgeTransport,
): AsyncIterable<AgentEnvironmentEvent> {
  const response = await transport.fetch(`${trimSlash(options.baseUrl)}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
      ...(turn.sessionId ? { "x-session-id": turn.sessionId } : {}),
    },
    body: JSON.stringify(toChatCompletionsBody(options, environmentInput, turn)),
    signal: turn.signal ?? environmentInput.signal,
  });
  if (!response.ok) {
    throw new Error(`cli-bridge ${response.status}: ${await response.text()}`);
  }
  if (!response.body) throw new Error("cli-bridge response body is empty");

  let text = "";
  const sessionId = turn.sessionId ?? environmentInput.idempotencyKey ?? environmentInput.name ?? "cli-bridge";
  const messageId = turn.turnId ?? `${sessionId}:assistant`;
  const emittedToolCalls = new Set<string>();
  let completed = false;
  for await (const event of parseSse(response.body)) {
    if (event === "[DONE]") continue;
    const parsed = safeJson(event);
    if (!parsed) continue;
    if (parsed.error && typeof parsed.error === "object") {
      const error = parsed.error as Record<string, unknown>;
      const message = typeof error.message === "string" ? error.message : "cli-bridge error";
      yield { type: "status", data: { status: "failed", error: message } };
      throw new Error(`cli-bridge: ${message}`);
    }
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
    const delta = choice?.delta;
    const chunk = delta && typeof delta.content === "string" ? delta.content : "";
    const nextUsage = usageFromOpenAi(parsed.usage);
    if (nextUsage) {
      yield { type: "usage", data: {}, usage: nextUsage };
    }
    if (chunk) {
      text += chunk;
      const part: TextPart = {
        id: `${messageId}:text`,
        sessionID: sessionId,
        messageID: messageId,
        type: "text",
        text,
      };
      const normalized: MessagePartUpdatedEvent = {
        type: "message.part.updated",
        part,
        delta: chunk,
      };
      yield {
        type: "message.part.updated",
        data: { part, delta: chunk },
        normalized,
      };
    }
    for (const toolCall of toolCallsFromDelta(delta)) {
      const callId = toolCall.id ?? `${messageId}:tool:${toolCall.index}`;
      if (!toolCall.name || emittedToolCalls.has(callId)) continue;
      emittedToolCalls.add(callId);
      const part: ToolPart = {
        id: callId,
        sessionID: sessionId,
        messageID: messageId,
        type: "tool",
        callID: callId,
        tool: toolCall.name,
        state: { status: "pending", input: {} },
      };
      const normalized: MessagePartUpdatedEvent = {
        type: "message.part.updated",
        part,
      };
      yield {
        type: "message.part.updated",
        data: { part },
        normalized,
      };
    }
    if (choice?.finish_reason) {
      if (choice.finish_reason === "error") {
        yield {
          type: "status",
          data: { status: "failed", error: "cli-bridge returned finish_reason=error" },
        };
        throw new Error("cli-bridge returned finish_reason=error");
      }
      completed = true;
      yield {
        type: "result",
        data: {
          finalText: text,
          finishReason: choice.finish_reason,
          status: "completed",
        },
      };
    }
  }
  if (!completed) throw new Error("cli-bridge stream ended without a terminal result");
}

interface CliBridgeTransport {
  fetch(input: string, init: CliBridgeRequest): Promise<CliBridgeResponse>;
  close(): Promise<void>;
}

interface CliBridgeRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

interface CliBridgeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: AsyncIterable<Uint8Array> | null;
  text(): Promise<string>;
}

function createTransport(options: CliBridgeProviderOptions): CliBridgeTransport {
  if (options.fetch) {
    const fetch = options.fetch;
    return {
      fetch: (input, init) => fetch(input, init),
      close: async () => {},
    };
  }
  const dispatcher = new Agent({
    headersTimeout: options.headersTimeoutMs ?? 0,
    bodyTimeout: options.bodyTimeoutMs ?? 0,
  });
  return {
    fetch: (input, init) =>
      undiciFetch(input, {
        ...init,
        dispatcher,
      }),
    close: async () => {
      await dispatcher.close();
    },
  };
}

function assertTimeout(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`createCliBridgeProvider ${name} must be a non-negative integer`);
  }
}

function toChatCompletionsBody(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  turn: AgentTurnInput,
): Record<string, unknown> {
  const profile = inlineProfile(environmentInput.profile);
  return {
    model: turn.model ?? environmentInput.backend ?? options.defaultModel ?? "opencode",
    messages: messagesFromTurn(turn, profile),
    stream: true,
    ...(turn.sessionId ? { session_id: turn.sessionId } : {}),
    ...(options.defaultMode ? { mode: options.defaultMode } : {}),
    ...(profile ? { agent_profile: profile } : {}),
    ...(environmentInput.env ? { env: environmentInput.env } : {}),
    ...(environmentInput.workspace?.cwd ? { cwd: environmentInput.workspace.cwd } : {}),
    ...(executionFromInput(options, environmentInput) ? { execution: executionFromInput(options, environmentInput) } : {}),
    metadata: {
      ...(environmentInput.metadata ?? {}),
      ...(turn.context ?? {}),
      ...(turn.providerOptions ?? {}),
    },
  };
}

function messagesFromTurn(turn: AgentTurnInput, profile: AgentProfile | undefined): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  const systemPrompt = profile?.prompt?.systemPrompt;
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: contentFromTurn(turn) });
  return messages;
}

function contentFromTurn(turn: AgentTurnInput): string | InputPart[] {
  if (turn.parts) return turn.parts;
  return turn.prompt ?? "";
}

function inlineProfile(profile: AgentProfileRef): AgentProfile | undefined {
  return typeof profile === "string" ? undefined : profile;
}

function executionFromInput(
  options: CliBridgeProviderOptions,
  input: CreateAgentEnvironmentInput,
): CliBridgeProviderOptions["defaultExecution"] | undefined {
  if (options.defaultExecution) return options.defaultExecution;
  if (!input.workspace?.repoUrl) return undefined;
  return {
    kind: "sandbox",
    repoUrl: input.workspace.repoUrl,
    ...(input.workspace.gitRef ? { gitRef: input.workspace.gitRef } : {}),
  };
}

async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const value of body) {
    buffer += decoder.decode(value, { stream: true });
    let boundary = findFrameBoundary(buffer);
    while (boundary) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const data = dataFromFrame(frame);
      if (data !== undefined) yield data;
      boundary = findFrameBoundary(buffer);
    }
  }
  if (buffer) {
    const data = dataFromFrame(buffer);
    if (data !== undefined) yield data;
  }
}

function findFrameBoundary(value: string): { index: number; length: number } | undefined {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function dataFromFrame(frame: string): string | undefined {
  const lines = frame.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  return data || undefined;
}

function toolCallsFromDelta(value: unknown): Array<{ id?: string; index: number; name?: string }> {
  if (!value || typeof value !== "object") return [];
  const calls = (value as Record<string, unknown>).tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call, position) => {
    if (!call || typeof call !== "object") return [];
    const record = call as Record<string, unknown>;
    const fn = record.function;
    const name =
      fn && typeof fn === "object" && typeof (fn as Record<string, unknown>).name === "string"
        ? ((fn as Record<string, unknown>).name as string)
        : undefined;
    const index = number(record.index) ?? position;
    const id = typeof record.id === "string" ? record.id : undefined;
    return [{ ...(id ? { id } : {}), index, ...(name ? { name } : {}) }];
  });
}

function safeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function usageFromOpenAi(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens = number(record.prompt_tokens) ?? number(record.input_tokens);
  const outputTokens = number(record.completion_tokens) ?? number(record.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const totalTokens = number(record.total_tokens);
  const cacheReadInputTokens = number(record.cache_read_input_tokens);
  const cacheCreationInputTokens = number(record.cache_creation_input_tokens);
  const reasoningTokens = number(record.reasoning_tokens);
  const cost = number(record.cost);
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function defaultCliBridgeCapabilities(): AgentEnvironmentCapabilities {
  return {
    profile: {
      namedProfiles: false,
      systemPrompt: true,
      instructions: true,
      tools: true,
      permissions: true,
      mcp: true,
      subagents: true,
      resources: {
        files: true,
        instructions: true,
        tools: true,
        skills: true,
        agents: true,
        commands: true,
      },
      hooks: false,
      modes: true,
      runtimeUpdate: false,
      validation: false,
    },
    streaming: { live: true, replay: false, detach: false, turnIdempotency: true },
    sessions: { continue: true, list: false, messages: false },
    workspace: { read: false, write: false, exec: false, git: false, upload: false, download: false },
    branching: { checkpoint: false, fork: false },
    placement: true,
    usage: true,
    confidential: false,
  };
}
