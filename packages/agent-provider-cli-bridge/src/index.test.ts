import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  CanonicalStreamEventSchema,
  agentRunCancellationRequestDigest,
  canonicalCandidateDigest,
  harnessTypeSchema,
  interactionRequestDigest,
  permissionAnswerSpec,
  RuntimeEventEnvelopeSchema,
  type AgentExactRunControlRef,
  type AgentProfile,
} from "@tangle-network/agent-interface";
import type { AgentEnvironment } from "@tangle-network/agent-interface/environment-provider";
import { describe, expect, it } from "vitest";
import { createCliBridgeProvider, defaultCliBridgeCapabilities } from "./index.js";
import { cliBridgeEnvironmentId } from "./environment-identity.js";
import { toChatCompletionsBody } from "./wire.js";

describe("createCliBridgeProvider", () => {
  it("rejects a named profile before network use", async () => {
    let called = false;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async () => {
        called = true;
        return new Response();
      },
    });

    await expect(provider.create({ profile: "profile-id" })).rejects.toThrow(
      /requires an inline AgentProfile/,
    );
    expect(called).toBe(false);
  });

  it("reuses a keyed generic create and rejects changed input", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async () => new Response(),
    });
    const input = {
      profile: { name: "worker", harness: "pi" as const },
      metadata: { z: "last", a: "first" },
      idempotencyKey: "environment-create-1",
    };

    const first = await provider.create(input);
    const replay = await provider.create({
      idempotencyKey: input.idempotencyKey,
      metadata: { a: "first", z: "last" },
      profile: { harness: "pi", name: "worker" },
    });

    expect(replay).toBe(first);
    await expect(
      provider.create({
        ...input,
        profile: { name: "different-worker", harness: "pi" },
      }),
    ).rejects.toThrow(/conflicts with a different create input/);
  });

  it("binds a configured non-Pi model into durable environment identity", async () => {
    const firstProvider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "codex/first-model",
      fetch: async () => new Response(),
    });
    const secondProvider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "codex/second-model",
      fetch: async () => new Response(),
    });
    const input = {
      profile: { name: "worker", harness: "codex" as const },
      idempotencyKey: "shared-model-key",
    };

    const first = await firstProvider.create(input);
    const second = await secondProvider.create(input);

    expect(second.id).not.toBe(first.id);
  });

  it("keeps profile authority separate from the task and forwards it unchanged through retained Pi", async () => {
    const profile: AgentProfile = {
      name: "scientist",
      harness: "pi",
      model: {
        provider: "tangle-router",
        default: "glm-5.2",
        reasoningEffort: "xhigh",
      },
      prompt: { systemPrompt: "Use this system prompt exactly once." },
      mcp: {
        coordination: {
          transport: "http",
          url: "http://127.0.0.1:4444/mcp",
        },
      },
    };
    const expectedProfile = structuredClone(profile);
    const fixture = createNativePiFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/tangle-router/glm-5.2",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({ profile });
    await expect(environment.session?.("missing").status()).resolves.toBeNull();
    profile.prompt!.systemPrompt = "Caller mutation must not cross intake.";
    profile.model!.default = "different-model";

    await consumeTurn(environment, {
      prompt: "run the task",
      sessionId: "profile-session",
      turnId: "profile-turn",
      executionId: "profile-run",
    });

    expect(fixture.sessionBodies).toEqual([
      expect.objectContaining({
        id: "profile-session",
        model: "pi/tangle-router/glm-5.2",
        interaction_policy: "interactive",
        agent_profile: expectedProfile,
      }),
    ]);
    expect(fixture.turnBodies).toEqual([
      expect.objectContaining({
        message: "run the task",
        turn_id: "profile-turn",
        execution_id: "profile-run",
        run_id: "profile-run",
        provider: "cli-bridge",
        environment_id: expect.any(String),
      }),
    ]);
    expect(fixture.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "GET /v1/capabilities",
      "POST /v1/sessions",
      "POST /v1/sessions/profile-session/turns",
      "GET /v1/runs/profile-run/events",
      "GET /v1/runs/profile-run",
    ]);
    expect(fixture.requests.some((request) => request.url.endsWith("/v1/chat/completions"))).toBe(false);
    expect(fixture.sessionBodies[0]?.agent_profile).toEqual(expectedProfile);
    expect(fixture.turnBodies[0]).not.toHaveProperty("agent_profile");
    expect(fixture.turnBodies[0]).toMatchObject({
      provider: "cli-bridge",
      environment_id: expect.any(String),
    });
  });

  it("uses a pi default model when create input omits backend and profile harness", async () => {
    const fixture = createNativePiFixture();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/tangle-router/glm-5.2",
      fetch: fixture.fetch,
    });

    const environment = await provider.create({
      idempotencyKey: "default-backend-environment",
      profile: { name: "worker" },
    });
    expect(environment.capabilities?.interactions?.kinds).toEqual(["permission"]);

    await consumeTurn(environment, {
      prompt: "use the configured native backend",
      sessionId: "default-backend-session",
      turnId: "default-backend-turn",
      executionId: "default-backend-run",
    });

    expect(fixture.sessionBodies[0]).toMatchObject({
      id: "default-backend-session",
      model: "pi/tangle-router/glm-5.2",
    });
    expect(fixture.requests.some((request) => request.url.endsWith("/v1/chat/completions"))).toBe(false);
  });

  it("keeps interaction posture top-level if a one-shot body is constructed", () => {
    const body = toChatCompletionsBody(
      { baseUrl: "http://bridge.local", defaultModel: "opencode/model" },
      { profile: { name: "worker" } },
      { prompt: "preserve posture", interactions: { permission: true } },
      {
        runId: "one-shot-run",
        provider: "cli-bridge",
        environmentId: "one-shot-environment",
        sessionId: "one-shot-session",
        executionId: "one-shot-execution",
      },
    );

    expect(body.interactions).toEqual({ permission: true });
    expect(body).toMatchObject({
      run_id: "one-shot-run",
      provider: "cli-bridge",
      environment_id: "one-shot-environment",
      session_id: "one-shot-session",
      execution_id: "one-shot-execution",
    });
    expect(body.metadata).not.toHaveProperty("interactions");
  });

  it("maps durable dispatch, replay, result, and continuation into one exact retained Pi session", async () => {
    const profile: AgentProfile = {
      name: "research-leader",
      harness: "pi",
      model: {
        provider: "tangle-router",
        default: "glm-5.2",
        reasoningEffort: "high",
      },
      prompt: { systemPrompt: "Lead the research." },
    };
    const fixture = createNativePiFixture({
      includeInteractionForRun: (runId) => runId === "run-1",
      textForRun: (runId) => runId === "run-2" ? "continued" : `complete-${runId}`,
      usageForRun: (runId) => runId === "run-2"
        ? { inputTokens: 5, outputTokens: 2, cost: 0.01 }
        : { inputTokens: 11, outputTokens: 7, totalTokens: 18, reasoningTokens: 3, cost: 0.04 },
    });
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/tangle-router/glm-5.2",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({ profile });

    const reference = await environment.dispatch?.({
      prompt: "initial task",
      sessionId: "research-session",
      turnId: "turn-1",
      executionId: "run-1",
    });

    expect(reference).toEqual({
      id: "research-session",
      provider: "cli-bridge",
      controlRef: {
        runId: "run-1",
        provider: "cli-bridge",
        environmentId: expect.any(String),
        sessionId: "research-session",
        executionId: "run-1",
        requestDigest: testDigest("run-1"),
      },
      metadata: {
        runId: "run-1",
        requestDigest: testDigest("run-1"),
      },
    });
    expect(fixture.requests.some((request) => request.url.endsWith("/v1/chat/completions"))).toBe(false);
    expect(fixture.turnBodies[0]).toMatchObject({
      run_id: reference!.controlRef!.runId,
      provider: reference!.controlRef!.provider,
      environment_id: reference!.controlRef!.environmentId,
    });
    const session = environment.session?.(reference!.id);
    await expect(session?.status()).resolves.toBe("running");
    const replayed = [];
    for await (const event of session!.events({ since: "1" })) replayed.push(event);
    expect(replayed.map((event) => event.type)).toEqual([
      "raw",
      "interaction",
      "message.part.updated",
      "status",
    ]);
    expect(replayed[0]?.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      reasoningTokens: 3,
      cost: 0.04,
    });
    expect(replayed[0]?.data).toMatchObject({ backend: "pi" });
    expect(replayed[1]?.normalized).toMatchObject({
      type: "interaction",
      request: {
        binding: {
          runId: reference!.controlRef!.runId,
          provider: reference!.controlRef!.provider,
          environmentId: reference!.controlRef!.environmentId,
          sessionId: reference!.controlRef!.sessionId,
          executionId: reference!.controlRef!.executionId,
        },
      },
    });
    expect(replayed.at(-1)).toMatchObject({
      id: "5",
      data: { status: "completed" },
    });
    await expect(session?.result()).resolves.toMatchObject({
      text: "complete-run-1",
      success: true,
      sessionId: "research-session",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        reasoningTokens: 3,
        cost: 0.04,
      },
      metadata: {
        runId: "run-1",
        executionId: "run-1",
        status: "done",
        requestDigest: testDigest("run-1"),
      },
    });
    await expect(session?.prompt({
      prompt: "new direction",
      turnId: "turn-2",
      executionId: "run-2",
    })).resolves.toMatchObject({
      text: "continued",
      success: true,
      sessionId: "research-session",
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cost: 0.01,
      },
      metadata: {
        runId: "run-2",
        executionId: "run-2",
        status: "done",
      },
    });
    await expect(session?.prompt({
      prompt: "wrong conversation",
      sessionId: "other-session",
    })).rejects.toThrow(/cannot prompt session/);

    expect(fixture.turnBodies).toEqual([
      expect.objectContaining({
        run_id: "run-1",
        message: "initial task",
        turn_id: "turn-1",
        execution_id: "run-1",
        provider: "cli-bridge",
        environment_id: reference!.controlRef!.environmentId,
      }),
      expect.objectContaining({
        run_id: "run-2",
        message: "new direction",
        turn_id: "turn-2",
        execution_id: "run-2",
        provider: "cli-bridge",
        environment_id: reference!.controlRef!.environmentId,
      }),
    ]);
    expect(fixture.sessionBodies[0]).toMatchObject({
      id: "research-session",
      model: "pi/tangle-router/glm-5.2",
      agent_profile: profile,
    });
    expect(fixture.turnBodies.every((body) => !Object.hasOwn(body, "agent_profile"))).toBe(true);
    expect(await provider.capabilities()).toMatchObject({
      streaming: { detach: true, replay: true },
      sessions: { continue: true },
    });
  });

  it("supports generic retained start, reconnect, status, result, and cancellation", async () => {
    const runId = "restart-run";
    const sessionId = "restart-session";
    const environmentId = "restart-environment";
    const requestDigest = testDigest(runId);
    let status: "running" | "done" = "running";
    let dispatches = 0;
    let cancellations = 0;
    const requests: string[] = [];
    let admittedCoordinates: Omit<AgentExactRunControlRef, "requestDigest"> | undefined;
    const bridgeFetch: typeof fetch = async (url, init) => {
      const target = String(url);
      requests.push(target);
      if (new URL(target).pathname === "/v1/capabilities") {
        return Response.json(defaultCliBridgeCapabilities("codex"));
      }
      if (target.endsWith("/events")) {
        status = "done";
        if (admittedCoordinates === undefined) throw new Error("run was not admitted");
        return new Response(
          [
            'id: 1\ndata: {"choices":[{"delta":{"content":"survived "},"finish_reason":null}]}\n\n',
            'id: 2\ndata: {"choices":[{"delta":{"content":"restart"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-run-id": runId,
              "x-run-request-digest": requestDigest,
              "x-run-provider": admittedCoordinates.provider,
              "x-run-environment-id": admittedCoordinates.environmentId,
              "x-run-session-id": admittedCoordinates.sessionId,
              "x-run-execution-id": admittedCoordinates.executionId,
            },
          },
        );
      }
      if (target.endsWith("/cancel")) {
        cancellations += 1;
        const request = JSON.parse(String(init?.body)) as {
          operationId: string;
          requestDigest: `sha256:${string}`;
          run: AgentExactRunControlRef;
        };
        expect(request.run).toEqual({
          ...admittedCoordinates,
          requestDigest,
        });
        return Response.json({
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          run: request.run,
          status: "accepted",
          effect: "not_live",
        });
      }
      if (init?.method === "GET") {
        return Response.json({
          ...admittedCoordinates,
          id: runId,
          requestDigest,
          status,
          terminal: status === "done",
        });
      }
      dispatches += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      admittedCoordinates = {
        runId,
        provider: String(body.provider),
        environmentId: String(body.environment_id),
        sessionId: String(body.session_id),
        executionId: String(body.execution_id),
      };
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
            "x-run-id": runId,
            "x-run-request-digest": requestDigest,
            "x-run-provider": admittedCoordinates.provider,
            "x-run-environment-id": admittedCoordinates.environmentId,
            "x-run-session-id": admittedCoordinates.sessionId,
            "x-run-execution-id": admittedCoordinates.executionId,
          },
        },
      );
    };
    const starter = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "codex/tangle-router/glm-5.2",
      fetch: bridgeFetch,
    });
    await starter.capabilities();
    const startedEnvironment = await starter.create({
      profile: { name: "worker", harness: "codex" },
      idempotencyKey: environmentId,
    });
    expect(startedEnvironment.capabilities).toMatchObject({
      sessions: { continue: true },
      retainedControl: {
        exactRunIdentity: true,
        resultIdentity: true,
        eventIdentity: true,
        cancellationIdempotency: true,
      },
    });
    expect(startedEnvironment.capabilities?.nativeContinuation).toBeUndefined();
    const reference = await startedEnvironment.dispatch?.({
      prompt: "keep working after restart",
      sessionId,
      turnId: "restart-turn",
      executionId: runId,
      detach: true,
    });
    const controlRef = reference?.controlRef as AgentExactRunControlRef;
    expect(requests).toContain("http://bridge.local/v1/chat/completions");
    expect(requests).not.toContain("http://bridge.local/v1/sessions");

    const restarted = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/tangle-router/glm-5.2",
      fetch: bridgeFetch,
    });
    await restarted.capabilities();
    const recoveredEnvironment = await restarted.get?.(startedEnvironment.id);
    expect(recoveredEnvironment?.capabilities?.interactions).toBeUndefined();
    expect(recoveredEnvironment?.capabilities?.nativeContinuation).toBeUndefined();
    expect(recoveredEnvironment?.capabilities?.retainedControl).toEqual({
      exactRunIdentity: true,
      resultIdentity: true,
      eventIdentity: true,
      cancellationIdempotency: true,
    });
    expect(recoveredEnvironment?.respondToInteraction).toBeUndefined();
    const recovered = recoveredEnvironment?.session?.(sessionId, { controlRef });
    await expect(recovered?.status()).resolves.toBe("running");
    const events = [];
    for await (const event of recovered!.events({ since: "0" })) events.push(event);
    expect(events.map((event) => event.id)).toEqual(["1:0", "2:0", "2:1", "2:2"]);
    await expect(recovered?.result()).resolves.toMatchObject({
      text: "survived restart",
      success: true,
      sessionId,
      metadata: {
        runId,
        executionId: runId,
        requestDigest,
      },
    });
    await recoveredEnvironment?.destroy?.();
    expect(cancellations).toBe(0);

    const cancellationMaterial = {
      operationId: "restart-cancel",
      run: controlRef,
      reason: "proof complete",
    };
    const cancellationRequest = {
      ...cancellationMaterial,
      requestDigest: agentRunCancellationRequestDigest(cancellationMaterial),
    };
    const controlEnvironment = await restarted.get?.(startedEnvironment.id);
    const controlSession = controlEnvironment?.session?.(sessionId, { controlRef });
    await expect(controlSession?.cancelRun?.(cancellationRequest)).resolves.toMatchObject({
      operationId: "restart-cancel",
      status: "accepted",
      effect: "not_live",
    });
    expect(dispatches).toBe(1);
    expect(cancellations).toBe(1);
  });

  it("waits for terminal proof when cancelling a dispatched session", async () => {
    const requested: string[] = [];
    let getCalls = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "runner/model",
      fetch: async (url, init) => {
        const target = String(url);
        requested.push(target);
        if (target.endsWith("/cancel")) {
          return cancelResponse(init, "cancel_requested", 202);
        }
        if (init?.method === "GET") {
          getCalls += 1;
          return runResponse(
            "cancel-run",
            getCalls === 1 ? "running" : "cancelled",
            getCalls > 1,
          );
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
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
              ...exactRunHeaders(body),
            },
          },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const reference = await environment.dispatch?.({
      prompt: "long task",
      sessionId: "cancel-session",
      turnId: "cancel-turn",
      executionId: "cancel-run",
    });

    await environment.session?.(reference!.id).cancel();

    expect(requested).toContain(
      "http://bridge.local/v1/runs/cancel-run/cancel",
    );
    expect(requested.some((target) =>
      /^http:\/\/bridge\.local\/v1\/runs\/cancel-run\?wait_ms=\d+$/u.test(target)
    )).toBe(true);
    expect(getCalls).toBe(2);
  });

  it("recovers one provider-owned exact retained run", async () => {
    const controlRef: AgentExactRunControlRef = {
      runId: "lookup-run",
      provider: "cli-bridge",
      environmentId: "lookup-environment",
      sessionId: "lookup-session",
      executionId: "lookup-execution",
      requestDigest: testDigest("lookup-run"),
    };
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (url, init) => {
        expect(String(url)).toBe("http://bridge.local/v1/runs/lookup-run");
        expect(init?.method).toBe("GET");
        return Response.json({
          ...controlRef,
          id: controlRef.runId,
          status: "running",
          terminal: false,
        });
      },
    });

    await expect(provider.lookupRun({
      runId: controlRef.runId,
      environmentId: controlRef.environmentId,
      sessionId: controlRef.sessionId,
      executionId: controlRef.executionId,
    })).resolves.toEqual(controlRef);
  });

  it("generates complete retained coordinates for a generic dispatch", async () => {
    let admittedBody: Record<string, unknown> | undefined;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode/model",
      capabilities: defaultCliBridgeCapabilities("opencode"),
      fetch: async (_url, init) => {
        admittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
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
              ...exactRunHeaders(admittedBody),
            },
          },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    const reference = await environment.dispatch?.({ prompt: "work" });

    expect(admittedBody).toMatchObject({
      provider: "cli-bridge",
      run_id: expect.any(String),
      environment_id: environment.id,
      session_id: expect.any(String),
      execution_id: expect.any(String),
    });
    expect(admittedBody?.session_id).toBe(admittedBody?.run_id);
    expect(admittedBody?.execution_id).toBe(admittedBody?.run_id);
    expect(reference?.id).toBe(admittedBody?.session_id);
    expect(reference?.controlRef).toMatchObject({
      runId: admittedBody?.run_id,
      provider: admittedBody?.provider,
      environmentId: admittedBody?.environment_id,
      sessionId: admittedBody?.session_id,
      executionId: admittedBody?.execution_id,
    });
  });

  it("keeps concurrent generic dispatches on distinct complete coordinates", async () => {
    const admitted: Record<string, unknown>[] = [];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode/model",
      capabilities: defaultCliBridgeCapabilities("opencode"),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        admitted.push(body);
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
              ...exactRunHeaders(body),
            },
          },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await Promise.all(Array.from({ length: 16 }, (_value, index) =>
      environment.dispatch!({ prompt: `work-${index}` })
    ));

    expect(new Set(admitted.map((body) => body.run_id)).size).toBe(16);
    for (const body of admitted) {
      expect(body).toMatchObject({
        provider: "cli-bridge",
        environment_id: environment.id,
        run_id: expect.any(String),
        session_id: expect.any(String),
        execution_id: expect.any(String),
      });
    }
  });

  it.each([
    { turnId: "caller-turn" },
    { executionId: "caller-execution" },
  ])("completes partial generic caller coordinates: %j", async (partial) => {
    let body: Record<string, unknown> | undefined;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode/model",
      capabilities: defaultCliBridgeCapabilities("opencode"),
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(": connected\n\n", {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            ...exactRunHeaders(body),
          },
        });
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await environment.dispatch!({ prompt: "work", ...partial });

    expect(body).toMatchObject({
      provider: "cli-bridge",
      environment_id: environment.id,
      run_id: expect.any(String),
      session_id: expect.any(String),
      execution_id: expect.any(String),
    });
  });

  it("refreshes model capability truth instead of retaining a fulfilled document", async () => {
    let requests = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode/model",
      fetch: async () => {
        requests += 1;
        const capabilities = defaultCliBridgeCapabilities("opencode");
        if (requests === 1) return Response.json(capabilities);
        const { retainedControl: _retainedControl, ...withoutRetainedControl } = capabilities;
        return Response.json({
          ...withoutRetainedControl,
          streaming: { ...capabilities.streaming, replay: false },
        });
      },
    });

    expect((await provider.capabilities()).retainedControl).toBeDefined();
    expect((await provider.capabilities()).retainedControl).toBeUndefined();
    expect(requests).toBe(2);
  });

  it("rejects a generic retained turn outside its verified model route", async () => {
    let called = false;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode/model-a",
      capabilities: defaultCliBridgeCapabilities("opencode"),
      fetch: async () => {
        called = true;
        return new Response();
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(environment.dispatch!({
      prompt: "wrong route",
      model: "opencode/model-b",
    })).rejects.toThrow("create another environment");
    expect(called).toBe(false);
  });

  it("returns null when an exact retained run does not exist", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async () => new Response(null, { status: 404 }),
    });

    await expect(provider.lookupRun({
      runId: "missing-run",
      environmentId: "lookup-environment",
      sessionId: "lookup-session",
      executionId: "lookup-execution",
    })).resolves.toBeNull();
  });

  it("bounds retained lookup responses", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async () => new Response("x".repeat(64 * 1024 + 1)),
    });

    await expect(provider.lookupRun({
      runId: "oversized-run",
      environmentId: "lookup-environment",
      sessionId: "lookup-session",
      executionId: "lookup-execution",
    })).rejects.toThrow("cli-bridge response exceeded 65536 bytes");
  });

  it("rejects oversized retained lookup coordinates before network use", async () => {
    let called = false;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async () => {
        called = true;
        return new Response();
      },
    });

    await expect(provider.lookupRun({
      runId: "r".repeat(129),
      environmentId: "lookup-environment",
      sessionId: "lookup-session",
      executionId: "lookup-execution",
    })).rejects.toThrow();
    expect(called).toBe(false);
  });

  it.each([
    ["runId", "other-run"],
    ["provider", "other-provider"],
    ["environmentId", "other-environment"],
    ["sessionId", "other-session"],
    ["executionId", "other-execution"],
  ] as const)("rejects a retained lookup with a forged %s", async (field, value) => {
    const admitted: AgentExactRunControlRef = {
      runId: "lookup-run",
      provider: "cli-bridge",
      environmentId: "lookup-environment",
      sessionId: "lookup-session",
      executionId: "lookup-execution",
      requestDigest: testDigest("lookup-run"),
    };
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async () => Response.json({
        ...admitted,
        [field]: value,
        id: field === "runId" ? value : admitted.runId,
        status: "running",
        terminal: false,
      }),
    });

    await expect(provider.lookupRun({
      runId: admitted.runId,
      environmentId: admitted.environmentId,
      sessionId: admitted.sessionId,
      executionId: admitted.executionId,
    })).rejects.toThrow("cli-bridge returned another retained run identity");
  });

  it("forwards retained lookup cancellation", async () => {
    const controller = new AbortController();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      }),
    });
    const lookup = provider.lookupRun({
      runId: "lookup-run",
      environmentId: "lookup-environment",
      sessionId: "lookup-session",
      executionId: "lookup-execution",
      signal: controller.signal,
    });

    controller.abort(new DOMException("caller stopped lookup", "AbortError"));

    await expect(lookup).rejects.toThrow("caller stopped lookup");
  });

  it("rejects replay when the bridge changes a bound request digest", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "runner/model",
      fetch: async (url, init) => {
        if (init?.method === "GET") {
          const runId = decodeURIComponent(String(url).split("/").at(-2) ?? "");
          const coordinates = requiredTestRunCoordinates(runId);
          return new Response(
            'id: 1\ndata: {"choices":[{"delta":{"content":"wrong"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
                "x-run-id": runId,
                "x-run-request-digest": testDigest("changed-digest"),
                "x-run-provider": coordinates.provider,
                "x-run-environment-id": coordinates.environmentId,
                "x-run-session-id": coordinates.sessionId,
                "x-run-execution-id": coordinates.executionId,
              },
            },
          );
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
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
              ...exactRunHeaders(body),
              "x-run-request-digest": testDigest("original-digest"),
            },
          },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const reference = await environment.dispatch?.({
      prompt: "task",
      sessionId: "digest-session",
      turnId: "digest-turn",
      executionId: "digest-run",
    });

    await expect(
      consumeEvents(environment.session!(reference!.id).events({ since: "0" })),
    ).rejects.toThrow(/changed request digest/);
  });

  it("keeps concurrent continuation results bound to their own run identity", async () => {
    const statuses = new Map<string, "running" | "done">();
    let releaseFirst: (() => void) | undefined;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "runner/model",
      fetch: async (url, init) => {
        if (init?.method === "GET") {
          const runId = decodeURIComponent(
            String(url).split("/").at(-1)?.split("?")[0] ?? "",
          );
          const status = statuses.get(runId) ?? "running";
          return runResponse(runId, status, status === "done");
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const runId = String(body.run_id);
        const headers = {
          "content-type": "text/event-stream",
          ...exactRunHeaders(body),
        };
        if (body.stream === false) {
          return Response.json({
            choices: [{
              message: {
                role: "assistant",
                content: runId === "concurrent-a" ? "first" : "second",
              },
              finish_reason: "stop",
            }],
          }, { headers });
        }
        statuses.set(runId, "running");
        if (runId === "concurrent-a") {
          return new Response(
            new ReadableStream({
              start(controller) {
                releaseFirst = () => {
                  statuses.set(runId, "done");
                  controller.enqueue(
                    new TextEncoder().encode(
                      'data: {"choices":[{"delta":{"content":"first"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                    ),
                  );
                  controller.close();
                };
              },
            }),
            { status: 200, headers },
          );
        }
        statuses.set(runId, "done");
        return new Response(
          'data: {"choices":[{"delta":{"content":"second"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const session = environment.session!("concurrent-session");
    const first = session.prompt({
      prompt: "first",
      executionId: "concurrent-a",
    });
    while (!releaseFirst) await Promise.resolve();
    const second = await session.prompt({
      prompt: "second",
      executionId: "concurrent-b",
    });
    releaseFirst();
    const firstResult = await first;

    expect(firstResult).toMatchObject({
      text: "first",
      metadata: { runId: "concurrent-a", status: "done" },
    });
    expect(second).toMatchObject({
      text: "second",
      metadata: { runId: "concurrent-b", status: "done" },
    });
  });

  it("streams canonical text, tool, usage, and result events", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "codex",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return exactCompletionResponse(
          init,
          [
            ": connected\r\n\r\n",
            'data: {"choices":[{"delta":{"content":"hel","tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}\r\n\r\n',
            'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call-1","function":{"arguments":"\\"README.md\\"}"}}]},"finish_reason":"stop"}],"usage":{"model_requests":2,"prompt_tokens":2,"completion_tokens":3,"total_tokens":5,"cost":0.01}}\r\n\r\n',
            "data: [DONE]\r\n\r\n",
          ].join(""),
        );
      },
    });
    const environment = await provider.create({
      profile: { name: "worker", prompt: { systemPrompt: "system" } },
      backend: "codex",
      workspace: { cwd: "/workspace" },
    });

    const events = [];
    for await (const event of environment.stream({ prompt: "go", sessionId: "s1" })) events.push(event);

    expect(body).toMatchObject({
      model: "codex",
      session_id: "s1",
      cwd: "/workspace",
    });
    expect(events.map((event) => event.type)).toEqual([
      "message.part.updated",
      "message.part.updated",
      "usage",
      "message.part.updated",
      "result",
    ]);
    expect(events[0]).toMatchObject({
      data: {
        delta: "hel",
        part: { type: "text", text: "hel", sessionID: "s1" },
      },
      normalized: {
        type: "message.part.updated",
        delta: "hel",
        part: { type: "text", text: "hel", sessionID: "s1" },
      },
    });
    expect(events[1]).toMatchObject({
      data: {
        part: {
          type: "tool",
          callID: "call-1",
          tool: "read_file",
          state: { status: "pending", input: {} },
        },
      },
    });
    expect(events[2]).toEqual({
      type: "usage",
      data: { modelRequests: 2 },
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        cost: 0.01,
      },
    });
    expect(events[3]).toMatchObject({
      data: { delta: "lo", part: { type: "text", text: "hello" } },
    });
    expect(events.at(-1)).toEqual({
      type: "result",
      data: {
        finalText: "hello",
        finishReason: "stop",
        status: "completed",
        modelRequests: 2,
      },
    });
    expect(events.filter((event) => event.data.part && (event.data.part as { type?: string }).type === "tool")).toHaveLength(1);
  });

  it("keeps text after tool activity as a separate transcript paragraph", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode/model",
      fetch: async (_url, init) =>
        exactCompletionResponse(
          init,
          [
            'data: {"choices":[{"delta":{"content":"I will inspect it."},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{"content":"## Result"},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
        ),
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    const events = [];
    for await (const event of environment.stream({ prompt: "inspect", sessionId: "s1" })) {
      events.push(event);
    }

    expect(
      events
        .filter((event) => event.normalized?.type === "message.part.updated")
        .map((event) => event.data.delta)
        .filter((delta) => typeof delta === "string"),
    ).toEqual(["I will inspect it.", "\n\n## Result"]);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      data: { finalText: "I will inspect it.\n\n## Result" },
    });
  });

  it("preserves the served model and system fingerprint", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "codex",
      fetch: async (_url, init) =>
        exactCompletionResponse(
          init,
          [
            'data: {"model":"codex@fp-1","system_fingerprint":"fp-1","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
        ),
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const events = [];
    for await (const event of environment.stream({ prompt: "go" })) events.push(event);

    expect(events.at(-1)).toMatchObject({
      type: "result",
      data: {
        model: "codex@fp-1",
        system_fingerprint: "fp-1",
      },
    });
  });

  it("throws after surfacing a bridge error", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode",
      fetch: async (_url, init) =>
        exactCompletionResponse(
          init,
          [
            'data: {"error":{"message":"harness failed","type":"provider_error"}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
        ),
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const iterator = environment.stream({ prompt: "go" })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: "status",
        data: { status: "failed", error: "harness failed" },
        normalized: { type: "status", status: "failed", detail: "harness failed" },
      },
    });
    await expect(iterator.next()).rejects.toThrow("cli-bridge: harness failed");
  });

  it("maps a live caller cancellation to one cancelled terminal event during initial streaming", async () => {
    const fixture = await startLiveCancellationFixture({ initialStream: true });
    let environment: AgentEnvironment | undefined;
    try {
      const provider = createCliBridgeProvider({
        baseUrl: fixture.baseUrl,
        defaultModel: "opencode",
      });
      environment = await provider.create({ profile: { name: "worker" } });
      const events = [];
      for await (const event of environment.stream({
        prompt: "work",
        sessionId: "initial-cancel",
        executionId: "initial-cancel",
      })) events.push(event);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: "1:0",
        type: "status",
        data: {
          status: "cancelled",
          error: "run cancelled by caller",
          cursor: "1:0",
          runId: "initial-cancel",
          sessionId: "initial-cancel",
          executionId: "initial-cancel",
        },
        normalized: {
          type: "status",
          status: "cancelled",
          detail: "run cancelled by caller",
        },
      });
      expect(CanonicalStreamEventSchema.parse(events[0]?.normalized)).toEqual({
        type: "status",
        status: "cancelled",
        detail: "run cancelled by caller",
      });
      expect(events.some((event) => event.data.status === "failed")).toBe(false);
      await expect(environment.session?.("initial-cancel").status()).resolves.toBe("cancelled");
    } finally {
      await environment?.destroy?.();
      await fixture.close();
    }
  });

  it("lets authoritative cancellation replace an initial completed frame", async () => {
    const fixture = await startLiveCancellationFixture({
      initialStream: true,
      terminalOrder: "completed-then-cancelled",
    });
    let environment: AgentEnvironment | undefined;
    try {
      const provider = createCliBridgeProvider({
        baseUrl: fixture.baseUrl,
        defaultModel: "opencode",
      });
      environment = await provider.create({ profile: { name: "worker" } });
      const events = [];
      for await (const event of environment.stream({
        prompt: "work",
        sessionId: "completed-before-cancel",
        executionId: "completed-before-cancel",
      })) events.push(event);

      const terminalEvents = events.filter(
        (event) => event.type === "result" || event.type === "status",
      );
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]).toMatchObject({
        type: "status",
        data: { status: "cancelled", error: "run cancelled by caller" },
      });
      expect(events.some((event) => event.type === "result")).toBe(false);
    } finally {
      await environment?.destroy?.();
      await fixture.close();
    }
  });

  it("uses retained cancellation when the initial stream only sends protocol end", async () => {
    let statusReads = 0;
    let aggregateReads = 0;
    const runId = "protocol-end-cancel";
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode",
      fetch: async (url, init) => {
        if (init?.method === "GET") {
          statusReads += 1;
          expect(String(url)).toBe(
            `http://bridge.local/v1/runs/${runId}?wait_ms=30000`,
          );
          return runResponse(runId, "cancelled", true);
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.stream === false) aggregateReads += 1;
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            ...exactRunHeaders(body),
          },
        });
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const events = [];

    for await (const event of environment.stream({
      prompt: "work",
      sessionId: runId,
      executionId: runId,
    })) events.push(event);

    expect(statusReads).toBe(1);
    expect(aggregateReads).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "status",
      data: {
        status: "cancelled",
        runId,
        sessionId: runId,
        executionId: runId,
      },
      normalized: { type: "status", status: "cancelled" },
    });
  });

  it("does not reconstruct a second result after a cancelled terminal replay", async () => {
    const fixture = await startLiveCancellationFixture({ initialStream: true });
    let environment: AgentEnvironment | undefined;
    try {
      const provider = createCliBridgeProvider({
        baseUrl: fixture.baseUrl,
        defaultModel: "opencode",
      });
      environment = await provider.create({ profile: { name: "worker" } });
      const events = [];
      for await (const event of environment.stream({
        prompt: "work",
        sessionId: "request-replay-cancel",
        executionId: "request-replay-cancel",
        lastEventId: "1",
      })) events.push(event);

      expect(events).toEqual([]);
    } finally {
      await environment?.destroy?.();
      await fixture.close();
    }
  });

  it("does not let a stale completed result flip a replayed cancellation", async () => {
    let resultRequests = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.stream === false) {
          resultRequests += 1;
          return Response.json({
            id: "replay-cancel",
            choices: [
              {
                message: { role: "assistant", content: "done" },
                finish_reason: "stop",
              },
            ],
          });
        }
        return new Response(
          [
            'id: 1\ndata: {"error":{"message":"run cancelled by caller","type":"run_cancelled"}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              ...exactRunHeaders(body),
            },
          },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const events = [];

    for await (const event of environment.stream({
      prompt: "work",
      sessionId: "replay-cancel",
      executionId: "replay-cancel",
      lastEventId: "0",
    })) events.push(event);

    // A cancelled terminal is authoritative, so the withheld result is never
    // requested and a stale completion cannot add or replace a terminal event.
    expect(resultRequests).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["status"]);
    expect(events[0]).toMatchObject({
      type: "status",
      data: {
        status: "cancelled",
        error: "run cancelled by caller",
        runId: "replay-cancel",
        sessionId: "replay-cancel",
        executionId: "replay-cancel",
      },
      normalized: {
        type: "status",
        status: "cancelled",
        detail: "run cancelled by caller",
      },
    });
    expect(events.some((event) => event.type === "result")).toBe(false);
  });

  it("lets authoritative cancellation replace a raced completion after a cursor", async () => {
    let requests = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode",
      fetch: async (url, init) => {
        requests += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.stream === false) {
          expect(String(url)).toBe("http://bridge.local/v1/chat/completions");
          expect(body.run_id).toBe("raced-cancel");
          return Response.json({
            error: {
              message: "run cancelled by caller",
              type: "run_cancelled",
            },
          }, {
            status: 409,
            headers: exactRunHeaders(body),
          });
        }
        expect(String(url)).toBe("http://bridge.local/v1/chat/completions");
        expect(body.run_id).toBe("raced-cancel");
        expect(new Headers(init?.headers).get("last-event-id")).toBe("0");
        return new Response(
          [
            'id: 1\ndata: {"choices":[{"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              ...exactRunHeaders(body),
            },
          },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const events = [];

    for await (const event of environment.stream({
      prompt: "work",
      sessionId: "raced-cancel",
      executionId: "raced-cancel",
      lastEventId: "0",
    })) events.push(event);

    expect(requests).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      "message.part.updated",
      "status",
    ]);
    expect(events[1]).toMatchObject({
      id: "1:1",
      type: "status",
      data: {
        status: "cancelled",
        error: "run cancelled by caller",
        cursor: "1:1",
        runId: "raced-cancel",
        sessionId: "raced-cancel",
        executionId: "raced-cancel",
      },
      normalized: {
        type: "status",
        status: "cancelled",
        detail: "run cancelled by caller",
      },
    });
    expect(events.some((event) => event.type === "result")).toBe(false);
  });

  it.each([
    {
      name: "missing run identity",
      headers: new Headers({
        "x-run-request-digest": testDigest("aggregate-identity"),
      }),
      error: "cli-bridge response omitted X-Run-Id",
    },
    {
      name: "another run id",
      headers: new Headers({
        "x-run-id": "another-run",
        "x-run-request-digest": testDigest("aggregate-identity"),
      }),
      error:
        'cli-bridge accepted run "another-run" for requested run "aggregate-identity"',
    },
    {
      name: "another request digest",
      headers: new Headers({
        "x-run-id": "aggregate-identity",
        "x-run-request-digest": testDigest("another-request"),
      }),
      error: "cli-bridge changed request digest",
    },
  ])("rejects a cancelled aggregate response with $name", async ({ headers, error }) => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.stream === false) {
          return Response.json({
            error: {
              message: "run cancelled by caller",
              type: "run_cancelled",
            },
          }, { status: 409, headers });
        }
        return new Response(
          'id: 1\ndata: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              ...exactRunHeaders(body),
            },
          },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(consumeEvents(environment.stream({
      prompt: "work",
      executionId: "aggregate-identity",
    }))).rejects.toThrow(error);
  });

  it("consumes rejected aggregate bodies before reusing the Undici connection", async () => {
    let connectionCount = 0;
    let aggregateRequests = 0;
    let statusRequests = 0;
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://bridge.local");
        if (request.method === "GET") {
          statusRequests += 1;
          const runId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
          sendJson(response, {
            ...requiredTestRunCoordinates(runId),
            id: runId,
            requestDigest: testDigest(runId),
            status: "cancelled",
            terminal: true,
          });
          return;
        }
        const body = await readJsonRequest(request);
        const runId = String(body.run_id);
        if (body.stream === false) {
          aggregateRequests += 1;
          sendJson(response, {
            error: {
              message: "run cancelled by caller",
              type: "run_cancelled",
            },
            padding: "x".repeat(256 * 1024),
          }, 409, {
            "x-run-request-digest": testDigest(runId),
          });
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          ...exactRunHeaders(body),
        });
        response.end(
          'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : undefined);
      });
    });
    server.on("connection", (socket) => {
      connectionCount += 1;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind TCP");
    }

    let environment: AgentEnvironment | undefined;
    try {
      const provider = createCliBridgeProvider({
        baseUrl: `http://127.0.0.1:${address.port}`,
        defaultModel: "opencode",
      });
      environment = await provider.create({ profile: { name: "worker" } });
      let connectionsAfterFirstMismatch = 0;
      for (let turn = 0; turn < 3; turn += 1) {
        await expect(consumeEvents(environment.stream({
          prompt: "work",
          executionId: `identity-mismatch-${turn}`,
        }))).rejects.toThrow("cli-bridge response omitted X-Run-Id");
        if (turn === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          connectionsAfterFirstMismatch = connectionCount;
        }
      }
      expect(aggregateRequests).toBe(3);
      expect(statusRequests).toBe(3);
      expect(connectionsAfterFirstMismatch).toBeGreaterThan(0);
      expect(connectionsAfterFirstMismatch).toBeLessThanOrEqual(2);
      expect(connectionCount).toBe(connectionsAfterFirstMismatch);
    } finally {
      await environment?.destroy?.();
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
  });

  it("does not replay a terminal event already consumed at a composite cursor", async () => {
    let aggregateCalls = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.stream === false) aggregateCalls += 1;
        return exactCompletionResponse(
          init,
          'id: 1\ndata: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const events = [];

    for await (const event of environment.stream({
      prompt: "work",
      executionId: "composite-terminal",
      lastEventId: "1:1",
    })) events.push(event);

    expect(events).toEqual([]);
    expect(aggregateCalls).toBe(1);
  });

  it("replays a live caller cancellation as one terminal event and reports a cancelled result", async () => {
    const fixture = await startLiveCancellationFixture({ initialStream: false });
    let environment: AgentEnvironment | undefined;
    try {
      const provider = createCliBridgeProvider({
        baseUrl: fixture.baseUrl,
        defaultModel: "opencode",
      });
      environment = await provider.create({ profile: { name: "worker" } });
      const reference = await environment.dispatch?.({
        prompt: "work",
        sessionId: "retained-cancel",
        turnId: "retained-cancel-turn",
        executionId: "retained-cancel",
      });
      const session = environment.session?.(reference!.id, {
        controlRef: reference!.controlRef,
      });
      const replayed = [];
      for await (const event of session!.events({ since: "0" })) replayed.push(event);

      expect(replayed).toHaveLength(1);
      expect(replayed[0]).toMatchObject({
        id: "1:0",
        type: "status",
        data: {
          status: "cancelled",
          error: "run cancelled by caller",
          cursor: "1:0",
        },
        normalized: {
          type: "status",
          status: "cancelled",
          detail: "run cancelled by caller",
        },
      });
      const canonicalEvents = replayed.flatMap((event) => {
        const parsed = CanonicalStreamEventSchema.safeParse(event.normalized);
        return parsed.success ? [parsed.data] : [];
      });
      expect(canonicalEvents).toEqual([
        {
          type: "status",
          status: "cancelled",
          detail: "run cancelled by caller",
        },
      ]);
      await expect(session?.status()).resolves.toBe("cancelled");

      const result = await session!.result();
      expect(result).toMatchObject({
        text: "",
        success: false,
        error: "cli-bridge run ended cancelled",
        metadata: {
          runId: "retained-cancel",
          executionId: "retained-cancel",
          status: "cancelled",
        },
      });
      expect(result.events?.map((event) => event.type)).toEqual(["status"]);
      expect(result.events?.[0]?.data.status).toBe("cancelled");
    } finally {
      await environment?.destroy?.();
      await fixture.close();
    }
  });

  it("lets retained cancellation replace a reconnect completion frame", async () => {
    const controlRef: AgentExactRunControlRef = {
      runId: "reconnect-cancel",
      provider: "cli-bridge",
      environmentId: cliBridgeEnvironmentId(
        { backend: "opencode", model: "opencode" },
        testDigest("reconnect-environment-create"),
        "reconnect-environment",
      ),
      sessionId: "reconnect-session",
      executionId: "reconnect-cancel",
      requestDigest: testDigest("reconnect-cancel"),
    };
    let statusReads = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode",
      fetch: async (url, init) => {
        if (new URL(String(url)).pathname === "/v1/capabilities") {
          return Response.json(defaultCliBridgeCapabilities("opencode"));
        }
        expect(init?.method).toBe("GET");
        if (String(url).endsWith("/events")) {
          return new Response(
            'id: 1\ndata: {"choices":[{"delta":{"content":"stale completion"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
                "x-run-id": controlRef.runId,
                "x-run-request-digest": controlRef.requestDigest,
                "x-run-provider": controlRef.provider,
                "x-run-environment-id": controlRef.environmentId,
                "x-run-session-id": controlRef.sessionId,
                "x-run-execution-id": controlRef.executionId,
              },
            },
          );
        }
        statusReads += 1;
        return runResponse(controlRef.runId, "cancelled", true);
      },
    });
    testRunCoordinates.set(controlRef.runId, {
      provider: controlRef.provider,
      environmentId: controlRef.environmentId,
      sessionId: controlRef.sessionId,
      executionId: controlRef.executionId,
    });
    const environment = await provider.get!(controlRef.environmentId);
    const events = [];

    for await (const event of environment!.session!(controlRef.sessionId, {
      controlRef,
    }).events({ since: "0" })) events.push(event);

    expect(statusReads).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      "message.part.updated",
      "status",
    ]);
    expect(events[1]).toMatchObject({
      id: "1:1",
      data: {
        status: "cancelled",
        runId: controlRef.runId,
        sessionId: controlRef.sessionId,
        executionId: controlRef.executionId,
      },
      normalized: { type: "status", status: "cancelled" },
    });
    expect(events.some((event) => event.type === "result")).toBe(false);
  });

  it("replays an exact cancellation acknowledgement without duplicating the cancellation request", async () => {
    const fixture = await startLiveCancellationFixture({ initialStream: false });
    let environment: AgentEnvironment | undefined;
    try {
      const provider = createCliBridgeProvider({
        baseUrl: fixture.baseUrl,
        defaultModel: "opencode",
      });
      environment = await provider.create({ profile: { name: "worker" } });
      const reference = await environment.dispatch?.({
        prompt: "work",
        sessionId: "exact-cancel",
        turnId: "exact-cancel-turn",
        executionId: "exact-cancel",
      });
      const session = environment.session?.(reference!.id);
      const controlRef = reference?.controlRef as AgentExactRunControlRef;
      const material = {
        operationId: "exact-cancel-operation",
        run: controlRef,
        reason: "caller stopped the run",
      };
      const request = {
        ...material,
        requestDigest: agentRunCancellationRequestDigest(material),
      };

      const first = await session?.cancelRun?.(request);
      const replayed = await session?.cancelRun?.(request);

      expect(first).toMatchObject({
        operationId: "exact-cancel-operation",
        status: "accepted",
        effect: "cancelled",
        run: controlRef,
      });
      expect(replayed).toMatchObject({
        operationId: "exact-cancel-operation",
        status: "replayed",
        effect: "cancelled",
        run: controlRef,
      });
      expect(fixture.exactCancelCalls).toBe(2);
      await expect(session?.status()).resolves.toBe("cancelled");
    } finally {
      await environment?.destroy?.();
      await fixture.close();
    }
  });

  it("rejects a stream that ends without a terminal result", async () => {
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode",
      fetch: async (_url, init) =>
        exactCompletionResponse(
          init,
          'data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]\n\n',
        ),
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    const consume = async () => {
      for await (const _event of environment.stream({ prompt: "go" })) {
        // Drain the stream to its terminal condition.
      }
    };
    await expect(consume()).rejects.toThrow("cli-bridge stream ended without a terminal result");
  });

  it("uses the timeout-free default transport for delayed bridge responses", async () => {
    let connectionCount = 0;
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((request, response) => {
      void (async () => {
        const body = await readJsonRequest(request);
        const runId = String(body.run_id);
        const headers = exactRunHeaders(body);
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        if (body.stream === false) {
          sendJson(response, {
            choices: [{
              message: { role: "assistant", content: "done" },
              finish_reason: "stop",
            }],
          }, 200, headers);
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          ...headers,
        });
        response.end(
          'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        );
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : undefined);
      });
    });
    server.on("connection", (socket) => {
      connectionCount += 1;
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    let environment: AgentEnvironment | undefined;
    try {
      const provider = createCliBridgeProvider({
        baseUrl: `http://127.0.0.1:${address.port}`,
        defaultModel: "opencode",
      });
      environment = await provider.create({ profile: { name: "worker" } });
      for (let turn = 0; turn < 2; turn += 1) {
        const events = [];
        for await (const event of environment.stream({ prompt: "go" })) events.push(event);
        expect(events.at(-1)).toMatchObject({
          type: "result",
          data: { finalText: "done", status: "completed" },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(connectionCount).toBeGreaterThan(0);
      expect(connectionCount).toBeLessThanOrEqual(2);
      const completedConnectionCount = connectionCount;

      const lazy = environment.stream({ prompt: "too late" });
      await environment.destroy?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(sockets.size).toBe(0);
      await expect(environment.status()).resolves.toBe("stopped");
      await expect(consumeEvents(lazy)).rejects.toThrow(
        "cli-bridge environment is destroyed",
      );
      expect(connectionCount).toBe(completedConnectionCount);
      await expect(environment.destroy?.()).resolves.toBeUndefined();
    } finally {
      await environment?.destroy?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("enforces a configured response-header timeout", async () => {
    let delayedResponse: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((request, response) => {
      const runId = decodeURIComponent(
        request.url?.split("/")[3]?.split("?")[0] ?? "",
      );
      if (request.url?.endsWith("/cancel")) {
        void readJsonRequest(request).then((body) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(cancellationAcknowledgement(body, "cancelled")));
        });
        return;
      }
      if (request.url?.startsWith("/v1/runs/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ...requiredTestRunCoordinates(runId),
          id: runId,
          requestDigest: testDigest(runId),
          status: "running",
          terminal: false,
        }));
        return;
      }
      void readJsonRequest(request).then((body) => {
        const headers = exactRunHeaders(body);
        delayedResponse = setTimeout(() => {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            ...headers,
          });
          response.end(
            'data: {"choices":[{"delta":{"content":"late"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          );
        }, 5_000);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    const provider = createCliBridgeProvider({
      baseUrl: `http://127.0.0.1:${address.port}`,
      defaultModel: "opencode",
      headersTimeoutMs: 10,
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    try {
      await expect(consume(environment)).rejects.toMatchObject({
        cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
      });
    } finally {
      if (delayedResponse) clearTimeout(delayedResponse);
      await environment.destroy?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("enforces a configured response-body idle timeout", async () => {
    let delayedBody: ReturnType<typeof setTimeout> | undefined;
    const server = createServer((request, response) => {
      const runId = decodeURIComponent(
        request.url?.split("/")[3]?.split("?")[0] ?? "",
      );
      if (request.url?.endsWith("/cancel")) {
        void readJsonRequest(request).then((body) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(cancellationAcknowledgement(body, "cancelled")));
        });
        return;
      }
      if (request.url?.startsWith("/v1/runs/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ...requiredTestRunCoordinates(runId),
          id: runId,
          requestDigest: testDigest(runId),
          status: "running",
          terminal: false,
        }));
        return;
      }
      void readJsonRequest(request).then((body) => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          ...exactRunHeaders(body),
        });
        response.write(
          'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
        );
        delayedBody = setTimeout(() => {
          response.end(
            'data: {"choices":[{"delta":{"content":"late"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          );
        }, 5_000);
      }).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : undefined);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    const provider = createCliBridgeProvider({
      baseUrl: `http://127.0.0.1:${address.port}`,
      defaultModel: "opencode",
      bodyTimeoutMs: 10,
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    try {
      await expect(consume(environment)).rejects.toMatchObject({
        cause: { code: "UND_ERR_BODY_TIMEOUT" },
      });
    } finally {
      if (delayedBody) clearTimeout(delayedBody);
      await environment.destroy?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each(
    (["headersTimeoutMs", "bodyTimeoutMs", "cancelWaitMs"] as const).flatMap((name) =>
      [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY].map((value) => ({ name, value })),
    ),
  )("rejects invalid $name=$value before execution", ({ name, value }) => {
    expect(() =>
      createCliBridgeProvider({
        baseUrl: "http://bridge.local",
        [name]: value,
      }),
    ).toThrow(`${name} must be a non-negative integer`);
  });

  it("continues one bridge-owned retained Pi session with profile-selected harness, provider, and model", async () => {
    const fixture = createNativePiFixture({
      textForRun: (runId) => runId === "run-1" ? "answer-1" : "answer-2",
    });
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "pi/tangle-router/glm-5.2",
      fetch: fixture.fetch,
    });
    const environment = await provider.create({
      idempotencyKey: "profile-selected-environment",
      profile: {
        name: "scientist",
        harness: "pi",
        model: { provider: "tangle-router", default: "glm-5.2" },
      },
    });

    await consumeTurn(environment, {
      prompt: "first",
      sessionId: "session-1",
      model: "glm-5.2",
      turnId: "turn-1",
      executionId: "run-1",
    });
    await consumeTurn(environment, {
      prompt: "second",
      sessionId: "session-1",
      model: "tangle-router/glm-5.2",
      turnId: "turn-2",
      executionId: "run-2",
    });
    expect(fixture.sessionBodies).toHaveLength(1);
    expect(fixture.turnBodies).toHaveLength(2);
    expect(fixture.sessionBodies).toEqual([
      expect.objectContaining({
        id: "session-1",
        model: "pi/tangle-router/glm-5.2",
        agent_profile: {
          name: "scientist",
          harness: "pi",
          model: { provider: "tangle-router", default: "glm-5.2" },
        },
      }),
    ]);
    expect(fixture.turnBodies).toEqual([
      expect.objectContaining({
        message: "first",
        turn_id: "turn-1",
        execution_id: "run-1",
        run_id: "run-1",
        provider: "cli-bridge",
        environment_id: environment.id,
      }),
      expect.objectContaining({
        message: "second",
        turn_id: "turn-2",
        execution_id: "run-2",
        run_id: "run-2",
        provider: "cli-bridge",
        environment_id: environment.id,
      }),
    ]);
    expect(fixture.requests.some((request) => request.url.endsWith("/v1/chat/completions"))).toBe(false);
    expect(await provider.capabilities()).toMatchObject({ streaming: { replay: true } });
  });

  it("waits through a 202 cancellation when a caller stops reading", async () => {
    let status: "running" | "cancelled" = "running";
    let getCalls = 0;
    const requested: string[] = [];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode/model",
      fetch: async (url, init) => {
        requested.push(String(url));
        if (init?.method === "GET") {
          getCalls += 1;
          if (getCalls === 1) {
            return runResponse("run-reader-stop", "running", false);
          }
          status = "cancelled";
          return runResponse("run-reader-stop", status, true);
        }
        if (String(url).endsWith("/cancel")) {
          return cancelResponse(init, "cancel_requested", 202);
        }
        return new Response(
          [
            'id: 1\ndata: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
            'id: 2\ndata: {"choices":[{"delta":{"content":"unused"},"finish_reason":"stop"}]}\n\n',
          ].join(""),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              ...exactRunHeaders(
                JSON.parse(String(init?.body)) as Record<string, unknown>,
              ),
            },
          },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const iterator = environment.stream({
      prompt: "work",
      sessionId: "reader-stop",
      executionId: "run-reader-stop",
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "message.part.updated", id: "1:0" },
    });
    await iterator.return?.();

    expect(requested).toContain("http://bridge.local/v1/runs/run-reader-stop/cancel");
    expect(requested.some((target) =>
      /^http:\/\/bridge\.local\/v1\/runs\/run-reader-stop\?wait_ms=\d+$/u.test(target)
    )).toBe(true);
    expect(getCalls).toBe(2);
  });

  it("keeps an environment retryable when cancellation is not confirmed", async () => {
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let cancelCalls = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "runner/model",
      fetch: async (url, init) => {
        if (String(url).endsWith("/cancel")) {
          cancelCalls += 1;
          if (cancelCalls === 1) {
            return new Response('{"error":{"message":"temporary failure"}}', {
              status: 503,
            });
          }
          return cancelResponse(init, "cancelled");
        }
        if (init?.method === "GET") {
          return runResponse("retryable-run", "running", false);
        }
        exactRunHeaders(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        startedResolve();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const running = consumeTurn(environment, {
      prompt: "long work",
      executionId: "retryable-run",
    });
    await started;

    await expect(environment.destroy?.()).rejects.toThrow("cli-bridge cancel 503");
    await expect(environment.status()).resolves.toBe("running");
    await environment.destroy?.();
    await expect(running).rejects.toThrow("cli-bridge run ended cancelled");
    expect(cancelCalls).toBe(2);
  });

  it("cancels an active sessionless run before destroying its transport", async () => {
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const requested: string[] = [];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode/model",
      fetch: async (url, init) => {
        requested.push(String(url));
        if (String(url).endsWith("/cancel")) {
          return cancelResponse(init, "cancelled");
        }
        if (init?.method === "GET") {
          return runResponse("run-no-session", "running", false);
        }
        exactRunHeaders(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        startedResolve();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const running = consumeTurn(environment, {
      prompt: "long work",
      executionId: "run-no-session",
    });
    await started;

    await environment.destroy?.();
    await expect(running).rejects.toThrow("cli-bridge run ended cancelled");
    expect(requested).toContain("http://bridge.local/v1/runs/run-no-session/cancel");
  });

  it("isolates derived run ids across environments and keeps them wire-safe", async () => {
    const runIds: string[] = [];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode/model",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.stream !== false) runIds.push(String(body.run_id));
        return terminalResponse(init, "ok");
      },
    });
    const first = await provider.create({ profile: { name: "same-name" } });
    const second = await provider.create({ profile: { name: "same-name" } });

    await consumeTurn(first, { prompt: "same", turnId: "turn-1" });
    await consumeTurn(second, { prompt: "same", turnId: "turn-1" });

    expect(runIds).toHaveLength(2);
    expect(runIds[0]).not.toBe(runIds[1]);
    for (const runId of runIds) {
      expect(runId.length).toBeLessThanOrEqual(128);
      expect(runId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
    }
  });

  it("hashes an unsafe execution id deterministically", async () => {
    const runIds: string[] = [];
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode/model",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.stream !== false) runIds.push(String(body.run_id));
        return terminalResponse(init, "ok");
      },
    });
    const environment = await provider.create({
      profile: { name: "worker" },
      idempotencyKey: "environment-1",
    });
    const unsafe = `${"not/wire safe ".repeat(20)}!`;

    await consumeTurn(environment, { prompt: "same", executionId: unsafe });
    await consumeTurn(environment, { prompt: "same", executionId: unsafe });

    expect(runIds[0]).toBe(runIds[1]);
    expect(runIds[0]).toMatch(/^agent-[a-f0-9]{64}$/u);
  });

  it("reattaches after a reader failure using the server event cursor", async () => {
    let chatCalls = 0;
    let aggregateCalls = 0;
    let status: "running" | "done" = "running";
    let replayCursor: string | null = null;
    const encoder = new TextEncoder();
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "opencode/model",
      fetch: async (_url, init) => {
        if (init?.method === "GET") return runResponse("run-replay", status, status === "done");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const headers = exactRunHeaders(body);
        if (body.stream === false) {
          aggregateCalls += 1;
          return Response.json({
            choices: [{
              message: { role: "assistant", content: "partial complete" },
              finish_reason: "stop",
            }],
          }, { headers });
        }
        chatCalls += 1;
        if (chatCalls === 1) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    'id: 1\ndata: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
                  ),
                );
                controller.error(new Error("reader disconnected"));
              },
            }),
            {
              status: 200,
              headers: { ...headers, "content-type": "text/event-stream" },
            },
          );
        }
        replayCursor = new Headers(init?.headers).get("last-event-id");
        status = "done";
        return new Response(
          'id: 2\ndata: {"choices":[{"delta":{"content":" complete"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          {
            status: 200,
            headers: { ...headers, "content-type": "text/event-stream" },
          },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(
      consumeTurn(environment, {
        prompt: "work",
        sessionId: "replay",
        executionId: "run-replay",
      }),
    ).rejects.toThrow("reader disconnected");
    const replayed = [];
    for await (const event of environment.stream({
      prompt: "work",
      sessionId: "replay",
      executionId: "run-replay",
      lastEventId: "1",
    })) replayed.push(event);

    expect(replayCursor).toBe("1");
    expect(replayed.map((event) => event.id)).toEqual(["2:0", "2:1"]);
    expect(replayed.at(-1)).toMatchObject({
      type: "result",
      id: "2:1",
      data: { finalText: "partial complete" },
    });
    expect(aggregateCalls).toBe(1);
  });

  it("reads the full result when replay starts after the terminal event", async () => {
    let aggregateCalls = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "runner/model",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const headers = exactRunHeaders(body);
        if (body.stream === false) {
          aggregateCalls += 1;
          return Response.json({
            choices: [{
              message: { role: "assistant", content: "already complete" },
              finish_reason: "stop",
            }],
          }, { headers });
        }
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { ...headers, "content-type": "text/event-stream" },
        });
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const events = [];

    for await (const event of environment.stream({
      prompt: "work",
      executionId: "terminal-replay",
      lastEventId: "3",
    })) events.push(event);

    expect(events).toEqual([]);
    expect(aggregateCalls).toBe(1);
  });

  it("does not claim or cancel a run id rejected by the bridge", async () => {
    let cancelCalls = 0;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      defaultModel: "runner/model",
      fetch: async (url, init) => {
        if (String(url).endsWith("/cancel")) {
          cancelCalls += 1;
          return cancelResponse(init, "cancelled");
        }
        if (init?.method === "GET") {
          return runResponse("shared-run", "running", false);
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("response body failed"));
            },
          }),
          { status: 409 },
        );
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(consumeTurn(environment, {
      prompt: "conflicting work",
      executionId: "shared-run",
    })).rejects.toThrow("cli-bridge 409");
    await environment.destroy?.();

    expect(cancelCalls).toBe(0);
  });

  it("refuses execution when no run data selects a model or harness", async () => {
    let called = false;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async () => {
        called = true;
        return new Response();
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(consume(environment)).rejects.toThrow(
      "requires an explicit bridge model or a profile/backend harness",
    );
    expect(called).toBe(false);
  });

  it("uses a provider-qualified turn model instead of the profile provider", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return terminalResponse(init, "ok");
      },
    });
    const environment = await provider.create({
      backend: "runner",
      profile: {
        name: "worker",
        model: { provider: "preferred", default: "base" },
      },
    });

    await consumeTurn(environment, {
      prompt: "work",
      model: "override/model",
    });

    expect(body?.model).toBe("runner/override/model");
  });

  it("sends both prompt intents through agent_profile and synthesizes no system message", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = createCliBridgeProvider({
      baseUrl: "http://bridge.local",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return terminalResponse(init, "ok");
      },
    });
    const environment = await provider.create({
      backend: "claude-code",
      profile: {
        name: "worker",
        prompt: {
          systemPrompt: "REPLACEMENT_ONLY",
          appendSystemPrompt: "ADDITION_ONLY",
          instructions: ["PROJECT_INSTRUCTION"],
        },
      },
    });

    await consumeTurn(environment, { prompt: "go" });

    // Both intents travel intact on agent_profile, where the bridge binds each to the control its
    // harness owns (claude-code: --system-prompt / --append-system-prompt) or refuses it.
    expect(
      (body?.agent_profile as { prompt?: Record<string, unknown> } | undefined)?.prompt,
    ).toEqual({
      systemPrompt: "REPLACEMENT_ONLY",
      appendSystemPrompt: "ADDITION_ONLY",
      instructions: ["PROJECT_INSTRUCTION"],
    });
    // The turn carries the user turn and nothing else. A synthesized `role: "system"` message would
    // (a) lower the REPLACEMENT intent as an ADDITION, and (b) make the bridge reject the whole
    // request, which refuses system-role messages beside agent_profile.
    expect(body?.messages).toEqual([{ role: "user", content: "go" }]);
    const roles = (body?.messages as Array<{ role: string }>).map((message) => message.role);
    expect(roles).not.toContain("system");
    expect(JSON.stringify(body?.messages)).not.toContain("REPLACEMENT_ONLY");
    expect(JSON.stringify(body?.messages)).not.toContain("ADDITION_ONLY");
  });

  it("declares the prompt intents of the named bridge harness, and neither without one", () => {
    // The adapter forwards agent_profile; the intents belong to the harness the bridge runs. Being
    // able to put the field on the wire is not honoring it, so an unnamed harness declares neither.
    expect(defaultCliBridgeCapabilities("claude-code").profile.systemPrompt).toEqual({
      replace: true,
      append: true,
    });
    expect(defaultCliBridgeCapabilities("opencode").profile.systemPrompt).toEqual({
      replace: false,
      append: true,
    });
    expect(defaultCliBridgeCapabilities("codex").profile.systemPrompt).toEqual({
      replace: true,
      append: false,
    });
    expect(defaultCliBridgeCapabilities("acp").profile.systemPrompt).toEqual({
      replace: false,
      append: false,
    });
    expect(defaultCliBridgeCapabilities().profile.systemPrompt).toEqual({
      replace: false,
      append: false,
    });
  });

  it.each(
    harnessTypeSchema.options.map((harness) => ({
      harness,
      native: harness === "pi",
      interactions: harness === "pi",
    })),
  )("projects $harness capabilities without overclaiming native controls", ({ harness, native, interactions }) => {
    const capabilities = defaultCliBridgeCapabilities(harness);

    expect(capabilities.sessions).toEqual({ continue: true, list: false, messages: false });
    expect(capabilities.retainedControl).toEqual({
      exactRunIdentity: true,
      resultIdentity: true,
      eventIdentity: true,
      cancellationIdempotency: true,
    });
    expect(capabilities.nativeContinuation).toEqual(
      native ? { atomicBoundary: true, requestIdempotency: true } : undefined,
    );
    expect(capabilities.interactions).toEqual(
      interactions
        ? {
            kinds: ["permission"],
            answerFieldTypes: ["select"],
            responseScopes: ["interaction"],
            secretAnswers: false,
            concurrentRequests: false,
            replay: true,
            responseIdempotency: true,
          }
        : undefined,
    );
  });
});

