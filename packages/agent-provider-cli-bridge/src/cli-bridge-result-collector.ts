import type {
  AgentEnvironmentEvent,
  AgentTurnResult,
} from "@tangle-network/agent-interface/environment-provider";
import type { TokenUsage } from "@tangle-network/agent-interface";
import {
  cancelCliBridgeRun,
  getCliBridgeRun,
} from "./cli-bridge-client.js";
import {
  addLimit,
  CLI_BRIDGE_MAX_RESULT_BYTES,
  CLI_BRIDGE_MAX_RESULT_EVENTS,
  CLI_BRIDGE_MAX_RESULT_TEXT_BYTES,
  CliBridgeProtocolError,
  preserveRootError,
  utf8Bytes,
} from "./cli-bridge-limits.js";
import { CliBridgeRunIdentityError } from "./cli-bridge-response.js";
import { settleCliBridgeSession } from "./cli-bridge-runs.js";
import type {
  CliBridgeProviderOptions,
  CliBridgeRun,
  CliBridgeSessionState,
  CliBridgeTransport,
} from "./cli-bridge-types.js";

export async function collectCliBridgeTurnResult(
  source: AsyncIterable<AgentEnvironmentEvent>,
  run: CliBridgeRun,
  options: CliBridgeProviderOptions,
  transport: CliBridgeTransport,
  runs: Map<string, CliBridgeRun>,
  sessions: Map<string, CliBridgeSessionState>,
): Promise<AgentTurnResult> {
  const events: AgentEnvironmentEvent[] = [];
  let text = "";
  let textBytes = 0;
  let resultBytes = 0;
  let eventCount = 0;
  let usage: TokenUsage | undefined;
  let streamError: unknown;
  let streamFailed = false;
  let collectorFailed = false;
  try {
    for await (const event of source) {
      try {
        const retainedEvent = compactResultEvent(event);
        let encodedEvent: string;
        try {
          encodedEvent = JSON.stringify(retainedEvent);
        } catch {
          throw new CliBridgeProtocolError("invalid-json", 0, 0);
        }
        resultBytes = addLimit(
          resultBytes,
          utf8Bytes(encodedEvent),
          CLI_BRIDGE_MAX_RESULT_BYTES,
          "result-bytes",
        );
        eventCount = addLimit(
          eventCount,
          1,
          CLI_BRIDGE_MAX_RESULT_EVENTS,
          "result-event-count",
        );
        events.push(retainedEvent);
        const finalText = event.data.finalText;
        if (typeof finalText === "string") {
          text = finalText;
          textBytes = utf8Bytes(text);
        } else if (typeof event.data.delta === "string") {
          textBytes = addLimit(
            textBytes,
            utf8Bytes(event.data.delta),
            CLI_BRIDGE_MAX_RESULT_TEXT_BYTES,
            "result-text-bytes",
          );
          text += event.data.delta;
        }
        if (textBytes > CLI_BRIDGE_MAX_RESULT_TEXT_BYTES) {
          throw new CliBridgeProtocolError(
            "result-text-bytes",
            CLI_BRIDGE_MAX_RESULT_TEXT_BYTES,
            textBytes,
          );
        }
        usage = addTokenUsage(usage, event.usage);
      } catch (error) {
        collectorFailed = true;
        throw error;
      }
    }
  } catch (error) {
    streamFailed = true;
    streamError = error;
  }

  if (streamFailed && streamError instanceof CliBridgeProtocolError) {
    if (collectorFailed && run.accepted) {
      try {
        await cancelCliBridgeRun(options, transport, run);
        run.settled = true;
        if (runs.get(run.id) === run) runs.delete(run.id);
        settleCliBridgeSession(run, run.sessionPrevious, sessions);
      } catch (cleanupError) {
        throw preserveRootError(
          streamError,
          cleanupError,
          "cli-bridge result retention cleanup was not confirmed",
        );
      }
    }
    throw streamError;
  }
  if (streamFailed && streamError instanceof CliBridgeRunIdentityError) {
    throw streamError;
  }

  let snapshot;
  try {
    snapshot = await getCliBridgeRun(options, transport, run.id);
  } catch (statusError) {
    if (streamFailed) throw streamError;
    throw statusError;
  }
  if (!snapshot) {
    if (streamFailed) throw streamError;
    throw new Error(`cli-bridge lost run "${run.id}" before reading its result`);
  }
  if (!snapshot.terminal) {
    if (streamFailed) throw streamError;
    throw new Error(`cli-bridge run "${run.id}" has no terminal result`);
  }
  run.settled = true;
  if (runs.get(run.id) === run) runs.delete(run.id);
  settleCliBridgeSession(run, run.sessionPrevious, sessions);
  const success = snapshot.status === "done" && !streamFailed;
  return {
    text,
    success,
    ...(!success
      ? {
          error:
            streamError instanceof Error
              ? streamError.message
              : `cli-bridge run ended ${snapshot.status}`,
        }
      : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(usage ? { usage } : {}),
    metadata: {
      runId: run.id,
      status: snapshot.status,
      ...(run.requestDigest ? { requestDigest: run.requestDigest } : {}),
    },
    events,
  };
}

function compactResultEvent(event: AgentEnvironmentEvent): AgentEnvironmentEvent {
  const part = event.data.part;
  if (
    !part ||
    typeof part !== "object" ||
    !("type" in part) ||
    part.type !== "text"
  ) {
    return event;
  }
  const delta = event.data.delta;
  if (typeof delta !== "string") return event;
  const compactedPart = { ...(part as Record<string, unknown>), text: delta };
  const normalized =
    event.normalized?.type === "message.part.updated" &&
    event.normalized.part.type === "text"
      ? {
          ...event.normalized,
          part: { ...event.normalized.part, text: delta },
        }
      : event.normalized;
  return {
    ...event,
    data: { ...event.data, part: compactedPart },
    ...(normalized === undefined ? {} : { normalized }),
  };
}

function addTokenUsage(
  current: TokenUsage | undefined,
  next: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!next) return current;
  if (!current) return { ...next };
  return {
    inputTokens: current.inputTokens + next.inputTokens,
    outputTokens: current.outputTokens + next.outputTokens,
    ...(current.totalTokens !== undefined || next.totalTokens !== undefined
      ? { totalTokens: (current.totalTokens ?? 0) + (next.totalTokens ?? 0) }
      : {}),
    ...(current.cacheReadInputTokens !== undefined ||
    next.cacheReadInputTokens !== undefined
      ? {
          cacheReadInputTokens:
            (current.cacheReadInputTokens ?? 0) +
            (next.cacheReadInputTokens ?? 0),
        }
      : {}),
    ...(current.cacheCreationInputTokens !== undefined ||
    next.cacheCreationInputTokens !== undefined
      ? {
          cacheCreationInputTokens:
            (current.cacheCreationInputTokens ?? 0) +
            (next.cacheCreationInputTokens ?? 0),
        }
      : {}),
    ...(current.reasoningTokens !== undefined || next.reasoningTokens !== undefined
      ? {
          reasoningTokens:
            (current.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
        }
      : {}),
    ...(current.cost !== undefined || next.cost !== undefined
      ? { cost: (current.cost ?? 0) + (next.cost ?? 0) }
      : {}),
  };
}
