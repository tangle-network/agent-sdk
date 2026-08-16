import { describe, expect, it, vi } from "vitest";
import { runSessionReplayConformance } from "@tangle-network/agent-provider-testkit";
import {
  reconnectRetainedRun,
  startRetainedRun,
} from "@tangle-network/agent-runtime/kernel";
import { Sandbox } from "@tangle-network/sandbox";
import type { SandboxEvent } from "@tangle-network/sandbox";
import {
  agentRunCancellationRequestDigest,
  InteractionKind,
  type AgentExactRunControlRef,
  type AgentRunCancellationRequest,
} from "@tangle-network/agent-interface";
import {
  createTangleProvider,
  type SandboxClientLike,
  type SandboxInstanceLike,
  type SandboxSessionLike,
} from "./index.js";
import type { PromptOptions, PromptResult } from "@tangle-network/sandbox";
import { sessionPromptRequestDigest } from "./tangle-environment-control.js";
import { retainedSessionControlRef } from "./tangle-session-control.js";
import {
  controlRefForTurn,
  executionIdForTurn,
  retainedDeployment,
  retainedSessionHandle,
  sessionPromptSessionId,
  TANGLE_PROVIDER as PROVIDER,
} from "./retained-control-test-helpers.js";

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function echoedExecution(options: PromptOptions | undefined) {
  return options?.executionId;
}

const REQUESTED_INTERACTIONS = {
  [InteractionKind.Permission]: true,
  [InteractionKind.Question]: false,
  [InteractionKind.Plan]: true,
} as const;

/**
 * Give a fake client the SDK HttpClient surface so the provider-level probe
 * can establish deployment facts from the installed SDK's instance and
 * session classes. The thrown fetch proves the probe never calls the network.
 */
function sdkShapedClient<T extends SandboxClientLike>(client: T) {
  return {
    ...client,
    fetch: async (): Promise<Response> => {
      throw new Error("capability probe must not call the network");
    },
  };
}

