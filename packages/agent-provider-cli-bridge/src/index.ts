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
import type { AgentProfile, InputPart, TokenUsage } from "@tangle-network/agent-interface";

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
  fetch?: typeof fetch;
  name?: string;
  capabilities?: AgentEnvironmentCapabilities;
}

export function createCliBridgeProvider(options: CliBridgeProviderOptions): AgentEnvironmentProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("createCliBridgeProvider requires fetch");
  const name = options.name ?? "cli-bridge";
  return {
    name,
    capabilities: () => options.capabilities ?? defaultCliBridgeCapabilities(),
    async create(input) {
      return {
        id: input.idempotencyKey ?? input.name ?? crypto.randomUUID(),
        provider: name,
        ...(input.name ? { name: input.name } : {}),
        status: async () => "running",
        stream: (turn) => streamCliBridgeTurn(fetchImpl, options, input, turn),
        placement: async () => ({
          kind: options.defaultExecution?.kind === "sandbox" ? "sandbox" : "local",
          providerMetadata: { baseUrl: options.baseUrl },
        }),
        destroy: async () => {},
      } satisfies AgentEnvironment;
    },
  };
}

async function* streamCliBridgeTurn(
  fetchImpl: typeof fetch,
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  turn: AgentTurnInput,
): AsyncIterable<AgentEnvironmentEvent> {
  const response = await fetchImpl(`${trimSlash(options.baseUrl)}/v1/chat/completions`, {
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
  let usage: TokenUsage | undefined;
  for await (const event of parseSse(response.body)) {
    if (event === "[DONE]") break;
    const parsed = safeJson(event);
    if (!parsed) continue;
    if (parsed.error && typeof parsed.error === "object") {
      const error = parsed.error as Record<string, unknown>;
      const message = typeof error.message === "string" ? error.message : "cli-bridge error";
      yield { type: "status", data: { status: "failed", error: message } };
      return;
    }
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
    const delta = choice?.delta;
    const chunk = delta && typeof delta.content === "string" ? delta.content : "";
    const nextUsage = usageFromOpenAi(parsed.usage);
    if (nextUsage) {
      usage = mergeUsage(usage, nextUsage);
      yield { type: "usage", data: { usage: nextUsage }, usage: nextUsage };
    }
    if (chunk) {
      text += chunk;
      yield {
        type: "message.part.updated",
        data: { delta: chunk },
      };
    }
    if (choice?.finish_reason) {
      yield {
        type: "result",
        data: {
          finalText: text,
          finishReason: choice.finish_reason,
          status: choice.finish_reason === "error" ? "failed" : "completed",
        },
        ...(usage ? { usage } : {}),
      };
    }
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

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = dataFromFrame(frame);
        if (data !== undefined) yield data;
        boundary = buffer.indexOf("\n\n");
      }
    }
    if (buffer) {
      const data = dataFromFrame(buffer);
      if (data !== undefined) yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

function dataFromFrame(frame: string): string | undefined {
  const lines = frame.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  return data || undefined;
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
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
}

function mergeUsage(left: TokenUsage | undefined, right: TokenUsage): TokenUsage {
  if (!left) return right;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(left.cost !== undefined || right.cost !== undefined ? { cost: (left.cost ?? 0) + (right.cost ?? 0) } : {}),
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
