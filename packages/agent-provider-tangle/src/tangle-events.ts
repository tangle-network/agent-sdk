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

/**
 * The session ids a Sandbox event carries, kept separate by field position.
 *
 * `runFrameSessionId` is `data.sessionId`/`data.sessionID`. The run/stream lane
 * copies that value straight from the backend adapter, so on `session.updated`
 * it is the harness-native session id (Claude, Codex, OpenCode) rather than the
 * runtime session id.
 *
 * `envelopeSessionId` is the `properties` and `properties.info` position of an
 * /agents/events frame, plus `properties.part` on a frame type that publishes a
 * part. The sidecar rewrites the backend's own ids to the runtime ids before it
 * publishes there, so that position names the runtime session on every frame
 * type it shapes.
 *
 * `sessionId` is the frame's own session id for a consumer that does not care
 * which position carried it: the run-frame position when present, otherwise the
 * envelope position. It repeats one of those two values and is never a third
 * one, so a caller that must know the position reads the position.
 */
export type SandboxEventIdentity = {
  executionId?: string;
  sessionId?: string;
  runFrameSessionId?: string;
  envelopeSessionId?: string;
};

/**
 * The frame types whose `properties.part` the sidecar shapes.
 *
 * A `raw` frame carries a backend event the sidecar does not shape, so any
 * `sessionID` inside it is the backend's own value and names no runtime
 * session. The part position is therefore read only on a frame type that
 * publishes a rewritten part. A type outside this set keeps its data opaque.
 */
const PART_BEARING_FRAME_TYPES: ReadonlySet<string> = new Set([
  "message.part.updated",
]);

/**
 * The session ids a frame carries, one per field position.
 *
 * Every position that names a session is an assertion the frame makes about
 * itself, so each one is compared. Reducing them to a single precedence winner
 * leaves the losing position unchecked.
 */
export function carriedSessionIds(
  identity: SandboxEventIdentity,
): readonly string[] {
  return [identity.runFrameSessionId, identity.envelopeSessionId].filter(
    (value): value is string => value !== undefined,
  );
}

/** Unwrap the nested identity carriers of a session-bus frame. */
function sessionEnvelope(
  data: EventRecord,
  type: string | undefined,
): {
  properties?: EventRecord;
  info?: EventRecord;
  part?: EventRecord;
} {
  const record = (value: unknown): EventRecord | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as EventRecord)
      : undefined;
  const properties = record(data.properties);
  // `data.part` is the run lane's raw backend part, whose ids are the backend's
  // own. Only the part under `properties` has been rewritten to the runtime ids.
  return {
    properties,
    info: record(properties?.info),
    part:
      type !== undefined && PART_BEARING_FRAME_TYPES.has(type)
        ? record(properties?.part)
        : undefined,
  };
}

/**
 * The one value a set of alias fields carries.
 *
 * The aliases of an id within one frame are copies of a single value, so two
 * different values across them is a frame claiming two identities. Such a frame
 * is refused rather than resolved by field precedence, which would leave the
 * losing alias unchecked.
 */
function agreedIdentifier(
  values: readonly unknown[],
  label: string,
): string | undefined {
  let agreed: string | undefined;
  for (const raw of values) {
    if (raw === undefined || raw === null) continue;
    const value = optionalNonEmptyString(raw, label);
    if (value === undefined) continue;
    if (agreed === undefined) {
      agreed = value;
      continue;
    }
    if (agreed !== value) {
      throw new Error(`${label} disagreed across the fields that carry it`);
    }
  }
  return agreed;
}

