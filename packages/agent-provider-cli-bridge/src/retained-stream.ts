import type {
  MessagePartUpdatedEvent,
  TextPart,
  TokenUsage,
  ToolPart,
} from "@tangle-network/agent-interface";
import type {
  AgentEnvironmentEvent,
  AgentTurnInput,
} from "@tangle-network/agent-interface/environment-provider";
import {
  retainedEventsWithIdentity,
  retainedReplayRequest,
} from "./retained-event-cursor.js";
import type { CliBridgeProviderOptions } from "./provider-options.js";
import type { CliBridgeResponse, CliBridgeTransport } from "./transport.js";
import { requestHeaders, trimSlash } from "./transport.js";
import {
  modelRequestsFromOpenAi,
  parseSse,
  responseIdentityFromOpenAi,
  safeJson,
  toolCallsFromDelta,
  usageFromOpenAi,
} from "./wire.js";

export class CliBridgeRequestRejectedError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`cli-bridge ${status}: ${detail}`);
    this.name = "CliBridgeRequestRejectedError";
  }
}

class CliBridgeRunCancelledError extends Error {
  constructor(detail: string) {
    super(`cli-bridge run cancelled: ${detail}`);
    this.name = "CliBridgeRunCancelledError";
  }
}

export async function* streamCliBridgeTurn(
  options: CliBridgeProviderOptions,
  turn: AgentTurnInput,
  requestBody: string | undefined,
  transport: CliBridgeTransport,
  runId: string,
  lastEventId?: string,
  signal?: AbortSignal,
  onAccepted?: (response: CliBridgeResponse) => void,
): AsyncIterable<AgentEnvironmentEvent> {
  const reconnect = requestBody === undefined;
  const replay = retainedReplayRequest(lastEventId);
  const response = await transport.fetch(
    reconnect
      ? `${trimSlash(options.baseUrl)}/v1/runs/${encodeURIComponent(runId)}/events`
      : `${trimSlash(options.baseUrl)}/v1/chat/completions`,
    {
      method: reconnect ? "GET" : "POST",
      headers: {
        ...requestHeaders(options),
        accept: "text/event-stream",
        ...(!reconnect && turn.sessionId ? { "x-session-id": turn.sessionId } : {}),
        ...(replay.serverCursor === undefined
          ? {}
          : { "last-event-id": replay.serverCursor }),
      },
      ...(requestBody === undefined ? {} : { body: requestBody }),
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) {
    let detail = "request rejected";
    try {
      detail = await response.text();
    } catch {
      // The HTTP status already proves this request was rejected.
    }
    throw new CliBridgeRequestRejectedError(response.status, detail);
  }
  onAccepted?.(response);
  if (!response.body) throw new Error("cli-bridge response body is empty");

  let text = "";
  const sessionId = turn.sessionId ?? runId;
  const messageId = turn.turnId ?? `${sessionId}:assistant`;
  const emittedToolCalls = new Set<string>();
  let completed = false;
  let sawUsage = false;
  let observedModelRequests = 0;
  let modelRequestsKnown = false;
  let servedModel: string | undefined;
  let systemFingerprint: string | undefined;
  let textBoundaryPending = false;
  let terminalCursor: string | undefined;
  let sawProtocolEnd = false;
  let terminalFrameSeen = false;
  let cancelledTerminalSeen = false;
  for await (const frame of parseSse(response.body)) {
    if (frame.data === "[DONE]") {
      sawProtocolEnd = true;
      continue;
    }
    if (terminalFrameSeen) continue;
    const parsed = safeJson(frame.data);
    if (!parsed) continue;
    if (parsed.error && typeof parsed.error === "object") {
      const error = parsed.error as Record<string, unknown>;
      const message = typeof error.message === "string" ? error.message : "cli-bridge error";
      const cancelled = error.type === "run_cancelled";
      yield* retainedEventsWithIdentity([{
        type: "status",
        data: { status: cancelled ? "cancelled" : "failed", error: message },
        normalized: {
          type: "status",
          status: cancelled ? "cancelled" : "failed",
          detail: message,
        },
      }], frame.id, runId, sessionId, turn.executionId, replay.anchor);
      terminalFrameSeen = true;
      completed = cancelled;
      cancelledTerminalSeen = cancelled;
      if (!cancelled) throw new Error(`cli-bridge: ${message}`);
      continue;
    }
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
    const delta = choice?.delta;
    const responseIdentity = responseIdentityFromOpenAi(parsed);
    if (responseIdentity?.model !== undefined) servedModel = responseIdentity.model;
    if (responseIdentity?.system_fingerprint !== undefined) {
      systemFingerprint = responseIdentity.system_fingerprint;
    }
    const identityData = {
      ...(servedModel === undefined ? {} : { model: servedModel }),
      ...(systemFingerprint === undefined ? {} : { system_fingerprint: systemFingerprint }),
    };
    const toolCallDeltas = toolCallsFromDelta(delta);
    const rawChunk = delta && typeof delta.content === "string" ? delta.content : "";
    const chunk =
      rawChunk &&
      textBoundaryPending &&
      toolCallDeltas.length === 0 &&
      text.length > 0 &&
      !/\s$/u.test(text) &&
      !/^\s/u.test(rawChunk)
        ? `\n\n${rawChunk}`
        : rawChunk;
    if (rawChunk && toolCallDeltas.length === 0) textBoundaryPending = false;
    const nextUsage = usageFromOpenAi(parsed.usage);
    const nextModelRequests = modelRequestsFromOpenAi(parsed.usage);
    const frameEvents: AgentEnvironmentEvent[] = [];
    if (nextUsage || nextModelRequests !== undefined) {
      if (nextUsage) sawUsage = true;
      if (nextModelRequests !== undefined) {
        observedModelRequests += nextModelRequests;
        modelRequestsKnown = true;
      }
      frameEvents.push({
        type: "usage",
        data: {
          ...identityData,
          ...(nextModelRequests === undefined ? {} : { modelRequests: nextModelRequests }),
        },
        ...(nextUsage ? { usage: nextUsage } : {}),
      });
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
        data: { ...identityData, part, delta: chunk },
        normalized,
      });
    }
    for (const toolCall of toolCallDeltas) {
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
    if (toolCallDeltas.length > 0) textBoundaryPending = true;
    if (choice?.finish_reason) {
      terminalFrameSeen = true;
      if (choice.finish_reason === "error") {
        frameEvents.push({
          type: "status",
          data: { status: "failed", error: "cli-bridge returned finish_reason=error" },
          normalized: {
            type: "status",
            status: "failed",
            detail: "cli-bridge returned finish_reason=error",
          },
        });
        yield* retainedEventsWithIdentity(
          frameEvents,
          frame.id,
          runId,
          sessionId,
          turn.executionId,
          replay.anchor,
        );
        throw new Error("cli-bridge returned finish_reason=error");
      }
      completed = true;
      if (lastEventId && requestBody !== undefined) {
        terminalCursor = frame.id === undefined
          ? undefined
          : `${frame.id}:${frameEvents.length}`;
      } else {
        frameEvents.push({
          type: "result",
          data: {
            finalText: text,
            finishReason: choice.finish_reason,
            status: "completed",
            ...identityData,
            ...(modelRequestsKnown ? { modelRequests: observedModelRequests } : {}),
          },
        });
      }
    }
    yield* retainedEventsWithIdentity(
      frameEvents,
      frame.id,
      runId,
      sessionId,
      turn.executionId,
      replay.anchor,
    );
  }
  if (!sawProtocolEnd) {
    throw new Error("cli-bridge stream ended without the [DONE] protocol marker");
  }
  if (!completed && lastEventId === undefined) {
    throw new Error("cli-bridge stream ended without a terminal result");
  }
  if (lastEventId && requestBody !== undefined && !cancelledTerminalSeen) {
    let result: Awaited<ReturnType<typeof readFullCliBridgeResult>>;
    try {
      result = await readFullCliBridgeResult(
        options,
        requestBody,
        transport,
        signal,
        onAccepted,
      );
    } catch (error) {
      // A cursor after a cancelled terminal has no event left to replay. The
      // bridge proves that state with a typed non-streaming response; do not
      // synthesize a second terminal event for an already committed cursor.
      if (error instanceof CliBridgeRunCancelledError) return;
      throw error;
    }
    const finalModelRequests = result.modelRequests ??
      (modelRequestsKnown ? observedModelRequests : undefined);
    const finalCursor = terminalCursor ?? lastEventId;
    yield {
      type: "result",
      data: {
        finalText: result.text,
        finishReason: result.finishReason,
        status: "completed",
        ...(result.model === undefined ? {} : { model: result.model }),
        ...(result.system_fingerprint === undefined
          ? {}
          : { system_fingerprint: result.system_fingerprint }),
        runId,
        sessionId,
        ...(turn.executionId === undefined ? {} : { executionId: turn.executionId }),
        ...(finalCursor === undefined ? {} : { cursor: finalCursor }),
        ...(finalModelRequests === undefined
          ? {}
          : { modelRequests: finalModelRequests }),
      },
      ...(result.usage && !sawUsage ? { usage: result.usage } : {}),
      ...(finalCursor === undefined ? {} : { id: finalCursor }),
    };
  }
}

