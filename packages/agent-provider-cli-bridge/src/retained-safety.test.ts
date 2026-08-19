import { createHash } from "node:crypto";
import type {
  AgentExactRunControlRef,
  RuntimeEventEnvelope,
  StreamEvent,
} from "@tangle-network/agent-interface";
import { AgentRunCancellationRequestSchema } from "@tangle-network/agent-interface";
import type { AgentEnvironmentEvent } from "@tangle-network/agent-interface/environment-provider";
import { describe, expect, it } from "vitest";
import {
  createCliBridgeProvider as createProvider,
  defaultCliBridgeCapabilities,
} from "./index.js";
import { cliBridgeEnvironmentId } from "./environment-identity.js";
import { visibleTextDelta } from "./retained-execution.js";

function createCliBridgeProvider(
  options: Parameters<typeof createProvider>[0],
): ReturnType<typeof createProvider> {
  return createProvider({
    capabilities: defaultCliBridgeCapabilities("opencode"),
    ...options,
  });
}

describe("retained cli-bridge safety", () => {
  it("rejects unnormalized reasoning from visible result text", () => {
    expect(visibleTextDelta({
      type: "message.part.updated",
      data: {
        part: { type: "reasoning", text: "private analysis" },
        delta: "private analysis",
      },
    })).toBeUndefined();
    expect(visibleTextDelta({
      type: "message.part.updated",
      data: {
        part: { type: "text", text: "visible answer" },
        delta: "visible answer",
      },
    })).toBe("visible answer");
  });

  it("rejects a conflicting control reference before replacing the active session", async () => {
    let calls = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode/model",
      fetch: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as { run_id: string };
        return dispatchResponse(body);
      },
    });
    const environment = await provider.create({
      profile: { name: "worker" },
      idempotencyKey: "environment-1",
    });
    const reference = await environment.dispatch?.({
      prompt: "work",
      sessionId: "session-1",
      turnId: "turn-1",
      executionId: "run-1",
    });
    const original = reference?.controlRef as AgentExactRunControlRef;
    const conflicting: AgentExactRunControlRef = {
      ...original,
      runId: "run-2",
      executionId: "run-2",
      requestDigest: testDigest("run-2"),
    };

    expect(() => environment.session?.("session-1", { controlRef: conflicting })).toThrow(
      "control reference conflicts with the retained run",
    );
    expect(environment.session?.("session-1").controlRef).toEqual(original);
    expect(calls).toBe(1);
  });

  it("rejects a mismatched event execution before network use", async () => {
    let called = false;
    const controlRef = exactControlRef();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async () => {
        called = true;
        return new Response();
      },
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });

    await expect(
      consumeEvents(session.events({ executionId: "another-execution" })),
    ).rejects.toThrow("event request targets another retained execution");
    expect(called).toBe(false);
  });

  it.each(["status", "result", "cancel"] as const)(
    "honors an AbortSignal while waiting for session %s",
    async (operation) => {
      let startedResolve!: () => void;
      const started = new Promise<void>((resolve) => {
        startedResolve = resolve;
      });
      const controlRef = exactControlRef();
      const provider = createCliBridgeProvider({
        baseUrl: "http://bridge.local",
        fetch: async (_url, init) => {
          init?.signal?.throwIfAborted();
          startedResolve();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          });
        },
      });
      const environment = (await provider.get!(controlRef.environmentId))!;
      const session = environment.session!(controlRef.sessionId, { controlRef });
      const controller = new AbortController();
      const pending = operation === "status"
        ? session.status({ signal: controller.signal })
        : operation === "result"
          ? session.result({ signal: controller.signal })
          : session.cancel({ signal: controller.signal });
      await started;

      controller.abort(new DOMException("caller stopped waiting", "AbortError"));

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    },
  );

  it("bounds status recovery and exact cancellation after an aborted stream", async () => {
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode/model",
      capabilities: defaultCliBridgeCapabilities("opencode"),
      cancelWaitMs: 10,
      fetch: async (url, init) => {
        if (String(url).endsWith("/v1/chat/completions")) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(new ReadableStream({
            start(controller) {
              startedResolve();
              init?.signal?.addEventListener("abort", () => {
                controller.error(init.signal?.reason);
              }, { once: true });
            },
          }), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              ...exactHeaders({ body: JSON.stringify(body) }),
            },
          });
        }
        return new Promise<Response>(() => {});
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const controller = new AbortController();
    const beganAt = performance.now();
    const pending = consumeEvents(environment.stream({
      prompt: "work",
      signal: controller.signal,
    }));
    await started;

    controller.abort(new DOMException("caller stopped work", "AbortError"));

    await expect(pending).rejects.toThrow("exact cancellation was not confirmed");
    expect(performance.now() - beganAt).toBeLessThan(500);
  });

  it("closes a pending cancellation response reader when its wait budget expires", async () => {
    let bodyClosed = false;
    const controlRef = exactControlRef();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      cancelWaitMs: 10,
      fetch: async () => {
        const body: AsyncIterable<Uint8Array> = {
          [Symbol.asyncIterator]() {
            return {
              next: (): Promise<IteratorResult<Uint8Array>> => new Promise(() => {}),
              return: async (): Promise<IteratorResult<Uint8Array>> => {
                bodyClosed = true;
                return { done: true, value: undefined };
              },
            };
          },
        };
        return {
          ok: true,
          status: 200,
          body,
          headers: { get: () => null },
          text: async () => "",
        } as unknown as Response;
      },
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });

    await expect(session.cancel()).rejects.toMatchObject({ name: "TimeoutError" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(bodyClosed).toBe(true);
  });

  it("keeps malformed token totals unknown while retaining an exact model-call count", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode/model",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const headers = exactHeaders(init);
        if (body.stream === false) {
          return Response.json({
            choices: [{
              message: { role: "assistant", content: "done" },
              finish_reason: "stop",
            }],
            usage: {
              model_requests: 2,
              prompt_tokens: -1,
              completion_tokens: 1.5,
            },
          }, { headers });
        }
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"model_requests":2,"prompt_tokens":-1,"completion_tokens":1.5}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          {
            status: 200,
            headers: { ...headers, "content-type": "text/event-stream" },
          },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const events: AgentEnvironmentEvent[] = [];

    for await (const event of environment.stream({ prompt: "work" })) events.push(event);

    expect(events[0]).toMatchObject({
      type: "usage",
      data: { modelRequests: 2 },
    });
    expect(events[0]).not.toHaveProperty("usage");
    expect(events.at(-1)).toMatchObject({
      type: "result",
      data: { finalText: "done", modelRequests: 2 },
    });
  });

  it("rejects a terminal-looking stream without the protocol end marker", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode/model",
      fetch: async (_url, init) => new Response(
        'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
        {
          status: 200,
          headers: { ...exactHeaders(init), "content-type": "text/event-stream" },
        },
      ),
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(
      consumeEvents(environment.stream({ prompt: "work" })),
    ).rejects.toThrow("without the [DONE] protocol marker");
  });

  it("reads retained canonical events without an OpenAI protocol marker", async () => {
    const controlRef = exactControlRef();
    let replayCursor: string | null = null;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (url, init) => {
        if (!String(url).endsWith("/events")) {
          return retainedRunResponse(controlRef.runId, "done", true);
        }
        replayCursor = new Headers(init?.headers).get("last-event-id");
        return canonicalEventsResponse(controlRef, canonicalEvents());
      },
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });
    const events: AgentEnvironmentEvent[] = [];

    for await (const event of session.events({
      since: "0",
      executionId: controlRef.executionId,
    })) {
      events.push(event);
    }

    expect(replayCursor).toBe("0");
    expect(events.map((event) => event.type)).toEqual([
      "message.part.updated",
      "raw",
      "status",
    ]);
    expect(events[0]).toMatchObject({
      id: "1",
      data: {
        cursor: "1",
        sequence: 1,
        runId: "run-1",
        sessionId: "session-1",
        executionId: "run-1",
        delta: "done",
      },
      normalized: { type: "message.part.updated", delta: "done" },
    });
    expect(events[1]).toMatchObject({
      id: "2",
      usage: {
        inputTokens: 11,
        outputTokens: 4,
        reasoningTokens: 2,
        cost: 0.005,
      },
    });
    expect(events[2]).toMatchObject({
      id: "3",
      normalized: { type: "status", status: "completed" },
    });
  });

  it("does not expose a canonical terminal event before matching retained status", async () => {
    const controlRef = exactControlRef();
    const observed: AgentEnvironmentEvent[] = [];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (url) => String(url).endsWith("/events")
        ? canonicalEventsResponse(controlRef, canonicalEvents())
        : retainedRunResponse(controlRef.runId, "error", true),
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });

    await expect((async () => {
      for await (const event of session.events({ since: "0" })) observed.push(event);
    })()).rejects.toThrow("contradicts retained run status");
    expect(observed.map((event) => event.type)).toEqual([
      "message.part.updated",
      "raw",
    ]);
  });

  it.each([
    {
      name: "missing request digest",
      mutate: (run: Record<string, unknown>) => {
        const { requestDigest: _requestDigest, ...withoutDigest } = run;
        return withoutDigest;
      },
      error: "invalid exact cancellation acknowledgement",
    },
    {
      name: "mismatched request digest",
      mutate: (run: Record<string, unknown>) => ({
        ...run,
        requestDigest: testDigest("another-run"),
      }),
      error: "cancellation acknowledgement for another request",
    },
  ])("rejects a cancellation acknowledgement with $name", async ({ mutate, error }) => {
    const controlRef = exactControlRef();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (url, init) => {
        expect(String(url)).toBe("http://bridge.local/v1/runs/run-1/cancel");
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          run: mutate(request.run as Record<string, unknown>),
          status: "accepted",
          effect: "cancelled",
        });
      },
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });

    await expect(session.cancel()).rejects.toThrow(error);
  });

  it.each([
    ["runId", "other-run"],
    ["provider", "other-provider"],
    ["environmentId", "other-environment"],
    ["sessionId", "other-session"],
    ["executionId", "other-execution"],
  ] as const)("rejects a cancellation acknowledgement with another %s", async (field, value) => {
    const controlRef = exactControlRef();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          run: {
            ...(request.run as Record<string, unknown>),
            [field]: value,
          },
          status: "accepted",
          effect: "cancelled",
        });
      },
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });

    await expect(session.cancel()).rejects.toThrow(
      "cancellation acknowledgement for another request",
    );
  });

  it("sends the complete exact identity for automatic cancellation", async () => {
    const controlRef = exactControlRef();
    let cancellationRequest: unknown;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (_url, init) => {
        cancellationRequest = JSON.parse(String(init?.body));
        const request = AgentRunCancellationRequestSchema.parse(cancellationRequest);
        return Response.json({
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          run: request.run,
          status: "accepted",
          effect: "cancelled",
        });
      },
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });

    await session.cancel();

    expect(AgentRunCancellationRequestSchema.parse(cancellationRequest).run).toEqual(controlRef);
  });

  it("resumes canonical events from a previously emitted event id", async () => {
    const controlRef = exactControlRef();
    const replayCursors: Array<string | null> = [];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (url, init) => {
        if (!String(url).endsWith("/events")) {
          return retainedRunResponse(controlRef.runId, "done", true);
        }
        const cursor = new Headers(init?.headers).get("last-event-id");
        replayCursors.push(cursor);
        return cursor === "1"
          ? canonicalEventsResponse(controlRef, canonicalEvents().slice(1), 1)
          : canonicalEventsResponse(controlRef, canonicalEvents());
      },
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });
    const firstRead: AgentEnvironmentEvent[] = [];

    for await (const event of session.events({ since: "0" })) {
      firstRead.push(event);
    }
    const firstEventId = firstRead[0]?.id;
    expect(firstEventId).toBe("1");

    const resumed: AgentEnvironmentEvent[] = [];
    for await (const event of session.events({ since: firstEventId })) {
      resumed.push(event);
    }

    expect(replayCursors).toEqual(["0", "1"]);
    expect(resumed.map((event) => event.id)).toEqual(["2", "3"]);
    expect(resumed.map((event) => event.type)).toEqual(["raw", "status"]);
    expect(resumed[0]?.data.eventId).toBe("run-1:event:2");
  });

  it("accepts an empty latest-cursor replay after terminal status proof", async () => {
    const controlRef = exactControlRef();
    const requests: string[] = [];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (url, init) => {
        const target = new URL(String(url));
        requests.push(`${init?.method ?? "GET"} ${target.pathname}${target.search}`);
        if (target.pathname.endsWith("/events")) {
          return new Response("", {
            status: 200,
            headers: canonicalEventHeaders(controlRef),
          });
        }
        return retainedRunResponse(controlRef.runId, "done", true);
      },
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });

    await expect(consumeEvents(session.events({ since: "3" }))).resolves.toBeUndefined();
    expect(requests).toEqual([
      "GET /v1/runs/run-1/events",
      "GET /v1/runs/run-1?wait_ms=30000",
    ]);
  });

  it("rejects an empty latest-cursor replay while the retained run is active", async () => {
    const controlRef = exactControlRef();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (url) => new URL(String(url)).pathname.endsWith("/events")
        ? new Response("", {
            status: 200,
            headers: canonicalEventHeaders(controlRef),
          })
        : retainedRunResponse(controlRef.runId, "running", false),
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });

    await expect(consumeEvents(session.events({ since: "3" }))).rejects.toThrow(
      "remained active after its stream ended",
    );
  });

  it("collects canonical text and usage from a retained result", async () => {
    const controlRef = exactControlRef();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (url) => String(url).endsWith("/events")
        ? canonicalEventsResponse(controlRef, canonicalEvents())
        : retainedRunResponse(controlRef.runId, "done", true),
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });

    await expect(session.result()).resolves.toMatchObject({
      text: "done",
      success: true,
      usage: {
        inputTokens: 11,
        outputTokens: 4,
        reasoningTokens: 2,
        cost: 0.005,
      },
      metadata: { runId: "run-1", executionId: "run-1", status: "done" },
    });
  });

  it("keeps canonical reasoning out of retained result text", async () => {
    const controlRef = exactControlRef();
    const events: StreamEvent[] = [
      {
        type: "message.part.updated",
        part: {
          id: "run-1:part:reasoning",
          sessionID: "session-1",
          messageID: "run-1:message:1",
          type: "reasoning",
          text: "private analysis",
        },
        delta: "private analysis",
      },
      ...canonicalEvents(),
    ];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (url) => String(url).endsWith("/events")
        ? canonicalEventsResponse(controlRef, events)
        : retainedRunResponse(controlRef.runId, "done", true),
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });

    await expect(session.result()).resolves.toMatchObject({
      text: "done",
      success: true,
    });
  });

  it("rejects canonical events whose wire identity does not match", async () => {
    const controlRef = exactControlRef();
    const wrongRun = { ...controlRef, runId: "another-run" };
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async () => canonicalEventsResponse(
        controlRef,
        canonicalEvents(),
        0,
        wrongRun.runId,
      ),
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });

    await expect(consumeEvents(session.events({ since: "0" }))).rejects.toThrow(
      "belongs to another retained run",
    );
  });

  it("rejects a canonical cursor that does not match its sequence", async () => {
    const controlRef = exactControlRef();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async () => canonicalEventsResponse(
        controlRef,
        [{ type: "status", status: "completed" }],
        0,
        controlRef.runId,
        () => 2,
      ),
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });

    await expect(consumeEvents(session.events({ since: "0" }))).rejects.toThrow(
      "cursor does not match its sequence",
    );
  });

  it("rejects a stream that changes format after a canonical event", async () => {
    const controlRef = exactControlRef();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async () => new Response(
        canonicalEventsBody(controlRef, [canonicalEvents()[0]!]) +
          'data: {"choices":[{"delta":{"content":"wrong"},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        { status: 200, headers: canonicalEventHeaders(controlRef) },
      ),
    });
    const environment = (await provider.get!(controlRef.environmentId))!;
    const session = environment.session!(controlRef.sessionId, { controlRef });

    await expect(consumeEvents(session.events({ since: "0" }))).rejects.toThrow(
      "mixed canonical and OpenAI stream formats",
    );
  });
});

