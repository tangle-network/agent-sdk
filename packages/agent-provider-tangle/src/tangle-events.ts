import type { SandboxEvent } from "@tangle-network/sandbox";
import {
  CanonicalStreamEventSchema,
  type StreamEvent,
} from "@tangle-network/agent-interface";
import type { AgentEnvironmentEvent } from "@tangle-network/agent-interface/environment-provider";
import { assertBoundedJson } from "./tangle-contract-safety.js";
import { optionalNonEmptyString } from "./tangle-environment-values.js";
import { tokenUsageFromData } from "./tangle-result-values.js";

type EventRecord = Record<string, unknown>;
type CanonicalStatus = "started" | "processing" | "completed" | "failed";

/** The sidecar sends this envelope when an SSE connection is ready. */
export function isSandboxConnectionMarker(event: SandboxEvent): boolean {
  if (!event || typeof event !== "object") return false;
  const record = event as unknown as EventRecord;
  if (record.type === "connection.established") return true;
  const data = record.data;
  return (
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    (data as EventRecord).type === "connection.established"
  );
}

/** Read identity from both run frames and /agents/events session envelopes. */
export function sandboxEventIdentity(event: SandboxEvent): {
  executionId?: string;
  sessionId?: string;
} {
  const record = event as unknown as EventRecord;
  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {};
  }
  const dataRecord = data as EventRecord;
  const properties =
    dataRecord.properties &&
    typeof dataRecord.properties === "object" &&
    !Array.isArray(dataRecord.properties)
      ? (dataRecord.properties as EventRecord)
      : undefined;
  const info =
    properties?.info &&
    typeof properties.info === "object" &&
    !Array.isArray(properties.info)
      ? (properties.info as EventRecord)
      : undefined;
  return {
    executionId: optionalNonEmptyString(
      dataRecord.executionId ?? properties?.executionId ?? info?.executionId,
      "Tangle Sandbox event executionId",
    ),
    sessionId: optionalNonEmptyString(
      dataRecord.sessionId ??
        dataRecord.sessionID ??
        properties?.sessionId ??
        properties?.sessionID ??
        info?.sessionId ??
        info?.sessionID,
      "Tangle Sandbox event sessionId",
    ),
  };
}

export function environmentEventFromSandboxEvent(
  event: SandboxEvent,
  expected: {
    executionId?: string;
    sessionId?: string;
    streamBound?: boolean;
  } = {},
): AgentEnvironmentEvent {
  if (!event || typeof event !== "object") {
    throw new Error("Tangle Sandbox emitted a non-object event");
  }
  const record = event as unknown as Record<string, unknown>;
  if (typeof record.type !== "string" || record.type.length === 0) {
    throw new Error("Tangle Sandbox event omitted its type");
  }
  if (record.type.length > 512 || record.type.trim() !== record.type) {
    throw new Error("Tangle Sandbox event type exceeded its bound");
  }
  if (
    !record.data ||
    typeof record.data !== "object" ||
    Array.isArray(record.data)
  ) {
    throw new Error("Tangle Sandbox event omitted its object data");
  }
  if (
    record.id !== undefined &&
    (typeof record.id !== "string" ||
      record.id.length === 0 ||
      record.id.length > 512 ||
      record.id.trim() !== record.id)
  ) {
    throw new Error("Tangle Sandbox event contained an invalid event id");
  }
  const data = record.data as Record<string, unknown>;
  assertBoundedRecord(data);
  assertBoundedJson(record);
  if (Object.prototype.hasOwnProperty.call(data, "contextTransferReceipt")) {
    throw new Error(
      "Tangle Sandbox emitted an unsolicited context transfer receipt",
    );
  }
  const { executionId: eventExecutionId, sessionId: eventSessionId } =
    sandboxEventIdentity(event);
  if (
    expected.executionId !== undefined &&
    ((eventExecutionId === undefined && expected.streamBound !== true) ||
      (eventExecutionId !== undefined && eventExecutionId !== expected.executionId))
  ) {
    throw new Error(
      "Tangle exact session event identified a different executionId",
    );
  }
  if (
    expected.sessionId !== undefined &&
    ((eventSessionId === undefined && expected.streamBound !== true) ||
      (eventSessionId !== undefined && eventSessionId !== expected.sessionId))
  ) {
    throw new Error("Tangle exact session event identified a different sessionId");
  }
  const usage = tokenUsageFromData(data);
  const normalized = normalizeSandboxEvent(record.type, data);
  return {
    type: record.type,
    data,
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(normalized ? { normalized } : {}),
    // Absent rather than zeroed: an event that reported no usage must not
    // contribute a total to whatever sums these events.
    ...(usage ? { usage } : {}),
    providerEvent: event,
  };
}