async function consume(environment: AgentEnvironment): Promise<void> {
  for await (const _event of environment.stream({ prompt: "go" })) {
    // Drain the stream to its terminal condition.
  }
}

async function consumeTurn(
  environment: AgentEnvironment,
  turn: Parameters<AgentEnvironment["stream"]>[0],
): Promise<void> {
  await consumeEvents(environment.stream(turn));
}

async function consumeEvents(
  events: AsyncIterable<unknown>,
): Promise<void> {
  for await (const _event of events) {
    // Drain the stream to its terminal condition.
  }
}

interface NativePiFixtureRequest {
  readonly url: string;
  readonly method: string;
  readonly body?: Record<string, unknown>;
  readonly since?: string;
}

interface NativePiFixtureOptions {
  readonly includeInteractionForRun?: (runId: string) => boolean;
  readonly textForRun?: (runId: string) => string;
  readonly usageForRun?: (runId: string) => Record<string, unknown>;
}

interface NativePiFixture {
  readonly requests: NativePiFixtureRequest[];
  readonly sessionBodies: Record<string, unknown>[];
  readonly turnBodies: Record<string, unknown>[];
  readonly fetch: typeof fetch;
}

interface NativePiSession {
  readonly model: string;
  readonly createRequestDigest: string;
}

interface NativePiRun {
  readonly provider: string;
  readonly environmentId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly requestDigest: string;
  readonly events: readonly Record<string, unknown>[];
  status: "running" | "done";
}

