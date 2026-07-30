import { createHash } from "node:crypto";
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentEnvironmentProvider,
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
  /** Maximum wait for cli-bridge to confirm cancellation. Defaults to 30 seconds. */
  cancelWaitMs?: number;
  fetch?: typeof fetch;
  name?: string;
  capabilities?: AgentEnvironmentCapabilities;
}

export function createCliBridgeProvider(options: CliBridgeProviderOptions): AgentEnvironmentProvider {
  assertTimeout(options.headersTimeoutMs, "headersTimeoutMs");
  assertTimeout(options.bodyTimeoutMs, "bodyTimeoutMs");
  assertTimeout(options.cancelWaitMs, "cancelWaitMs");
  const name = options.name ?? "cli-bridge";
  return {
    name,
    capabilities: () => options.capabilities ?? defaultCliBridgeCapabilities(),
    async create(input) {
      const transport = createTransport(options);
      const environmentId = input.idempotencyKey ?? crypto.randomUUID();
      const runs = new Map<string, CliBridgeRun>();
      const readers = new Set<AbortController>();
      let destroyed = false;
      let closePromise: Promise<void> | undefined;
      const stream = async function* (
        turn: AgentTurnInput,
      ): AsyncIterable<AgentEnvironmentEvent> {
        if (destroyed) throw new Error("cli-bridge environment is destroyed");
        yield* streamTrackedCliBridgeTurn(
          options,
          input,
          turn,
          transport,
          environmentId,
          runs,
          readers,
        );
      };
      const environment = {
        id: environmentId,
        provider: name,
        ...(input.name ? { name: input.name } : {}),
        status: async () => (destroyed ? "stopped" : "running"),
        stream,
        placement: async () => ({
          kind: options.defaultExecution?.kind === "sandbox" ? "sandbox" : "local",
          providerMetadata: { baseUrl: options.baseUrl },
        }),
        async destroy() {
          if (closePromise) return closePromise;
          destroyed = true;
          let cancellationsConfirmed = false;
          const attempt = (async () => {
            const cancellations = await Promise.allSettled(
              Array.from(runs.values()).map(async (run) => {
                const snapshot = await cancelCliBridgeRun(options, transport, run);
                if (runs.get(run.id) === run) runs.delete(run.id);
                return snapshot;
              }),
            );
            const failures = cancellations.flatMap((result) =>
              result.status === "rejected" ? [result.reason] : [],
            );
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
              throw new AggregateError(failures, "cli-bridge environment cancellation failed");
            }
            cancellationsConfirmed = true;
            for (const reader of readers) {
              reader.abort(
                new DOMException("cli-bridge environment was destroyed", "AbortError"),
              );
            }
            await transport.close();
          })();
          closePromise = attempt;
          try {
            await attempt;
          } catch (error) {
            closePromise = undefined;
            if (!cancellationsConfirmed) destroyed = false;
            throw error;
          }
        },
      } satisfies AgentEnvironment;
      return environment;
    },
  };
}

interface CliBridgeRun {
  readonly id: string;
  readonly readers: Set<AbortController>;
  cancellation?: Promise<CliBridgeRunSnapshot>;
}

interface CliBridgeRunSnapshot {
  readonly id: string;
  readonly status: "running" | "done" | "error" | "cancelled";
  readonly terminal: boolean;
}

