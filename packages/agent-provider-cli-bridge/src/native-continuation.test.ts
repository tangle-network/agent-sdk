import {
  AgentNativeContextContinuationResultSchema,
  agentRunCancellationRequestDigest,
  canonicalCandidateDigest,
  nativeContextContinuationRequestDigest,
  nativeContextContinuationTurnDigest,
  type AgentExactRunControlRef,
  type NativeContextBoundaryProof,
  type NativeContextContinuationRequest,
  type NativeContextContinuationTurn,
} from "@tangle-network/agent-interface";
import { describe, expect, it } from "vitest";
import {
  createCliBridgeProvider,
  defaultCliBridgeCapabilities,
} from "./index.js";

const baseUrl = "http://bridge.local";

describe("cli-bridge native continuation", () => {
  it("keeps generic retained control when the Bridge omits native continuation", async () => {
    const { nativeContinuation: _nativeContinuation, ...withoutNativeContinuation } =
      defaultCliBridgeCapabilities("pi");
    const provider = createCliBridgeProvider({
      baseUrl,
      defaultModel: "pi/test-model",
      capabilities: withoutNativeContinuation,
      fetch: async () => {
        throw new Error("capability-gated provider must not use the network");
      },
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi" },
    });

    const capabilities = environment.capabilities;
    if (!capabilities) throw new Error("the provider omitted capabilities");
    expect(capabilities.sessions.continue).toBe(true);
    expect(capabilities.retainedControl).toEqual({
      exactRunIdentity: true,
      resultIdentity: true,
      eventIdentity: true,
      cancellationIdempotency: true,
    });
    expect(capabilities.nativeContinuation).toBeUndefined();
    expect(environment.session!("session").contextBoundary).toBeUndefined();
    expect(environment.session!("session").continueNative).toBeUndefined();
  });

  it("reads the exact boundary, advances the live session, and controls the new run", async () => {
    const fixture = createNativeContinuationFixture();
    const provider = createProvider(fixture.fetch);
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi" },
    });
    const reference = await environment.dispatch!({
      prompt: "start the task",
      sessionId: "continuation-session",
      turnId: "initial-turn",
      executionId: "initial-run",
    });
    const initialControlRef = exactControlRef(reference.controlRef);
    const session = environment.session!(initialControlRef.sessionId, {
      controlRef: initialControlRef,
    });
    if (!session.contextBoundary || !session.continueNative) {
      throw new Error("the native continuation methods were not exposed");
    }

    const boundary = await session.contextBoundary();
    expect(boundary).toEqual(fixture.boundaryFor(initialControlRef));
    if (!boundary) throw new Error("the fixture did not return a context boundary");

    const turn: NativeContextContinuationTurn = { prompt: "continue the task" };
    const request = continuationRequest(initialControlRef, boundary, "continue-1", turn);
    const outcome = await session.continueNative(request, { turn });
    const continuedControlRef = fixture.continuedControlRef(initialControlRef);

    expect(outcome).toMatchObject({
      acknowledgement: {
        operationId: "continue-1",
        requestDigest: request.requestDigest,
        status: "accepted",
        historyMessagesSent: 0,
      },
      result: { text: "continued", success: true, sessionId: initialControlRef.sessionId },
      controlRef: continuedControlRef,
    });
    expect(session.controlRef).toEqual(continuedControlRef);
    expect(fixture.continuationBodies).toHaveLength(1);
    expect(fixture.continuationBodies[0]).toEqual({ request, turn });

    await expect(session.status()).resolves.toBe("completed");
    const events = [];
    for await (const event of session.events({ since: "0" })) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: "status",
      normalized: { type: "status", status: "completed" },
    });
    await expect(session.result()).resolves.toMatchObject({
      text: "continued",
      success: true,
      sessionId: initialControlRef.sessionId,
    });

    const cancellationMaterial = {
      operationId: "cancel-continued",
      run: continuedControlRef,
      reason: "test complete",
    };
    const cancellation = {
      ...cancellationMaterial,
      requestDigest: agentRunCancellationRequestDigest(cancellationMaterial),
    };
    await expect(session.cancelRun!(cancellation)).resolves.toMatchObject({
      operationId: cancellation.operationId,
      requestDigest: cancellation.requestDigest,
      run: continuedControlRef,
      status: "accepted",
      effect: "not_live",
    });

    expect(fixture.count("POST", "/v1/sessions/continuation-session/turns")).toBe(1);
    expect(fixture.count("POST", "/v1/sessions")).toBe(1);
    expect(fixture.count("POST", "/v1/chat/completions")).toBe(0);
    expect(fixture.count("POST", "/v1/sessions/continuation-session/continue")).toBe(1);
    expect(
      fixture.requests
        .filter((request) => request.method === "POST" && request.path.endsWith("/cancel"))
        .map((request) => request.path),
    ).toEqual(["/v1/runs/continued-run/cancel"]);
  });

  it("exposes the continued run before its terminal result", async () => {
    const fixture = createNativeContinuationFixture();
    let releaseTerminal!: () => void;
    const terminalBarrier = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    let admissionReturned = false;
    const provider = createProvider(async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body === undefined
        ? undefined
        : JSON.parse(String(init.body)) as {
            request?: NativeContextContinuationRequest;
          };
      if (
        admissionReturned &&
        parsed.pathname.endsWith("/continue") &&
        parsed.searchParams.get("return") === null &&
        body?.request?.operationId === "continue-admission"
      ) {
        await terminalBarrier;
      }
      const response = await fixture.fetch(url, init);
      if (parsed.searchParams.get("return") === "admission") admissionReturned = true;
      return response;
    });
    const environment = await provider.create({
      profile: { name: "worker", harness: "pi" },
    });
    const reference = await environment.dispatch!({
      prompt: "start the task",
      sessionId: "admission-session",
      turnId: "initial-turn",
      executionId: "initial-run",
    });
    const initialControlRef = exactControlRef(reference.controlRef);
    const session = environment.session!(initialControlRef.sessionId, {
      controlRef: initialControlRef,
    });
    const boundary = await session.contextBoundary!();
    if (!boundary) throw new Error("the fixture did not return a context boundary");
    const turn: NativeContextContinuationTurn = { prompt: "continue and stay controllable" };
    const request = continuationRequest(
      initialControlRef,
      boundary,
      "continue-admission",
      turn,
    );
    let resolveAdmission!: (controlRef: AgentExactRunControlRef) => void;
    const admitted = new Promise<AgentExactRunControlRef>((resolve) => {
      resolveAdmission = resolve;
    });
    let terminalSettled = false;
    const terminal = session.continueNative!(request, {
      turn,
      onAdmission(controlRef) {
        resolveAdmission(controlRef);
      },
    }).finally(() => {
      terminalSettled = true;
    });

    try {
      const controlRef = await admitted;
      expect(controlRef).toEqual(fixture.continuedControlRef(initialControlRef));
      expect(session.controlRef).toEqual(controlRef);
      expect(terminalSettled).toBe(false);
    } finally {
      releaseTerminal();
    }
    await expect(terminal).resolves.toMatchObject({
      acknowledgement: { status: "replayed" },
      controlRef: fixture.continuedControlRef(initialControlRef),
    });
    expect(fixture.continuationBodies).toHaveLength(2);
  });

  it("aborts a stalled context-boundary reader and closes its iterator", async () => {
    const fixture = createNativeContinuationFixture();
    let readStartedResolve!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      readStartedResolve = resolve;
    });
    let readerClosed = false;
    const provider = createProvider(async (url, init) => {
      if (new URL(String(url)).pathname === "/v1/sessions/stalled-boundary-session") {
        return stalledResponse(readStartedResolve, () => {
          readerClosed = true;
        });
      }
      return fixture.fetch(url, init);
    });
    const environment = await provider.create({ profile: { name: "worker", harness: "pi" } });
    const reference = await environment.dispatch!({
      prompt: "start the task",
      sessionId: "stalled-boundary-session",
      turnId: "initial-turn",
      executionId: "initial-run",
    });
    const session = environment.session!(reference.id, {
      controlRef: exactControlRef(reference.controlRef),
    });
    const controller = new AbortController();
    const pending = session.contextBoundary!({ signal: controller.signal });
    await readStarted;
    const abortTimer = setTimeout(() => {
      controller.abort(new DOMException("caller stopped boundary read", "AbortError"));
    }, 10);
    const outcome = await Promise.race([
      pending.then(
        () => ({ kind: "resolved" as const }),
        (error) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ kind: "timeout" }), 500);
      }),
    ]);
    clearTimeout(abortTimer);

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("stalled boundary read did not reject");
    expect(outcome.error).toMatchObject({ name: "AbortError" });
    expect(readerClosed).toBe(true);
  });

  it("aborts a stalled continuation reader and closes its iterator", async () => {
    const fixture = createNativeContinuationFixture();
    let readStartedResolve!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      readStartedResolve = resolve;
    });
    let readerClosed = false;
    const provider = createProvider(async (url, init) => {
      if (new URL(String(url)).pathname === "/v1/sessions/stalled-continuation-session/continue") {
        return stalledResponse(readStartedResolve, () => {
          readerClosed = true;
        });
      }
      return fixture.fetch(url, init);
    });
    const environment = await provider.create({ profile: { name: "worker", harness: "pi" } });
    const reference = await environment.dispatch!({
      prompt: "start the task",
      sessionId: "stalled-continuation-session",
      turnId: "initial-turn",
      executionId: "initial-run",
    });
    const initialControlRef = exactControlRef(reference.controlRef);
    const session = environment.session!(initialControlRef.sessionId, {
      controlRef: initialControlRef,
    });
    const boundary = await session.contextBoundary!();
    if (!boundary) throw new Error("the fixture did not return a context boundary");
    const turn: NativeContextContinuationTurn = { prompt: "continue the task" };
    const request = continuationRequest(initialControlRef, boundary, "stalled-continue", turn);
    const controller = new AbortController();
    const pending = session.continueNative!(request, { turn, signal: controller.signal });
    await readStarted;
    const abortTimer = setTimeout(() => {
      controller.abort(new DOMException("caller stopped continuation", "AbortError"));
    }, 10);
    const outcome = await Promise.race([
      pending.then(
        () => ({ kind: "resolved" as const }),
        (error) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ kind: "timeout" }), 500);
      }),
    ]);
    clearTimeout(abortTimer);

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("stalled continuation did not reject");
    expect(outcome.error).toMatchObject({ name: "AbortError" });
    expect(readerClosed).toBe(true);
  });

  it("reconstructs without dispatch, replays the same operation, and maps a conflict", async () => {
    const fixture = createNativeContinuationFixture();
    const provider = createProvider(fixture.fetch);
    const environment = await provider.create({
      idempotencyKey: "restart-environment",
      profile: { name: "worker", harness: "pi" },
    });
    const reference = await environment.dispatch!({
      prompt: "start the task",
      sessionId: "restart-session",
      turnId: "initial-turn",
      executionId: "initial-run",
    });
    const initialControlRef = exactControlRef(reference.controlRef);
    const initialSession = environment.session!(initialControlRef.sessionId, {
      controlRef: initialControlRef,
    });
    const boundary = await initialSession.contextBoundary!();
    if (!boundary) throw new Error("the fixture did not return a context boundary");
    const turn: NativeContextContinuationTurn = { prompt: "continue after restart" };
    const request = continuationRequest(initialControlRef, boundary, "continue-replay", turn);

    const restarted = createProvider(fixture.fetch);
    const reconstructedEnvironment = await restarted.get!(environment.id);
    if (!reconstructedEnvironment) throw new Error("the environment was not reconstructed");
    expect(environment.creation).toBe("created");
    expect(reconstructedEnvironment.creation).toBeUndefined();
    await expect(reconstructedEnvironment.dispatch!({ prompt: "must not dispatch" })).rejects.toThrow(
      /cannot start a turn through environment\.dispatch\(\)/,
    );
    const reconstructed = reconstructedEnvironment.session!(initialControlRef.sessionId, {
      controlRef: initialControlRef,
    });
    expect(reconstructed.prompt).toBeDefined();
    await expect(reconstructed.prompt!({ prompt: "must not dispatch" })).rejects.toThrow(
      /cannot start a turn through session\.prompt\(\)/,
    );
    await expect(reconstructed.contextBoundary!()).resolves.toEqual(boundary);

    const accepted = await initialSession.continueNative!(request, { turn });
    expect(accepted.acknowledgement.status).toBe("accepted");
    const replayed = await reconstructed.continueNative!(request, { turn });
    expect(replayed).toMatchObject({
      acknowledgement: { operationId: "continue-replay", status: "replayed" },
      controlRef: fixture.continuedControlRef(initialControlRef),
    });
    expect(reconstructed.controlRef).toEqual(fixture.continuedControlRef(initialControlRef));

    const conflictProvider = createProvider(fixture.fetch);
    const conflictEnvironment = await conflictProvider.get!(environment.id);
    if (!conflictEnvironment) throw new Error("the conflict environment was not reconstructed");
    const conflictSession = conflictEnvironment.session!(initialControlRef.sessionId, {
      controlRef: initialControlRef,
    });
    const conflictTurn: NativeContextContinuationTurn = { prompt: "conflicting retry" };
    const conflictRequest = continuationRequest(
      initialControlRef,
      boundary,
      "conflict-1",
      conflictTurn,
    );
    const conflict = await conflictSession.continueNative!(conflictRequest, {
      turn: conflictTurn,
    });
    expect(conflict).toEqual({
      acknowledgement: {
        operationId: "conflict-1",
        requestDigest: conflictRequest.requestDigest,
        status: "conflict",
        historyMessagesSent: 0,
        existingRequestDigest: canonicalCandidateDigest("different-request"),
      },
    });
    expect(conflictSession.controlRef).toEqual(initialControlRef);
    expect(fixture.count("POST", "/v1/sessions")).toBe(1);
    expect(fixture.count("POST", "/v1/sessions/restart-session/turns")).toBe(1);
    expect(fixture.count("POST", "/v1/chat/completions")).toBe(0);
  });

  it.each(["wrong-ack", "wrong-control"] as const)(
    "rejects a %s continuation acknowledgement without advancing the session",
    async (caseName) => {
      const fixture = createNativeContinuationFixture();
      const provider = createProvider(fixture.fetch);
      const environment = await provider.create({
        profile: { name: "worker", harness: "pi" },
      });
      const reference = await environment.dispatch!({
        prompt: "start the task",
        sessionId: `${caseName}-session`,
        turnId: "initial-turn",
        executionId: "initial-run",
      });
      const initialControlRef = exactControlRef(reference.controlRef);
      const session = environment.session!(initialControlRef.sessionId, {
        controlRef: initialControlRef,
      });
      const boundary = await session.contextBoundary!();
      if (!boundary) throw new Error("the fixture did not return a context boundary");
      const turn: NativeContextContinuationTurn = { prompt: `exercise ${caseName}` };
      const request = continuationRequest(initialControlRef, boundary, caseName, turn);

      await expect(session.continueNative!(request, { turn })).rejects.toThrow(
        /acknowledgement|another request/,
      );
      expect(session.controlRef).toEqual(initialControlRef);
      expect(fixture.count("POST", `/${caseName}-session/turns`)).toBe(0);
      expect(fixture.count("POST", `/v1/sessions/${caseName}-session/turns`)).toBe(1);
      expect(fixture.count("POST", "/v1/chat/completions")).toBe(0);
    },
  );
});