async function consumeEvents(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Drain events until the operation ends.
  }
}

function dispatchResponse(body: Record<string, unknown>): Response {
  const runId = String(body.run_id);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": connected\n\n"));
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        ...exactHeaders({ body: JSON.stringify(body) }),
      },
    },
  );
}

function canonicalEvents(): StreamEvent[] {
  return [
    {
      type: "message.part.updated",
      part: {
        id: "run-1:part:1",
        sessionID: "session-1",
        messageID: "run-1:message:1",
        type: "text",
        text: "done",
      },
      delta: "done",
    },
    {
      type: "raw",
      backend: "pi",
      event: {
        type: "usage",
        data: {},
        usage: {
          inputTokens: 11,
          outputTokens: 4,
          reasoningTokens: 2,
          cost: 0.005,
        },
      },
    },
    { type: "status", status: "completed" },
  ];
}

function canonicalEventsResponse(
  controlRef: AgentExactRunControlRef,
  events: StreamEvent[],
  sequenceOffset = 0,
  envelopeRunId = controlRef.runId,
  frameSequence: (sequence: number) => number = (sequence) => sequence,
): Response {
  return new Response(
    canonicalEventsBody(
      controlRef,
      events,
      sequenceOffset,
      envelopeRunId,
      frameSequence,
    ),
    { status: 200, headers: canonicalEventHeaders(controlRef) },
  );
}