/** Read identity from both run frames and /agents/events session envelopes. */
export function sandboxEventIdentity(event: SandboxEvent): SandboxEventIdentity {
  const record = event as unknown as EventRecord;
  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {};
  }
  const dataRecord = data as EventRecord;
  const { properties, info, part } = sessionEnvelope(
    dataRecord,
    typeof record.type === "string" ? record.type : undefined,
  );
  const runFrameSessionId = agreedIdentifier(
    [dataRecord.sessionId, dataRecord.sessionID],
    "Tangle Sandbox event sessionId",
  );
  const envelopeSessionId = agreedIdentifier(
    [
      properties?.sessionId,
      properties?.sessionID,
      info?.sessionId,
      info?.sessionID,
      part?.sessionId,
      part?.sessionID,
    ],
    "Tangle Sandbox event sessionId",
  );
  return {
    executionId: agreedIdentifier(
      [dataRecord.executionId, properties?.executionId, info?.executionId],
      "Tangle Sandbox event executionId",
    ),
    sessionId: runFrameSessionId ?? envelopeSessionId,
    runFrameSessionId,
    envelopeSessionId,
  };
}

/** Read the `title`/`time` content of a `session.updated` frame in either shape. */
function sessionUpdateContent(data: EventRecord): {
  title?: unknown;
  time?: unknown;
} {
  const { info } = sessionEnvelope(data, "session.updated");
  return {
    title: data.title ?? info?.title,
    time: data.time ?? info?.time,
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
  // A stream-bound iterator is the response body of the run this call started
  // or the replay of one named execution, so the transport itself excludes
  // another session's frames. On such a stream the run-frame position of
  // `session.updated` carries the harness-native session id (for example an
  // OpenCode session) rather than the runtime session id, so that one position
  // on that one frame type is content. Every other position of that frame, and
  // every position of every other frame type, names the runtime session and is
  // compared to the expected id.
  const identity = sandboxEventIdentity(event);
  const runFrameCarriesNativeSessionId =
    expected.streamBound === true && record.type === "session.updated";
  const identityBearingSessionIds = carriedSessionIds(
    runFrameCarriesNativeSessionId
      ? { envelopeSessionId: identity.envelopeSessionId }
      : identity,
  );
  if (expected.executionId !== undefined) {
    if (identity.executionId === undefined && expected.streamBound !== true) {
      throw new Error(
        "Tangle exact session event arrived without an executionId",
      );
    }
    if (
      identity.executionId !== undefined &&
      identity.executionId !== expected.executionId
    ) {
      throw new Error(
        "Tangle exact session event identified a different executionId",
      );
    }
  }
  if (expected.sessionId !== undefined) {
    if (identityBearingSessionIds.length === 0 && expected.streamBound !== true) {
      throw new Error("Tangle exact session event arrived without a sessionId");
    }
    for (const value of identityBearingSessionIds) {
      if (value !== expected.sessionId) {
        throw new Error(
          "Tangle exact session event identified a different sessionId",
        );
      }
    }
  }
  const usage = tokenUsageFromData(data);
  // The session id reaches the normalized event whichever position carried it,
  // including the native id an execution-bound stream just accepted as content.
  const normalized = normalizeSandboxEvent(record.type, data, identity);
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
  identity: SandboxEventIdentity,
): StreamEvent | undefined {
  const sessionId = identity.sessionId;
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
    // A supplied block is a field of the frame, so it repeats a session id the
    // frame's own positions carry. It carries no field position of its own, so
    // it cannot say which position it repeats: every position must agree with
    // it. Reading it against one precedence winner would leave the other
    // position free to name a different session. A frame that carries no
    // session id at all can supply no session id either.
    if (parsed.data.type === "session.updated") {
      const suppliedSessionId = parsed.data.sessionId;
      const carried = carriedSessionIds(identity);
      if (!carried.includes(suppliedSessionId)) {
        throw new Error(
          "Tangle Sandbox normalized event named a session the frame does not carry",
        );
      }
      if (carried.some((value) => value !== suppliedSessionId)) {
        throw new Error(
          "Tangle Sandbox normalized event named a session only one position of the frame carries",
        );
      }
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
    case "session.updated": {
      const content = sessionUpdateContent(data);
      return parseCanonical({
        type,
        sessionId,
        ...(typeof content.title === "string" ? { title: content.title } : {}),
        ...(content.time !== undefined ? { time: content.time } : {}),
      });
    }
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