async function readFullCliBridgeResult(
  options: CliBridgeProviderOptions,
  requestBody: string,
  transport: CliBridgeTransport,
  signal?: AbortSignal,
  onAccepted?: (response: CliBridgeResponse) => void,
): Promise<{
  text: string;
  finishReason: string;
  usage?: TokenUsage;
  modelRequests?: number;
  model?: string;
  system_fingerprint?: string;
}> {
  const body = safeJson(requestBody);
  if (!body) throw new Error("cli-bridge replay request is not valid JSON");
  const response = await transport.fetch(`${trimSlash(options.baseUrl)}/v1/chat/completions`, {
    method: "POST",
    headers: requestHeaders(options),
    body: JSON.stringify({ ...body, stream: false }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const responseText = await response.text();
    const error = cliBridgeError(safeJson(responseText));
    if (error?.type === "run_cancelled") {
      throw new CliBridgeRunCancelledError(cliBridgeErrorMessage(error));
    }
    throw new Error(`cli-bridge replay result ${response.status}: ${responseText}`);
  }
  onAccepted?.(response);
  const parsed = safeJson(await response.text());
  const error = cliBridgeError(parsed);
  if (error) {
    if (error.type === "run_cancelled") {
      throw new CliBridgeRunCancelledError(cliBridgeErrorMessage(error));
    }
    throw new Error(`cli-bridge replay result failed: ${cliBridgeErrorMessage(error)}`);
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
  const usage = usageFromOpenAi(parsed?.usage);
  const modelRequests = modelRequestsFromOpenAi(parsed?.usage);
  const responseIdentity = responseIdentityFromOpenAi(parsed);
  return {
    text: message.content,
    finishReason: choice.finish_reason,
    ...(usage ? { usage } : {}),
    ...(modelRequests === undefined ? {} : { modelRequests }),
    ...(responseIdentity?.model === undefined ? {} : { model: responseIdentity.model }),
    ...(responseIdentity?.system_fingerprint === undefined
      ? {}
      : { system_fingerprint: responseIdentity.system_fingerprint }),
  };
}

function cliBridgeError(
  parsed: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  const error = parsed?.error;
  return error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : undefined;
}

function cliBridgeErrorMessage(error: Record<string, unknown>): string {
  return typeof error.message === "string" ? error.message : "cli-bridge replay failed";
}
