import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
} from "@tangle-network/agent-interface/environment-provider";
import {
  AgentRunCancellationRequestSchema,
  agentRunCancellationRequestDigest,
  canonicalCandidateDigest,
  type RuntimeEventEnvelope,
} from "@tangle-network/agent-interface";
import { describe, expect, it } from "vitest";
import { createCliBridgeProvider } from "./index.js";

const capabilities: AgentEnvironmentCapabilities = {
  profile: {
    namedProfiles: false,
    systemPrompt: true,
    instructions: true,
    tools: true,
    permissions: true,
    mcp: true,
    subagents: true,
    resources: { files: false, instructions: true, tools: false, skills: true, agents: true, commands: true },
    hooks: false,
    modes: true,
    runtimeUpdate: false,
    validation: true,
    extensions: ["pi"],
  },
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  sessions: { continue: true, list: true, messages: true },
  retainedControl: {
    exactRunIdentity: true,
    resultIdentity: true,
    eventIdentity: true,
    cancellationIdempotency: true,
  },
  interactions: {
    kinds: ["question"],
    answerFieldTypes: ["text"],
    responseScopes: ["interaction"],
    secretAnswers: false,
    concurrentRequests: false,
    replay: true,
    responseIdempotency: true,
  },
  workspace: { read: true, write: true, exec: true, git: true, upload: false, download: false },
  branching: { checkpoint: false, fork: false },
  placement: true,
  usage: true,
  confidential: false,
};