async function* streamTrackedCliBridgeTurn(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  originalTurn: AgentTurnInput,
  transport: CliBridgeTransport,
  environmentId: string,
  runs: Map<string, CliBridgeRun>,
  readers: Set<AbortController>,
): AsyncIterable<AgentEnvironmentEvent> {
  if (originalTurn.detach) {
    throw new Error("cli-bridge provider does not support detached turns");
  }
  const sessionId = originalTurn.sessionId;
  const turnId = originalTurn.turnId ?? crypto.randomUUID();
  const runId = cliBridgeRunId(environmentId, originalTurn, turnId);
  const controller = new AbortController();
  const signals = [
    originalTurn.signal,
    environmentInput.signal,
    controller.signal,
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  const turn = {
    ...originalTurn,
    turnId,
    ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
  };
  const requestBody = JSON.stringify(
    toChatCompletionsBody(options, environmentInput, turn, runId),
  );
  const run = runs.get(runId) ?? {
    id: runId,
    readers: new Set<AbortController>(),
  };
  run.readers.add(controller);
  readers.add(controller);
  runs.set(runId, run);

  let drained = false;
  let threw = false;
  try {
    for await (const event of streamCliBridgeTurn(
      options,
      turn,
      requestBody,
      transport,
      runId,
      originalTurn.lastEventId,
      signals.length > 0 ? AbortSignal.any(signals) : undefined,
    )) {
      yield event;
    }
    drained = true;
    if (runs.get(run.id) === run) runs.delete(run.id);
  } catch (error) {
    threw = true;
    if (error instanceof CliBridgeRequestRejectedError) {
      if (runs.get(run.id) === run) runs.delete(run.id);
      throw error;
    }
    let snapshot: CliBridgeRunSnapshot | null | undefined;
    try {
      snapshot = await getCliBridgeRun(options, transport, run.id);
    } catch {
      snapshot = undefined;
    }
    if (snapshot?.terminal) {
      if (runs.get(run.id) === run) runs.delete(run.id);
    } else if (
      (originalTurn.signal?.aborted || environmentInput.signal?.aborted)
    ) {
      await cancelCliBridgeRun(options, transport, run);
      if (runs.get(run.id) === run) runs.delete(run.id);
    }
    throw error;
  } finally {
    if (!drained && !threw && runs.get(run.id) === run) {
      await cancelCliBridgeRun(options, transport, run);
      runs.delete(run.id);
    }
    run.readers.delete(controller);
    readers.delete(controller);
  }
}

async function cancelCliBridgeRun(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  run: CliBridgeRun,
): Promise<CliBridgeRunSnapshot> {
  if (run.cancellation) return run.cancellation;
  run.cancellation = (async () => {
    const response = await transport.fetch(
      `${trimSlash(options.baseUrl)}/v1/runs/${encodeURIComponent(run.id)}/cancel`,
      {
        method: "POST",
        headers: requestHeaders(options),
        body: "{}",
      },
    );
    if (!response.ok) {
      throw new Error(`cli-bridge cancel ${response.status}: ${await response.text()}`);
    }
    let snapshot: CliBridgeRunSnapshot | null = cancelSnapshot(await response.text());
    const waitBudgetMs = options.cancelWaitMs ?? 30_000;
    const deadline = Date.now() + waitBudgetMs;
    while (!snapshot.terminal) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      snapshot = await getCliBridgeRun(
        options,
        transport,
        run.id,
        Math.min(remainingMs, 30_000),
      );
      if (snapshot === null) {
        throw new Error(`cli-bridge lost run "${run.id}" before confirming cancellation`);
      }
    }
    if (!snapshot?.terminal) {
      throw new Error(`cli-bridge run "${run.id}" did not confirm terminal cancellation`);
    }
    for (const reader of run.readers) {
      reader.abort(
        new DOMException(`cli-bridge run ended ${snapshot.status}`, "AbortError"),
      );
    }
    return snapshot;
  })();
  try {
    return await run.cancellation;
  } finally {
    run.cancellation = undefined;
  }
}