function normalizeSandboxEvent(
  type: string,
  data: Record<string, unknown>,
): StreamEvent | undefined {
  const supplied = data.normalized;
  if (supplied !== undefined) {
    const parsed = CanonicalStreamEventSchema.safeParse(supplied);
    if (!parsed.success) {
      throw new Error("Tangle Sandbox emitted an invalid normalized event");
    }
    if (parsed.data.type !== type) {
      throw new Error(
        `Tangle Sandbox normalized event type "${parsed.data.type}" does not match transport type "${type}"`,
      );
    }
    return parsed.data;
  }

  switch (type) {
    case "status": {
      const status = statusFromSandboxValue(data.status);
      if (!status) return undefined;
      return {
        type: "status",
        status,
        ...detailFromSandboxData(data),
      };
    }
    case "message.part.updated": {
      const candidate = {
        type,
        ...(data.part !== undefined ? { part: data.part } : {}),
        ...(typeof data.delta === "string" ? { delta: data.delta } : {}),
      };
      const parsed = CanonicalStreamEventSchema.safeParse(candidate);
      return parsed.success ? parsed.data : undefined;
    }
    case "tool-heartbeat":
      return parseCanonical({
        type,
        toolName: data.toolName,
        partId: data.partId,
        elapsedMs: data.elapsedMs,
      });
    case "tool-slow":
      return parseCanonical({
        type,
        toolName: data.toolName,
        partId: data.partId,
        elapsedMs: data.elapsedMs,
        thresholdMs: data.thresholdMs,
      });
    case "model-processing":
      return parseCanonical({
        type,
        phase: data.phase,
        ...(typeof data.toolName === "string" ? { toolName: data.toolName } : {}),
        ...(typeof data.elapsedMs === "number" ? { elapsedMs: data.elapsedMs } : {}),
      });
    case "warning":
      return parseCanonical({
        type,
        code: data.code,
        message: data.message,
      });
    case "session.updated":
      return parseCanonical({
        type,
        sessionId: data.sessionId ?? data.sessionID,
        ...(typeof data.title === "string" ? { title: data.title } : {}),
        ...(data.time !== undefined ? { time: data.time } : {}),
      });
    case "interaction":
      return parseCanonical({ type, request: data.request });
    case "interaction.cancel":
      return parseCanonical({
        type,
        id: data.id,
        ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
      });
    case "plan.submitted":
      return parseCanonical({ type, plan: data.plan });
    case "result":
    case "done":
    default:
      // These transport frames carry terminal/result data, but they are not
      // members of the provider-neutral canonical event union. The exact
      // result endpoint remains the authoritative result surface.
      return undefined;
  }
}

function parseCanonical(value: unknown): StreamEvent | undefined {
  const parsed = CanonicalStreamEventSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function statusFromSandboxValue(value: unknown): CanonicalStatus | undefined {
  if (typeof value !== "string") return undefined;
  switch (value) {
    case "started":
    case "queued":
      return "started";
    case "processing":
    case "running":
      return "processing";
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
    case "cancelled":
      return "failed";
    default:
      return undefined;
  }
}

function detailFromSandboxData(
  data: Record<string, unknown>,
): { detail?: string } {
  const detail = [data.detail, data.error, data.message].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return detail === undefined ? {} : { detail };
}

function assertBoundedRecord(value: Record<string, unknown>): void {
  if (Object.keys(value).length > 256) {
    throw new Error("Tangle Sandbox event data has too many fields");
  }
  const pending: Array<{ value: unknown; depth: number; leave?: boolean }> = [
    { value, depth: 0 },
  ];
  const ancestors = new Set<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) continue;
    nodes += 1;
    if (nodes > 8_192) throw new Error("Tangle Sandbox event data has too many JSON nodes");
    const current = item.value;
    if (item.leave) {
      ancestors.delete(current as object);
      continue;
    }
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "string" || typeof current === "number") {
      if (typeof current === "string" && current.length > 16_384) {
        throw new Error("Tangle Sandbox event data exceeded its string bound");
      }
      if (typeof current === "number" && !Number.isFinite(current)) {
        throw new Error("Tangle Sandbox event data contained a non-finite number");
      }
      continue;
    }
    if (typeof current !== "object" || item.depth >= 16 || ancestors.has(current)) {
      throw new Error("Tangle Sandbox event data exceeded its JSON bound");
    }
    ancestors.add(current);
    pending.push({ value: current, depth: item.depth, leave: true });
    if (Array.isArray(current)) {
      if (current.length > 1_024) {
        throw new Error("Tangle Sandbox event data has too many array entries");
      }
      for (const entry of current) pending.push({ value: entry, depth: item.depth + 1 });
      continue;
    }
    if (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
      throw new Error("Tangle Sandbox event data must be plain JSON");
    }
    const keys = Object.keys(current);
    if (keys.length > 256) throw new Error("Tangle Sandbox event map is too large");
    for (const key of keys) {
      if (key.length > 512) throw new Error("Tangle Sandbox event key is too long");
      pending.push({ value: (current as Record<string, unknown>)[key], depth: item.depth + 1 });
    }
  }
}