describe("retained cli-bridge sessions", () => {
  it("negotiates returned capabilities and maps canonical envelopes to a result", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "session-1",
    });

    expect(environment.id).toBe("cli-bridge");
    expect(environment.dispatch).toBeTypeOf("function");
    expect(environment.session).toBeTypeOf("function");
    expect(await provider.capabilities()).toEqual(capabilities);

    const events = [];
    for await (const event of environment.stream({ prompt: "hello", executionId: "run-1" })) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "status",
      "message.part.updated",
      "raw",
      "status",
    ]);
    expect(events[1]).toMatchObject({
      id: "1",
      normalized: { type: "message.part.updated", part: { type: "text", text: "hello" } },
      providerEvent: { sequence: 1, cursor: "12" },
    });
    expect(events[2]?.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });

    const session = environment.session?.("session-1");
    if (!session) throw new Error("retained session method was not exposed");
    const replayed = [];
    for await (const event of session.events({ since: "2", executionId: "run-1" })) replayed.push(event.id);
    expect(replayed).toEqual(["3"]);
    const result = await session.result();
    expect(result).toMatchObject({
      text: "hello",
      success: true,
      sessionId: "session-1",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      metadata: {
        status: "completed",
        executionId: "run-1",
        profileMaterializationReceipt: { profileDigest: "receipt-1" },
      },
    });
    expect(session.controlRef).toMatchObject({
      runId: expect.stringMatching(/^agent-[a-f0-9]{64}$/u),
      provider: "cli-bridge",
      environmentId: "cli-bridge",
      sessionId: "session-1",
      executionId: "run-1",
      requestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(Object.isFrozen(session.controlRef)).toBe(true);
    expect(Object.isFrozen(result.metadata?.profileMaterializationReceipt)).toBe(true);

    const reconnected = await provider.get?.("session-1");
    expect(reconnected?.session?.("session-1").controlRef).toMatchObject({
      runId: session.controlRef?.runId,
    });
    await reconnected?.destroy?.();
    const bridgeEnvironment = await provider.get?.("cli-bridge");
    const bridgeSession = bridgeEnvironment?.session?.("session-1", { controlRef: session.controlRef });
    expect(bridgeSession?.controlRef).toEqual(session.controlRef);
    await expect(bridgeSession?.status()).resolves.toBe("completed");
    if (!bridgeSession?.cancelRun || !bridgeSession.controlRef) {
      throw new Error("reconstructed retained cancellation was not exposed");
    }
    const cancellationMaterial = {
      operationId: "cancel-reconstructed-run-1",
      run: bridgeSession.controlRef,
    };
    await expect(bridgeSession.cancelRun({
      ...cancellationMaterial,
      requestDigest: agentRunCancellationRequestDigest(cancellationMaterial),
    })).resolves.toMatchObject({ status: "accepted", effect: "not_live" });
    await bridgeEnvironment?.destroy?.();
  });

  it("preserves the public execution identity when it differs from URL-safe legacy ids", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "session-public-id",
    });
    const executionId = "run with an internal space";
    const ref = await environment.dispatch?.({ prompt: "identity", executionId });
    expect(ref?.controlRef).toMatchObject({
      runId: expect.stringMatching(/^agent-[a-f0-9]{64}$/u),
      executionId,
    });
    expect(ref?.controlRef?.runId).not.toBe(executionId);
    const session = environment.session?.("session-public-id", {
      controlRef: ref?.controlRef,
    });
    await expect(session?.result()).resolves.toMatchObject({
      sessionId: "session-public-id",
      metadata: { runId: ref?.controlRef?.runId, executionId },
    });
  });

  it("detaches on reader return and reserves cancellation for explicit cancel", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "session-2",
    });
    const iterator = environment.stream({ prompt: "detach", executionId: "run-2" })[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(fixture.calls.filter((call) => call.path.endsWith("/detach"))).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.path.endsWith("/cancel"))).toHaveLength(0);

    const session = environment.session?.("session-2");
    if (!session) throw new Error("retained session method was not exposed");
    if (!session.cancelRun || !session.controlRef) {
      throw new Error("retry-safe retained cancellation was not exposed");
    }
    const cancellationMaterial = {
      operationId: "cancel-run-2",
      run: session.controlRef,
      reason: "test cancellation",
    };
    const request = {
      ...cancellationMaterial,
      requestDigest: agentRunCancellationRequestDigest(cancellationMaterial),
    };
    const cancelled = await session.cancelRun(request);
    const retried = await session.cancelRun(request);
    expect(retried).toEqual(cancelled);
    expect(cancelled).toMatchObject({
      operationId: "cancel-run-2",
      status: "accepted",
      effect: "not_live",
      run: { runId: session.controlRef.runId, sessionId: "session-2" },
    });
    await expect(session.cancelRun({
      ...request,
      reason: "changed",
      requestDigest: agentRunCancellationRequestDigest({ ...cancellationMaterial, reason: "changed" }),
    })).resolves.toMatchObject({ status: "conflict", effect: "unknown" });
    const cancelCalls = fixture.calls.filter((call) => call.path.endsWith("/cancel"));
    expect(cancelCalls).toHaveLength(2);
    expect(cancelCalls[0]?.body).toEqual(request);
    await expect(session.status()).resolves.toBe("completed");
  });

  it("returns the bridge acknowledgement for exact interaction retries", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "session-3",
    });
    await environment.dispatch?.({ prompt: "ask", executionId: "run-3" });
    const command = {
      operationId: "operation-1",
      binding: {
        runId: "run-3",
        environmentId: "cli-bridge",
        sessionId: "session-3",
        interactionId: "interaction-1",
      },
      response: { id: "interaction-1", outcome: "accepted" as const },
    };
    const respond = environment.respondToInteraction;
    if (!respond) throw new Error("interaction response method was not exposed");
    const first = await respond(command);
    const retry = await respond(command);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      operationId: "operation-1",
      binding: command.binding,
      status: "accepted",
    });
    await expect(respond({ ...command, response: { id: "interaction-1", outcome: "declined" } })).resolves.toMatchObject({
      status: "already_resolved_different",
    });
  });

  it("keeps a reconstructed session bound to its requested older run", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "session-old-run",
    });
    for await (const _event of environment.stream({ prompt: "first", executionId: "run-old" })) {
      // Drain the first run to a durable terminal result.
    }
    const first = environment.session?.("session-old-run");
    if (!first?.controlRef) throw new Error("first retained control reference was not exposed");
    const oldControlRef = first.controlRef;
    await environment.dispatch?.({ prompt: "second", executionId: "run-new" });

    const old = environment.session?.("session-old-run", { controlRef: oldControlRef });
    if (!old?.cancelRun) throw new Error("exact older-run control was not exposed");
    expect(old.controlRef).toEqual(oldControlRef);
    await expect(old.status()).resolves.toBe("completed");
    await expect(old.result()).resolves.toMatchObject({
      success: true,
      metadata: { runId: oldControlRef.runId, executionId: "run-old" },
    });
    const material = { operationId: "cancel-old", run: oldControlRef };
    await expect(old.cancelRun({
      ...material,
      requestDigest: agentRunCancellationRequestDigest(material),
    })).resolves.toMatchObject({ status: "accepted", effect: "not_live" });
    expect(fixture.calls.filter((call) =>
      call.path.endsWith("/cancel") &&
      (call.body?.run as Record<string, unknown> | undefined)?.runId === oldControlRef.runId
    )).toHaveLength(1);
    await expect(environment.session?.("session-old-run")?.status()).resolves.toBe("running");
  });

  it("recovers only an identical lost create response and never closes a conflicting session", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const input = {
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "create-retry",
    } as const;
    const first = await provider.create(input);
    const recovered = await provider.create(input);
    expect(first.id).toBe("cli-bridge");
    expect(recovered.id).toBe("cli-bridge");
    expect(fixture.calls.filter((call) => call.path === "/v1/sessions" && call.method === "POST")).toHaveLength(2);

    await expect(provider.create({
      ...input,
      profile: { ...input.profile, prompt: { systemPrompt: "changed" } },
    })).rejects.toThrow(/different create request/);
    expect(fixture.calls.some((call) => call.path.endsWith("/close"))).toBe(false);
  });

  it("namespaces the same public execution id independently in each retained session", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const profile = { name: "worker", harness: "pi", model: { default: "test" } } as const;
    const first = await provider.create({ profile, idempotencyKey: "session-a" });
    const second = await provider.create({ profile, idempotencyKey: "session-b" });
    const firstRef = await first.dispatch?.({ prompt: "first", executionId: "shared-execution" });
    const secondRef = await second.dispatch?.({ prompt: "second", executionId: "shared-execution" });
    expect(firstRef?.controlRef?.executionId).toBe("shared-execution");
    expect(secondRef?.controlRef?.executionId).toBe("shared-execution");
    expect(firstRef?.controlRef?.runId).not.toBe(secondRef?.controlRef?.runId);
  });

  it("requires explicit retained turn identity and rejects a changed admission digest", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "exact-run",
    });
    await expect(environment.dispatch?.({ prompt: "missing identity" })).rejects.toThrow(/executionId or turnId/);
    const dispatched = await environment.dispatch?.({ prompt: "exact", executionId: "exact-execution" });
    if (!dispatched?.controlRef) throw new Error("exact retained control reference was not returned");
    const changedRef = {
      ...dispatched.controlRef,
      requestDigest: `sha256:${"a".repeat(64)}` as const,
    };
    await expect(
      environment.session?.("exact-run", { controlRef: changedRef }).status(),
    ).rejects.toThrow(/changed its exact request digest/);
  });

  it("uses legacy execution when retained create inputs cannot be represented exactly", async () => {
    const fixture = createFixture();
    const withoutDefaultModel = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: fixture.fetch,
    });
    const profile = { name: "worker", harness: "pi", model: { default: "test" } } as const;
    const noDefault = await withoutDefaultModel.create({ profile });
    expect(noDefault.dispatch).toBeUndefined();

    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const withEnvironment = await provider.create({
      profile,
      env: { EXACT_VALUE: "required" },
    });
    expect(withEnvironment.dispatch).toBeUndefined();
    expect(fixture.calls.filter((call) => call.path === "/v1/sessions" && call.method === "POST")).toHaveLength(0);
  });

  it("cancels and closes a retained session owned by the created environment", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "owned-cleanup",
    });
    await environment.dispatch?.({ prompt: "stay live", executionId: "cleanup-run" });
    await environment.destroy?.();
    expect(fixture.calls.filter((call) => call.path.endsWith("/cancel"))).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.path.endsWith("/close"))).toHaveLength(1);
    await expect(environment.status()).resolves.toBe("stopped");
  });

  it("keeps retained operations absent when the backend denies retention", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "one-shot/model",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("/v1/capabilities?")) {
          return json({ error: { message: "native sessions unavailable", type: "capability_denied" } }, 501);
        }
        if (url.endsWith("/v1/sessions") && init?.method === "POST") {
          return json({ error: { message: "native sessions unavailable", type: "capability_denied" } }, 501);
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    expect(environment.dispatch).toBeUndefined();
    expect(environment.session).toBeUndefined();
    expect(await provider.capabilities()).toMatchObject({
      streaming: { detach: false },
    });
    await expect(consume(environment)).resolves.toBeUndefined();
  });
});