function createProvider(fetch: typeof globalThis.fetch) {
  return createCliBridgeProvider({
    baseUrl,
    defaultModel: "pi/test-model",
    fetch,
  });
}

function stalledResponse(onRead: () => void, onClose: () => void): Response {
  let readReported = false;
  const body: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<Uint8Array>> => {
          if (!readReported) {
            readReported = true;
            onRead();
          }
          return new Promise(() => {});
        },
        return: async (): Promise<IteratorResult<Uint8Array>> => {
          onClose();
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
}

function exactControlRef(value: unknown): AgentExactRunControlRef {
  if (!value || typeof value !== "object") {
    throw new Error("the Bridge did not return an exact control reference");
  }
  return value as AgentExactRunControlRef;
}

function continuationRequest(
  run: AgentExactRunControlRef,
  expectedBoundary: NativeContextBoundaryProof,
  operationId: string,
  turn: NativeContextContinuationTurn,
): NativeContextContinuationRequest {
  const material = {
    operationId,
    turnDigest: nativeContextContinuationTurnDigest(turn),
    run,
    expectedBoundary,
  };
  return {
    ...material,
    requestDigest: nativeContextContinuationRequestDigest(material),
  };
}

interface NativeContinuationRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
}

interface NativeContinuationFixture {
  readonly requests: NativeContinuationRequest[];
  readonly continuationBodies: Record<string, unknown>[];
  readonly fetch: typeof globalThis.fetch;
  boundaryFor(controlRef: AgentExactRunControlRef): NativeContextBoundaryProof;
  continuedControlRef(controlRef: AgentExactRunControlRef): AgentExactRunControlRef;
  count(method: string, path: string): number;
}

