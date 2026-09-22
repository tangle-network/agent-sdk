import type {
  AgentEnvironmentEvent,
  AgentTurnInput,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  MessagePartUpdatedEvent,
  TextPart,
  ToolPart,
} from "@tangle-network/agent-interface";
import {
  parseJson,
  eventsWithCursor,
  parseSse,
  toolCallsFromDelta,
  usageFromOpenAi,
} from "./cli-bridge-sse.js";
import {
  addLimit,
  boundedErrorDetail,
  CLI_BRIDGE_MAX_EVENTS,
  CLI_BRIDGE_MAX_RESULT_TEXT_BYTES,
  CLI_BRIDGE_MAX_TOOL_CALLS,
  CliBridgeProtocolError,
  preserveRootError,
  utf8Bytes,
} from "./cli-bridge-limits.js";
import { readFullCliBridgeResult } from "./cli-bridge-result.js";
import {
  acceptCliBridgeResponse,
  detachCliBridgeReader,
  readCliBridgeResponseText,
} from "./cli-bridge-response.js";
import { requestHeaders, trimSlash } from "./cli-bridge-transport.js";
import type {
  CliBridgeProviderOptions,
  CliBridgeResponse,
  CliBridgeTransport,
} from "./cli-bridge-types.js";

export class CliBridgeRequestRejectedError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`cli-bridge ${status}: ${boundedErrorDetail(detail)}`);
    this.name = "CliBridgeRequestRejectedError";
  }
}

export async function* streamCliBridgeTurn(
  options: CliBridgeProviderOptions,
  turn: AgentTurnInput,
  requestBody: string,
  transport: CliBridgeTransport,
  runId: string,
  lastEventId?: string,
  signal?: AbortSignal,
  onAccepted?: (response: CliBridgeResponse) => void,
): AsyncIterable<AgentEnvironmentEvent> {
  const response = await transport.fetch(
    `${trimSlash(options.baseUrl)}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        ...requestHeaders(options, turn.sessionId),
        accept: "text/event-stream",
        ...(lastEventId ? { "last-event-id": lastEventId } : {}),
      },
      body: requestBody,
      signal,
    },
  );
  if (!response.ok) {
    let detail = "request rejected";
    try {
      detail = await readCliBridgeResponseText(response);
    } catch (error) {
      if (error instanceof CliBridgeProtocolError) throw error;
      // The HTTP status already proves this request was rejected.
    }
    throw new CliBridgeRequestRejectedError(response.status, detail);
  }
  let text = "";
  let textBytes = 0;
  const sessionId = turn.sessionId ?? runId;
  const messageId = turn.turnId ?? `${sessionId}:assistant`;
  const emittedToolCalls = new Set<string>();
  let toolCallCount = 0;
  let eventCount = 0;
  let completed = false;
  let sawUsage = false;
  let terminalCursor: string | undefined;
  let bodyConsumed = false;
  let rootError: unknown;
  try {
    acceptCliBridgeResponse(response, requestBody, onAccepted);
    if (!response.body) {
      throw new CliBridgeProtocolError("invalid-body", 0, 0);
    }
    const responseBody = response.body;
    for await (const frame of parseSse(responseBody)) {
      if (frame.data === "[DONE]") continue;
      const parsed = parseJson(frame.data);
      if (parsed.error && typeof parsed.error === "object") {
        const error = parsed.error as Record<string, unknown>;
        const message =
          typeof error.message === "string"
            ? boundedErrorDetail(error.message)
            : "cli-bridge error";
        eventCount = addLimit(eventCount, 1, CLI_BRIDGE_MAX_EVENTS, "event-count");
        yield {
          type: "status",
          data: { status: "failed", error: message },
          ...(frame.id ? { id: frame.id } : {}),
        };
        throw new Error(`cli-bridge: ${message}`);
      }
      const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
      const delta = choice?.delta;
      const chunk =
        delta && typeof delta.content === "string" ? delta.content : "";
      if (chunk) {
        textBytes = addLimit(
          textBytes,
          utf8Bytes(chunk),
          CLI_BRIDGE_MAX_RESULT_TEXT_BYTES,
          "result-text-bytes",
        );
        text += chunk;
      }
      const nextUsage = usageFromOpenAi(parsed.usage);
      const frameEvents: AgentEnvironmentEvent[] = [];
      if (nextUsage) {
        sawUsage = true;
        frameEvents.push({ type: "usage", data: {}, usage: nextUsage });
      }
      if (chunk) {
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
      const toolCalls = toolCallsFromDelta(delta);
      toolCallCount = addLimit(
        toolCallCount,
        toolCalls.length,
        CLI_BRIDGE_MAX_TOOL_CALLS,
        "tool-call-count",
      );
      for (const toolCall of toolCalls) {
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
      const finishReason =
        typeof choice?.finish_reason === "string"
          ? choice.finish_reason
          : undefined;
      if (finishReason) {
        if (finishReason === "error") {
          frameEvents.push({
            type: "status",
            data: {
              status: "failed",
              error: "cli-bridge returned finish_reason=error",
            },
          });
          eventCount = addLimit(
            eventCount,
            frameEvents.length,
            CLI_BRIDGE_MAX_EVENTS,
            "event-count",
          );
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
              finishReason,
              status: "completed",
            },
          });
        }
      }
      eventCount = addLimit(
        eventCount,
        frameEvents.length,
        CLI_BRIDGE_MAX_EVENTS,
        "event-count",
      );
      yield* eventsWithCursor(
        frameEvents,
        finishReason && lastEventId ? undefined : frame.id,
      );
    }
    bodyConsumed = true;
    if (!completed && !lastEventId) {
      throw new Error("cli-bridge stream ended without a terminal result");
    }
    if (lastEventId) {
      const result = await readFullCliBridgeResult(
        options,
        requestBody,
        transport,
        signal,
        turn.sessionId,
        onAccepted,
      );
      if (result.usage && !sawUsage) {
        eventCount = addLimit(eventCount, 1, CLI_BRIDGE_MAX_EVENTS, "event-count");
        yield { type: "usage", data: {}, usage: result.usage };
      }
      eventCount = addLimit(eventCount, 1, CLI_BRIDGE_MAX_EVENTS, "event-count");
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
  } catch (error) {
    rootError = error;
    throw error;
  } finally {
    if (!bodyConsumed && response.body) {
      try {
        await detachCliBridgeReader(response.body);
      } catch (detachError) {
        if (rootError !== undefined) {
          throw preserveRootError(
            rootError,
            detachError,
            "cli-bridge response reader cleanup failed",
          );
        }
        throw detachError;
      }
    }
  }
}