interface FixtureCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function createFixture(): {
  fetch: typeof fetch;
  calls: FixtureCall[];
} {
  const calls: FixtureCall[] = [];
  const sessions = new Map<string, Record<string, unknown>>();
  const events = new Map<string, RuntimeEventEnvelope[]>();
  const runSessions = new Map<string, string>();
  const runs = new Map<string, Record<string, unknown>>();
  const operations = new Map<string, string>();
  const cancellationOperations = new Map<string, string>();
  const createDigests = new Map<string, string>();

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, path: url.pathname, ...(body ? { body } : {}) });

    if (method === "GET" && url.pathname === "/v1/capabilities") {
      return json(capabilities, 200);
    }

    if (method === "POST" && url.pathname === "/v1/sessions") {
      const id = String(body?.id);
      if (sessions.has(id)) {
        return json({ error: { message: "already exists", type: "session_identity_conflict" } }, 409);
      }
      createDigests.set(id, canonicalCandidateDigest(body ?? {}));
      const view = sessionView(id, "created", null, null);
      sessions.set(id, view);
      return json(view, 201);
    }
    if (method === "GET" && url.pathname === "/v1/sessions") {
      return json({ object: "list", data: Array.from(sessions.values()) }, 200);
    }
    if (method === "POST" && url.pathname.includes("/interactions/") && url.pathname.endsWith("/respond")) {
      const operationId = String(body?.operationId);
      const digest = JSON.stringify(body?.response);
      const previous = operations.get(operationId);
      if (previous && previous !== digest) {
        return json({ operationId, binding: body?.binding, status: "already_resolved_different" }, 409);
      }
      operations.set(operationId, digest);
      return json({ operationId, binding: body?.binding, status: "accepted" }, 200);
    }
    const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(events))?$/u);
    if (runMatch && method === "GET") {
      const runId = decodeURIComponent(runMatch[1]!);
      const sessionId = runSessions.get(runId);
      if (!sessionId) return json({ error: { message: "not found", type: "not_found_error" } }, 404);
      const run = runs.get(runId)!;
      if (runMatch[2] === "events") {
        const runEvents = events.get(runId) ?? [];
        const last = Number(new Headers(init?.headers).get("last-event-id") ?? "-1");
        const completedRun = { ...run, id: runId, status: "done", terminal: true, sessionId };
        runs.set(runId, completedRun);
        const completed = sessionView(sessionId, "idle", runId, completedRun);
        completed.profile_materialization_receipt = { profileDigest: "receipt-1" };
        if (sessions.get(sessionId)?.run_id === runId) sessions.set(sessionId, completed);
        const payload = runEvents
          .filter((event) => event.sequence > last)
          .map((event) => `id: ${event.sequence}\nevent: ${event.event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join("");
        return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return json(run, 200);
    }
    const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)(?:\/(events|turns|detach|cancel|status|close))?$/u);
    if (!sessionMatch) return json({ error: { message: "not found", type: "not_found_error" } }, 404);
    const id = decodeURIComponent(sessionMatch[1]!);
    const operation = sessionMatch[2];
    const view = sessions.get(id);
    if (!view) return json({ error: { message: "not found", type: "not_found_error" } }, 404);
    if (method === "GET" && !operation) return json(view, 200);
    if (method === "GET" && operation === "status") return json(view, 200);
    if (method === "POST" && operation === "turns") {
      const runId = String(body?.run_id);
      const requestDigest = canonicalCandidateDigest({
        sessionId: id,
        runId,
        model: "pi/test",
        prompt: String(body?.message ?? ""),
        turnId: body?.turn_id ?? null,
      });
      const run = {
        id: runId,
        requestDigest,
        status: "running",
        terminal: false,
        sessionId: id,
      };
      runs.set(runId, run);
      const runEvents = makeEvents(runId, id);
      events.set(runId, runEvents);
      runSessions.set(runId, id);
      const running = sessionView(id, "running", runId, run);
      running.profile_materialization_receipt = { profileDigest: "receipt-1" };
      sessions.set(id, running);
      return json({ session: running, run, context_boundary: null }, 202);
    }
    if (method === "POST" && operation === "detach") return json({ detached: true, session: view }, 200);
    if (method === "POST" && operation === "close") {
      const closed = sessionView(id, "closed", view.run_id as string | null, view.run as Record<string, unknown> | null);
      sessions.set(id, closed);
      return json({ closed: true, session: closed }, 200);
    }
    if (method === "POST" && operation === "cancel") {
      const request = AgentRunCancellationRequestSchema.parse(body);
      const previousDigest = cancellationOperations.get(request.operationId);
      if (previousDigest && previousDigest !== request.requestDigest) {
        return json({
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          run: request.run,
          status: "conflict",
          effect: "unknown",
        }, 409);
      }
      cancellationOperations.set(request.operationId, request.requestDigest);
      const runId = request.run.runId;
      const exactRun = runs.get(runId);
      if (exactRun?.terminal) {
        return json({
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          run: request.run,
          status: "accepted",
          effect: exactRun.status === "cancelled" ? "cancelled" : "not_live",
        }, 200);
      }
      const cancelled = sessionView(id, "cancelled", runId, {
        ...exactRun,
        id: runId,
        status: "cancelled",
        terminal: true,
        sessionId: id,
      });
      runs.set(runId, cancelled.run as Record<string, unknown>);
      sessions.set(id, cancelled);
      return json({
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        run: request.run,
        status: "accepted",
        effect: "cancelled",
      }, 200);
    }
    return json({ error: { message: "unsupported", type: "not_found_error" } }, 404);
  };
  return { fetch, calls };

  function sessionView(
    id: string,
    status: string,
    runId: string | null,
    run: Record<string, unknown> | null,
  ): Record<string, unknown> {
    return {
      id,
      object: "session",
      create_request_digest: createDigests.get(id),
      backend: "pi",
      model: "pi/test",
      status,
      run_id: runId,
      internal_session_id: null,
      turns: status === "idle" ? 1 : 0,
      created_at: "2026-08-02T00:00:00.000Z",
      updated_at: "2026-08-02T00:00:01.000Z",
      capabilities,
      profile_materialization_receipt: null,
      context_boundary: null,
      ...(run ? { run } : {}),
    };
  }
}

function makeEvents(runId: string, sessionId: string): RuntimeEventEnvelope[] {
  const receivedAt = "2026-08-02T00:00:01.000Z";
  return [
    {
      runId,
      eventId: `${runId}:event-1`,
      sequence: 0,
      cursor: "11",
      receivedAt,
      event: { type: "status", status: "processing" },
    },
    {
      runId,
      eventId: `${runId}:event-2`,
      sequence: 1,
      cursor: "12",
      receivedAt,
      event: {
        type: "message.part.updated",
        part: {
          id: "part-1",
          sessionID: sessionId,
          messageID: "message-1",
          type: "text",
          text: "hello",
        },
        delta: "hello",
      },
    },
    {
      runId,
      eventId: `${runId}:event-3`,
      sequence: 2,
      cursor: "13",
      receivedAt,
      event: {
        type: "raw",
        backend: "pi",
        event: { type: "usage", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
      },
    },
    {
      runId,
      eventId: `${runId}:event-4`,
      sequence: 3,
      cursor: "14",
      receivedAt,
      event: { type: "status", status: "completed" },
    },
  ];
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function consume(environment: AgentEnvironment): Promise<void> {
  for await (const _event of environment.stream({ prompt: "compatibility" })) {
    // The assertion is about the retained surface, not the legacy event body.
  }
}
