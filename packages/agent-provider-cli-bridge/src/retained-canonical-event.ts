import {
  RuntimeEventEnvelopeSchema,
  type RuntimeEventEnvelope,
  type StreamEvent,
  type TokenUsage,
} from "@tangle-network/agent-interface";
import type { AgentEnvironmentEvent } from "@tangle-network/agent-interface/environment-provider";
import type { CliBridgeSseFrame } from "./wire.js";

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
    id: envelope.eventId,
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

export function isTerminalCanonicalEvent(event: AgentEnvironmentEvent): boolean {
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
  const inputTokens = nonNegativeInteger(usage.inputTokens);
  const outputTokens = nonNegativeInteger(usage.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...optionalInteger(usage, "totalTokens"),
    ...optionalInteger(usage, "cacheReadInputTokens"),
    ...optionalInteger(usage, "cacheCreationInputTokens"),
    ...optionalInteger(usage, "reasoningTokens"),
    ...optionalNumber(usage, "cost"),
  };
}

function optionalInteger(
  source: Record<string, unknown>,
  key: keyof TokenUsage,
): Partial<TokenUsage> {
  const value = nonNegativeInteger(source[key]);
  return value === undefined ? {} : { [key]: value };
}

function optionalNumber(
  source: Record<string, unknown>,
  key: keyof TokenUsage,
): Partial<TokenUsage> {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? { [key]: value }
    : {};
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
