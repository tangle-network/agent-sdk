import { AgentEnvironmentCapabilitiesSchema } from "@tangle-network/agent-interface/environment-provider";
import { AgentRunControlRefSchema } from "@tangle-network/agent-interface";
import type { SessionReplayConformanceOptions, SessionReplayConformanceReport } from "./conformance-types.js";
import { assert, collect, deepEqual, isTerminalEvent, withEnvironmentCleanup } from "./conformance-helpers.js";

export async function runSessionReplayConformance(
  options: SessionReplayConformanceOptions,
): Promise<SessionReplayConformanceReport> {
  const checked: string[] = [];
  const provider = await options.createProvider();
  const capabilities = AgentEnvironmentCapabilitiesSchema.parse(
    await provider.capabilities(),
  );
  assert(capabilities.streaming.detach, "provider must declare detach", checked);
  assert(capabilities.streaming.replay, "provider must declare replay", checked);
  const environment = await provider.create({
    profile: { name: `${options.name}-profile` },
    name: `${options.name}-environment`,
    ...(options.createInput ?? {}),
  });
  return withEnvironmentCleanup(environment, checked, async () => {
    assert(
      typeof environment.dispatch === "function",
      "detach requires dispatch()",
      checked,
    );
    assert(
      typeof environment.session === "function",
      "replay requires session()",
      checked,
    );
    const reference = await environment.dispatch({
      ...options.turn,
      detach: true,
    });
    assert(
      reference.controlRef,
      "detached session requires a durable control reference",
      checked,
    );
    const controlRef = AgentRunControlRefSchema.parse(reference.controlRef);
    assert(
      controlRef.provider === provider.name &&
        controlRef.environmentId === environment.id &&
        controlRef.sessionId === reference.id,
      "detached control reference does not identify the dispatched session",
      checked,
    );
    const session = environment.session(reference.id, {
      controlRef,
    });
    assert(
      session.id === reference.id &&
        session.controlRef &&
        deepEqual(session.controlRef, controlRef),
      "session control reference differs from dispatch",
      checked,
    );
    checked.push("detach-control-reference");

    const competingControlRef = AgentRunControlRefSchema.parse({
      ...controlRef,
      runId: `${controlRef.runId}-competing`,
      ...(controlRef.executionId
        ? { executionId: `${controlRef.executionId}-competing` }
        : {}),
    });
    let competingRunRejected = false;
    try {
      const competingSession = environment.session(reference.id, {
        controlRef: competingControlRef,
      });
      if (!deepEqual(competingSession.controlRef, competingControlRef)) {
        competingRunRejected = true;
      } else {
        await collect(
          competingSession.events({
            ...(competingControlRef.executionId
              ? { executionId: competingControlRef.executionId }
              : {}),
          }),
        );
      }
    } catch {
      competingRunRejected = true;
    }
    assert(
      competingRunRejected,
      "session replay accepted a competing run control reference",
      checked,
    );
    checked.push("competing-run-isolation");

    const events = await collect(session.events());
    assert(events.length > 1, "replay check requires at least two events", checked);
    assert(
      events.some(isTerminalEvent),
      "session event stream must terminate",
      checked,
    );
    const eventIds = events.map((event) => event.id);
    assert(
      eventIds.every(
        (eventId) => typeof eventId === "string" && eventId.length > 0,
      ),
      "replayable session events require stable ids",
      checked,
    );
    assert(
      new Set(eventIds).size === eventIds.length,
      "replayable session event ids must be unique",
      checked,
    );
    checked.push("stable-event-ids");

    const cursor = eventIds[0]!;
    const expectedReplay = eventIds.slice(1);
    const sameClientReplay = await collect(
      session.events({
        since: cursor,
        ...(controlRef.executionId
          ? { executionId: controlRef.executionId }
          : {}),
      }),
    );
    assert(
      deepEqual(
        sameClientReplay.map((event) => event.id),
        expectedReplay,
      ),
      "same-client replay differs after cursor",
      checked,
    );
    checked.push("same-client-replay");

    const reconnected = await options.reconnect(reference);
    assert(
      reconnected.id === reference.id &&
        reconnected.controlRef &&
        deepEqual(reconnected.controlRef, controlRef),
      "reconnected session identity differs from dispatch",
      checked,
    );
    const reconnectedReplay = await collect(
      reconnected.events({
        since: cursor,
        ...(controlRef.executionId
          ? { executionId: controlRef.executionId }
          : {}),
      }),
    );
    assert(
      deepEqual(
        reconnectedReplay.map((event) => event.id),
        expectedReplay,
      ),
      "reconnected replay differs after cursor",
      checked,
    );
    checked.push("reconnected-replay");

    return {
      name: options.name,
      sessionId: reference.id,
      eventIds: eventIds as string[],
      checked,
    };
  });
}

/** Prove durable binding and idempotency for one prepared interaction. */
