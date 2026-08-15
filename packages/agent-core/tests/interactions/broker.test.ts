import {
  InteractionRequestSchema,
  type InteractionResponse,
  interactionRequestDigest,
  type StreamEvent,
} from "@tangle-network/agent-interface";
import { describe, expect, it } from "vitest";
import {
  coercePermissionGrant,
  InteractionBroker,
  interactionAnswerSpecForQuestions,
  interactionDataToQuestionAnswers,
} from "../../src/interactions/broker.js";

type InteractionEvent = Extract<StreamEvent, { type: "interaction" }>;

const binding = (sessionId: string) => ({
  runId: `run-${sessionId}`,
  provider: "test-provider",
  environmentId: "environment-1",
  sessionId,
  executionId: `execution-${sessionId}`,
});

describe("InteractionBroker permissions", () => {
  it("binds and digests the canonical request", async () => {
    const broker = new InteractionBroker();
    const events: StreamEvent[] = [];
    const pending = broker.request({
      id: "permission-1",
      sessionId: "session-1",
      binding: binding("session-1"),
      toolName: "bash",
      allowlistGrant: "deny",
      emit: (event) => events.push(event),
    });

    const event = events[0] as InteractionEvent;
    const request = InteractionRequestSchema.parse(event.request);
    expect(request.subject).toEqual({ type: "tool", toolName: "bash" });
    expect(request.binding).toEqual({
      ...binding("session-1"),
      interactionId: "permission-1",
    });
    const { requestDigest, ...material } = request;
    expect(requestDigest).toBe(interactionRequestDigest(material));

    expect(broker.respond({ id: request.id, outcome: "declined" })).toBe(true);
    await expect(pending).resolves.toBe("deny");
  });

  it("honors only grants declared by the request", async () => {
    const broker = new InteractionBroker();
    const pending = broker.request({
      id: "permission-1",
      sessionId: "session-1",
      binding: binding("session-1"),
      toolName: "write",
      allowlistGrant: "deny",
      emit: () => undefined,
    });

    broker.respond({
      id: "permission-1",
      outcome: "accepted",
      data: { grant: ["allow_always"] },
    });
    await expect(pending).resolves.toBe("deny");
  });

  it("returns the static default when no UI is attached", async () => {
    const broker = new InteractionBroker();
    await expect(
      broker.request({
        id: "permission-1",
        sessionId: "session-1",
        binding: binding("session-1"),
        toolName: "read",
        allowlistGrant: "allow_session",
      }),
    ).resolves.toBe("allow_session");
  });

  it("enforces the declared timeout without an external timer", async () => {
    const broker = new InteractionBroker({ decisionTimeoutMs: 15 });
    const startedAt = Date.now();
    const grant = await broker.request({
      id: "permission-timeout",
      sessionId: "session-1",
      binding: binding("session-1"),
      toolName: "read",
      allowlistGrant: "deny",
      emit: () => undefined,
    });
    expect(grant).toBe("deny");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(10);
  });

  it("applies the static default when event delivery throws", async () => {
    const broker = new InteractionBroker();
    await expect(
      broker.request({
        id: "permission-emit-error",
        sessionId: "session-1",
        binding: binding("session-1"),
        toolName: "read",
        allowlistGrant: "allow_once",
        emit: () => {
          throw new Error("sink closed");
        },
      }),
    ).resolves.toBe("allow_once");
    expect(broker.resolve("permission-emit-error", "allow_once")).toBe(false);
  });

  it("denies a mismatched binding and duplicate id", async () => {
    const broker = new InteractionBroker();
    const events: StreamEvent[] = [];
    await expect(
      broker.request({
        id: "mismatch",
        sessionId: "session-1",
        binding: binding("session-2"),
        toolName: "write",
        allowlistGrant: "allow_always",
        emit: (event) => events.push(event),
      }),
    ).resolves.toBe("deny");
    expect(events).toHaveLength(0);

    const first = broker.request({
      id: "duplicate",
      sessionId: "session-1",
      binding: binding("session-1"),
      toolName: "write",
      allowlistGrant: "deny",
      emit: () => undefined,
    });
    await expect(
      broker.request({
        id: "duplicate",
        sessionId: "session-1",
        binding: binding("session-1"),
        toolName: "write",
        allowlistGrant: "allow_always",
        emit: () => undefined,
      }),
    ).resolves.toBe("deny");
    broker.failSession("session-1");
    await expect(first).resolves.toBe("deny");
  });

  it("rejects invalid timeout configuration", () => {
    expect(() => new InteractionBroker({ decisionTimeoutMs: 0 })).toThrow(
      RangeError,
    );
  });

  it("coerces unknown grants to deny", () => {
    expect(coercePermissionGrant("allow_once")).toBe("allow_once");
    expect(coercePermissionGrant("yes")).toBe("deny");
  });
});

