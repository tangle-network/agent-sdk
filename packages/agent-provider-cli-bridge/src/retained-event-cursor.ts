import type { AgentEnvironmentEvent } from "@tangle-network/agent-interface/environment-provider";

interface RetainedReplayAnchor {
  readonly frameId: string;
  readonly eventIndex: number;
}

export interface RetainedReplayRequest {
  readonly serverCursor?: string;
  readonly anchor?: RetainedReplayAnchor;
}

/**
 * Translate one provider event cursor into the frame cursor understood by
 * cli-bridge. A composite cursor replays its source frame, then filters the
 * canonical events that the caller already committed.
 */
export function retainedReplayRequest(cursor?: string): RetainedReplayRequest {
  if (cursor === undefined) return {};
  if (isBaseTenInteger(cursor)) {
    assertSafeInteger(cursor, "cli-bridge replay cursor");
    return { serverCursor: cursor };
  }
  const match = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/u.exec(cursor);
  if (!match) throw new Error("cli-bridge replay cursor is invalid");
  const frameId = match[1]!;
  const eventIndexText = match[2]!;
  const frameSequence = assertSafeInteger(frameId, "cli-bridge replay frame");
  const eventIndex = assertSafeInteger(eventIndexText, "cli-bridge replay event index");
  if (frameSequence === 0) {
    throw new Error("cli-bridge retained event frame must be positive");
  }
  return {
    serverCursor: String(frameSequence - 1),
    anchor: { frameId, eventIndex },
  };
}

/** Add exact per-event identity to all canonical events from one SSE frame. */
export function* retainedEventsWithIdentity(
  events: readonly AgentEnvironmentEvent[],
  frameId?: string,
  runId?: string,
  sessionId?: string,
  executionId?: string,
  replayAnchor?: RetainedReplayAnchor,
): Iterable<AgentEnvironmentEvent> {
  if (frameId === undefined) {
    yield* events;
    return;
  }
  const frameSequence = assertSafeInteger(frameId, "cli-bridge retained event id");
  if (frameSequence === 0) {
    throw new Error("cli-bridge retained event id must be positive");
  }
  for (let index = 0; index < events.length; index += 1) {
    if (
      replayAnchor?.frameId === frameId &&
      index <= replayAnchor.eventIndex
    ) {
      continue;
    }
    const event = events[index]!;
    const cursor = `${frameId}:${index}`;
    yield {
      ...event,
      id: cursor,
      data: {
        ...event.data,
        cursor,
        ...(runId === undefined ? {} : { runId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(executionId === undefined ? {} : { executionId }),
      },
    };
  }
}

function isBaseTenInteger(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/u.test(value);
}

function assertSafeInteger(value: string, label: string): number {
  if (!isBaseTenInteger(value)) throw new Error(`${label} must be a base-10 integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds the supported range`);
  return parsed;
}