function createNativePiFixture(options: NativePiFixtureOptions = {}): NativePiFixture {
  const requests: NativePiFixtureRequest[] = [];
  const sessionBodies: Record<string, unknown>[] = [];
  const turnBodies: Record<string, unknown>[] = [];
  const sessions = new Map<string, NativePiSession>();
  const runs = new Map<string, NativePiRun>();
  const textForRun = options.textForRun ?? ((runId) => `complete-${runId}`);
  const usageForRun = options.usageForRun ?? (() => ({
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    cost: 0.01,
  }));
  const fetcher: typeof fetch = async (url, init) => {
    const target = String(url);
    const parsedUrl = new URL(target);
    const pathname = parsedUrl.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body === undefined
      ? undefined
      : JSON.parse(String(init.body)) as Record<string, unknown>;
    const since = new Headers(init?.headers).get("last-event-id");
    requests.push({
      url: target,
      method,
      ...(body ? { body } : {}),
      ...(since === null ? {} : { since }),
    });

    if (method === "GET" && pathname === "/v1/capabilities") {
      return Response.json(defaultCliBridgeCapabilities("pi"));
    }

    if (method === "POST" && pathname === "/v1/sessions") {
      if (!body) throw new Error("native Pi session request body is missing");
      const sessionId = String(body.id);
      const model = String(body.model);
      const session = {
        model,
        createRequestDigest: canonicalCandidateDigest(body),
      };
      sessions.set(sessionId, session);
      sessionBodies.push(body);
      return Response.json({
        id: sessionId,
        model,
        create_request_digest: session.createRequestDigest,
      }, { status: 201 });
    }

    const segments = pathname.split("/").filter((segment) => segment.length > 0);
    if (
      method === "POST" &&
      segments[0] === "v1" &&
      segments[1] === "sessions" &&
      segments[3] === "turns"
    ) {
      if (!body) throw new Error("native Pi turn request body is missing");
      const sessionId = decodeURIComponent(segments[2] ?? "");
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`native Pi session ${sessionId} was not created`);
      const runId = String(body.run_id);
      const executionId = String(body.execution_id);
      const requestDigest = testDigest(runId);
      turnBodies.push(body);
      runs.set(runId, {
        provider: String(body.provider),
        environmentId: String(body.environment_id),
        sessionId,
        executionId,
        requestDigest,
        status: "running",
        events: nativePiEvents({
          runId,
          sessionId,
          executionId,
          provider: String(body.provider),
          environmentId: String(body.environment_id),
          text: textForRun(runId),
          usage: usageForRun(runId),
          includeInteraction: options.includeInteractionForRun?.(runId) ?? false,
        }),
      });
      return Response.json({
        session: {
          id: sessionId,
          model: session.model,
          create_request_digest: session.createRequestDigest,
        },
        run: {
          id: runId,
          provider: String(body.provider),
          environmentId: String(body.environment_id),
          executionId,
          sessionId,
          requestDigest,
          status: "running",
          terminal: false,
        },
        context_boundary: null,
      }, { status: 202 });
    }

    if (
      method === "GET" &&
      segments[0] === "v1" &&
      segments[1] === "runs" &&
      segments[3] === "events"
    ) {
      const runId = decodeURIComponent(segments[2] ?? "");
      const run = runs.get(runId);
      if (!run) throw new Error(`native Pi run ${runId} was not admitted`);
      run.status = "done";
      const cursor = Number(since ?? "0");
      const replay = run.events.filter((event) => Number(event.sequence) > cursor);
      return new Response(nativePiSse(replay), {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-run-id": runId,
          "x-run-request-digest": run.requestDigest,
          "x-run-provider": run.provider,
          "x-run-environment-id": run.environmentId,
          "x-run-session-id": run.sessionId,
          "x-run-execution-id": run.executionId,
        },
      });
    }

    if (
      method === "GET" &&
      segments[0] === "v1" &&
      segments[1] === "runs" &&
      segments.length === 3
    ) {
      const runId = decodeURIComponent(segments[2] ?? "");
      const run = runs.get(runId);
      if (!run) throw new Error(`native Pi run ${runId} was not admitted`);
      return Response.json({
        id: runId,
        provider: run.provider,
        environmentId: run.environmentId,
        executionId: run.executionId,
        sessionId: run.sessionId,
        requestDigest: run.requestDigest,
        status: run.status,
        terminal: run.status === "done",
      });
    }

    throw new Error(`unexpected native Pi fixture route: ${target}`);
  };
  return { requests, sessionBodies, turnBodies, fetch: fetcher };
}