async function getCliBridgeRun(
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  runId: string,
  waitMs?: number,
): Promise<CliBridgeRunSnapshot | null> {
  const query = waitMs === undefined ? "" : `?wait_ms=${waitMs}`;
  const response = await transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/runs/${encodeURIComponent(runId)}${query}`,
    {
      method: "GET",
      headers: requestHeaders(options),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`cli-bridge run status ${response.status}: ${await response.text()}`);
  }
  return runSnapshot(await response.text());
}

async function* streamCliBridgeTurn(
  options: CliBridgeProviderOptions,
  turn: AgentTurnInput,
  requestBody: string,
  transport: CliBridgeTransport,
  runId: string,
  lastEventId?: string,
  signal?: AbortSignal,
): AsyncIterable<AgentEnvironmentEvent> {
  const response = await transport.fetch(`${trimSlash(options.baseUrl)}/v1/chat/completions`, {
    method: "POST",
    headers: {
      ...requestHeaders(options),
      accept: "text/event-stream",
      ...(turn.sessionId ? { "x-session-id": turn.sessionId } : {}),
      ...(lastEventId ? { "last-event-id": lastEventId } : {}),
    },
    body: requestBody,
    signal,
  });
  if (!response.ok) {
    let detail = "request rejected";
    try {
      detail = await response.text();
    } catch {
      // The HTTP status already proves this request was rejected.
    }
    throw new CliBridgeRequestRejectedError(response.status, detail);
  }
  if (!response.body) throw new Error("cli-bridge response body is empty");

  let text = "";
  const sessionId = turn.sessionId ?? runId;
  const messageId = turn.turnId ?? `${sessionId}:assistant`;
  const emittedToolCalls = new Set<string>();
  let completed = false;
  let terminalCursor: string | undefined;
  for await (const frame of parseSse(response.body)) {
    if (frame.data === "[DONE]") continue;
    const parsed = safeJson(frame.data);
    if (!parsed) continue;
    if (parsed.error && typeof parsed.error === "object") {
      const error = parsed.error as Record<string, unknown>;
      const message = typeof error.message === "string" ? error.message : "cli-bridge error";
      yield {
        type: "status",
        data: { status: "failed", error: message },
        ...(frame.id ? { id: frame.id } : {}),
      };
      throw new Error(`cli-bridge: ${message}`);
    }
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
    const delta = choice?.delta;
    const chunk = delta && typeof delta.content === "string" ? delta.content : "";
    const nextUsage = usageFromOpenAi(parsed.usage);
    const frameEvents: AgentEnvironmentEvent[] = [];
    if (nextUsage) {
      frameEvents.push({ type: "usage", data: {}, usage: nextUsage });
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
      frameEvents.push({
        type: "message.part.updated",
        data: { part, delta: chunk },
        normalized,
      });
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
      frameEvents.push({
        type: "message.part.updated",
        data: { part },
        normalized,
      });
    }
    if (choice?.finish_reason) {
      if (choice.finish_reason === "error") {
        frameEvents.push({
          type: "status",
          data: { status: "failed", error: "cli-bridge returned finish_reason=error" },
        });
        yield* eventsWithCursor(frameEvents, frame.id);
        throw new Error("cli-bridge returned finish_reason=error");
      }
      completed = true;
      if (lastEventId) {
        terminalCursor = frame.id;
      } else {
        frameEvents.push({
          type: "result",
          data: {
            finalText: text,
            finishReason: choice.finish_reason,
            status: "completed",
          },
        });
      }
    }
    yield* eventsWithCursor(
      frameEvents,
      choice?.finish_reason && lastEventId ? undefined : frame.id,
    );
  }
  if (!completed && !lastEventId) {
    throw new Error("cli-bridge stream ended without a terminal result");
  }
  if (lastEventId) {
    const result = await readFullCliBridgeResult(
      options,
      requestBody,
      transport,
      signal,
    );
    yield {
      type: "result",
      data: {
        finalText: result.text,
        finishReason: result.finishReason,
        status: "completed",
      },
      id: terminalCursor ?? lastEventId,
    };
  }
}

class CliBridgeRequestRejectedError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`cli-bridge ${status}: ${detail}`);
    this.name = "CliBridgeRequestRejectedError";
  }
}

async function readFullCliBridgeResult(
  options: CliBridgeProviderOptions,
  requestBody: string,
  transport: CliBridgeTransport,
  signal?: AbortSignal,
): Promise<{ text: string; finishReason: string }> {
  const body = safeJson(requestBody);
  if (!body) throw new Error("cli-bridge replay request is not valid JSON");
  const response = await transport.fetch(`${trimSlash(options.baseUrl)}/v1/chat/completions`, {
    method: "POST",
    headers: requestHeaders(options),
    body: JSON.stringify({ ...body, stream: false }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`cli-bridge replay result ${response.status}: ${await response.text()}`);
  }
  const parsed = safeJson(await response.text());
  if (parsed?.error && typeof parsed.error === "object") {
    const error = parsed.error as Record<string, unknown>;
    const message =
      typeof error.message === "string" ? error.message : "cli-bridge replay failed";
    throw new Error(`cli-bridge replay result failed: ${message}`);
  }
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined;
  const message =
    choice?.message && typeof choice.message === "object"
      ? choice.message as Record<string, unknown>
      : undefined;
  if (
    typeof message?.content !== "string" ||
    typeof choice?.finish_reason !== "string"
  ) {
    throw new Error("cli-bridge replay result returned an invalid completion");
  }
  if (choice.finish_reason === "error" || choice.finish_reason === "timeout") {
    throw new Error(`cli-bridge replay result ended ${choice.finish_reason}`);
  }
  return { text: message.content, finishReason: choice.finish_reason };
}

interface CliBridgeTransport {
  fetch(input: string, init: CliBridgeRequest): Promise<CliBridgeResponse>;
  close(): Promise<void>;
}

interface CliBridgeRequest {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
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
  runId: string,
): Record<string, unknown> {
  const profile = inlineProfile(environmentInput.profile);
  return {
    model: resolveBridgeModel(options, environmentInput, turn, profile),
    messages: messagesFromTurn(turn),
    stream: true,
    ...(turn.sessionId ? { session_id: turn.sessionId } : {}),
    run_id: runId,
    ...(options.defaultMode ? { mode: options.defaultMode } : {}),
    ...(profile ? { agent_profile: profile } : {}),
    ...(profile?.model?.reasoningEffort
      ? { effort: profile.model.reasoningEffort }
      : {}),
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

function resolveBridgeModel(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  turn: AgentTurnInput,
  profile: AgentProfile | undefined,
): string {
  const harness = environmentInput.backend ?? profile?.harness;
  const model = turn.model ?? options.defaultModel ?? profile?.model?.default;
  const provider = profile?.model?.provider;
  if (!harness) {
    if (model) return model;
    throw new Error(
      "createCliBridgeProvider requires an explicit bridge model or a profile/backend harness",
    );
  }
  if (!model || model === harness) return harness;
  if (model.startsWith(`${harness}/`)) return model;
  if (model.includes("/")) return `${harness}/${model}`;
  if (provider) return `${harness}/${provider}/${model}`;
  return `${harness}/${model}`;
}

function messagesFromTurn(turn: AgentTurnInput): Array<Record<string, unknown>> {
  return [{ role: "user", content: contentFromTurn(turn) }];
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

interface CliBridgeSseFrame {
  readonly data: string;
  readonly id?: string;
}

async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncIterable<CliBridgeSseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const value of body) {
    buffer += decoder.decode(value, { stream: true });
    let boundary = findFrameBoundary(buffer);
    while (boundary) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const data = dataFromFrame(frame);
      if (data) yield data;
      boundary = findFrameBoundary(buffer);
    }
  }
  if (buffer) {
    const data = dataFromFrame(buffer);
    if (data) yield data;
  }
}

function findFrameBoundary(value: string): { index: number; length: number } | undefined {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function dataFromFrame(frame: string): CliBridgeSseFrame | undefined {
  const lines = frame.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) return undefined;
  const id = lines.find((line) => line.startsWith("id:"))?.slice("id:".length).trim();
  return { data, ...(id ? { id } : {}) };
}

function* eventsWithCursor(
  events: readonly AgentEnvironmentEvent[],
  cursor?: string,
): Iterable<AgentEnvironmentEvent> {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    yield cursor && index === events.length - 1 ? { ...event, id: cursor } : event;
  }
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

function requestHeaders(options: CliBridgeProviderOptions): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
  };
}

function cliBridgeRunId(
  environmentId: string,
  turn: AgentTurnInput,
  turnId: string,
): string {
  if (
    turn.executionId &&
    turn.executionId.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(turn.executionId)
  ) {
    return turn.executionId;
  }
  const digest = createHash("sha256")
    .update(environmentId)
    .update("\0")
    .update(turn.sessionId ?? "")
    .update("\0")
    .update(turn.executionId ?? turnId)
    .digest("hex");
  return `agent-${digest}`;
}

function runSnapshot(value: string): CliBridgeRunSnapshot {
  const parsed = safeJson(value);
  if (!parsed) throw new Error("cli-bridge run status returned invalid JSON");
  const id = parsed.id;
  const status = parsed.status;
  const terminal = parsed.terminal;
  if (
    typeof id !== "string" ||
    !["running", "done", "error", "cancelled"].includes(String(status)) ||
    typeof terminal !== "boolean"
  ) {
    throw new Error("cli-bridge run status returned an invalid snapshot");
  }
  return {
    id,
    status: status as CliBridgeRunSnapshot["status"],
    terminal,
  };
}

function cancelSnapshot(value: string): CliBridgeRunSnapshot {
  const parsed = safeJson(value);
  if (!parsed || !parsed.run || typeof parsed.run !== "object") {
    throw new Error("cli-bridge cancel returned an invalid snapshot");
  }
  return runSnapshot(JSON.stringify(parsed.run));
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
    streaming: { live: true, replay: true, detach: false, turnIdempotency: true },
    sessions: { continue: true, list: false, messages: false },
    workspace: { read: false, write: false, exec: false, git: false, upload: false, download: false },
    branching: { checkpoint: false, fork: false },
    placement: true,
    usage: true,
    confidential: false,
  };
}
