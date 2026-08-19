import {
  CanonicalStreamEventSchema,
  RuntimeEventEnvelopeSchema,
  canonicalCandidateDigest,
  interactionRequestDigest,
  permissionAnswerSpec,
  type AgentExactRunControlRef,
} from "@tangle-network/agent-interface";
import {
  agentEnvironmentCreateInputDigest,
  type AgentEnvironmentCapabilities,
  type AgentEnvironmentEvent,
  type CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import { describe, expect, it } from "vitest";
import {
  createCliBridgeProvider,
  defaultCliBridgeCapabilities,
} from "./index.js";
import { cliBridgeEnvironmentId } from "./environment-identity.js";

const baseUrl = "http://bridge.local";
const environmentId = "native-environment";
const sessionId = "native-session";
const model = "pi/model";
const retainedEnvironmentId = cliBridgeEnvironmentId(
  { backend: "pi", model },
  agentEnvironmentCreateInputDigest({
    idempotencyKey: environmentId,
    profile: { name: "native-pi", harness: "pi" },
  }),
  environmentId,
);
const nativeRunId = "native-execution";
const runDigest = canonicalCandidateDigest("native-turn");

function sessionView(createRequestDigest: string) {
  return {
    id: sessionId,
    object: "session",
    create_request_digest: createRequestDigest,
    backend: "pi",
    model,
    status: "running",
    run_id: null,
    internal_session_id: null,
    turns: 0,
    created_at: "2026-08-15T16:00:00.000Z",
    updated_at: "2026-08-15T16:00:00.000Z",
    capabilities: defaultCliBridgeCapabilities("pi"),
    profile_materialization_receipt: null,
    context_boundary: null,
  };
}

function sse(events: readonly Record<string, unknown>[]): string {
  return events
    .map((event) => {
      const sequence = String(event.sequence);
      const type = String((event.event as Record<string, unknown>).type);
      return `id: ${sequence}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
}

function nativeEnvelope(
  sequence: number,
  event: Record<string, unknown>,
): Record<string, unknown> {
  return {
    runId: nativeRunId,
    eventId: `native-event-${sequence}`,
    sequence,
    cursor: String(sequence),
    occurredAt: "2026-08-15T16:00:00.000Z",
    receivedAt: "2026-08-15T16:00:00.010Z",
    event,
  };
}

function interactionRequest() {
  const material = {
    id: "native-interaction",
    kind: "permission",
    title: "Allow the command?",
    answerSpec: permissionAnswerSpec({ allowFeedback: false }),
    responseScopes: ["interaction" as const],
    binding: {
      runId: nativeRunId,
      provider: "cli-bridge",
      environmentId: retainedEnvironmentId,
      sessionId,
      executionId: nativeRunId,
      interactionId: "native-interaction",
    },
  };
  return {
    ...material,
    requestDigest: interactionRequestDigest(material),
  };
}

function nativeRunResponse(status = "running", terminal = false): Response {
  return Response.json({
    id: nativeRunId,
    provider: "cli-bridge",
    environmentId: retainedEnvironmentId,
    executionId: nativeRunId,
    sessionId,
    requestDigest: runDigest,
    status,
    terminal,
  });
}

function createNativeFetch(
  requests: Array<{ url: string; method: string; body?: Record<string, unknown>; since?: string }>,
  events: readonly Record<string, unknown>[] = [],
): typeof fetch {
  let createRequestDigest: string | undefined;
  return async (url, init) => {
    const target = String(url);
    const pathname = new URL(target).pathname;
    const parsedBody = init?.body === undefined
      ? undefined
      : JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({
      url: target,
      method: init?.method ?? "GET",
      ...(parsedBody ? { body: parsedBody } : {}),
      ...(new Headers(init?.headers).get("last-event-id")
        ? { since: new Headers(init?.headers).get("last-event-id")! }
        : {}),
    });
    if (pathname === "/v1/capabilities") {
      return Response.json(defaultCliBridgeCapabilities("pi"));
    }
    if (pathname === "/v1/sessions") {
      const digest = canonicalCandidateDigest(parsedBody!);
      createRequestDigest = digest;
      return Response.json(sessionView(digest), { status: 201 });
    }
    if (pathname === `/v1/sessions/${sessionId}/turns`) {
      if (createRequestDigest === undefined) {
        throw new Error("turn arrived before native session creation");
      }
      const turnRunId = String(parsedBody?.run_id);
      const turnExecutionId = String(parsedBody?.execution_id);
      return Response.json({
        session: sessionView(createRequestDigest),
        run: {
          id: turnRunId,
          provider: String(parsedBody?.provider),
          environmentId: String(parsedBody?.environment_id),
          executionId: turnExecutionId,
          sessionId,
          requestDigest: runDigest,
          status: "running",
          terminal: false,
        },
        context_boundary: null,
      }, { status: 202 });
    }
    if (pathname === `/v1/runs/${nativeRunId}/events`) {
      const since = Number(new Headers(init?.headers).get("last-event-id") ?? "0");
      const body = sse(events.filter((event) => Number(event.sequence) > since));
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-run-id": nativeRunId,
          "x-run-request-digest": runDigest,
          "x-run-provider": "cli-bridge",
          "x-run-environment-id": retainedEnvironmentId,
          "x-run-session-id": sessionId,
          "x-run-execution-id": nativeRunId,
        },
      });
    }
    if (pathname === `/v1/runs/${nativeRunId}`) {
      return nativeRunResponse("done", true);
    }
    throw new Error(`unexpected cli-bridge route: ${target}`);
  };
}

function reportedPiCapabilities(): AgentEnvironmentCapabilities {
  const { observation: _observation, ...reported } = defaultCliBridgeCapabilities("pi");
  return {
    ...reported,
    interactions: {
      ...reported.interactions!,
      kinds: ["permission", "question"],
      answerFieldTypes: ["select", "text"],
      responseScopes: ["interaction", "session"],
    },
    profile: {
      ...reported.profile,
      resources: {
        ...reported.profile.resources,
        files: false,
        tools: false,
      },
      validation: true,
      extensions: ["pi"],
    },
    sessions: { continue: true, list: true, messages: true },
    nativeContinuation: { atomicBoundary: true, requestIdempotency: true },
    workspace: {
      read: true,
      write: true,
      exec: true,
      git: true,
      upload: false,
      download: false,
    },
  };
}

describe("cli-bridge native retained sessions", () => {
  it("recovers Pi capabilities and native replay from the configured route", async () => {
    const events = [
      nativeEnvelope(1, { type: "status", status: "completed" }),
    ].map((event) => RuntimeEventEnvelopeSchema.parse(event));
    const requests: Array<{ url: string; method: string; since?: string }> = [];
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      fetch: createNativeFetch(requests, events),
    });

    expect((await provider.capabilities()).interactions?.responseIdempotency).toBe(true);
    const created = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "native-pi", harness: "pi" },
    });
    const environment = await provider.get!(created.id);
    expect(environment?.capabilities?.interactions?.responseIdempotency).toBe(true);
    const session = environment!.session!(sessionId, {
      controlRef: {
        runId: nativeRunId,
        provider: "cli-bridge",
        environmentId: created.id,
        sessionId,
        executionId: nativeRunId,
        requestDigest: runDigest,
      },
    });
    const replayed: AgentEnvironmentEvent[] = [];
    for await (const event of session.events({ since: "0" })) replayed.push(event);

    expect(replayed.map((event) => event.id)).toEqual(["1"]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/capabilities",
      "/v1/capabilities",
      "/v1/capabilities",
      `/v1/runs/${nativeRunId}/events`,
      `/v1/runs/${nativeRunId}`,
    ]);
  });

  it("discovers the exact model route once across provider and environment intake", async () => {
    const exactModel = "pi/tangle-router/glm-5.2@latest";
    const requests: string[] = [];
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: exactModel,
      fetch: async (url) => {
        requests.push(String(url));
        await Promise.resolve();
        return Response.json(defaultCliBridgeCapabilities("pi"));
      },
    });

    const [capabilities, environment] = await Promise.all([
      provider.capabilities(),
      provider.create({
        idempotencyKey: "shared-discovery-environment",
        profile: { name: "native-pi", harness: "pi" },
      }),
    ]);

    expect(capabilities.interactions?.kinds).toEqual(["permission"]);
    expect(capabilities.interactions?.answerFieldTypes).toEqual(["select"]);
    expect(capabilities.interactions?.responseScopes).toEqual(["interaction"]);
    expect(environment.capabilities?.interactions?.kinds).toEqual(["permission"]);
    expect(requests).toEqual([
      `${baseUrl}/v1/capabilities?model=${encodeURIComponent(exactModel)}`,
    ]);
    expect(new URL(requests[0]!).searchParams.get("model")).toBe(exactModel);
  });

  it("rejects a native turn model outside the environment route before network use", async () => {
    let called = false;
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async () => {
        called = true;
        return new Response();
      },
    });
    const environment = await provider.create({
      idempotencyKey: "model-bound-environment",
      profile: { name: "native-pi", harness: "pi" },
    });

    await expect(environment.dispatch!({
      prompt: "do not change routes",
      model: "pi/another-model",
      sessionId,
      turnId: "model-bound-turn",
      executionId: "model-bound-run",
    })).rejects.toThrow("create another environment");
    expect(called).toBe(false);
  });

  it("rejects a native session prompt outside the environment model before network use", async () => {
    let called = false;
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async () => {
        called = true;
        return new Response();
      },
    });
    const environment = await provider.create({
      idempotencyKey: "session-model-bound-environment",
      profile: { name: "native-pi", harness: "pi" },
    });
    const session = environment.session!(sessionId);

    await expect(session.prompt({
      prompt: "keep the retained route",
      model: "pi/another-model",
      turnId: "session-model-bound-turn",
      executionId: "session-model-bound-run",
    })).rejects.toThrow("create another environment");
    expect(called).toBe(false);
  });

  it.each([
    { field: "provider", value: undefined },
    { field: "provider", value: "other-provider" },
    { field: "environmentId", value: undefined },
    { field: "environmentId", value: "other-environment" },
  ] as const)("rejects native admission with $field=$value", async ({ field, value }) => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const delegate = createNativeFetch(requests);
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async (url, init) => {
        const response = await delegate(url, init);
        if (!new URL(String(url)).pathname.endsWith("/turns")) return response;
        const body = await response.json() as {
          session: Record<string, unknown>;
          run: Record<string, unknown>;
        };
        if (value === undefined) delete body.run[field];
        else body.run[field] = value;
        return Response.json(body, { status: response.status });
      },
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "native-pi", harness: "pi" },
    });

    await expect(environment.dispatch!({
      prompt: "keep exact identity",
      sessionId,
      turnId: "forged-native-turn",
      executionId: nativeRunId,
    })).rejects.toThrow("mismatched run coordinates");
  });

  it("intersects Bridge truth with methods implemented by this provider", async () => {
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      fetch: async () => Response.json(reportedPiCapabilities()),
    });

    const capabilities = await provider.capabilities();
    expect(capabilities.profile.resources).toMatchObject({
      files: false,
      tools: false,
    });
    expect(capabilities.profile.validation).toBe(false);
    expect(capabilities.profile.extensions).toBeUndefined();
    expect(capabilities.sessions).toEqual({ continue: true, list: false, messages: false });
    expect(capabilities.nativeContinuation).toEqual({
      atomicBoundary: true,
      requestIdempotency: true,
    });
    expect(capabilities.workspace).toEqual({
      read: false,
      write: false,
      exec: false,
      git: false,
      upload: false,
      download: false,
    });
    expect(capabilities.interactions?.kinds).toEqual(["permission"]);
    expect(capabilities.observation?.modelUsage).toBe(true);

    const environment = await provider.create({
      idempotencyKey: "narrowed-capability-environment",
      profile: { name: "native-pi", harness: "pi" },
    });
    expect(environment.capabilities).toEqual(capabilities);
    expect(environment.read).toBeUndefined();
    expect(environment.write).toBeUndefined();
    expect(environment.exec).toBeUndefined();
  });

  it("fails closed when Bridge capability discovery is unavailable", async () => {
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      fetch: async () => new Response("backend unavailable", { status: 503 }),
    });

    await expect(provider.capabilities()).rejects.toThrow(
      /capability discovery returned HTTP 503: backend unavailable/,
    );
    await expect(provider.create({
      idempotencyKey: "unavailable-discovery-environment",
      profile: { name: "native-pi", harness: "pi" },
    })).rejects.toThrow(/capability discovery returned HTTP 503/);
  });

  it("rejects invalid capability documents and retries discovery", async () => {
    let requests = 0;
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      fetch: async () => {
        requests += 1;
        if (requests === 1) return Response.json({ interactions: {} });
        return Response.json(defaultCliBridgeCapabilities("pi"));
      },
    });

    await expect(provider.capabilities()).rejects.toThrow(
      /invalid capability document/,
    );
    await expect(provider.capabilities()).resolves.toMatchObject({
      interactions: { kinds: ["permission"] },
    });
    expect(requests).toBe(2);
  });

  it("does not expose native interactions unless Bridge proves the complete contract", async () => {
    const requests: string[] = [];
    const { interactions: _interactions, ...incomplete } = defaultCliBridgeCapabilities("pi");
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      fetch: async (url) => {
        requests.push(String(url));
        return Response.json(incomplete);
      },
    });
    const environment = await provider.create({
      idempotencyKey: "incomplete-contract-environment",
      profile: { name: "native-pi", harness: "pi" },
    });

    expect(environment.capabilities?.interactions).toBeUndefined();
    expect(environment.respondToInteraction).toBeUndefined();
    await expect(environment.dispatch!({
      prompt: "do not route this as a native interaction",
      sessionId,
      turnId: "incomplete-contract-turn",
      executionId: "incomplete-contract-execution",
      interactions: { permission: true },
    })).rejects.toThrow(/does not advertise requested interaction kind/);
    expect(requests).toEqual([`${baseUrl}/v1/capabilities?model=${encodeURIComponent(model)}`]);
  });

  it("uses the select-only permission answer contract", () => {
    const request = interactionRequest();

    expect(defaultCliBridgeCapabilities("pi").interactions?.answerFieldTypes).toEqual(["select"]);
    expect(request.answerSpec.fields).toHaveLength(1);
    expect(request.answerSpec.fields[0]).toMatchObject({
      type: "select",
      name: "grant",
    });
    expect(request.answerSpec.fields.every((field) => field.type === "select")).toBe(true);
  });

  it.each([
    { ids: { executionId: nativeRunId }, missing: "turnId" },
    { ids: { turnId: "stable-turn" }, missing: "executionId" },
  ] as const)("rejects a native turn without stable $missing", async ({ ids }) => {
    let calls = 0;
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async () => {
        calls += 1;
        throw new Error("native request should not start");
      },
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "native-pi", harness: "pi" },
    });

    await expect(environment.dispatch!({
      prompt: "must be retry safe",
      sessionId,
      ...ids,
    })).rejects.toThrow(`stable turnId and executionId`);
    expect(calls).toBe(0);
  });

  it("retains a profile-selected Pi route and rejects caller-owned ids", async () => {
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: "codex/model",
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async (_url, init) => new Response("data: [DONE]\n\n", {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-run-id": "codex-run",
          "x-run-request-digest": canonicalCandidateDigest("codex-run"),
        },
      }),
    });
    expect((await provider.capabilities()).interactions).toBeUndefined();
    const pi = await provider.create({
      idempotencyKey: "pi-environment",
      profile: { name: "pi", harness: "pi" },
    });
    expect(pi.capabilities?.interactions?.responseIdempotency).toBe(true);
    expect(pi.respondToInteraction).toBeTypeOf("function");
    const reconnectedPi = await provider.get!(pi.id);
    expect(reconnectedPi?.capabilities?.interactions?.responseIdempotency).toBe(true);
    expect(reconnectedPi?.respondToInteraction).toBeTypeOf("function");
    await expect(provider.get!("pi-environment")).rejects.toThrow(
      "not a provider-owned retained identity",
    );
    const codex = await provider.create({
      idempotencyKey: "codex-environment",
      profile: { name: "codex", harness: "codex" },
    });
    expect(codex.capabilities?.interactions).toBeUndefined();
    expect(codex.respondToInteraction).toBeUndefined();
  });

  it("uses native session turns and forwards exact interaction posture, including empty maps", async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: createNativeFetch(requests),
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "native-pi", harness: "pi" },
    });

    const first = await environment.dispatch!({
      prompt: "start safely",
      sessionId,
      turnId: "turn-1",
      executionId: "native-execution",
      detach: true,
      interactions: { permission: true },
    });
    await environment.dispatch!({
      prompt: "continue safely",
      sessionId,
      turnId: "turn-2",
      executionId: "native-execution-2",
      interactions: {},
    });
    await environment.dispatch!({
      prompt: "deny safely",
      sessionId,
      turnId: "turn-3",
      executionId: "native-execution-3",
      interactions: { permission: false },
    });
    await environment.dispatch!({
      prompt: "omit posture",
      sessionId,
      turnId: "turn-4",
      executionId: "native-execution-4",
    });

    expect(first.controlRef).toMatchObject({
      runId: nativeRunId,
      provider: "cli-bridge",
      environmentId: retainedEnvironmentId,
      sessionId,
      executionId: nativeRunId,
      requestDigest: runDigest,
    });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "POST /v1/sessions",
      "POST /v1/sessions/native-session/turns",
      "POST /v1/sessions/native-session/turns",
      "POST /v1/sessions/native-session/turns",
      "POST /v1/sessions/native-session/turns",
    ]);
    expect(requests.some((request) => request.url.endsWith("/v1/chat/completions"))).toBe(false);
    expect(requests[1]?.body).toMatchObject({
      message: "start safely",
      turn_id: "turn-1",
      execution_id: "native-execution",
      run_id: "native-execution",
      provider: "cli-bridge",
      environment_id: environment.id,
      interactions: { permission: true },
    });
    expect(requests[2]?.body).toMatchObject({
      message: "continue safely",
      turn_id: "turn-2",
      execution_id: "native-execution-2",
      run_id: "native-execution-2",
      interactions: {},
    });
    expect(requests[3]?.body).toMatchObject({ interactions: { permission: false } });
    expect(requests[4]?.body).not.toHaveProperty("interactions");
    expect(requests[1]?.body).not.toHaveProperty("metadata.interactions");
    expect(requests[1]?.body).not.toHaveProperty("detach");

    const detachedStream = async () => {
      for await (const _event of environment.stream({
        prompt: "do not open a detached stream",
        sessionId,
        turnId: "turn-stream-detach",
        executionId: "native-stream-detach",
        detach: true,
      })) {
        // A detached stream must fail before it emits an event.
      }
    };
    await expect(detachedStream()).rejects.toThrow(
      "cli-bridge provider does not support detached turns",
    );
  });

  it("cancels a native turn after a 2xx admission response loses its coordinates", async () => {
    const requests: string[] = [];
    let createRequestDigest: string | undefined;
    let statusReads = 0;
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async (url, init) => {
        const target = new URL(String(url));
        const method = init?.method ?? "GET";
        requests.push(`${method} ${target.pathname}${target.search}`);
        const body = init?.body === undefined
          ? undefined
          : JSON.parse(String(init.body)) as Record<string, unknown>;
        if (target.pathname === "/v1/sessions") {
          createRequestDigest = canonicalCandidateDigest(body);
          return Response.json(sessionView(createRequestDigest), { status: 201 });
        }
        if (target.pathname === `/v1/sessions/${sessionId}/turns`) {
          return Response.json({
            session: sessionView(createRequestDigest!),
            run: {
              id: "wrong-run-after-admission",
              provider: String(body?.provider),
              environmentId: String(body?.environment_id),
              executionId: "wrong-execution",
              sessionId,
              requestDigest: runDigest,
              status: "running",
              terminal: false,
            },
          }, { status: 202 });
        }
        if (target.pathname === `/v1/runs/${nativeRunId}/cancel`) {
          const request = body as {
            operationId: string;
            requestDigest: string;
            run: AgentExactRunControlRef;
          };
          return Response.json({
            operationId: request.operationId,
            requestDigest: request.requestDigest,
            run: request.run,
            status: "accepted",
            effect: "cancel_requested",
          });
        }
        if (target.pathname === `/v1/runs/${nativeRunId}`) {
          statusReads += 1;
          return nativeRunResponse(statusReads === 1 ? "running" : "cancelled", statusReads > 1);
        }
        throw new Error(`unexpected cli-bridge route: ${target}`);
      },
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "native-pi", harness: "pi" },
    });

    await expect(environment.dispatch!({
      prompt: "continue even if the response is dropped",
      sessionId,
      turnId: "dropped-response-turn",
      executionId: nativeRunId,
    })).rejects.toThrow("mismatched run coordinates");

    expect(requests).toEqual([
      "POST /v1/sessions",
      "POST /v1/sessions/native-session/turns",
      "GET /v1/runs/native-execution",
      "POST /v1/runs/native-execution/cancel",
      expect.stringMatching(/^GET \/v1\/runs\/native-execution\?wait_ms=\d+$/),
    ]);
    for (const request of requests.slice(4)) {
      const waitMs = Number(
        new URL(request.slice(4), baseUrl).searchParams.get("wait_ms"),
      );
      expect(waitMs).toBeGreaterThan(0);
      expect(waitMs).toBeLessThanOrEqual(30_000);
    }
    expect(statusReads).toBe(2);
  });

  it("forwards every retained Bridge control without collapsing it into metadata", async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      defaultExecution: { kind: "host" },
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: createNativeFetch(requests),
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "native-pi", harness: "pi" },
      workspace: { cwd: "" },
      env: { BRIDGE_TEST_MODE: "retained" },
      metadata: { source: "focused-test" },
      providerOptions: { route: "native" },
    });

    await environment.dispatch!({
      prompt: "inspect the attachment",
      parts: [{ type: "file", filename: "README.md", path: "README.md" }],
      sessionId,
      turnId: "wire-turn",
      executionId: "wire-execution",
      interactions: { permission: true },
      context: {},
      providerOptions: {},
    });

    expect(requests[0]?.body).toMatchObject({
      id: sessionId,
      model,
      interaction_policy: "interactive",
      cwd: "",
      execution: { kind: "host" },
      env: { BRIDGE_TEST_MODE: "retained" },
      metadata: { source: "focused-test" },
      provider_options: { route: "native" },
    });
    expect(requests[1]?.body).toEqual({
      message: "inspect the attachment",
      parts: [{ type: "file", filename: "README.md", path: "README.md" }],
      turn_id: "wire-turn",
      execution_id: "wire-execution",
      run_id: "wire-execution",
      provider: "cli-bridge",
      environment_id: environment.id,
      interactions: { permission: true },
      context: {},
      provider_options: {},
    });
    expect(requests[0]?.body).not.toHaveProperty("metadata.route");
    expect(requests[1]?.body).not.toHaveProperty("metadata.route");
  });

  it("rejects retained inputs that Bridge cannot represent before network use", async () => {
    const unsupported: Array<{
      label: string;
      input: Partial<CreateAgentEnvironmentInput>;
    }> = [
      { label: "workspace.repoUrl", input: { workspace: { repoUrl: "https://example.com/repo.git" } } },
      { label: "workspace.gitRef", input: { workspace: { gitRef: "main" } } },
      { label: "workspace.image", input: { workspace: { image: "node:22" } } },
      { label: "workspace.providerOptions", input: { workspace: { providerOptions: { size: "large" } } } },
      { label: "resources", input: { resources: { cpu: 2 } } },
      { label: "secrets", input: { secrets: ["router-key"] } },
    ];

    for (const [index, testCase] of unsupported.entries()) {
      const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
      const provider = createCliBridgeProvider({
        baseUrl,
        defaultModel: model,
        capabilities: defaultCliBridgeCapabilities("pi"),
        fetch: createNativeFetch(requests),
      });
      const environment = await provider.create({
        profile: { name: "native-pi", harness: "pi" },
        idempotencyKey: `${environmentId}-${index}`,
        ...testCase.input,
      });

      await expect(environment.dispatch!({
        prompt: "must fail before Bridge",
        sessionId,
        turnId: `unsupported-turn-${index}`,
        executionId: `unsupported-execution-${index}`,
      })).rejects.toThrow(new RegExp(testCase.label.replace(".", "\\."), "u"));
      expect(requests, testCase.label).toEqual([]);
    }
  });

  it("rejects a retained turn timeout before creating the retained session", async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: createNativeFetch(requests),
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "native-pi", harness: "pi" },
    });

    await expect(environment.dispatch!({
      prompt: "must fail before Bridge",
      sessionId,
      turnId: "unsupported-turn",
      executionId: "unsupported-execution",
      timeoutMs: 1_000,
    })).rejects.toThrow(/timeoutMs/);
    expect(requests).toEqual([]);
  });

  it("rejects sandbox execution before creating a retained session", async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      defaultExecution: {
        kind: "sandbox",
        repoUrl: "https://example.com/repo.git",
      },
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: createNativeFetch(requests),
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "native-pi", harness: "pi" },
    });

    await expect(environment.dispatch!({
      prompt: "must fail before Bridge",
      sessionId,
      turnId: "sandbox-turn",
      executionId: "sandbox-execution",
    })).rejects.toThrow(/cannot execute in a sandbox/);
    expect(requests).toEqual([]);
  });

  it("defines the companion cli-bridge request shape for retained interaction turns", async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: createNativeFetch(requests),
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "native-pi", harness: "pi" },
    });

    await environment.dispatch!({
      prompt: "contract test",
      sessionId,
      turnId: "contract-turn",
      executionId: "contract-execution",
      interactions: { permission: true },
    });

    const turnBody = requests[1]?.body;
    expect(turnBody).toEqual({
      message: "contract test",
      turn_id: "contract-turn",
      execution_id: "contract-execution",
      run_id: "contract-execution",
      provider: "cli-bridge",
      environment_id: environment.id,
      interactions: { permission: true },
    });
    expect(turnBody).not.toHaveProperty("metadata");
  });

  it("replays canonical events, usage, plans, cancellations, and unknown provider events", async () => {
    const request = interactionRequest();
    const part = {
      id: "native-part",
      sessionID: sessionId,
      messageID: "native-message",
      type: "text" as const,
      text: "finished",
    };
    const events = [
      nativeEnvelope(1, { type: "status", status: "started" }),
      nativeEnvelope(2, { type: "interaction", request }),
      nativeEnvelope(3, {
        type: "raw",
        backend: "pi",
        event: {
          type: "usage",
          data: {},
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cost: 0.01 },
        },
      }),
      nativeEnvelope(4, { type: "message.part.updated", part, delta: "finished" }),
      nativeEnvelope(5, {
        type: "plan.submitted",
        plan: {
          id: "plan-1",
          revision: 1,
          body: "inspect the result",
          submittedAt: "2026-08-15T16:00:00.000Z",
        },
      }),
      nativeEnvelope(6, {
        type: "interaction.cancel",
        id: request.id,
        reason: "turn completed",
      }),
      nativeEnvelope(7, {
        type: "raw",
        backend: "pi",
        event: { type: "future-provider-event", payload: { retained: true } },
      }),
      nativeEnvelope(8, { type: "status", status: "completed" }),
    ].map((event) => RuntimeEventEnvelopeSchema.parse(event));
    const requests: Array<{ url: string; method: string; since?: string }> = [];
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: createNativeFetch(requests, events),
    });
    const environment = await provider.create({
      idempotencyKey: environmentId,
      profile: { name: "native-pi", harness: "pi" },
    });
    const reference = await environment.dispatch!({
      prompt: "run the native turn",
      sessionId,
      turnId: "native-turn",
      executionId: "native-execution",
    });
    const session = environment.session!(reference.id);
    const replayed: AgentEnvironmentEvent[] = [];
    for await (const event of session.events({ since: "0" })) replayed.push(event);

    expect(replayed.map((event) => event.id)).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8",
    ]);
    for (const event of replayed) {
      expect(() => CanonicalStreamEventSchema.parse(event.normalized)).not.toThrow();
      expect(() => RuntimeEventEnvelopeSchema.parse(event.providerEvent)).not.toThrow();
    }
    expect(replayed[1]).toMatchObject({
      type: "interaction",
      normalized: {
        type: "interaction",
        request: {
          binding: {
            provider: "cli-bridge",
            environmentId: retainedEnvironmentId,
            sessionId,
            executionId: nativeRunId,
            interactionId: "native-interaction",
          },
          requestDigest: request.requestDigest,
        },
      },
    });
    expect(replayed[2]?.usage).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      cost: 0.01,
    });
    expect(replayed[4]?.normalized).toMatchObject({ type: "plan.submitted" });
    expect(replayed[5]?.normalized).toMatchObject({
      type: "interaction.cancel",
      id: "native-interaction",
    });
    expect(replayed[6]?.data).toMatchObject({
      backend: "pi",
      event: { type: "future-provider-event", payload: { retained: true } },
    });
    expect(requests.find((request) => request.url.endsWith("/events"))?.since).toBe("0");

    const afterThree: AgentEnvironmentEvent[] = [];
    for await (const event of session.events({ since: "3" })) afterThree.push(event);
    expect(afterThree.map((event) => event.id)).toEqual(["4", "5", "6", "7", "8"]);
    expect(requests.filter((request) => request.url.endsWith("/events")).at(-1)?.since).toBe("3");
  });

  it("rejects a native replay response without the accepted run identity", async () => {
    const requests: Array<{
      url: string;
      method: string;
      body?: Record<string, unknown>;
      since?: string;
    }> = [];
    const delegate = createNativeFetch(
      requests,
      [nativeEnvelope(1, { type: "status", status: "completed" })],
    );
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: model,
      capabilities: defaultCliBridgeCapabilities("pi"),
      fetch: async (url, init) => {
        const response = await delegate(url, init);
        if (!new URL(String(url)).pathname.endsWith("/events")) return response;
        return new Response(await response.text(), {
          status: response.status,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const environment = await provider.create({
      idempotencyKey: "missing-native-replay-identity",
      profile: { name: "native-pi", harness: "pi" },
    });
    const reference = await environment.dispatch!({
      prompt: "retain exact identity",
      sessionId,
      turnId: "missing-identity-turn",
      executionId: nativeRunId,
    });
    const session = environment.session!(sessionId, {
      controlRef: reference.controlRef,
    });

    await expect(async () => {
      for await (const _event of session.events({ since: "0" })) {
        // The response must fail before any event reaches the caller.
      }
    }).rejects.toThrow("response omitted X-Run-Id");
  });

  it.each(["x-run-provider", "x-run-environment-id"])(
    "rejects a native replay response without %s",
    async (omittedHeader) => {
      const requests: Array<{
        url: string;
        method: string;
        body?: Record<string, unknown>;
        since?: string;
      }> = [];
      const delegate = createNativeFetch(
        requests,
        [nativeEnvelope(1, { type: "status", status: "completed" })],
      );
      const provider = createCliBridgeProvider({
        baseUrl,
        defaultModel: model,
        capabilities: defaultCliBridgeCapabilities("pi"),
        fetch: async (url, init) => {
          const response = await delegate(url, init);
          if (!new URL(String(url)).pathname.endsWith("/events")) return response;
          const headers = new Headers(response.headers);
          headers.delete(omittedHeader);
          return new Response(await response.text(), {
            status: response.status,
            headers,
          });
        },
      });
      const environment = await provider.create({
        idempotencyKey: `partial-native-replay-${omittedHeader}`,
        profile: { name: "native-pi", harness: "pi" },
      });
      const reference = await environment.dispatch!({
        prompt: "retain exact identity",
        sessionId,
        turnId: `partial-${omittedHeader}`,
        executionId: nativeRunId,
      });
      const session = environment.session!(sessionId, {
        controlRef: reference.controlRef,
      });

      await expect(async () => {
        for await (const _event of session.events({ since: "0" })) {
          // The response must fail before any event reaches the caller.
        }
      }).rejects.toThrow("response omitted exact run coordinates");
    },
  );

  it.each([
    { permission: true },
    { permission: false },
    { question: false },
  ] as Readonly<Record<string, boolean>>[])("rejects unsupported interaction posture before the one-shot chat route: %j", async (interactions) => {
    const requests: string[] = [];
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: "codex/model",
      fetch: async (url, init) => {
        requests.push(`${init?.method ?? "GET"} ${String(url)}`);
        return new Response("data: [DONE]\n\n", {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "x-run-id": "unsupported-run",
            "x-run-request-digest": canonicalCandidateDigest("unsupported-run"),
          },
        });
      },
    });
    const environment = await provider.create({
      idempotencyKey: "unsupported-environment",
      profile: { name: "codex", harness: "codex" },
    });

    await expect(environment.dispatch!({
      prompt: "one shot",
      sessionId: "unsupported-session",
      executionId: "unsupported-run",
      turnId: "unsupported-turn",
      interactions,
    })).rejects.toThrow(/does not advertise requested interaction kind/);

    expect(requests).toHaveLength(0);
    expect(environment.respondToInteraction).toBeUndefined();
  });
});