function createNativeContinuationFixture(): NativeContinuationFixture {
  const requests: NativeContinuationRequest[] = [];
  const continuationBodies: Record<string, unknown>[] = [];
  const controls = new Map<string, AgentExactRunControlRef>();
  const accepted = new Map<string, AgentExactRunControlRef>();
  const sessionCreateDigests = new Map<string, string>();
  const sessionModels = new Map<string, string>();
  let currentControlRef: AgentExactRunControlRef | undefined;

  const boundaryFor = (controlRef: AgentExactRunControlRef): NativeContextBoundaryProof => ({
    ...controlRef,
    boundary: { kind: "revision", revision: `revision-${controlRef.runId}` },
    observedAt: "2026-08-19T12:00:00.000Z",
  });

  const continuedControlRef = (
    controlRef: AgentExactRunControlRef,
  ): AgentExactRunControlRef => ({
    ...controlRef,
    runId: "continued-run",
    executionId: "continued-execution",
    requestDigest: canonicalCandidateDigest("continued-run"),
  });

  const fetcher: typeof globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body === undefined
      ? undefined
      : JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({
      method,
      path: parsed.pathname,
      ...(body === undefined ? {} : { body }),
    });

    if (method === "GET" && parsed.pathname === "/v1/capabilities") {
      return Response.json(defaultCliBridgeCapabilities("pi"));
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    if (method === "POST" && parsed.pathname === "/v1/sessions") {
      const createRequestDigest = canonicalCandidateDigest(body ?? {});
      const sessionId = String(body?.id);
      sessionCreateDigests.set(sessionId, createRequestDigest);
      sessionModels.set(sessionId, String(body?.model));
      return Response.json({
        id: sessionId,
        model: sessionModels.get(sessionId),
        create_request_digest: createRequestDigest,
      }, { status: 201 });
    }

    if (
      method === "POST" &&
      segments[0] === "v1" &&
      segments[1] === "sessions" &&
      segments[3] === "turns"
    ) {
      if (!body) throw new Error("the initial native turn body is missing");
      const sessionId = decodeURIComponent(segments[2] ?? "");
      const runId = String(body.run_id);
      const controlRef: AgentExactRunControlRef = {
        runId,
        provider: String(body.provider),
        environmentId: String(body.environment_id),
        sessionId,
        executionId: String(body.execution_id),
        requestDigest: canonicalCandidateDigest(runId),
      };
      controls.set(runId, controlRef);
      currentControlRef = controlRef;
      return Response.json({
        session: {
          id: sessionId,
          model: sessionModels.get(sessionId),
          create_request_digest: sessionCreateDigests.get(sessionId),
        },
        run: {
          id: runId,
          provider: controlRef.provider,
          environmentId: controlRef.environmentId,
          executionId: controlRef.executionId,
          sessionId,
          requestDigest: controlRef.requestDigest,
          status: "running",
          terminal: false,
        },
        context_boundary: null,
      }, { status: 202 });
    }

    if (
      method === "GET" &&
      segments[0] === "v1" &&
      segments[1] === "sessions" &&
      segments.length === 3
    ) {
      if (!currentControlRef) throw new Error("the session was not created");
      return Response.json({
        id: decodeURIComponent(segments[2] ?? ""),
        context_boundary: boundaryFor(currentControlRef),
      });
    }

    if (
      method === "POST" &&
      segments[0] === "v1" &&
      segments[1] === "sessions" &&
      segments[3] === "continue"
    ) {
      if (!body) throw new Error("the native continuation body is missing");
      continuationBodies.push(body);
      const request = body.request as NativeContextContinuationRequest;
      const operationId = request.operationId;
      const nextControlRef = continuedControlRef(request.run);
      if (operationId === "conflict-1") {
        return Response.json({
          acknowledgement: {
            operationId,
            requestDigest: request.requestDigest,
            status: "conflict",
            historyMessagesSent: 0,
            existingRequestDigest: canonicalCandidateDigest("different-request"),
          },
        }, { status: 409 });
      }
      if (operationId === "wrong-ack") {
        return Response.json(validAcceptedOutcome(
          request,
          boundaryFor(request.run),
          nextControlRef,
          "other-operation",
        ));
      }
      if (operationId === "wrong-control") {
        return Response.json(validAcceptedOutcome(
          request,
          boundaryFor(request.run),
          { ...nextControlRef, sessionId: "other-session" },
        ));
      }
      const replay = accepted.get(operationId);
      if (!replay) {
        accepted.set(operationId, nextControlRef);
        controls.set(nextControlRef.runId, nextControlRef);
        currentControlRef = nextControlRef;
      }
      const activeControlRef = replay ?? nextControlRef;
      if (parsed.searchParams.get("return") === "admission") {
        return Response.json({
          phase: "admitted",
          acknowledgement: {
            operationId,
            requestDigest: request.requestDigest,
            historyMessagesSent: 0,
            actualBoundary: boundaryFor(request.run),
          },
          controlRef: activeControlRef,
        }, {
          status: 202,
          headers: {
            "x-run-id": activeControlRef.runId,
            "x-run-request-digest": activeControlRef.requestDigest,
            "x-run-provider": activeControlRef.provider,
            "x-run-environment-id": activeControlRef.environmentId,
            "x-run-session-id": activeControlRef.sessionId,
            "x-run-execution-id": activeControlRef.executionId,
            location: `/v1/runs/${encodeURIComponent(activeControlRef.runId)}`,
          },
        });
      }
      return Response.json(validAcceptedOutcome(
        request,
        boundaryFor(request.run),
        activeControlRef,
        undefined,
        replay ? "replayed" : "accepted",
      ));
    }

    if (
      method === "GET" &&
      segments[0] === "v1" &&
      segments[1] === "runs" &&
      segments[3] === "events"
    ) {
      const runId = decodeURIComponent(segments[2] ?? "");
      const controlRef = controls.get(runId);
      if (!controlRef) throw new Error(`unknown run ${runId}`);
      return nativeEventsResponse(controlRef);
    }

    if (
      method === "GET" &&
      segments[0] === "v1" &&
      segments[1] === "runs" &&
      segments.length === 3
    ) {
      const runId = decodeURIComponent(segments[2] ?? "");
      const controlRef = controls.get(runId);
      if (!controlRef) throw new Error(`unknown run ${runId}`);
      return Response.json({
        id: runId,
        provider: controlRef.provider,
        environmentId: controlRef.environmentId,
        executionId: controlRef.executionId,
        sessionId: controlRef.sessionId,
        requestDigest: controlRef.requestDigest,
        status: "done",
        terminal: true,
      });
    }

    if (
      method === "POST" &&
      segments[0] === "v1" &&
      segments[1] === "runs" &&
      segments[3] === "cancel"
    ) {
      const runId = decodeURIComponent(segments[2] ?? "");
      const controlRef = controls.get(runId);
      if (!controlRef) throw new Error(`unknown run ${runId}`);
      if (!body || body.operationId === undefined) {
        return Response.json({
          run: {
            id: runId,
            provider: controlRef.provider,
            environmentId: controlRef.environmentId,
            sessionId: controlRef.sessionId,
            executionId: controlRef.executionId,
            requestDigest: controlRef.requestDigest,
            status: "done",
            terminal: true,
          },
        });
      }
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
        effect: "not_live",
      });
    }

    throw new Error(`unexpected native continuation route: ${method} ${parsed.pathname}`);
  };

  return {
    requests,
    continuationBodies,
    fetch: fetcher,
    boundaryFor,
    continuedControlRef,
    count: (method, path) => requests.filter(
      (request) => request.method === method && request.path === path,
    ).length,
  };
}

