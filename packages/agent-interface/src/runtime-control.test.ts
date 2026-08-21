import { describe, expect, it } from "vitest";
import {
  AgentRunCancellationAcknowledgementSchema,
  AgentRunCancellationRequestSchema,
  AgentRunControlRefSchema,
  CanonicalStreamEventSchema,
  RuntimeEventEnvelopeSchema,
  agentRunCancellationAcknowledgementMatchesRequest,
  agentRunCancellationRequestDigest,
} from "./runtime-control.js";
import { interactionRequestDigest } from "./interaction-envelope.js";

describe("durable run control", () => {
  it("validates provider-neutral coordinates needed after process restart", () => {
    const reference = {
      runId: "run-1",
      provider: "cli-bridge",
      environmentId: "local-1",
      sessionId: "session-1",
      executionId: "execution-1",
      requestDigest: `sha256:${"a".repeat(64)}`,
    };
    expect(AgentRunControlRefSchema.parse(reference)).toEqual(reference);
    expect(() =>
      AgentRunControlRefSchema.parse({ ...reference, provider: " cli-bridge" }),
    ).toThrow(/outer whitespace/);
  });

  it("binds a retry-safe cancellation to one exact run and request digest", () => {
    const material = {
      operationId: "cancel-1",
      run: {
        runId: "run-1",
        provider: "cli-bridge",
        environmentId: "local-1",
        sessionId: "session-1",
        executionId: "execution-1",
        requestDigest: `sha256:${"b".repeat(64)}` as `sha256:${string}`,
      },
      reason: "user requested stop",
    };
    const request = AgentRunCancellationRequestSchema.parse({
      ...material,
      requestDigest: agentRunCancellationRequestDigest(material),
    });
    const acknowledgement = AgentRunCancellationAcknowledgementSchema.parse({
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      run: request.run,
      status: "accepted",
      effect: "cancel_requested",
    });
    expect(
      agentRunCancellationAcknowledgementMatchesRequest(request, acknowledgement),
    ).toBe(true);
    expect(() =>
      AgentRunCancellationRequestSchema.parse({ ...request, reason: "changed" }),
    ).toThrow(/digest/);
    expect(() =>
      AgentRunCancellationAcknowledgementSchema.parse({
        ...acknowledgement,
        status: "accepted",
        effect: "unknown",
      }),
    ).toThrow(/certainty/);
  });
});