function nativePiEvents(args: {
  readonly runId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly provider: string;
  readonly environmentId: string;
  readonly text: string;
  readonly usage: Record<string, unknown>;
  readonly includeInteraction: boolean;
}): readonly Record<string, unknown>[] {
  let sequence = 1;
  const events = [
    nativePiEnvelope(args.runId, sequence++, { type: "status", status: "started" }),
    nativePiEnvelope(args.runId, sequence++, {
      type: "raw",
      backend: "pi",
      event: { type: "usage", usage: args.usage },
    }),
  ];
  if (args.includeInteraction) {
    const material = {
      id: `${args.runId}-interaction`,
      kind: "permission",
      title: "Allow the command?",
      answerSpec: permissionAnswerSpec({ allowFeedback: false }),
      responseScopes: ["interaction" as const],
      binding: {
        runId: args.runId,
        provider: args.provider,
        environmentId: args.environmentId,
        sessionId: args.sessionId,
        executionId: args.executionId,
        interactionId: `${args.runId}-interaction`,
      },
    };
    events.push(nativePiEnvelope(args.runId, sequence++, {
      type: "interaction",
      request: {
        ...material,
        requestDigest: interactionRequestDigest(material),
      },
    }));
  }
  events.push(
    nativePiEnvelope(args.runId, sequence++, {
      type: "message.part.updated",
      part: {
        id: `${args.runId}-part`,
        sessionID: args.sessionId,
        messageID: `${args.runId}-message`,
        type: "text",
        text: args.text,
      },
      delta: args.text,
    }),
    nativePiEnvelope(args.runId, sequence, { type: "status", status: "completed" }),
  );
  return events;
}

