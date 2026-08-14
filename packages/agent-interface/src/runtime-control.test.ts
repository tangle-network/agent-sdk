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