function canonicalEventsBody(
  controlRef: AgentExactRunControlRef,
  events: StreamEvent[],
  sequenceOffset = 0,
  envelopeRunId = controlRef.runId,
  frameSequence: (sequence: number) => number = (sequence) => sequence,
): string {
  const receivedAt = "2026-08-18T12:00:00.000Z";
  return events.map((event, index) => {
    const sequence = sequenceOffset + index + 1;
    const envelope: RuntimeEventEnvelope = {
      runId: envelopeRunId,
      eventId: `${controlRef.runId}:event:${sequence}`,
      sequence,
      receivedAt,
      event,
    };
    return [
      `id: ${frameSequence(sequence)}`,
      `event: ${event.type}`,
      `data: ${JSON.stringify(envelope)}`,
      "",
      "",
    ].join("\n");
  }).join("");
}

function canonicalEventHeaders(controlRef: AgentExactRunControlRef): HeadersInit {
  return {
    "content-type": "text/event-stream",
    "x-run-id": controlRef.runId,
    "x-run-request-digest": controlRef.requestDigest,
    "x-run-provider": controlRef.provider,
    "x-run-environment-id": controlRef.environmentId,
    "x-run-session-id": controlRef.sessionId,
    "x-run-execution-id": controlRef.executionId,
  };
}

function retainedRunResponse(
  id: string,
  status: "running" | "done" | "error" | "cancelled",
  terminal: boolean,
): Response {
  const controlRef = exactControlRef();
  return Response.json({
    id,
    provider: controlRef.provider,
    environmentId: controlRef.environmentId,
    sessionId: controlRef.sessionId,
    executionId: controlRef.executionId,
    requestDigest: testDigest(id),
    status,
    terminal,
  });
}

function exactControlRef(): AgentExactRunControlRef {
  return {
    runId: "run-1",
    provider: "cli-bridge",
    environmentId: cliBridgeEnvironmentId(
      { model: "opencode/model" },
      testDigest("environment-create-1"),
      "environment-1",
    ),
    sessionId: "session-1",
    executionId: "run-1",
    requestDigest: testDigest("run-1"),
  };
}

function testDigest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactHeaders(init: { readonly body?: unknown } | undefined) {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  const runId = String(body.run_id);
  return {
    "x-run-id": runId,
    "x-run-request-digest": testDigest(runId),
    "x-run-provider": String(body.provider),
    "x-run-environment-id": String(body.environment_id),
    "x-run-session-id": String(body.session_id),
    "x-run-execution-id": String(body.execution_id),
  };
}