function validAcceptedOutcome(
  request: NativeContextContinuationRequest,
  actualBoundary: NativeContextBoundaryProof,
  controlRef: AgentExactRunControlRef,
  operationId = request.operationId,
  status: "accepted" | "replayed" = "accepted",
) {
  return AgentNativeContextContinuationResultSchema.parse({
    acknowledgement: {
      operationId,
      requestDigest: request.requestDigest,
      status,
      historyMessagesSent: 0,
      actualBoundary,
    },
    result: {
      text: "continued",
      success: true,
      sessionId: request.run.sessionId,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, cost: 0.01 },
    },
    controlRef,
  });
}

function nativeEventsResponse(controlRef: AgentExactRunControlRef): Response {
  const text = "continued";
  const events = [
    {
      runId: controlRef.runId,
      eventId: `${controlRef.runId}-message`,
      sequence: 1,
      cursor: "1",
      occurredAt: "2026-08-19T12:00:00.000Z",
      receivedAt: "2026-08-19T12:00:00.010Z",
      event: {
        type: "message.part.updated",
        part: {
          id: `${controlRef.runId}-part`,
          sessionID: controlRef.sessionId,
          messageID: `${controlRef.runId}-message`,
          type: "text",
          text,
        },
        delta: text,
      },
    },
    {
      runId: controlRef.runId,
      eventId: `${controlRef.runId}-status`,
      sequence: 2,
      cursor: "2",
      occurredAt: "2026-08-19T12:00:00.000Z",
      receivedAt: "2026-08-19T12:00:00.010Z",
      event: { type: "status", status: "completed" },
    },
  ];
  const body = events.map((envelope) => {
    const type = (envelope.event as { type: string }).type;
    return `id: ${envelope.sequence}\nevent: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`;
  }).join("");
  return new Response(body, {
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
  });
}
