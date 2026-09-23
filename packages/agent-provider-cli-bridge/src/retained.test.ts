import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
} from "@tangle-network/agent-interface/environment-provider";
import {
  AgentExactRunControlRefSchema,
  AgentRunCancellationRequestSchema,
  agentRunCancellationRequestDigest,
  canonicalCandidateDigest,
  interactionResponseCommandDigest,
  normalizeInputParts,
  type RuntimeEventEnvelope,
} from "@tangle-network/agent-interface";
import { describe, expect, it } from "vitest";
import { createCliBridgeProvider } from "./index.js";

function exactRun(value: unknown) {
  return AgentExactRunControlRefSchema.parse(value);
}

const capabilities: AgentEnvironmentCapabilities = {
  profile: {
    namedProfiles: false,
    systemPrompt: { replace: true, append: true },
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
        requestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
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
      run: exactRun(bridgeSession.controlRef),
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
      metadata: {
        runId: ref?.controlRef?.runId,
        executionId,
        requestDigest: ref?.controlRef?.requestDigest,
      },
    });

    const restartedProvider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const restartedEnvironment = await restartedProvider.get?.("session-public-id");
    const restartedSession = restartedEnvironment?.session?.("session-public-id");
    expect(restartedSession?.controlRef).toMatchObject({
      runId: ref?.controlRef?.runId,
      executionId,
      requestDigest: ref?.controlRef?.requestDigest,
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
      run: exactRun(session.controlRef),
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
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]?.body).toEqual(request);
    await expect(session.status()).resolves.toBe("completed");
  });

  it("binds a concurrent cancellation operationId before its first request", async () => {
    const fixture = createFixture();
    let releaseFirst!: () => void;
    let firstCancelStarted!: () => void;
    const firstCancel = new Promise<void>((resolve) => {
      firstCancelStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let cancelRequests = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: async (input, init) => {
        if (String(input).endsWith("/cancel?wait_ms=30000")) {
          cancelRequests += 1;
          if (cancelRequests === 1) {
            firstCancelStarted();
            await release;
          }
        }
        return fixture.fetch(input, init);
      },
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "cancel-concurrent",
    });
    const dispatched = await environment.dispatch?.({ prompt: "cancel", executionId: "cancel-concurrent-run" });
    if (!dispatched?.controlRef || !environment.session) throw new Error("exact cancellation control was not returned");
    const session = environment.session("cancel-concurrent", { controlRef: dispatched.controlRef });
    const firstMaterial = {
      operationId: "cancel-concurrent-operation",
      run: exactRun(dispatched.controlRef),
      reason: "first",
    };
    const firstRequest = {
      ...firstMaterial,
      requestDigest: agentRunCancellationRequestDigest(firstMaterial),
    };
    const secondMaterial = { ...firstMaterial, reason: "second" };
    const secondRequest = {
      ...secondMaterial,
      requestDigest: agentRunCancellationRequestDigest(secondMaterial),
    };
    const firstResult = session.cancelRun?.(firstRequest);
    await firstCancel;
    await expect(session.cancelRun?.(secondRequest)).resolves.toMatchObject({
      operationId: secondRequest.operationId,
      requestDigest: secondRequest.requestDigest,
      status: "conflict",
      effect: "unknown",
      run: secondRequest.run,
    });
    releaseFirst();
    await expect(firstResult).resolves.toMatchObject({ status: "accepted" });
    expect(cancelRequests).toBe(1);
    expect(fixture.calls.filter((call) => call.path.endsWith("/cancel"))).toHaveLength(1);
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
    const dispatched = await environment.dispatch?.({ prompt: "ask", executionId: "run-3" });
    if (!dispatched?.controlRef?.executionId || !dispatched.controlRef.requestDigest) {
      throw new Error("interaction run identity was not returned");
    }
    const binding = {
      runId: dispatched.controlRef.runId,
      provider: dispatched.controlRef.provider,
      environmentId: "cli-bridge",
      sessionId: "session-3",
      executionId: dispatched.controlRef.executionId,
      interactionId: "interaction-1",
      requestDigest: dispatched.controlRef.requestDigest,
    };
    const response = { id: "interaction-1", outcome: "accepted" as const };
    const command = {
      operationId: "operation-1",
      binding,
      response,
      commandDigest: interactionResponseCommandDigest({ binding, response }),
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
    const session = environment.session?.("session-3", { controlRef: dispatched.controlRef });
    if (!session) throw new Error("retained interaction session was not exposed");
    await session.result();
    await expect(respond(command)).resolves.toEqual(first);
    const changedResponse = { id: "interaction-1", outcome: "declined" as const };
    await expect(respond({
      ...command,
      response: changedResponse,
      commandDigest: interactionResponseCommandDigest({ binding, response: changedResponse }),
    })).resolves.toMatchObject({
      status: "already_resolved_different",
    });
  });

  it("rejects interaction responses that omit or change the exact live run binding", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "interaction-binding",
    });
    const dispatched = await environment.dispatch?.({ prompt: "ask", executionId: "interaction-run" });
    if (
      !dispatched?.controlRef?.executionId ||
      !dispatched.controlRef.requestDigest ||
      !environment.respondToInteraction
    ) {
      throw new Error("interaction control was not returned");
    }
    const binding = {
      runId: dispatched.controlRef.runId,
      provider: dispatched.controlRef.provider,
      environmentId: "cli-bridge",
      sessionId: "interaction-binding",
      executionId: dispatched.controlRef.executionId,
      interactionId: "interaction-binding-question",
      requestDigest: dispatched.controlRef.requestDigest,
    };
    const response = { id: "interaction-binding-question", outcome: "accepted" as const };
    const command = {
      operationId: "interaction-binding-operation",
      binding,
      response,
      commandDigest: interactionResponseCommandDigest({ binding, response }),
    };
    const { sessionId: _sessionId, ...bindingWithoutSession } = command.binding;
    await expect(environment.respondToInteraction({
      ...command,
      binding: bindingWithoutSession,
    } as never)).rejects.toThrow(/sessionId/);
    const wrongSessionBinding = { ...command.binding, sessionId: "another-session" };
    await expect(environment.respondToInteraction({
      ...command,
      binding: wrongSessionBinding,
      commandDigest: interactionResponseCommandDigest({ binding: wrongSessionBinding, response }),
    })).rejects.toThrow(/must include this retained session/);
    const wrongRunBinding = { ...command.binding, runId: "another-run" };
    await expect(environment.respondToInteraction({
      ...command,
      binding: wrongRunBinding,
      commandDigest: interactionResponseCommandDigest({ binding: wrongRunBinding, response }),
    })).rejects.toThrow(/does not match the current retained run/);
    expect(fixture.calls.filter((call) => call.path.includes("/interactions/")).length).toBe(0);
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
    const material = { operationId: "cancel-old", run: exactRun(oldControlRef) };
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

  it("keeps cleanup bound to the current run after reading an older run", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "historical-cleanup",
    });
    await consumeEvents(environment.stream({ prompt: "first", executionId: "historical-cleanup-old" }));
    const oldControlRef = environment.session?.("historical-cleanup")?.controlRef;
    if (!oldControlRef) throw new Error("older run identity was not returned");
    const current = await environment.dispatch?.({
      prompt: "second",
      executionId: "historical-cleanup-current",
    });
    if (!current?.controlRef) throw new Error("current run identity was not returned");
    await expect(environment.session?.("historical-cleanup", {
      controlRef: oldControlRef,
    }).status()).resolves.toBe("completed");

    await environment.destroy?.();
    const cancellation = fixture.calls.find((call) => call.path.endsWith("/cancel"));
    expect(cancellation?.body?.run).toMatchObject({ runId: current.controlRef.runId });
    expect(fixture.calls.filter((call) => call.path.endsWith("/cancel"))).toHaveLength(1);
  });

  it("does not detach the current run when a historical event reader returns early", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "historical-reader",
    });
    await consumeEvents(environment.stream({ prompt: "old", executionId: "historical-reader-old" }));
    const oldControlRef = environment.session?.("historical-reader")?.controlRef;
    if (!oldControlRef) throw new Error("historical run identity was not returned");
    const current = await environment.dispatch?.({
      prompt: "current",
      executionId: "historical-reader-current",
    });
    if (!current?.controlRef) throw new Error("current run identity was not returned");
    const historical = environment.session?.("historical-reader", { controlRef: oldControlRef });
    if (!historical) throw new Error("historical session was not reconstructed");
    const iterator = historical.events()[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(fixture.calls.filter((call) => call.path.endsWith("/detach"))).toHaveLength(0);

    await environment.destroy?.();
    expect(fixture.calls.find((call) => call.path.endsWith("/cancel"))?.body?.run)
      .toMatchObject({ runId: current.controlRef.runId });
  });

  it("serializes a delayed status read before admitting the next turn", async () => {
    const fixture = createFixture();
    let releaseStatus!: () => void;
    let statusStarted!: () => void;
    const statusIsStarted = new Promise<void>((resolve) => {
      statusStarted = resolve;
    });
    const statusRelease = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    let delayStatus = false;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (delayStatus && url.pathname.endsWith("/status") && init?.method === "GET") {
          statusStarted();
          await statusRelease;
        }
        return fixture.fetch(input, init);
      },
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "status-admission-order",
    });
    delayStatus = true;
    const status = environment.status();
    await statusIsStarted;
    const dispatched = environment.dispatch?.({
      prompt: "current",
      executionId: "status-admission-current",
    });
    await Promise.resolve();
    expect(fixture.calls.filter((call) => call.path.endsWith("/turns"))).toHaveLength(0);
    releaseStatus();
    await status;
    const current = await dispatched;
    if (!current?.controlRef) throw new Error("serialized run identity was not returned");
    await environment.destroy?.();
    expect(fixture.calls.find((call) => call.path.endsWith("/cancel"))?.body?.run)
      .toMatchObject({ runId: current.controlRef.runId });
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

  it("rejects and closes a create response for a different session identity", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: async (input, init) => {
        const response = await fixture.fetch(input, init);
        const url = new URL(String(input));
        if (url.pathname === "/v1/sessions" && init?.method === "POST" && response.ok) {
          const body = await response.json() as Record<string, unknown>;
          return json({ ...body, id: "another-session" }, response.status);
        }
        return response;
      },
    });
    await expect(provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "create-session-identity",
    })).rejects.toThrow(/returned a different session/);
    expect(fixture.calls.filter((call) => call.path.endsWith("/close"))).toHaveLength(1);
  });

  it("closes a created session after any malformed success response", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: async (input, init) => {
        const response = await fixture.fetch(input, init);
        const url = new URL(String(input));
        if (url.pathname === "/v1/sessions" && init?.method === "POST" && response.ok) {
          return new Response('{"id":', {
            status: response.status,
            headers: { "content-type": "application/json" },
          });
        }
        return response;
      },
    });
    await expect(provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "malformed-create-success",
    })).rejects.toThrow(/invalid JSON/);
    expect(fixture.calls.filter((call) => call.path.endsWith("/close"))).toHaveLength(1);
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

  it("binds a retained turn retry to the exact execution and request before POST", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "turn-retry-binding",
    });
    const first = await environment.dispatch?.({
      prompt: "same request",
      executionId: "turn-retry-execution",
    });
    if (!first?.controlRef) throw new Error("retry run identity was not returned");
    await expect(environment.dispatch?.({
      prompt: "same request",
      controlRef: first.controlRef,
    })).resolves.toMatchObject({ controlRef: first.controlRef });
    const admittedRequests = fixture.calls.filter((call) => call.path.endsWith("/turns")).length;

    await expect(environment.dispatch?.({
      prompt: "changed request",
      controlRef: first.controlRef,
    })).rejects.toThrow(/does not match its exact retry controlRef/);
    await expect(environment.dispatch?.({
      prompt: "same request",
      executionId: "another-execution",
      controlRef: first.controlRef,
    })).rejects.toThrow(/does not match its exact retry controlRef/);
    expect(fixture.calls.filter((call) => call.path.endsWith("/turns"))).toHaveLength(admittedRequests);
  });

  it("rejects a server turn admission whose digest is not the exact submitted request", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: async (input, init) => {
        const response = await fixture.fetch(input, init);
        if (String(input).endsWith("/turns")) {
          const body = await response.json() as Record<string, unknown>;
          const run = body.run as Record<string, unknown>;
          return json({
            ...body,
            run: { ...run, requestDigest: `sha256:${"b".repeat(64)}` },
            session: {
              ...(body.session as Record<string, unknown>),
              run: {
                ...((body.session as Record<string, unknown>).run as Record<string, unknown>),
                requestDigest: `sha256:${"b".repeat(64)}`,
              },
            },
          }, response.status);
        }
        return response;
      },
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "admission-digest",
    });
    await expect(environment.dispatch?.({ prompt: "exact", executionId: "admission-run" }))
      .rejects.toThrow(/changed its exact request digest/);
    expect(fixture.calls.filter((call) => call.path.endsWith("/events"))).toHaveLength(0);
  });

  it("fails executionId-only historical access before network when no exact run is known", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "historical-binding",
    });
    const session = environment.session?.("historical-binding");
    expect(() => session?.events({ executionId: "not-admitted" })).toThrow(/exact digest-bearing controlRef/);
    await expect(session?.result()).rejects.toThrow(/exact digest-bearing controlRef/);
    expect(fixture.calls.filter((call) => call.path.startsWith("/v1/runs/") || call.path.endsWith("/status"))).toHaveLength(0);
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

    const withoutKey = await provider.create({ profile });
    expect(withoutKey.dispatch).toBeUndefined();
    expect(fixture.calls.filter((call) => call.path === "/v1/sessions" && call.method === "POST")).toHaveLength(0);

    const unsupportedMetadata = await provider.create({
      profile,
      idempotencyKey: "metadata-fallback",
      metadata: { arbitrary: "cannot be retained exactly" },
    });
    expect(unsupportedMetadata.dispatch).toBeUndefined();
    expect(fixture.calls.filter((call) => call.path === "/v1/sessions" && call.method === "POST")).toHaveLength(0);
  });

  it("rejects retained turn fields and attachments the server cannot execute exactly", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "unsupported-turns",
    });
    const turnsBefore = fixture.calls.filter((call) => call.path.endsWith("/turns")).length;
    await expect(environment.dispatch?.({
      prompt: "wrong model",
      executionId: "unsupported-model",
      model: "pi/other",
    })).rejects.toThrow(/cannot change model/);
    await expect(environment.dispatch?.({
      prompt: "timeout",
      executionId: "unsupported-timeout",
      timeoutMs: 1_000,
    })).rejects.toThrow(/timeoutMs/);
    await expect(environment.dispatch?.({
      prompt: "context",
      executionId: "unsupported-context",
      context: { trace: "value" },
    })).rejects.toThrow(/context metadata/);
    await expect(environment.dispatch?.({
      prompt: "provider options",
      executionId: "unsupported-options",
      providerOptions: { private: true },
    })).rejects.toThrow(/providerOptions/);
    await expect(environment.dispatch?.({
      parts: [{ type: "image", url: "https://example.test/image.png" }],
      executionId: "unsupported-image",
    })).rejects.toThrow(/text input parts only/);
    expect(fixture.calls.filter((call) => call.path.endsWith("/turns"))).toHaveLength(turnsBefore);
  });

  it("rebuilds complete result text when attachment begins after the text event", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "suffix-result",
    });
    const dispatched = await environment.dispatch?.({ prompt: "hello", executionId: "suffix-run" });
    if (!dispatched?.controlRef) throw new Error("retained control reference was not returned");
    const session = environment.session?.("suffix-result", { controlRef: dispatched.controlRef });
    const result = await session?.prompt({
      controlRef: dispatched.controlRef,
      lastEventId: "1",
    });
    expect(result).toMatchObject({ text: "hello", success: true });
    expect(result?.events?.some((event) => event.normalized?.type === "message.part.updated")).toBe(false);
  });

  it("can replay historical events after terminal status when the stream omitted a terminal event", async () => {
    const fixture = createFixture({
      eventTransform: (events) => events.filter((event) =>
        event.event.type !== "status" || event.event.status !== "completed"),
    });
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "terminal-status-only",
    });
    await consumeEvents(environment.stream({
      prompt: "historical text",
      executionId: "terminal-status-only-run",
    }));
    const session = environment.session?.("terminal-status-only");
    await expect(session?.result()).resolves.toMatchObject({
      text: "hello",
      success: true,
    });
  });

  it("preserves prompt and text parts in the exact retained turn digest", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "prompt-and-parts",
    });
    await expect(environment.dispatch?.({
      prompt: "prompt text",
      parts: [{ type: "text", text: "part text" }],
      executionId: "prompt-and-parts-run",
    })).resolves.toMatchObject({
      controlRef: { requestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) },
    });
    expect(fixture.calls.find((call) => call.path.endsWith("/turns"))?.body).toMatchObject({
      message: "prompt text",
      parts: [{ type: "text", text: "part text" }],
    });
  });

  it("requires a retained run digest for cancellation", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "cancel-digest",
    });
    const dispatched = await environment.dispatch?.({ prompt: "cancel", executionId: "cancel-digest-run" });
    if (!dispatched?.controlRef) throw new Error("retained control reference was not returned");
    const session = environment.session?.("cancel-digest", { controlRef: dispatched.controlRef });
    if (!session?.cancelRun) throw new Error("retained cancellation was not exposed");
    const { requestDigest: _runDigest, ...runWithoutDigest } = dispatched.controlRef;
    const material = { operationId: "cancel-without-run-digest", run: runWithoutDigest };
    const request = {
      ...material,
      requestDigest: `sha256:${"b".repeat(64)}` as const,
    } as Parameters<typeof session.cancelRun>[0];
    await expect(session.cancelRun(request)).rejects.toThrow(/requires the admitted run request digest/);
    const historical = environment.session?.("cancel-digest", { controlRef: runWithoutDigest });
    await expect(historical?.status()).rejects.toThrow(/exact executionId and request digest/);
    expect(fixture.calls.filter((call) => call.path.endsWith("/cancel"))).toHaveLength(0);
  });

  it("checks configured retained capabilities against the live endpoint", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      capabilities: {
        ...capabilities,
        usage: false,
      },
      fetch: fixture.fetch,
    });
    await expect(provider.capabilities()).rejects.toThrow(/do not match the live endpoint/);
    await expect(provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "capability-mismatch-create",
    })).rejects.toThrow(/do not match the live endpoint/);
    await expect(provider.get?.("capability-mismatch-get")).rejects.toThrow(/do not match the live endpoint/);
    await expect(provider.list?.()).rejects.toThrow(/do not match the live endpoint/);
    expect(fixture.calls.filter((call) => call.path === "/v1/sessions" && call.method === "POST")).toHaveLength(0);
  });

  it("rejects a mismatched newly created view and closes it, while checking every listed view", async () => {
    const fixture = createFixture();
    let corruptCreate = true;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: async (input, init) => {
        const response = await fixture.fetch(input, init);
        const url = new URL(String(input));
        if (corruptCreate && url.pathname === "/v1/sessions" && init?.method === "POST") {
          const body = await response.json() as Record<string, unknown>;
          return json({ ...body, capabilities: { ...capabilities, usage: false } }, response.status);
        }
        return response;
      },
    });
    await expect(provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "mismatched-created-view",
    })).rejects.toThrow(/capabilities/);
    expect(fixture.calls.filter((call) => call.path.endsWith("/close"))).toHaveLength(1);

    corruptCreate = false;
    await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "listed-a",
    });
    await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "listed-b",
    });
    const listProvider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: async (input, init) => {
        const response = await fixture.fetch(input, init);
        const url = new URL(String(input));
        if (url.pathname === "/v1/sessions" && init?.method === "GET" && !url.search) {
          const body = await response.json() as { data?: Array<Record<string, unknown>> };
          const data = body.data ?? [];
          const second = data[1];
          if (second) data[1] = { ...second, capabilities: { ...capabilities, usage: false } };
          return json({ ...body, data }, response.status);
        }
        return response;
      },
    });
    await expect(listProvider.list?.()).rejects.toThrow(/capabilities/);
  });

  it("checks capability digests on get, status refresh, lazy reconnect, and environment discovery", async () => {
    const fixture = createFixture();
    let corrupt = false;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: async (input, init) => {
        const response = await fixture.fetch(input, init);
        if (!corrupt || init?.method !== "GET") return response;
        const url = new URL(String(input));
        if (!url.pathname.startsWith("/v1/sessions")) return response;
        const body = await response.json() as Record<string, unknown>;
        if (Array.isArray(body.data)) {
          const first = body.data[0];
          if (first) body.data[0] = { ...first, capabilities: { ...capabilities, usage: false } };
        } else {
          body.capabilities = { ...capabilities, usage: false };
        }
        return json(body, response.status);
      },
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "view-checks",
    });
    corrupt = true;
    await expect(provider.get?.("view-checks")).rejects.toThrow(/capabilities/);
    await expect(provider.get?.("cli-bridge")).rejects.toThrow(/capabilities/);
    await expect(environment.status()).rejects.toThrow(/capabilities/);
    await expect(environment.refresh?.()).rejects.toThrow(/capabilities/);
  });

  it("rejects GET responses that return a different session identity", async () => {
    const fixture = createFixture();
    let corruptView = false;
    let corruptStatus = false;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: async (input, init) => {
        const response = await fixture.fetch(input, init);
        const url = new URL(String(input));
        if (
          response.ok &&
          init?.method === "GET" &&
          ((corruptView && url.pathname === "/v1/sessions/session-identity") ||
            (corruptStatus && url.pathname === "/v1/sessions/session-identity/status"))
        ) {
          const body = await response.json() as Record<string, unknown>;
          return json({ ...body, id: "another-session" }, response.status);
        }
        return response;
      },
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "session-identity",
    });
    corruptView = true;
    await expect(provider.get?.("session-identity")).rejects.toThrow(/does not match the requested session/);
    corruptView = false;
    corruptStatus = true;
    await expect(environment.status()).rejects.toThrow(/does not match the requested session/);
  });

  it("rejects event replay when run status changes the requested execution identity", async () => {
    const fixture = createFixture();
    let corruptRunStatus = false;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: async (input, init) => {
        const response = await fixture.fetch(input, init);
        const url = new URL(String(input));
        if (
          corruptRunStatus &&
          init?.method === "GET" &&
          /^\/v1\/runs\/[^/]+$/u.test(url.pathname) &&
          response.ok
        ) {
          const body = await response.json() as Record<string, unknown>;
          return json({ ...body, executionId: "changed-execution" }, response.status);
        }
        return response;
      },
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "event-execution-binding",
    });
    const dispatched = await environment.dispatch?.({
      prompt: "bind events",
      executionId: "expected-execution",
    });
    if (!dispatched?.controlRef) throw new Error("retained control reference was not returned");
    corruptRunStatus = true;
    const session = environment.session?.("event-execution-binding", {
      controlRef: dispatched.controlRef,
    });
    const consumeEvents = async () => {
      for await (const _event of session!.events({ executionId: "expected-execution" })) {
        // The status binding must be checked before any event is yielded.
      }
    };
    await expect(consumeEvents()).rejects.toThrow(/changed its public execution identity/);
    expect(fixture.calls.filter((call) => call.path.endsWith("/events"))).toHaveLength(0);
  });

  it("rejects duplicate, rewound, and post-terminal retained events", async () => {
    const cases: Array<[string, (events: RuntimeEventEnvelope[]) => RuntimeEventEnvelope[]]> = [
      ["duplicate", (events) => [events[0]!, events[0]!, ...events.slice(1)]],
      ["rewound", (events) => [events[0]!, events[2]!, events[1]!, events[3]!]],
      ["after terminal", (events) => [
        ...events,
        { ...events[0]!, eventId: `${events[0]!.eventId}-after`, sequence: 4 },
      ]],
    ];
    for (const [label, eventTransform] of cases) {
      const fixture = createFixture({ eventTransform });
      const provider = createCliBridgeProvider({
        baseUrl: "http://bridge.local",
        defaultModel: "pi/test",
        fetch: fixture.fetch,
      });
      const environment = await provider.create({
        profile: { name: "worker", harness: "pi", model: { default: "test" } },
        idempotencyKey: `event-integrity-${label}`,
      });
      await expect(consumeEvents(environment.stream({ prompt: label, executionId: `${label}-run` })))
        .rejects.toThrow(label === "after terminal" ? /after a terminal/ : /strictly increasing|after a terminal/);
    }
  });

  it("rejects a changed replay payload for an observed event identity", async () => {
    let corrupt = false;
    const fixture = createFixture({
      eventTransform: (events) => {
        if (!corrupt) return events;
        const changed = events[1]!;
        return events.map((event) => event.sequence === changed.sequence
          ? {
              ...event,
              event: {
                ...event.event,
                delta: "changed",
              } as RuntimeEventEnvelope["event"],
            }
          : event);
      },
    });
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "event-payload-conflict",
    });
    await consumeEvents(environment.stream({ prompt: "first", executionId: "payload-conflict-run" }));
    corrupt = true;
    const session = environment.session?.("event-payload-conflict");
    await expect(consumeEvents(session!.events({ since: "0", executionId: "payload-conflict-run" })))
      .rejects.toThrow(/changed its event id binding or payload/);
  });

  it("rejects a changed replay event id for an observed sequence", async () => {
    let corrupt = false;
    const fixture = createFixture({
      eventTransform: (events) => {
        if (!corrupt) return events;
        return events.map((event) => event.sequence === 1
          ? { ...event, eventId: `${event.eventId}-changed` }
          : event);
      },
    });
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "event-id-conflict",
    });
    await consumeEvents(environment.stream({ prompt: "first", executionId: "id-conflict-run" }));
    corrupt = true;
    const session = environment.session?.("event-id-conflict");
    await expect(consumeEvents(session!.events({ since: "0", executionId: "id-conflict-run" })))
      .rejects.toThrow(/changed its sequence binding or payload/);
  });

  it("keeps legacy and retained run identities in distinct namespaces", async () => {
    const fixture = createFixture();
    let legacyRunId: string | undefined;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/chat/completions") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          legacyRunId = String(body.run_id);
          return new Response(
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
        }
        return fixture.fetch(input, init);
      },
    });
    const retained = await provider.create({
      profile: { name: "retained", harness: "pi", model: { default: "test" } },
      idempotencyKey: "same-session",
    });
    await retained.dispatch?.({ prompt: "same", executionId: "same-execution" });
    const retainedRunId = String(
      fixture.calls.find((call) => call.path.endsWith("/turns"))?.body?.run_id,
    );

    const legacy = await provider.create({
      profile: { name: "legacy", harness: "pi", model: { default: "test" } },
      idempotencyKey: "cli-bridge",
      env: { FORCE_LEGACY: "1" },
    });
    for await (const _event of legacy.stream({
      prompt: "same",
      sessionId: "same-session",
      executionId: "same-execution",
    })) {
      // Drain the legacy response.
    }
    expect(retainedRunId).toMatch(/^agent-[a-f0-9]{64}$/u);
    expect(legacyRunId).toMatch(/^agent-[a-f0-9]{64}$/u);
    expect(legacyRunId).not.toBe(retainedRunId);
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

  it("does not cancel a second time during cleanup after confirmed cancellation", async () => {
    const fixture = createFixture();
    let staleStatus = false;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: async (input, init) => {
        const response = await fixture.fetch(input, init);
        const url = new URL(String(input));
        if (staleStatus && url.pathname.endsWith("/status") && init?.method === "GET") {
          const body = await response.json() as Record<string, unknown>;
          const run = body.run as Record<string, unknown>;
          return json({
            ...body,
            status: "running",
            run: { ...run, status: "running", terminal: false },
          }, response.status);
        }
        return response;
      },
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi", model: { default: "test" } },
      idempotencyKey: "cancel-then-cleanup",
    });
    const dispatched = await environment.dispatch?.({
      prompt: "stay live",
      executionId: "cancel-then-cleanup-run",
    });
    if (!dispatched?.controlRef || !environment.session) {
      throw new Error("cancellable run identity was not returned");
    }
    const session = environment.session("cancel-then-cleanup", { controlRef: dispatched.controlRef });
    const material = {
      operationId: "cancel-before-cleanup",
      run: exactRun(dispatched.controlRef),
    };
    await expect(session.cancelRun?.({
      ...material,
      requestDigest: agentRunCancellationRequestDigest(material),
    })).resolves.toMatchObject({ status: "accepted", effect: "cancelled" });
    staleStatus = true;
    await expect(session.status()).resolves.toBe("cancelled");
    await environment.destroy?.();
    expect(fixture.calls.filter((call) => call.path.endsWith("/cancel"))).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.path.endsWith("/close"))).toHaveLength(1);
  });

  it("rejects unsupported list filters before reading session metadata", async () => {
    const fixture = createFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/test",
      fetch: fixture.fetch,
    });
    await expect(provider.list?.({ name: "worker" })).rejects.toThrow(/does not support filtered queries/);
    expect(fixture.calls.filter((call) => call.path === "/v1/sessions" && call.method === "GET"))
      .toHaveLength(0);
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

