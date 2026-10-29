import {
  RuntimeEventEnvelopeSchema,
  type RuntimeEventEnvelope,
  type StreamEvent,
  type TokenUsage,
} from "@tangle-network/agent-interface";
import type { AgentEnvironmentEvent } from "@tangle-network/agent-interface/environment-provider";
import { providerUsageFromOpenAi as recordValue, usageFromOpenAi, type CliBridgeSseFrame } from "./wire.js";

interface CanonicalEventContext {
  readonly runId: string;
  readonly sessionId: string;
  readonly executionId?: string;
}

/** Decode one explicitly typed retained-run frame without guessing its wire format. */
export function retainedCanonicalEvent(
  frame: CliBridgeSseFrame,
  context: CanonicalEventContext,
): AgentEnvironmentEvent | undefined {
  if (frame.event === undefined) return undefined;
  if (frame.event === "error") throw retainedCanonicalStreamError(frame.data);

  const envelope = parseEnvelope(frame.data);
  if (envelope.runId !== context.runId) {
    throw new Error("cli-bridge canonical event belongs to another retained run");
  }
  if (frame.event !== envelope.event.type) {
    throw new Error("cli-bridge SSE event type does not match its canonical envelope");
  }
  if (frame.id === undefined) {
    throw new Error("cli-bridge canonical event has no replay cursor");
  }
  if (
    !isBaseTenInteger(frame.id) ||
    envelope.sequence === 0 ||
    Number(frame.id) !== envelope.sequence
  ) {
    throw new Error("cli-bridge canonical event cursor does not match its sequence");
  }

  const event = envelope.event;
  const usage = usageFromCanonicalEvent(event);
  return {
    type: event.type,
    // AgentSession.events({ since }) accepts a previously emitted event id.
    // The bridge replays by its numeric SSE cursor, while eventId identifies
    // the canonical envelope and is not a replay cursor.
    id: frame.id,
    data: {
      ...eventPayload(event),
      eventId: envelope.eventId,
      sequence: envelope.sequence,
      cursor: frame.id,
      runId: context.runId,
      sessionId: context.sessionId,
      ...(context.executionId === undefined
        ? {}
        : { executionId: context.executionId }),
      ...(envelope.occurredAt === undefined
        ? {}
        : { occurredAt: envelope.occurredAt }),
      receivedAt: envelope.receivedAt,
    },
    normalized: event,
    ...(usage === undefined ? {} : { usage }),
    providerEvent: envelope,
  };
}

export function isTerminalCanonicalEvent(
  event: AgentEnvironmentEvent,
): event is AgentEnvironmentEvent & {
  normalized: Extract<StreamEvent, { type: "status" }> & {
    status: "completed" | "failed" | "cancelled";
  };
} {
  return event.normalized?.type === "status" &&
    ["completed", "failed", "cancelled"].includes(event.normalized.status);
}

function parseEnvelope(data: string): RuntimeEventEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch (error) {
    throw new Error("cli-bridge canonical event is not valid JSON", { cause: error });
  }
  const parsed = RuntimeEventEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("cli-bridge emitted an invalid canonical event envelope", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function eventPayload(event: StreamEvent): Record<string, unknown> {
  const { type: _type, ...payload } = event;
  return payload;
}

function usageFromCanonicalEvent(event: StreamEvent): TokenUsage | undefined {
  if (event.type !== "raw") return undefined;
  const providerEvent = recordValue(event.event);
  if (providerEvent?.type !== "usage") return undefined;
  const data = recordValue(providerEvent.data);
  const usage = recordValue(providerEvent.usage) ?? recordValue(data?.usage);
  if (!usage) return undefined;
  return usageFromOpenAi({
    prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens, cache_read_input_tokens: usage.cacheReadInputTokens,
    cache_write_input_tokens: usage.cacheCreationInputTokens, reasoning_tokens: usage.reasoningTokens,
    cost: usage.cost,
  });
}

function isBaseTenInteger(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/u.test(value) && Number.isSafeInteger(Number(value));
}

function retainedCanonicalStreamError(data: string): Error {
  let message = "cli-bridge canonical event stream failed";
  try {
    const parsed = recordValue(JSON.parse(data));
    const error = recordValue(parsed?.error);
    if (typeof error?.message === "string" && error.message.length > 0) {
      message = error.message;
    }
  } catch {
    // The typed error frame is authoritative even when its detail is malformed.
  }
  return new Error(`cli-bridge: ${message}`);
}