function nativePiEnvelope(
  runId: string,
  sequence: number,
  event: Record<string, unknown>,
): Record<string, unknown> {
  return RuntimeEventEnvelopeSchema.parse({
    runId,
    eventId: `${runId}-event-${sequence}`,
    sequence,
    cursor: String(sequence),
    occurredAt: "2026-08-15T16:00:00.000Z",
    receivedAt: "2026-08-15T16:00:00.010Z",
    event,
  }) as Record<string, unknown>;
}

function nativePiSse(events: readonly Record<string, unknown>[]): string {
  return events
    .map((event) => {
      const type = String((event.event as Record<string, unknown>).type);
      return `id: ${String(event.sequence)}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

function terminalResponse(init: RequestInit | undefined, text: string): Response {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  const runId = String(body.run_id);
  const headers = exactRunHeaders(body);
  if (body.stream === false) {
    return Response.json({
      choices: [{
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      }],
    }, { headers });
  }
  return new Response(
    `data: {"choices":[{"delta":{"content":"${text}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { ...headers, "content-type": "text/event-stream" } },
  );
}

function exactCompletionResponse(
  init: RequestInit | undefined,
  sse: string,
): Response {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
  const headers = exactRunHeaders(body);
  if (body.stream !== false) {
    return new Response(sse, {
      status: 200,
      headers: { ...headers, "content-type": "text/event-stream" },
    });
  }
  let text = "";
  let finishReason = "stop";
  let usage: unknown;
  let model: unknown;
  let systemFingerprint: unknown;
  for (const line of sse.split(/\r?\n/u)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const chunk = JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
    const choice = Array.isArray(chunk.choices)
      ? chunk.choices[0] as Record<string, unknown> | undefined
      : undefined;
    const delta = choice?.delta && typeof choice.delta === "object"
      ? choice.delta as Record<string, unknown>
      : undefined;
    if (typeof delta?.content === "string") text += delta.content;
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    if (chunk.usage !== undefined) usage = chunk.usage;
    if (chunk.model !== undefined) model = chunk.model;
    if (chunk.system_fingerprint !== undefined) systemFingerprint = chunk.system_fingerprint;
  }
  return Response.json({
    choices: [{ message: { role: "assistant", content: text }, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
    ...(model === undefined ? {} : { model }),
    ...(systemFingerprint === undefined ? {} : { system_fingerprint: systemFingerprint }),
  }, { headers });
}

function runResponse(
  id: string,
  status: "running" | "done" | "error" | "cancelled",
  terminal: boolean,
): Response {
  return new Response(JSON.stringify({
    ...testRunCoordinates.get(id),
    id,
    requestDigest: testDigest(id),
    status,
    terminal,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function cancelResponse(
  init: RequestInit | undefined,
  effect: "cancel_requested" | "cancelled" | "not_live",
  responseStatus = 200,
): Response {
  const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
  return Response.json(cancellationAcknowledgement(request, effect), {
    status: responseStatus,
  });
}

function cancellationAcknowledgement(
  request: Record<string, unknown>,
  effect: "cancel_requested" | "cancelled" | "not_live",
): Record<string, unknown> {
  return {
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    run: request.run,
    status: "accepted",
    effect,
  };
}

interface TestRunCoordinates {
  readonly provider: string;
  readonly environmentId: string;
  readonly sessionId: string;
  readonly executionId: string;
}

const testRunCoordinates = new Map<string, TestRunCoordinates>();

function requiredTestRunCoordinates(runId: string): TestRunCoordinates {
  const coordinates = testRunCoordinates.get(runId);
  if (coordinates === undefined) {
    throw new Error(`test fixture has no coordinates for run ${runId}`);
  }
  return coordinates;
}

function runHeaders(runId: string): Record<string, string> {
  const coordinates = requiredTestRunCoordinates(runId);
  return {
    "x-run-id": runId,
    "x-run-request-digest": testDigest(runId),
    "x-run-provider": coordinates.provider,
    "x-run-environment-id": coordinates.environmentId,
    "x-run-session-id": coordinates.sessionId,
    "x-run-execution-id": coordinates.executionId,
  };
}

function exactRunHeaders(body: Record<string, unknown>): Record<string, string> {
  const runId = String(body.run_id);
  const coordinates = {
    provider: String(body.provider),
    environmentId: String(body.environment_id),
    sessionId: String(body.session_id),
    executionId: String(body.execution_id),
  };
  testRunCoordinates.set(runId, coordinates);
  return {
    "x-run-id": runId,
    "x-run-request-digest": testDigest(runId),
    "x-run-provider": coordinates.provider,
    "x-run-environment-id": coordinates.environmentId,
    "x-run-session-id": coordinates.sessionId,
    "x-run-execution-id": coordinates.executionId,
  };
}

interface LiveCancellationFixture {
  readonly baseUrl: string;
  readonly exactCancelCalls: number;
  close(): Promise<void>;
}

async function startLiveCancellationFixture(args: {
  initialStream: boolean;
  terminalOrder?: "cancelled" | "completed-then-cancelled";
}): Promise<LiveCancellationFixture> {
  const statuses = new Map<string, "running" | "cancelled">();
  const cancellationOperations = new Set<string>();
  let exactCancelCalls = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://bridge.local");
      const segments = url.pathname
        .split("/")
        .filter((segment) => segment.length > 0)
        .map((segment) => decodeURIComponent(segment));
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await readJsonRequest(request);
        const runId = String(body.run_id);
        const headers = exactRunHeaders(body);
        statuses.set(runId, args.initialStream ? "cancelled" : "running");
        if (body.stream === false) {
          sendJson(response, {
            error: {
              message: "run cancelled by caller",
              type: "run_cancelled",
            },
          }, 409, headers);
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          ...headers,
        });
        response.end(
          args.initialStream && request.headers["last-event-id"] !== "1"
            ? liveCancellationSse(args.terminalOrder)
            : ": connected\n\ndata: [DONE]\n\n",
        );
        return;
      }
      const runId = segments[2];
      if (!runId || segments[0] !== "v1" || segments[1] !== "runs") {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.method === "POST" && segments[3] === "cancel") {
        const body = await readJsonRequest(request);
        statuses.set(runId, "cancelled");
        if (
          typeof body.operationId === "string" &&
          typeof body.requestDigest === "string" &&
          body.run &&
          typeof body.run === "object"
        ) {
          exactCancelCalls += 1;
          const replayed = cancellationOperations.has(body.operationId);
          cancellationOperations.add(body.operationId);
          sendJson(response, {
            operationId: body.operationId,
            requestDigest: body.requestDigest,
            run: body.run,
            status: replayed ? "replayed" : "accepted",
            effect: "cancelled",
          });
          return;
        }
        sendJson(response, {
          cancelled: true,
          cancel_requested: true,
          terminal: true,
          run: {
            ...requiredTestRunCoordinates(runId),
            id: runId,
            requestDigest: testDigest(runId),
            status: "cancelled",
            terminal: true,
          },
        });
        return;
      }
      if (request.method === "GET" && segments[3] === "events") {
        statuses.set(runId, "cancelled");
        response.writeHead(200, {
          "content-type": "text/event-stream",
          ...runHeaders(runId),
        });
        response.end(liveCancellationSse());
        return;
      }
      if (request.method === "GET" && segments.length === 3) {
        const status = statuses.get(runId) ?? "running";
        sendJson(response, {
          ...requiredTestRunCoordinates(runId),
          id: runId,
          requestDigest: testDigest(runId),
          status,
          terminal: status === "cancelled",
        });
        return;
      }
      response.writeHead(404);
      response.end();
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(response, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "fixture_error",
        },
      }, 500);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("live cancellation fixture did not bind TCP");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get exactCancelCalls() {
      return exactCancelCalls;
    },
    close: () => closeServer(server),
  };
}

async function readJsonRequest(
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) {
    raw += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  const parsed: unknown = raw.length === 0 ? {} : JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("fixture request body is not an object");
  }
  return parsed as Record<string, unknown>;
}

function liveCancellationSse(
  terminalOrder: "cancelled" | "completed-then-cancelled" = "cancelled",
): string {
  return [
    ...(terminalOrder === "completed-then-cancelled"
      ? ['id: 1\ndata: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n']
      : []),
    `id: ${terminalOrder === "completed-then-cancelled" ? "2" : "1"}\ndata: {"error":{"message":"run cancelled by caller","type":"run_cancelled"}}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

function sendJson(
  response: import("node:http").ServerResponse,
  value: Record<string, unknown>,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

async function closeServer(server: import("node:http").Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function testDigest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