interface FixtureOptions {
  eventTransform?: (events: RuntimeEventEnvelope[]) => RuntimeEventEnvelope[];
}

function createFixture(options: FixtureOptions = {}): {
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
        return json({ operationId, binding: body?.binding, commandDigest: body?.commandDigest, status: "already_resolved_different" }, 409);
      }
      operations.set(operationId, digest);
      return json({ operationId, binding: body?.binding, commandDigest: body?.commandDigest, status: "accepted" }, 200);
    }
    const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(events))?$/u);
    if (runMatch && method === "GET") {
      const runId = decodeURIComponent(runMatch[1]!);
      const sessionId = runSessions.get(runId);
      if (!sessionId) return json({ error: { message: "not found", type: "not_found_error" } }, 404);
      const run = runs.get(runId)!;
      if (runMatch[2] === "events") {
        const runEvents = events.get(runId) ?? [];
        const lastHeader = new Headers(init?.headers).get("last-event-id");
        const last = lastHeader === null ? -1 : Number(lastHeader);
        if (!Number.isSafeInteger(last) || last < -1) {
          return json({ error: { message: "invalid Last-Event-ID", type: "invalid_request_error" } }, 400);
        }
        const completedRun = { ...run, id: runId, status: "done", terminal: true, sessionId };
        runs.set(runId, completedRun);
        const completed = sessionView(sessionId, "idle", runId, completedRun);
        completed.profile_materialization_receipt = { profileDigest: "receipt-1" };
        if (sessions.get(sessionId)?.run_id === runId) sessions.set(sessionId, completed);
        const payload = (options.eventTransform?.(runEvents) ?? runEvents)
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
      const executionId = String(body?.execution_id);
      const inputParts = normalizeInputParts({
        message: typeof body?.message === "string" ? body.message : undefined,
        parts: Array.isArray(body?.parts) ? body.parts : undefined,
      });
      const requestDigest = canonicalCandidateDigest({
        sessionId: id,
        runId,
        executionId,
        model: view.model,
        input: inputParts,
        turnId: body?.turn_id,
      });
      if (
        typeof body?.turn_id !== "string" ||
        body?.execution_id !== executionId
      ) {
        return json({ error: { message: "turn request digest mismatch", type: "invalid_request_error" } }, 400);
      }
      const run = {
        id: runId,
        executionId,
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
      if (
        !exactRun ||
        exactRun.sessionId !== id ||
        request.run.provider !== "cli-bridge" ||
        request.run.environmentId !== "cli-bridge" ||
        request.run.sessionId !== id ||
        request.run.executionId !== exactRun.executionId ||
        request.run.requestDigest !== exactRun.requestDigest
      ) {
        return json({
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          run: request.run,
          status: "conflict",
          effect: "unknown",
        }, 409);
      }
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

async function consumeEvents(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // Drain the stream to its terminal condition.
  }
}