describe("InteractionBroker questions", () => {
  it("round-trips a write-in answer", async () => {
    const broker = new InteractionBroker();
    const events: StreamEvent[] = [];
    const pending = broker.requestQuestion({
      id: "question-1",
      sessionId: "session-1",
      binding: binding("session-1"),
      questions: [
        {
          question: "Which database?",
          options: [{ label: "Postgres" }, { label: "SQLite" }],
        },
      ],
      emit: (event) => events.push(event),
    });

    const event = events[0] as InteractionEvent;
    expect(event.request.kind).toBe("question");
    expect(event.request.answerSpec.fields[0]).toMatchObject({
      type: "select",
      allowCustom: true,
    });
    broker.respondQuestion({
      id: "question-1",
      outcome: "accepted",
      data: { q0: ["DuckDB"] },
    });
    await expect(pending).resolves.toEqual([["DuckDB"]]);
  });

  it("returns null for invalid data, timeout, and teardown", async () => {
    const broker = new InteractionBroker({ decisionTimeoutMs: 15 });
    const invalid = broker.requestQuestion({
      id: "invalid",
      sessionId: "session-1",
      binding: binding("session-1"),
      questions: [{ question: "Continue?" }],
      emit: () => undefined,
    });
    broker.respondQuestion({
      id: "invalid",
      outcome: "accepted",
      data: { unexpected: ["yes"] },
    } as InteractionResponse);
    await expect(invalid).resolves.toBeNull();

    const teardown = broker.requestQuestion({
      id: "teardown",
      sessionId: "session-1",
      binding: binding("session-1"),
      questions: [{ question: "Continue?" }],
      emit: () => undefined,
    });
    broker.failSession("session-1");
    await expect(teardown).resolves.toBeNull();

    await expect(
      broker.requestQuestion({
        id: "timeout",
        sessionId: "session-2",
        binding: binding("session-2"),
        questions: [{ question: "Continue?" }],
        emit: () => undefined,
      }),
    ).resolves.toBeNull();
  });

  it("does not permit ids to collide across interaction kinds", async () => {
    const broker = new InteractionBroker();
    const permission = broker.request({
      id: "shared-id",
      sessionId: "session-1",
      binding: binding("session-1"),
      toolName: "write",
      allowlistGrant: "deny",
      emit: () => undefined,
    });
    await expect(
      broker.requestQuestion({
        id: "shared-id",
        sessionId: "session-1",
        binding: binding("session-1"),
        questions: [{ question: "Continue?" }],
        emit: () => undefined,
      }),
    ).resolves.toBeNull();
    broker.failSession("session-1");
    await expect(permission).resolves.toBe("deny");
  });

  it("rejects an empty question list and cancels when event delivery throws", async () => {
    const broker = new InteractionBroker();
    expect(() =>
      broker.requestQuestion({
        id: "empty",
        sessionId: "session-1",
        binding: binding("session-1"),
        questions: [],
        emit: () => undefined,
      }),
    ).toThrow();

    await expect(
      broker.requestQuestion({
        id: "emit-error",
        sessionId: "session-1",
        binding: binding("session-1"),
        questions: [{ question: "Continue?" }],
        emit: () => {
          throw new Error("sink closed");
        },
      }),
    ).resolves.toBeNull();
  });
});

describe("question conversion", () => {
  it("orders canonical fields and wraps scalar values", () => {
    expect(
      interactionDataToQuestionAnswers({ q1: ["b"], q0: "a" }),
    ).toEqual([["a"], ["b"]]);
  });

  it("builds select and text answer fields", () => {
    const answerSpec = interactionAnswerSpecForQuestions([
      {
        question: "Environment?",
        options: [{ label: "prod", description: "live" }],
        multiSelect: true,
      },
      { question: "Notes?" },
    ]);
    expect(answerSpec.fields[0]).toMatchObject({
      type: "select",
      name: "q0",
      allowCustom: true,
      multi: true,
    });
    expect(answerSpec.fields[1]).toEqual({
      type: "text",
      name: "q1",
      label: "Notes?",
      required: true,
    });
  });
});
