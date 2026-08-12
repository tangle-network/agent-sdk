import { createHash } from "node:crypto";
import type {
  AgentProfile,
  AgentProfileRef,
  InputPart,
  TokenUsage,
} from "@tangle-network/agent-interface";
import { AgentExactRunControlRefSchema } from "@tangle-network/agent-interface";
import type {
  AgentTurnInput,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import type { CliBridgeProviderOptions } from "./provider-options.js";
import type { CliBridgeRunSnapshot } from "./retained-run-state.js";

export function toChatCompletionsBody(
  options: CliBridgeProviderOptions,
  environmentInput: CreateAgentEnvironmentInput,
  turn: AgentTurnInput,
  runId: string,
): Record<string, unknown> {
  const profile = inlineProfile(environmentInput.profile);
  const execution = executionFromInput(options, environmentInput);
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
    ...(execution ? { execution } : {}),
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

/** Keep task messages separate from the profile's harness-owned prompt controls. */
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

export interface CliBridgeSseFrame {
  readonly data: string;
  readonly id?: string;
}

export async function* parseSse(
  body: AsyncIterable<Uint8Array>,
): AsyncIterable<CliBridgeSseFrame> {
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
  buffer += decoder.decode();
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

export function toolCallsFromDelta(
  value: unknown,
): Array<{ id?: string; index: number; name?: string }> {
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
    const index = nonNegativeSafeInteger(record.index) ?? position;
    const id = typeof record.id === "string" ? record.id : undefined;
    return [{ ...(id ? { id } : {}), index, ...(name ? { name } : {}) }];
  });
}

export function safeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function usageFromOpenAi(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens =
    nonNegativeSafeInteger(record.prompt_tokens) ??
    nonNegativeSafeInteger(record.input_tokens);
  const outputTokens =
    nonNegativeSafeInteger(record.completion_tokens) ??
    nonNegativeSafeInteger(record.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const totalTokens = nonNegativeSafeInteger(record.total_tokens);
  const cacheReadInputTokens = nonNegativeSafeInteger(record.cache_read_input_tokens);
  const cacheCreationInputTokens = nonNegativeSafeInteger(record.cache_creation_input_tokens);
  const reasoningTokens = nonNegativeSafeInteger(record.reasoning_tokens);
  const cost = finiteNonNegativeNumber(record.cost);
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
}

export function modelRequestsFromOpenAi(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  return modelRequestCount((value as Record<string, unknown>).model_requests);
}

/** Preserve the provider identity that cli-bridge returns on each completion frame. */
export function responseIdentityFromOpenAi(value: unknown): {
  model?: string;
  system_fingerprint?: string;
} | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const model = nonEmptyString(record.model);
  const systemFingerprint = nonEmptyString(record.system_fingerprint);
  if (model === undefined && systemFingerprint === undefined) return undefined;
  return {
    ...(model === undefined ? {} : { model }),
    ...(systemFingerprint === undefined ? {} : { system_fingerprint: systemFingerprint }),
  };
}

export function modelRequestCount(value: unknown): number | undefined {
  return nonNegativeSafeInteger(value);
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function cliBridgeRunId(
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

export function runSnapshot(value: string): CliBridgeRunSnapshot {
  const parsed = safeJson(value);
  if (!parsed) throw new Error("cli-bridge run status returned invalid JSON");
  const id = parsed.id;
  const requestDigest = parsed.requestDigest === undefined
    ? undefined
    : AgentExactRunControlRefSchema.shape.requestDigest.safeParse(parsed.requestDigest);
  const status = parsed.status;
  const terminal = parsed.terminal;
  if (
    typeof id !== "string" ||
    (requestDigest !== undefined && !requestDigest.success) ||
    !["running", "done", "error", "cancelled"].includes(String(status)) ||
    typeof terminal !== "boolean"
  ) {
    throw new Error("cli-bridge run status returned an invalid snapshot");
  }
  return {
    id,
    ...(requestDigest?.success ? { requestDigest: requestDigest.data } : {}),
    status: status as CliBridgeRunSnapshot["status"],
    terminal,
  };
}

export function cancelSnapshot(value: string): CliBridgeRunSnapshot {
  const parsed = safeJson(value);
  if (!parsed || !parsed.run || typeof parsed.run !== "object") {
    throw new Error("cli-bridge cancel returned an invalid snapshot");
  }
  return runSnapshot(JSON.stringify(parsed.run));
}