describe("Tangle retained control", () => {
  it("claims retained control from probed deployment facts", async () => {
    // A client with the SDK HttpClient surface lets the probe prove that its
    // sandboxes carry dispatchPrompt, session, and cancelRun. With get for
    // reconstruction, the provider claims the full retained-control block.
    const provider = createTangleProvider({
      client: sdkShapedClient({
        create: async (): Promise<SandboxInstanceLike> => {
          throw new Error("capabilities never create a sandbox");
        },
        get: async () => null,
      }),
    });
    await expect(provider.capabilities()).resolves.toMatchObject({
      sessions: { continue: true },
      retainedControl: {
        exactRunIdentity: true,
        resultIdentity: true,
        eventIdentity: true,
        cancellationIdempotency: true,
      },
    });

    // The published SDK client itself passes the same probe.
    const realClient = new Sandbox({
      apiKey: "test-key",
      baseUrl: "http://127.0.0.1:1",
    });
    const realProvider = createTangleProvider({ client: realClient });
    await expect(realProvider.capabilities()).resolves.toMatchObject({
      sessions: { continue: true },
      retainedControl: { cancellationIdempotency: true },
    });

    // Without get the run cannot be reconstructed, so nothing is claimed.
    const withoutReconstruction = createTangleProvider({
      client: sdkShapedClient({
        create: async (): Promise<SandboxInstanceLike> => {
          throw new Error("capabilities never create a sandbox");
        },
      }),
    });
    const narrowed = await withoutReconstruction.capabilities();
    expect(narrowed.sessions.continue).toBe(false);
    expect(narrowed).not.toHaveProperty("retainedControl");
  });

  it("grants per-sandbox retained control from measured facts under a wrapper client", async () => {
    // A wrapper without the SDK fetch surface denies the PROVIDER-level
    // claim, but the concrete box proves every fact, so the sandbox stage
    // must still grant retained control on the production create path.
    const sessionId = "session-wrapper-grant";
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-wrapper-grant",
      async *streamPrompt() {},
      dispatchPrompt: async (_message, options) => ({
        sessionId: options?.sessionId ?? sessionId,
        executionId: options?.executionId,
        runControlRef: options?.runControlRef,
        status: "running",
        alreadyExisted: false,
        dispatched: true,
      }),
      session: retainedSessionHandle,
    });
    const provider = createTangleProvider({
      client: {
        create: async () => box,
        get: async (id) => (id === box.id ? box : null),
      },
    });

    const providerDocument = await provider.capabilities();
    expect(providerDocument.sessions.continue).toBe(false);
    expect(providerDocument).not.toHaveProperty("retainedControl");

    const environment = await provider.create({ profile: { name: "worker" } });
    const controlRef = controlRefForTurn(
      { prompt: "wrapper grant", turnId: "wrapper-grant-turn" },
      box.id,
      sessionId,
    );
    const session = environment.session!(sessionId, { controlRef });
    expect(typeof session.cancelRun).toBe("function");
    const material = {
      operationId: "wrapper-grant-cancel",
      run: controlRef,
    };
    await expect(
      session.cancelRun!({
        ...material,
        requestDigest: agentRunCancellationRequestDigest(material),
      }),
    ).resolves.toMatchObject({ status: "accepted", run: controlRef });
  });

  it("rejects a concrete session that cannot honor granted retained control", async () => {
    // Retained control is granted from the probe session's fact set. A box
    // whose real sessions diverge from that surface must fail loud at
    // session construction — this also proves sessions.continue reached the
    // sandbox stage as true despite the fail-closed provider document.
    const probeSession = (id: string): SandboxSessionLike => ({
      id,
      status: async () => ({ status: "running" }),
      async *events() {},
      result: async () => {
        throw new Error("not called");
      },
      prompt: async () => {
        throw new Error("not called");
      },
      interrupt: async () => ({ cancelled: true }),
      cancelRun: async (request) => ({
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        run: request.run,
        status: "accepted",
        effect: "not_live",
      }),
    });
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-divergent-session",
      async *streamPrompt() {},
      dispatchPrompt: async () => {
        throw new Error("not called");
      },
      session: (id) => {
        const session = probeSession(id);
        if (id === "__tangle-capability-probe__") return session;
        const { cancelRun: _cancelRun, ...withoutCancelRun } = session;
        return withoutCancelRun as SandboxSessionLike;
      },
    });
    const provider = createTangleProvider({
      client: {
        create: async () => box,
        get: async (id) => (id === box.id ? box : null),
      },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    expect(() => environment.session!("session-divergent")).toThrow(
      /requires SandboxSession\.cancelRun/,
    );
  });

  it("rejects retained dispatch before create when cancelRun is unproven", async () => {
    const create = vi.fn(async (): Promise<SandboxInstanceLike> => ({
      id: "sbx-unproven-claim",
      async *streamPrompt() {},
    }));
    // A client without the SDK probe surface cannot prove cancelRun, even
    // with get present: the pre-0.19.6 over-claim fails closed here.
    const provider = createTangleProvider({
      client: { create, get: async () => null },
    });
    const capabilities = await provider.capabilities();
    expect(capabilities.sessions.continue).toBe(false);
    expect(capabilities).not.toHaveProperty("retainedControl");

    await expect(
      startRetainedRun({
        provider,
        environment: {
          profile: { name: "worker" },
          idempotencyKey: "unproven-environment",
        },
        turn: { prompt: "never dispatched", turnId: "unproven-turn" },
        onAdmission: async () => {},
      }),
    ).rejects.toThrow(/cannot control a retry-safe retained run/);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not attribute another execution's state to the exact control ref", async () => {
    const sessionId = "session-status-binding";
    let statusPayload: Record<string, unknown> = { status: "running" };
    const sandboxSession: SandboxSessionLike = {
      id: sessionId,
      status: async () => statusPayload,
      async *events() {},
      result: async (options) => ({
        success: true,
        status: "success",
        executionId: echoedExecution(options),
        durationMs: 1,
      }),
      prompt: async (_message, options) => ({
        success: true,
        status: "success",
        executionId: echoedExecution(options),
        durationMs: 1,
      }),
      interrupt: async () => ({ cancelled: true }),
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-status-binding",
      async *streamPrompt() {},
      session: () => sandboxSession,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const controlRef = controlRefForTurn(
      { prompt: "bind status", turnId: "status-binding-turn" },
      box.id,
      sessionId,
    );
    const exact = environment.session!(sessionId, { controlRef });
    const unbound = environment.session!(sessionId);

    // A newer execution owns the session-wide state; the exact session must
    // not present that state as this run's status.
    statusPayload = {
      status: "completed",
      latestExecutionId: "execution-from-another-caller",
    };
    await expect(exact.status()).resolves.toBe("unknown");
    await expect(unbound.status()).resolves.toBe("completed");

    statusPayload = {
      status: "completed",
      latestExecutionId: controlRef.executionId,
    };
    await expect(exact.status()).resolves.toBe("completed");

    statusPayload = {
      status: "running",
      activeExecutionId: controlRef.executionId,
    };
    await expect(exact.status()).resolves.toBe("running");

    // A payload with no execution identity cannot be bound to the exact run.
    statusPayload = { status: "completed" };
    await expect(exact.status()).resolves.toBe("unknown");
  });

  it("honors Runtime-owned execution identity and binds it into the request", async () => {
    const sessionId = "runtime-contract-session";
    const executionId = "runtime-contract-execution";
    const runId = "runtime-server-run-control";
    const dispatches: Array<PromptOptions & { runControlRef?: AgentExactRunControlRef }> = [];
    const replayCalls: Array<PromptOptions & { runControlRef?: AgentExactRunControlRef }> = [];
    const retainedEvents = [
      {
        id: "runtime-event-1",
        type: "status",
        data: {
          status: "processing",
          sessionId,
          executionId,
        },
      },
      {
        id: "runtime-event-2",
        type: "status",
        data: {
          status: "completed",
          sessionId,
          executionId,
        },
      },
    ] as SandboxEvent[];
    const sandboxSession: SandboxSessionLike = {
      id: sessionId,
      status: async () => ({ status: "running" }),
      async *events() {},
      result: async (options) => ({
        success: true,
        status: "success",
        executionId: echoedExecution(options),
        response: "done",
        durationMs: 1,
      }),
      prompt: async (_message, options) => ({
        success: true,
        status: "success",
        executionId: echoedExecution(options),
        response: "done",
        durationMs: 1,
      }),
      interrupt: async () => ({ cancelled: true }),
      cancelRun: async (request) => ({
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        run: request.run,
        status: "accepted",
        effect: "not_live",
      }),
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-runtime-contract",
      async *streamPrompt(_message, options) {
        replayCalls.push({ ...(options ?? {}) });
        if (options?.executionId !== executionId) {
          throw new Error("runtime replay used a different execution");
        }
        const start = options?.lastEventId === "runtime-event-1" ? 1 : 0;
        for (const event of retainedEvents.slice(start)) yield event;
      },
      dispatchPrompt: async (_message, options) => {
        dispatches.push({ ...(options ?? {}) });
        return {
          sessionId,
          executionId: options?.executionId,
          runControlRef: {
            ...(options?.runControlRef ?? {}),
            runId,
          },
          status: "running",
          alreadyExisted: false,
          dispatched: true,
        };
      },
      session: () => sandboxSession,
    });
    const provider = createTangleProvider({
      client: sdkShapedClient({
        create: async () => box,
        get: async (id) => (id === box.id ? box : null),
      }),
    });

    const run = await startRetainedRun({
      provider,
      environment: {
        profile: { name: "worker" },
        idempotencyKey: "runtime-contract-environment",
      },
      turn: { prompt: "run this exact task", turnId: "runtime-contract-turn" },
      identity: { sessionId, executionId },
      onAdmission: async () => {},
    });

    expect(run.controlRef).toMatchObject({
      sessionId,
      executionId,
      runId,
      requestDigest: expect.stringMatching(/^sha256:/),
    });
    expect(dispatches[0]).toMatchObject({
      sessionId,
      executionId,
      turnId: "runtime-contract-turn",
      detach: true,
    });
    expect(dispatches[0]?.runControlRef).toMatchObject({
      sessionId,
      executionId,
      requestDigest: run.controlRef.requestDigest,
    });

    const events = await collect(run.events());
    expect(events.map((event) => event.eventId)).toEqual([
      "runtime-event-1",
      "runtime-event-2",
    ]);
    expect(events[0]).toMatchObject({
      runId,
      cursor: "runtime-event-1",
      sequence: 1,
    });
    await expect(run.result()).resolves.toMatchObject({
      text: "done",
      success: true,
      sessionId,
    });

    const freshProvider = createTangleProvider({
      client: sdkShapedClient({
        create: async () => box,
        get: async (id) => (id === box.id ? box : null),
      }),
    });
    const recovered = await reconnectRetainedRun({
      provider: freshProvider,
      controlRef: run.controlRef,
    });
    expect(recovered?.controlRef).toEqual(run.controlRef);
    const replay = await collect(
      recovered!.events({
        after: { cursor: "runtime-event-1", sequence: 0 },
      }),
    );
    expect(replay.map((event) => event.eventId)).toEqual(["runtime-event-2"]);
    expect(replayCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionId,
          lastEventId: "0",
          runControlRef: expect.objectContaining({ runId }),
        }),
        expect.objectContaining({
          executionId,
          lastEventId: "runtime-event-1",
          runControlRef: expect.objectContaining({ runId }),
        }),
      ]),
    );
  });

  it("fails closed when admission omits the exact reference", async () => {
    const sessionId = "missing-echo-session";
    const turn = {
      prompt: "retry this exact task",
      sessionId,
      turnId: "missing-echo-turn",
      detach: true,
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-missing-echo",
      async *streamPrompt() {},
      dispatchPrompt: async (_message, options) => ({
        sessionId,
        executionId: options?.executionId,
        status: "running",
        alreadyExisted: true,
        dispatched: false,
      }),
      session: retainedSessionHandle,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(environment.dispatch!(turn)).rejects.toThrow(
      /did not return the exact run control reference/,
    );

    const callerControlRef = controlRefForTurn(turn, box.id, sessionId);
    await expect(
      environment.dispatch!({ ...turn, controlRef: callerControlRef }),
    ).resolves.toMatchObject({ controlRef: callerControlRef });
  });

  it("keeps explicit identity stable and lets changed input reach conflict binding", async () => {
    const executionId = "caller-owned-execution";
    const requestDigests = new Map<string, string>();
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-explicit-identity",
      async *streamPrompt() {},
      dispatchPrompt: async (_message, options) => {
        const digest = options?.runControlRef?.requestDigest;
        if (!digest) throw new Error("missing request digest");
        const requestExecutionId = options?.executionId;
        if (!requestExecutionId) throw new Error("missing execution id");
        const previous = requestDigests.get(requestExecutionId);
        if (previous !== undefined && previous !== digest) {
          throw new Error("exact execution request conflict");
        }
        requestDigests.set(requestExecutionId, digest);
        return {
          sessionId: options?.sessionId,
          executionId: requestExecutionId,
          runControlRef: options?.runControlRef,
          status: "running",
        };
      },
      session: retainedSessionHandle,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    const first = await environment.dispatch!({
      prompt: "same exact request",
      turnId: "explicit-identity-turn",
      executionId,
      detach: true,
    });
    const retry = await environment.dispatch!({
      prompt: "same exact request",
      turnId: "explicit-identity-turn",
      executionId,
      detach: true,
    });

    expect(retry.controlRef).toEqual(first.controlRef);
    const differentExecution = await environment.dispatch!({
      prompt: "same exact request",
      turnId: "explicit-identity-turn",
      executionId: "another-caller-owned-execution",
      detach: true,
    });
    expect(differentExecution.controlRef?.requestDigest).not.toBe(
      first.controlRef?.requestDigest,
    );
    const explicitSessionId = sessionPromptSessionId(
      PROVIDER,
      box.id,
      "explicit-identity-turn",
    )!;
    const legacyDigest = sessionPromptRequestDigest(
      {
        prompt: "same exact request",
        sessionId: explicitSessionId,
        turnId: "explicit-identity-turn",
        executionId,
        detach: true,
      },
      PROVIDER,
      box.id,
      explicitSessionId,
    );
    const legacyControlRef = retainedSessionControlRef(
      explicitSessionId,
      executionId,
      PROVIDER,
      box.id,
      legacyDigest,
      "legacy-run-control",
    );
    await expect(
      environment.dispatch!({
        prompt: "same exact request",
        sessionId: explicitSessionId,
        turnId: "explicit-identity-turn",
        controlRef: legacyControlRef,
        detach: true,
      }),
    ).rejects.toThrow(/request digest conflicts/);
    await expect(
      environment.dispatch!({
        prompt: "changed request",
        turnId: "explicit-identity-turn",
        executionId,
        detach: true,
      }),
    ).rejects.toThrow("exact execution request conflict");
  });

  it("derives one session for a turn and a new execution for changed input", async () => {
    const dispatches: PromptOptions[] = [];
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-derived-identity",
      async *streamPrompt() {},
      dispatchPrompt: async (_message, options) => {
        dispatches.push({ ...(options ?? {}) });
        return {
          sessionId: options?.sessionId,
          executionId: echoedExecution(options),
          runControlRef: options?.runControlRef,
          status: "running",
        };
      },
      session: retainedSessionHandle,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    const first = await environment.dispatch!({
      prompt: "same request",
      turnId: "derived-turn",
      detach: true,
    });
    const second = await environment.dispatch!({
      prompt: "same request",
      turnId: "derived-turn",
      detach: true,
    });
    const changed = await environment.dispatch!({
      prompt: "changed request",
      turnId: "derived-turn",
      detach: true,
    });

    expect(first.id).toBe(
      sessionPromptSessionId(PROVIDER, box.id, "derived-turn"),
    );
    expect(second.id).toBe(first.id);
    expect(second.controlRef?.executionId).toBe(first.controlRef?.executionId);
    expect(changed.id).toBe(first.id);
    expect(changed.controlRef?.executionId).not.toBe(first.controlRef?.executionId);
    expect(dispatches[0]?.sessionId).toBe(first.id);
    expect(dispatches[0]?.executionId).toBe(first.controlRef?.executionId);
    expect(dispatches[1]?.executionId).toBe(second.controlRef?.executionId);
    expect(dispatches[2]?.executionId).toBe(changed.controlRef?.executionId);
    expect(
      (dispatches[0] as PromptOptions & {
        runControlRef?: AgentExactRunControlRef;
      }).runControlRef,
    ).toEqual(first.controlRef);
    expect(
      (dispatches[2] as PromptOptions & {
        runControlRef?: AgentExactRunControlRef;
      }).runControlRef,
    ).toEqual(changed.controlRef);
  });

  it("rejects a changed request when the sandbox reports the old execution", async () => {
    let firstExecutionId: string | undefined;
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-stale-dispatch-receipt",
      async *streamPrompt() {},
      dispatchPrompt: async (_message, options) => {
        firstExecutionId ??= echoedExecution(options);
        return {
          sessionId: options?.sessionId,
          executionId: firstExecutionId,
          runControlRef: options?.runControlRef,
          status: "running",
        };
      },
      session: retainedSessionHandle,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(
      environment.dispatch!({
        prompt: "original request",
        turnId: "stale-receipt-turn",
        detach: true,
      }),
    ).resolves.toMatchObject({
      controlRef: { executionId: expect.any(String) },
    });
    expect(firstExecutionId).toEqual(expect.any(String));
    await expect(
      environment.dispatch!({
        prompt: "changed request",
        turnId: "stale-receipt-turn",
        detach: true,
      }),
    ).rejects.toThrow(
      /sandbox dispatch returned an execution id different from the requested run/,
    );
  });

  it("keeps detached cloud work alive when stream or dispatch callers abort", async () => {
    const streamEntered = deferred<void>();
    const streamGate = deferred<void>();
    const dispatchCalled = deferred<void>();
    const dispatchResult = deferred<unknown>();
    const interrupt = vi.fn(async () => ({ cancelled: true }));
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-detached-abort",
      async *streamPrompt() {
        streamEntered.resolve(undefined);
        await streamGate.promise;
      },
      dispatchPrompt: async () => {
        dispatchCalled.resolve(undefined);
        return dispatchResult.promise;
      },
      session: (id) => ({
        id,
        status: async () => ({ status: "running" }),
        async *events() {},
        result: async () => {
          throw new Error("not called");
        },
        prompt: async () => {
          throw new Error("not called");
        },
        interrupt,
      }),
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    const streamAbort = new AbortController();
    const streamCall = collect(
      environment.stream({
        prompt: "keep this cloud run",
        sessionId: "stream-session",
        detach: true,
        signal: streamAbort.signal,
      }),
    );
    await streamEntered.promise;
    streamAbort.abort();
    await expect(streamCall).rejects.toThrow();
    streamGate.resolve(undefined);

    const dispatchAbort = new AbortController();
    const dispatchCall = environment.dispatch!({
      prompt: "keep this dispatched cloud run",
      sessionId: "dispatch-session",
      turnId: "dispatch-turn",
      detach: true,
      signal: dispatchAbort.signal,
    });
    await dispatchCalled.promise;
    dispatchAbort.abort();
    await expect(dispatchCall).rejects.toThrow();
    dispatchResult.resolve({
      sessionId: "dispatch-session",
      executionId: executionIdForTurn(
        {
          prompt: "keep this dispatched cloud run",
          sessionId: "dispatch-session",
          turnId: "dispatch-turn",
          detach: true,
        },
        box.id,
        "dispatch-session",
      ),
    });
    await dispatchResult.promise;
    await Promise.resolve();

    expect(interrupt).not.toHaveBeenCalled();
  });

  it("does not interrupt a duplicate dispatch after the caller aborts", async () => {
    const dispatchCalled = deferred<void>();
    const dispatchResult = deferred<unknown>();
    const interrupt = vi.fn(async () => ({ cancelled: true }));
    const sandboxSession: SandboxSessionLike = {
      id: "duplicate-session",
      status: async () => ({ status: "running" }),
      async *events() {},
      result: async () => {
        throw new Error("not called");
      },
      prompt: async () => {
        throw new Error("not called");
      },
      interrupt,
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-duplicate-dispatch",
      async *streamPrompt() {},
      dispatchPrompt: async () => {
        dispatchCalled.resolve(undefined);
        return dispatchResult.promise;
      },
      session: () => sandboxSession,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const abort = new AbortController();
    const dispatchCall = environment.dispatch!({
      prompt: "retry the existing run",
      sessionId: sandboxSession.id,
      turnId: "duplicate-turn",
      signal: abort.signal,
    });

    await dispatchCalled.promise;
    abort.abort();
    await expect(dispatchCall).rejects.toThrow();
    dispatchResult.resolve({
      sessionId: sandboxSession.id,
      executionId: executionIdForTurn(
        {
          prompt: "retry the existing run",
          sessionId: sandboxSession.id,
          turnId: "duplicate-turn",
        },
        box.id,
        sandboxSession.id,
      ),
      status: "running",
      alreadyExisted: true,
      dispatched: false,
    });
    await dispatchResult.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(interrupt).not.toHaveBeenCalled();
  });

  it("persists a detached prompt reference at admission before result completion", async () => {
    const dispatchCalled = deferred<void>();
    const resultGate = deferred<PromptResult>();
    const interrupt = vi.fn(async () => ({ cancelled: true }));
    let dispatchOptions: PromptOptions | undefined;
    let resultExecutionId: string | undefined;
    const sandboxSession: SandboxSessionLike = {
      id: "session-direct-detach",
      status: async () => ({ status: "running" }),
      async *events() {},
      result: async (options) => {
        resultExecutionId = options?.executionId;
        return resultGate.promise;
      },
      prompt: async () => {
        throw new Error("detached prompts use dispatchPrompt");
      },
      interrupt,
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-direct-detach",
      async *streamPrompt() {},
      dispatchPrompt: async (_message, options) => {
        dispatchOptions = options;
        dispatchCalled.resolve(undefined);
        return {
          sessionId: sandboxSession.id,
          executionId: options?.executionId,
          runControlRef: options?.runControlRef,
          status: "running",
          alreadyExisted: false,
          dispatched: true,
        };
      },
      session: () => sandboxSession,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const session = environment.session!(sandboxSession.id);
    const abort = new AbortController();
    const promptCall = session.prompt({
      prompt: "continue after reconnect",
      turnId: "direct-detach-turn",
      detach: true,
      interactions: REQUESTED_INTERACTIONS,
      signal: abort.signal,
    });

    await dispatchCalled.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchOptions?.executionId).toEqual(
      executionIdForTurn(
        {
          prompt: "continue after reconnect",
          sessionId: sandboxSession.id,
          turnId: "direct-detach-turn",
          detach: true,
          interactions: REQUESTED_INTERACTIONS,
        },
        box.id,
        sandboxSession.id,
      ),
    );
    expect(dispatchOptions?.backend?.interactions).toEqual(
      REQUESTED_INTERACTIONS,
    );
    expect(session.controlRef).toMatchObject({
      sessionId: sandboxSession.id,
      executionId: dispatchOptions?.executionId,
    });
    expect(resultExecutionId).toBe(dispatchOptions?.executionId);

    abort.abort();
    await expect(promptCall).rejects.toThrow();
    resultGate.resolve({
      success: true,
      status: "success",
      executionId: dispatchOptions?.executionId,
      response: "done",
      durationMs: 1,
    });
    await resultGate.promise;
    await Promise.resolve();

    expect(interrupt).not.toHaveBeenCalled();
  });

  it("ignores connection markers and follows the exclusive cursor with stable-ID dedupe", async () => {
    let executionId: string | undefined;
    let capturedOptions: Record<string, unknown> | undefined;
    const upstreamEvents = [
      {
        id: "event-1",
        type: "status",
        data: {
          status: "processing",
          sessionId: "session-replay",
          executionId: undefined,
        },
      },
      {
        id: "event-native-session",
        type: "session.updated",
        data: {
          sessionId: "opencode-native-session",
          sessionID: "opencode-native-session",
          title: "Native harness session",
        },
      },
      {
        id: "event-2",
        type: "result",
        data: {
          type: "result",
          properties: {
            finalText: "ok",
            sessionId: "session-replay",
            executionId: undefined,
          },
        },
      },
    ] as SandboxEvent[];
    const sandboxSession: SandboxSessionLike = {
      id: "session-replay",
      status: async () => ({ status: "running" }),
      async *events(options) {
        capturedOptions = options as Record<string, unknown>;
        yield {
          id: "connection-marker",
          type: "connection.established",
          data: {
            type: "connection.established",
            properties: {
              sessionId: "session-replay",
              executionId,
              timestamp: 1,
            },
          },
        } as SandboxEvent;
        const replayEvents =
          options?.since === "event-1"
            ? [upstreamEvents[1]!, upstreamEvents[2]!, upstreamEvents[2]!]
            : upstreamEvents;
        for (const event of replayEvents) yield event;
      },
      result: async (options) => ({
        success: true,
        status: "success",
        executionId: echoedExecution(options),
        response: "ok",
        durationMs: 1,
      }),
      prompt: async (_message, options) => ({
        success: true,
        status: "success",
        executionId: echoedExecution(options),
        response: "ok",
        durationMs: 1,
      }),
      interrupt: async () => ({ cancelled: true }),
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-replay",
      async *streamPrompt(_message, options) {
        capturedOptions = options as Record<string, unknown>;
        yield {
          id: "connection-marker",
          type: "connection.established",
          data: {
            type: "connection.established",
            properties: {
              sessionId: "session-replay",
              executionId,
              timestamp: 1,
            },
          },
        } as SandboxEvent;
        const replayEvents =
          options?.lastEventId === "event-1"
            ? [upstreamEvents[1]!, upstreamEvents[2]!, upstreamEvents[2]!]
            : upstreamEvents;
        for (const event of replayEvents) yield event;
      },
      dispatchPrompt: async (_prompt, options) => {
        executionId = echoedExecution(options);
        for (const event of upstreamEvents) {
          const data = event.data as Record<string, unknown>;
          const properties = data.properties as Record<string, unknown> | undefined;
          if (properties) properties.executionId = executionId;
          else data.executionId = executionId;
        }
        return {
          sessionId: options?.sessionId,
          executionId,
          runControlRef: options?.runControlRef,
        };
      },
      session: () => sandboxSession,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const reference = await environment.dispatch!({
      prompt: "replay this run",
      sessionId: sandboxSession.id,
      turnId: "replay-turn",
      detach: true,
    });
    const session = environment.session!(sandboxSession.id, {
      controlRef: reference.controlRef,
    });

    const replay = await collect(session.events({ since: "event-1" }));
    expect(replay.map((event) => event.id)).toEqual([
      "event-native-session",
      "event-2",
    ]);
    // The replay lane serves run frames, so `session.updated` arrives with the
    // harness-native id in `data.sessionId`. That id is content and reaches the
    // normalized event.
    expect(replay[0]?.normalized).toEqual({
      type: "session.updated",
      sessionId: "opencode-native-session",
      title: "Native harness session",
    });
    expect(capturedOptions).toMatchObject({
      lastEventId: "event-1",
      executionId,
    });

    await expect(
      collect(session.events({ since: "unknown-event" })),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "event-1" }),
        expect.objectContaining({ id: "event-2" }),
      ]),
    );
  });

  it("refuses a foreign runtime session id on the retained replay stream", async () => {
    const environmentId = "sbx-foreign-session";
    const sessionId = "session-foreign";
    const controlRef = controlRefForTurn(
      { prompt: "replay this run", turnId: "foreign-turn" },
      environmentId,
      sessionId,
    );
    const foreignFrames: Record<string, SandboxEvent[]> = {
      // The envelope position names the runtime session on every frame, so a
      // foreign value there is another session's frame. The replay lane serves
      // run frames and the session bus serves envelopes; the rule binds the
      // position, so it holds on whichever lane the shape arrives.
      envelope: [
        {
          id: "event-foreign-envelope",
          type: "session.updated",
          data: {
            properties: {
              info: { id: "other-session", sessionID: "other-session" },
            },
          },
        } as unknown as SandboxEvent,
      ],
      // The run-frame position is content on `session.updated` only. A run
      // frame that also fills the envelope position is still checked there.
      mixed: [
        {
          id: "event-foreign-mixed",
          type: "session.updated",
          data: {
            sessionId: "opencode-native-session",
            properties: {
              info: { id: "other-session", sessionID: "other-session" },
            },
          },
        } as unknown as SandboxEvent,
      ],
      // A lifecycle frame keeps its runtime identity check in every position.
      lifecycle: [
        {
          id: "event-foreign-lifecycle",
          type: "status",
          data: {
            status: "processing",
            sessionId: "other-session",
            executionId: controlRef.executionId,
          },
        } as unknown as SandboxEvent,
      ],
      // A connection marker names the session its stream was opened for.
      marker: [
        {
          id: "connection-marker",
          type: "connection.established",
          data: {
            type: "connection.established",
            properties: {
              sessionId: "other-session",
              executionId: controlRef.executionId,
              timestamp: 1,
            },
          },
        } as unknown as SandboxEvent,
      ],
      // A marker carries no native id, so filling the run-frame position with
      // this session does not exempt the envelope position from the check.
      markerMixed: [
        {
          id: "connection-marker",
          type: "connection.established",
          data: {
            type: "connection.established",
            sessionId,
            properties: {
              sessionId: "other-session",
              executionId: controlRef.executionId,
              timestamp: 1,
            },
          },
        } as unknown as SandboxEvent,
      ],
    };

    for (const [shape, frames] of Object.entries(foreignFrames)) {
      const sandboxSession: SandboxSessionLike = {
        ...retainedSessionHandle(sessionId),
        async *events() {
          for (const frame of frames) yield frame;
        },
      };
      const box: SandboxInstanceLike = retainedDeployment({
        id: environmentId,
        async *streamPrompt() {
          for (const frame of frames) yield frame;
        },
        session: () => sandboxSession,
      });
      const provider = createTangleProvider({
        client: { create: async () => box },
      });
      const environment = await provider.create({ profile: { name: "worker" } });
      const session = environment.session!(sessionId, { controlRef });
      await expect(
        collect(session.events()),
        `foreign ${shape} frame must not pass identity binding`,
      ).rejects.toThrow(/identified a different sessionId/);
    }
  });

  it("carries the runtime session id of a session-bus envelope frame", async () => {
    const environmentId = "sbx-session-bus";
    const sessionId = "session-bus";
    // Without an exact executionId the session surface reads the session bus,
    // which serves envelopes under `properties` rather than run frames. That
    // position names the runtime session on every frame.
    const envelopeFrame = (id: string, sessionID: string): SandboxEvent =>
      ({
        id,
        type: "session.updated",
        data: {
          properties: {
            info: { id: sessionID, sessionID, title: "Runtime session" },
          },
        },
      }) as unknown as SandboxEvent;

    const busEnvironment = async (frames: SandboxEvent[]) => {
      const sandboxSession: SandboxSessionLike = {
        ...retainedSessionHandle(sessionId),
        async *events() {
          for (const frame of frames) yield frame;
        },
      };
      const box: SandboxInstanceLike = retainedDeployment({
        id: environmentId,
        async *streamPrompt() {},
        session: () => sandboxSession,
      });
      const provider = createTangleProvider({
        client: { create: async () => box },
      });
      const environment = await provider.create({ profile: { name: "worker" } });
      return environment.session!(sessionId);
    };

    // A message part names its session only inside the part. The sidecar
    // rewrites that id to the runtime session before it publishes to the bus.
    const partFrame = (id: string, sessionID: string): SandboxEvent =>
      ({
        id,
        type: "message.part.updated",
        data: {
          properties: {
            part: {
              id: "part-1",
              sessionID,
              messageID: "message-1",
              type: "text",
              text: "hello",
            },
          },
        },
      }) as unknown as SandboxEvent;

    const own = await busEnvironment([
      envelopeFrame("event-bus", sessionId),
      partFrame("event-bus-part", sessionId),
    ]);
    const events = await collect(own.events());
    expect(events.map((event) => event.id)).toEqual([
      "event-bus",
      "event-bus-part",
    ]);
    expect(events[0]?.normalized).toEqual({
      type: "session.updated",
      sessionId,
      title: "Runtime session",
    });
    expect(events[1]?.type).toBe("message.part.updated");

    const foreignPart = await busEnvironment([
      partFrame("event-bus-part-foreign", "other-session"),
    ]);
    await expect(collect(foreignPart.events())).rejects.toThrow(
      /identified a different sessionId/,
    );

    const foreign = await busEnvironment([
      envelopeFrame("event-bus-foreign", "other-session"),
    ]);
    await expect(collect(foreign.events())).rejects.toThrow(
      /identified a different sessionId/,
    );
  });

  it("keeps the provider-owned control reference after external mutation", async () => {
    const environmentId = "sbx-control-ref-copy";
    const sessionId = "session-control-ref-copy";
    const controlRef = controlRefForTurn(
      { prompt: "inspect this run", turnId: "control-ref-turn" },
      environmentId,
      sessionId,
    );
    let resultExecutionId: string | undefined;
    const sandboxSession: SandboxSessionLike = {
      id: sessionId,
      status: async () => ({ status: "completed" }),
      async *events() {},
      result: async (options) => {
        resultExecutionId = options?.executionId;
        return {
          success: true,
          status: "success",
          executionId: echoedExecution(options),
          durationMs: 1,
        };
      },
      prompt: async (_message, options) => ({
        success: true,
        status: "success",
        executionId: echoedExecution(options),
        durationMs: 1,
      }),
      interrupt: async () => ({ cancelled: true }),
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: environmentId,
      async *streamPrompt() {},
      session: () => sandboxSession,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const session = environment.session!(sessionId, { controlRef });
    const exposed = session.controlRef as { runId: string; executionId: string };
    exposed.runId = `session-turn-${"f".repeat(64)}`;
    exposed.executionId = exposed.runId;

    await expect(session.result()).resolves.toMatchObject({
      success: true,
      metadata: {
        runId: controlRef.runId,
        executionId: controlRef.executionId,
      },
    });
    expect(session.controlRef).toMatchObject(controlRef);
    expect(resultExecutionId).toBe(controlRef.executionId);
  });

  it("rejects concurrent prompts on one retained session", async () => {
    const promptPending = deferred<unknown>();
    let promptCalls = 0;
    const environmentId = "sbx-concurrent-prompts";
    const sessionId = "session-concurrent-prompts";
    const firstInput = { prompt: "first prompt", turnId: "first-turn" };
    const sandboxSession: SandboxSessionLike = {
      id: sessionId,
      status: async () => ({ status: "running" }),
      async *events() {},
      result: async () => {
        throw new Error("not called");
      },
      prompt: async (_message, options) => {
        promptCalls += 1;
        await promptPending.promise;
        return {
          success: true,
          status: "success",
          executionId: echoedExecution(options),
          durationMs: 1,
        };
      },
      interrupt: async () => ({ cancelled: true }),
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: environmentId,
      async *streamPrompt() {},
      session: () => sandboxSession,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const session = environment.session!(sessionId);
    const first = session.prompt(firstInput);

    await expect(
      session.prompt({ prompt: "second prompt", turnId: "second-turn" }),
    ).rejects.toThrow(/already has a prompt in flight/);

    promptPending.resolve(undefined);
    await expect(first).resolves.toMatchObject({ success: true });
    expect(promptCalls).toBe(1);
  });

  it("forwards accepted and replayed cancellation, then rejects a mismatched acknowledgement", async () => {
    const acknowledgements = new Map<string, AgentRunCancellationRequest>();
    const cancelRun = vi.fn(async (request: AgentRunCancellationRequest) => {
      const replay = acknowledgements.has(request.operationId);
      acknowledgements.set(request.operationId, request);
      return {
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        run: request.run,
        status: replay ? ("replayed" as const) : ("accepted" as const),
        effect: "cancelled" as const,
      };
    });
    let executionId: string | undefined;
    const sandboxSession: SandboxSessionLike = {
      id: "session-cancel",
      status: async () => ({ status: "completed" }),
      async *events() {},
      result: async (options) => ({
        success: true,
        status: "success",
        executionId: echoedExecution(options),
        durationMs: 1,
      }),
      prompt: async (_message, options) => ({
        success: true,
        status: "success",
        executionId: echoedExecution(options),
        durationMs: 1,
      }),
      interrupt: async () => ({ cancelled: true }),
      cancelRun,
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-cancel",
      async *streamPrompt() {},
      dispatchPrompt: async (_message, options) => {
        executionId = echoedExecution(options);
        return {
          sessionId: options?.sessionId ?? sandboxSession.id,
          executionId,
          runControlRef: options?.runControlRef,
          status: "running",
        };
      },
      session: () => sandboxSession,
    });
    const provider = createTangleProvider({
      client: sdkShapedClient({
        create: async () => box,
        get: async (id) => (id === box.id ? box : null),
      }),
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const reference = await environment.dispatch!({
      prompt: "cancel this run",
      sessionId: sandboxSession.id,
      turnId: "cancel-turn",
    });
    const session = environment.session!(sandboxSession.id, {
      controlRef: reference.controlRef,
    });
    const run = reference.controlRef as AgentExactRunControlRef;
    const material = { operationId: "cancel-operation", run };
    const request = {
      ...material,
      requestDigest: agentRunCancellationRequestDigest(material),
    };

    await expect(session.cancelRun!(request)).resolves.toMatchObject({
      status: "accepted",
      run,
    });
    await expect(session.cancelRun!(request)).resolves.toMatchObject({
      status: "replayed",
      run,
    });
    expect(cancelRun).toHaveBeenCalledTimes(2);

    cancelRun.mockResolvedValueOnce({
      ...request,
      status: "accepted",
      effect: "cancelled",
      run: { ...run, sessionId: "another-session" },
    });
    await expect(session.cancelRun!(request)).rejects.toThrow(
      /acknowledgement for another run, session, execution, or request/,
    );
    expect(executionId).toBe(run.executionId);
  });

  it("passes retained reconnect conformance with exact event identities", async () => {
    let executionId: string | undefined;
    const sandboxSession: SandboxSessionLike = {
      id: "conformance-session",
      status: async () => ({ status: "completed" }),
      async *events(options) {
        const events = [
          {
            id: "conformance-event-1",
            type: "status",
            data: {
              executionId,
              sessionId: "conformance-session",
              status: "running",
            },
          },
          {
            id: "conformance-event-2",
            type: "result",
            data: {
              executionId,
              sessionId: "conformance-session",
            },
          },
        ] as SandboxEvent[];
        const start = options?.since === "conformance-event-1" ? 1 : 0;
        for (const event of events.slice(start)) yield event;
      },
      result: async (_options) => ({
        success: true,
        status: "success",
        executionId,
        response: "ok",
        durationMs: 1,
      }),
      prompt: async (_message, options) => ({
        success: true,
        status: "success",
        executionId: echoedExecution(options),
        response: "ok",
        durationMs: 1,
      }),
      interrupt: async () => ({ cancelled: true }),
      cancelRun: async (request) => ({
        operationId: request.operationId,
        requestDigest: request.requestDigest,
        run: request.run,
        status: "accepted",
        effect: "not_live",
      }),
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: "conformance-environment",
      async *streamPrompt(_message, options) {
        if (options?.executionId !== executionId) {
          throw new Error("unknown exact execution");
        }
        const events = [
          {
            id: "conformance-event-1",
            type: "status",
            data: {
              executionId,
              sessionId: "conformance-session",
              status: "running",
            },
          },
          {
            id: "conformance-event-2",
            type: "result",
            data: {
              executionId,
              sessionId: "conformance-session",
            },
          },
        ] as SandboxEvent[];
        const start = options?.lastEventId === "conformance-event-1" ? 1 : 0;
        for (const event of events.slice(start)) yield event;
      },
      dispatchPrompt: async (_message, options) => {
        executionId = echoedExecution(options);
        return {
          sessionId: options?.sessionId ?? sandboxSession.id,
          executionId,
          runControlRef: options?.runControlRef,
          status: "running",
          alreadyExisted: false,
          dispatched: true,
        };
      },
      session: () => sandboxSession,
    });
    const provider = createTangleProvider({
      client: sdkShapedClient({
        create: async () => box,
        get: async (id) => (id === box.id ? box : null),
      }),
    });

    await expect(
      runSessionReplayConformance({
        name: "tangle-retained",
        createProvider: () => provider,
        turn: {
          prompt: "reconnect me",
          sessionId: sandboxSession.id,
          turnId: "conformance-turn",
        },
        reconnect: async (reference) => {
          const environment = await provider.create({
            profile: { name: "reconnected" },
          });
          return environment.session!(reference.id, {
            controlRef: reference.controlRef,
          });
        },
      }),
    ).resolves.toMatchObject({
      sessionId: sandboxSession.id,
      checked: expect.arrayContaining(["stable-event-ids", "reconnected-replay"]),
    });
  });
});