describe("runtime event envelope", () => {
  it("preserves stable run, event, sequence, cursor, and canonical event", () => {
    const envelope = {
      runId: "run-1",
      eventId: "event-7",
      sequence: 7,
      cursor: "cursor-7",
      occurredAt: "2026-08-01T20:00:00.000Z",
      receivedAt: "2026-08-01T20:00:00.010Z",
      event: { type: "status", status: "processing" as const },
    };
    expect(RuntimeEventEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it("rejects malformed identities, sequence, timestamps, and event values", () => {
    const valid = {
      runId: "run-1",
      eventId: "event-1",
      sequence: 1,
      receivedAt: "2026-08-01T20:00:00.000Z",
      event: { type: "status", status: "processing" as const },
    };
    for (const invalid of [
      { ...valid, runId: "" },
      { ...valid, sequence: -1 },
      { ...valid, receivedAt: "yesterday" },
      { ...valid, event: { status: "running" } },
      { ...valid, event: { type: "result", data: { success: true } } },
      { ...valid, event: { type: "status", status: "running" } },
    ]) {
      expect(() => RuntimeEventEnvelopeSchema.parse(invalid)).toThrow();
    }
  });

  it("validates every canonical event variant and rejects extra fields", () => {
    const part = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "text" as const,
      text: "hello",
    };
    const events = [
      { type: "message.part.updated", part, delta: "hello" },
      {
        type: "tool-heartbeat",
        toolName: "shell",
        partId: "part-1",
        elapsedMs: 10,
      },
      {
        type: "tool-slow",
        toolName: "shell",
        partId: "part-1",
        elapsedMs: 1_000,
        thresholdMs: 500,
      },
      { type: "model-processing", phase: "thinking", elapsedMs: 5 },
      { type: "status", status: "completed", detail: "done" },
      { type: "warning", code: "slow", message: "slow response" },
      { type: "raw", backend: "pi", event: { vendor: true } },
      {
        type: "session.updated",
        sessionId: "session-1",
        time: { created: 1, updated: 2 },
      },
      {
        type: "interaction",
        request: {
          id: "interaction-1",
          kind: "question",
          title: "Continue?",
          answerSpec: { fields: [] },
          binding: {
            runId: "run-1",
            provider: "cli-bridge",
            environmentId: "environment-1",
            sessionId: "session-1",
            executionId: "execution-1",
            interactionId: "interaction-1",
          },
          requestDigest: interactionRequestDigest({
            id: "interaction-1",
            kind: "question",
            title: "Continue?",
            answerSpec: { fields: [] },
            binding: {
              runId: "run-1",
              provider: "cli-bridge",
              environmentId: "environment-1",
              sessionId: "session-1",
              executionId: "execution-1",
              interactionId: "interaction-1",
            },
          }),
        },
      },
      { type: "interaction.cancel", id: "interaction-1", reason: "done" },
      {
        type: "plan.submitted",
        plan: {
          id: "plan-1",
          revision: 1,
          body: "1. Continue",
          submittedAt: "2026-08-01T20:00:00.000Z",
        },
      },
      {
        type: "child-task",
        childId: "child-1",
        status: "started",
        title: "Review tests",
        time: { started: 1_000, updated: 1_000 },
        runner: "claude-code",
        sourceEventId: "event-1",
      },
      {
        type: "child-task",
        childId: "child-2",
        parentChildId: "child-1",
        status: "completed",
        time: { started: 1_100, updated: 1_900, ended: 1_900 },
        runner: "claude-code",
        model: "claude-sonnet-4-5",
        usage: { inputTokens: 10, outputTokens: 4, cost: 0.01 },
        terminalReason: "end_turn",
        sourceEventId: "event-2",
        raw: { vendor: { agentType: "reviewer" } },
      },
    ];
    for (const event of events) {
      expect(CanonicalStreamEventSchema.parse(event)).toEqual(event);
    }
    expect(() =>
      CanonicalStreamEventSchema.parse({
        type: "status",
        status: "completed",
        adminOverride: true,
      }),
    ).toThrow();
  });

  it("preserves caller cancellation as a canonical terminal status", () => {
    const event = {
      type: "status",
      status: "cancelled",
      detail: "run cancelled by caller",
    } as const;

    expect(CanonicalStreamEventSchema.parse(event)).toEqual(event);
    expect(
      RuntimeEventEnvelopeSchema.parse({
        runId: "run-cancelled",
        eventId: "event-cancelled",
        sequence: 1,
        cursor: "1:0",
        receivedAt: "2026-08-14T06:00:00.000Z",
        event,
      }).event,
    ).toEqual(event);
  });
});

describe("child-task lifecycle event", () => {
  const started = {
    type: "child-task",
    childId: "child-1",
    status: "started",
    time: { started: 1_000, updated: 1_000 },
    sourceEventId: "event-1",
  } as const;
  const completed = {
    type: "child-task",
    childId: "child-2",
    parentChildId: "child-1",
    status: "completed",
    title: "Write the failing test",
    time: { started: 1_100, updated: 1_900, ended: 1_900 },
    runner: "opencode",
    model: "gpt-5",
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    terminalReason: "end_turn",
    sourceEventId: "event-2",
    raw: { vendor: { agentType: "tester" } },
  } as const;

  it("accepts a root child, a nested terminal child, and a run-parented update", () => {
    expect(CanonicalStreamEventSchema.parse(started)).toEqual(started);
    expect(CanonicalStreamEventSchema.parse(completed)).toEqual(completed);
    const running = {
      ...started,
      status: "running",
      time: { started: 1_000, updated: 1_500 },
      sourceEventId: "event-3",
    };
    expect(CanonicalStreamEventSchema.parse(running)).toEqual(running);
  });

  it("rejects a child task without stable identity, with contradictory certainty, or with unknown fields", () => {
    const { childId: _childId, ...withoutChildId } = started;
    const { sourceEventId: _sourceEventId, ...withoutSourceEventId } = started;
    for (const [invalid, reason] of [
      [withoutChildId, /childId/],
      [withoutSourceEventId, /sourceEventId/],
      [{ ...started, childId: "" }, /childId/],
      [{ ...started, childId: " child-1" }, /outer whitespace/],
      [{ ...started, parentChildId: "child-1" }, /own parent/],
      [{ ...started, time: { started: 1_000, updated: 1_000, ended: 1_000 } }, /end time/],
      [{ ...started, terminalReason: "end_turn" }, /terminal reason/],
      [{ ...started, time: { started: 1_000, updated: 900 } }, /precede its start/],
      [
        { ...completed, time: { started: 1_100, updated: 1_900, ended: 1_000 } },
        /precede its start/,
      ],
      [{ ...started, time: { started: -1, updated: 1_000 } }, /time/],
      [{ ...started, time: { started: 1_000 } }, /updated/],
      [{ ...completed, usage: { inputTokens: -1, outputTokens: 0 } }, /usage/],
      [{ ...completed, raw: ["not", "a", "record"] }, /raw/],
      [{ ...started, status: "paused" }, /status/],
      [{ ...started, agentType: "tester" }, /agentType/],
    ] as const) {
      expect(() => CanonicalStreamEventSchema.parse(invalid), JSON.stringify(invalid)).toThrow(
        reason,
      );
    }
  });

  it("round-trips through the runtime event envelope", () => {
    const envelope = {
      runId: "run-1",
      eventId: "event-12",
      sequence: 12,
      cursor: "12:0",
      occurredAt: "2026-08-20T10:00:00.000Z",
      receivedAt: "2026-08-20T10:00:00.010Z",
      event: completed,
    };
    expect(RuntimeEventEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(() =>
      RuntimeEventEnvelopeSchema.parse({
        ...envelope,
        event: { ...completed, sourceEventId: "" },
      }),
    ).toThrow(/sourceEventId/);
  });

  it("dedupes by sourceEventId so live and replayed streams build the same tree", () => {
    const live = [
      started,
      { ...started, status: "running", time: { started: 1_000, updated: 1_200 }, sourceEventId: "event-2" },
      { ...completed, sourceEventId: "event-3" },
      { ...started, status: "completed", time: { started: 1_000, updated: 2_000, ended: 2_000 }, sourceEventId: "event-4" },
    ] as const;
    const replayed = [live[0], live[1], live[1], live[2], live[2], live[3], live[0]];
    const tree = (events: ReadonlyArray<(typeof live)[number]>) => {
      const applied = new Set<string>();
      const children = new Map<string, { parentChildId?: string; status: string }>();
      for (const event of events) {
        const parsed = CanonicalStreamEventSchema.parse(event);
        if (parsed.type !== "child-task") continue;
        if (applied.has(parsed.sourceEventId)) continue;
        applied.add(parsed.sourceEventId);
        children.set(parsed.childId, {
          ...(parsed.parentChildId !== undefined
            ? { parentChildId: parsed.parentChildId }
            : {}),
          status: parsed.status,
        });
      }
      return { applied: applied.size, children: [...children.entries()] };
    };
    const fromLive = tree(live);
    const fromReplay = tree(replayed);
    expect(fromReplay).toEqual(fromLive);
    expect(fromLive).toEqual({
      applied: 4,
      children: [
        ["child-1", { status: "completed" }],
        ["child-2", { parentChildId: "child-1", status: "completed" }],
      ],
    });
  });
});
