import { describe, expect, it, vi } from "vitest";
import {
  AgentEnvironmentCapabilitiesSchema,
  AgentNativeContextContinuationResultSchema,
  AGENT_ENVIRONMENT_CREATE_MAX_RECORDS,
  AgentEnvironmentCreateRetryBlockedError,
  attachAgentEnvironmentCreateRetention,
  awaitAgentEnvironmentWithSignal,
  agentNativeContextContinuationResultMatchesRequest,
  agentEnvironmentCreateInputDigest,
  createAgentEnvironmentResource,
  createAgentEnvironmentWithIdempotency,
  snapshotAgentEnvironmentCreateInput,
  withoutAgentEnvironmentCreateSignal,
} from "./environment-provider.js";
import type {
  AgentEnvironment,
  AgentEnvironmentCreateIdempotencyRecord,
  CreateAgentEnvironmentInput,
} from "./environment-provider.js";
import {
  nativeContextContinuationRequestDigest,
  nativeContextContinuationTurnDigest,
} from "./portable-context.js";

const capabilities = {
  profile: {
    namedProfiles: true,
    systemPrompt: { replace: true, append: true },
    instructions: true,
    tools: true,
    permissions: true,
    mcp: true,
    subagents: true,
    resources: { files: true, instructions: true },
    runtimeUpdate: true,
    validation: true,
  },
  streaming: {
    live: true,
    replay: true,
    detach: true,
    turnIdempotency: true,
  },
  sessions: { continue: true, list: true, messages: true },
  nativeContinuation: { atomicBoundary: true, requestIdempotency: true },
  workspace: {
    read: true,
    write: true,
    exec: true,
    git: true,
    upload: true,
    download: true,
  },
  branching: {
    checkpoint: true,
    fork: true,
    retrySafe: true,
    lookup: true,
    cleanup: true,
  },
  placement: true,
  usage: true,
  confidential: false,
  exactProcess: { egress: ["blocked", "strict"] as const },
  observation: {
    identity: true,
    lifecycle: true,
    endpoint: true,
    placement: true,
    resources: true,
    resourceUse: true,
    modelUsage: true,
    computeBilling: true,
    accountUsage: true,
  },
  interactiveTerminal: {
    attach: true,
    input: true,
    resize: true,
    reattach: true,
  },
};

describe("generic environment create idempotency", () => {
  const input = {
    profile: { name: "worker" },
    metadata: { z: 1, a: 2 },
    idempotencyKey: "create-1",
    signal: new AbortController().signal,
  };

  it("uses canonical create material without the key or attempt signal", () => {
    expect(
      agentEnvironmentCreateInputDigest(input),
    ).toBe(
      agentEnvironmentCreateInputDigest({
        signal: new AbortController().signal,
        idempotencyKey: "create-1",
        metadata: { a: 2, z: 1 },
        profile: { name: "worker" },
      }),
    );
    expect(
      agentEnvironmentCreateInputDigest({ ...input, metadata: { a: 3, z: 1 } }),
    ).not.toBe(agentEnvironmentCreateInputDigest(input));
  });

  it("coalesces same-key retries and rejects changed input", async () => {
    const records = new Map<
      string,
      AgentEnvironmentCreateIdempotencyRecord<{ id: string }>
    >();
    const create = vi.fn(async () => ({ id: "environment-1" }));

    const first = await createAgentEnvironmentWithIdempotency(
      records,
      input,
      create,
    );
    const replay = await createAgentEnvironmentWithIdempotency(
      records,
      {
        profile: { name: "worker" },
        metadata: { a: 2, z: 1 },
        idempotencyKey: "create-1",
        signal: new AbortController().signal,
      },
      create,
    );

    expect(replay).toBe(first);
    expect(create).toHaveBeenCalledOnce();
    await expect(
      createAgentEnvironmentWithIdempotency(
        records,
        { ...input, metadata: { a: 3, z: 1 } },
        create,
      ),
    ).rejects.toThrow(/conflicts with a different create input/);
    expect(create).toHaveBeenCalledOnce();

    const aborted = new AbortController();
    aborted.abort(new Error("retry cancelled"));
    await expect(
      createAgentEnvironmentWithIdempotency(
        records,
        { ...input, signal: aborted.signal },
        create,
      ),
    ).rejects.toThrow("retry cancelled");
  });

  it("snapshots caller input before the provider callback runs", async () => {
    const records = new Map<
      string,
      AgentEnvironmentCreateIdempotencyRecord<{ id: string }>
    >();
    const original = {
      profile: { name: "before" },
      metadata: { owner: "before" },
      idempotencyKey: "snapshot-1",
    };
    const create = vi.fn(async (snapshot: CreateAgentEnvironmentInput) => ({
      id: `${(snapshot.profile as { name: string }).name}:${(snapshot.metadata as { owner: string }).owner}`,
    }));
    const firstPromise = createAgentEnvironmentWithIdempotency(
      records,
      original,
      create,
    );
    original.profile.name = "after";
    original.metadata.owner = "after";

    await expect(firstPromise).resolves.toEqual({ id: "before:before" });
    await expect(
      createAgentEnvironmentWithIdempotency(
        records,
        {
          profile: { name: "before" },
          metadata: { owner: "before" },
          idempotencyKey: "snapshot-1",
        },
        create,
      ),
    ).resolves.toEqual({ id: "before:before" });
    expect(create).toHaveBeenCalledOnce();
  });

  it("gives each coalesced caller an independent abortable wait", async () => {
    const records = new Map<
      string,
      AgentEnvironmentCreateIdempotencyRecord<{ id: string }>
    >();
    let resolveCreate!: (value: { id: string }) => void;
    const create = vi.fn(
      () => new Promise<{ id: string }>((resolve) => { resolveCreate = resolve; }),
    );
    const keyedInput = { profile: { name: "worker" }, idempotencyKey: "wait-1" };
    const first = createAgentEnvironmentWithIdempotency(records, keyedInput, create);
    const controller = new AbortController();
    const retry = createAgentEnvironmentWithIdempotency(
      records,
      { ...keyedInput, signal: controller.signal },
      create,
    );
    controller.abort(new Error("retry waiter cancelled"));
    await expect(retry).rejects.toThrow("retry waiter cancelled");
    resolveCreate({ id: "environment-1" });
    await expect(first).resolves.toEqual({ id: "environment-1" });
    expect(create).toHaveBeenCalledOnce();
  });

  it("retains a late operation after the first caller aborts", async () => {
    const records = new Map<
      string,
      AgentEnvironmentCreateIdempotencyRecord<{ id: string }>
    >();
    let resolveCreate!: (value: { id: string }) => void;
    const create = vi.fn(
      (attempt: CreateAgentEnvironmentInput) => {
        expect(attempt.signal).toBeUndefined();
        return new Promise<{ id: string }>((resolve) => { resolveCreate = resolve; });
      },
    );
    const controller = new AbortController();
    const first = createAgentEnvironmentWithIdempotency(
      records,
      {
        profile: { name: "worker" },
        idempotencyKey: "late-1",
        signal: controller.signal,
      },
      create,
    );
    const retry = createAgentEnvironmentWithIdempotency(
      records,
      { profile: { name: "worker" }, idempotencyKey: "late-1" },
      create,
    );
    controller.abort(new Error("first waiter cancelled"));
    await expect(first).rejects.toThrow("first waiter cancelled");
    resolveCreate({ id: "environment-1" });
    await expect(retry).resolves.toEqual({ id: "environment-1" });
    expect(create).toHaveBeenCalledOnce();
  });

  it("does not let a keyed caller abort the shared provider attempt", async () => {
    const records = new Map<
      string,
      AgentEnvironmentCreateIdempotencyRecord<{ id: string }>
    >();
    const controller = new AbortController();
    const create = vi.fn(async (attempt: CreateAgentEnvironmentInput) => {
      expect(attempt.signal).toBeUndefined();
      return { id: "environment-1" };
    });
    const first = createAgentEnvironmentWithIdempotency(
      records,
      { profile: { name: "worker" }, idempotencyKey: "signal-1", signal: controller.signal },
      create,
    );
    controller.abort(new Error("first waiter cancelled"));
    await expect(first).rejects.toThrow("first waiter cancelled");
    await expect(
      createAgentEnvironmentWithIdempotency(
        records,
        { profile: { name: "worker" }, idempotencyKey: "signal-1" },
        create,
      ),
    ).resolves.toEqual({ id: "environment-1" });
    expect(create).toHaveBeenCalledOnce();
    expect(withoutAgentEnvironmentCreateSignal({ signal: controller.signal })).toEqual({});
  });

  it("bounds retention and freezes replay identity", async () => {
    const records = new Map<
      string,
      AgentEnvironmentCreateIdempotencyRecord<{
        id: string;
        metadata: { value: string };
      }>
    >();
    const create = vi.fn(async (input: { idempotencyKey?: string }) => ({
      id: input.idempotencyKey ?? "unkeyed",
      metadata: { value: "stable" },
    }));
    const first = await createAgentEnvironmentWithIdempotency(
      records,
      { profile: { name: "worker" }, idempotencyKey: "retained-0" },
      create,
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.metadata)).toBe(true);
    expect(() => {
      first.metadata.value = "changed";
    }).toThrow();

    for (let index = 1; index <= AGENT_ENVIRONMENT_CREATE_MAX_RECORDS; index += 1) {
      await createAgentEnvironmentWithIdempotency(
        records,
        { profile: { name: "worker" }, idempotencyKey: `retained-${index}` },
        create,
      );
    }
    expect(records.size).toBe(AGENT_ENVIRONMENT_CREATE_MAX_RECORDS);
  });

  it("does not let an evicted keyed handle destroy a later replay", async () => {
    const records = new Map<
      string,
      AgentEnvironmentCreateIdempotencyRecord<AgentEnvironment>
    >();
    const destroyed = vi.fn(async () => {});
    const create = vi.fn(async (input: CreateAgentEnvironmentInput) => {
      const environment: AgentEnvironment = {
        id: input.idempotencyKey ?? "unkeyed",
        provider: "test",
        status: async () => "running",
        async *stream() {},
        destroy: destroyed,
      };
      return attachAgentEnvironmentCreateRetention(
        environment,
        records,
        input.idempotencyKey,
      );
    });
    const first = await createAgentEnvironmentWithIdempotency(
      records,
      { profile: { name: "worker" }, idempotencyKey: "evicted-0" },
      create,
    );
    for (let index = 1; index <= AGENT_ENVIRONMENT_CREATE_MAX_RECORDS; index += 1) {
      await createAgentEnvironmentWithIdempotency(
        records,
        { profile: { name: "worker" }, idempotencyKey: `evicted-${index}` },
        create,
      );
    }

    if (!first.destroy) throw new Error("test environment must be destroyable");
    await expect(first.destroy()).rejects.toBeInstanceOf(
      AgentEnvironmentCreateRetryBlockedError,
    );
    expect(destroyed).not.toHaveBeenCalled();
  });

  it("rejects oversized canonical input before hashing", () => {
    let value: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 32; index += 1) value = { next: value };
    expect(() => snapshotAgentEnvironmentCreateInput({
      profile: { name: "worker" },
      metadata: value,
      idempotencyKey: "deep-1",
    })).toThrow(/exceeds the contract bounds/);
  });

  it("waits for non-aborted operations without changing their result", async () => {
    await expect(
      awaitAgentEnvironmentWithSignal(Promise.resolve("ready")),
    ).resolves.toBe("ready");
  });

  it("cleans an already-started allocation when the signal is pre-aborted", async () => {
    const controller = new AbortController();
    const cleanup = vi.fn(async () => {});
    controller.abort(new Error("allocation cancelled"));

    await expect(
      createAgentEnvironmentResource(
        Promise.resolve({ id: "allocated" }),
        controller.signal,
        () => ({ id: "mapped" }),
        cleanup,
      ),
    ).rejects.toThrow("allocation cancelled");
    expect(cleanup).toHaveBeenCalledWith({ id: "allocated" });
  });
});

describe("AgentEnvironmentCapabilitiesSchema", () => {
  it("accepts a complete strict capability document", () => {
    expect(AgentEnvironmentCapabilitiesSchema.parse(capabilities)).toEqual(
      capabilities,
    );
  });

  it("rejects malformed booleans and unknown capability fields", () => {
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        workspace: { ...capabilities.workspace, read: "yes" },
      }),
    ).toThrow();
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        providerNativeBypass: true,
      }),
    ).toThrow();
  });

  it("requires both system-prompt intents to be declared independently", () => {
    for (const systemPrompt of [
      true,
      false,
      { replace: true },
      { append: true },
      { replace: true, append: true, prepend: true },
    ]) {
      expect(() =>
        AgentEnvironmentCapabilitiesSchema.parse({
          ...capabilities,
          profile: { ...capabilities.profile, systemPrompt },
        }),
      ).toThrow();
    }

    for (const systemPrompt of [
      { replace: false, append: false },
      { replace: false, append: true },
      { replace: true, append: false },
      { replace: true, append: true },
    ]) {
      const document = {
        ...capabilities,
        profile: { ...capabilities.profile, systemPrompt },
      };
      expect(AgentEnvironmentCapabilitiesSchema.parse(document)).toEqual(
        document,
      );
    }
  });

  it("requires durable branching features to be all-or-nothing", () => {
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        branching: {
          ...capabilities.branching,
          cleanup: false,
        },
      }),
    ).toThrow(/requires checkpoint, fork, lookup, and cleanup together/);
  });

  it("requires native continuation admission and retry safety together", () => {
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        nativeContinuation: { atomicBoundary: true, requestIdempotency: false },
      }),
    ).toThrow(/requires session continuation, atomic boundary admission, and request idempotency together/);
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        sessions: { ...capabilities.sessions, continue: false },
      }),
    ).toThrow(/requires session continuation/);
  });

  it("advertises retained run control only with every identity guarantee", () => {
    const retainedControl = {
      exactRunIdentity: true,
      resultIdentity: true,
      eventIdentity: true,
      cancellationIdempotency: true,
    };
    expect(
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        retainedControl,
      }),
    ).toMatchObject({ retainedControl });
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        retainedControl: { ...retainedControl, resultIdentity: false },
      }),
    ).toThrow(/retained control requires exact run/);
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        streaming: { ...capabilities.streaming, detach: false },
        retainedControl,
      }),
    ).toThrow(/retained control requires exact run/);
  });

  it("accepts observation surfaces declared independently", () => {
    for (const observation of [
      {
        identity: false,
        lifecycle: false,
        endpoint: true,
        placement: false,
        resources: false,
        resourceUse: false,
        modelUsage: false,
        computeBilling: false,
        accountUsage: false,
      },
      {
        identity: true,
        lifecycle: true,
        endpoint: false,
        placement: true,
        resources: true,
        resourceUse: false,
        modelUsage: true,
        computeBilling: false,
        accountUsage: true,
      },
    ]) {
      const document = { ...capabilities, observation };
      expect(AgentEnvironmentCapabilitiesSchema.parse(document)).toEqual(document);
    }
  });

  it("requires interactive terminal input, resize, and reattach to imply attach", () => {
    for (const interactiveTerminal of [
      { attach: false, input: true, resize: false, reattach: false },
      { attach: false, input: false, resize: true, reattach: false },
      { attach: false, input: false, resize: false, reattach: true },
    ]) {
      expect(() =>
        AgentEnvironmentCapabilitiesSchema.parse({
          ...capabilities,
          interactiveTerminal,
        }),
      ).toThrow(/input, resize, and reattach each require attach/);
    }
    const attachOnly = {
      ...capabilities,
      interactiveTerminal: {
        attach: true,
        input: false,
        resize: false,
        reattach: false,
      },
    };
    expect(AgentEnvironmentCapabilitiesSchema.parse(attachOnly)).toEqual(attachOnly);
  });

  it("requires interactive agent controls to name the operations they depend on", () => {
    const complete = {
      start: true,
      control: true,
      status: true,
      attach: true,
      reattach: true,
      sendPrompt: true,
      input: true,
      resize: true,
      stop: true,
    };
    expect(
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        interactiveAgent: complete,
      }),
    ).toMatchObject({ interactiveAgent: complete });

    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        interactiveAgent: { ...complete, start: false },
      }),
    ).toThrow(/each require start/);
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        interactiveAgent: { ...complete, attach: false },
      }),
    ).toThrow(/each require attach/);
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        interactiveAgent: { ...complete, control: false },
      }),
    ).toThrow(/provider-issued control claims/);
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        interactiveAgent: { ...complete, input: "yes" },
      }),
    ).toThrow();
  });

  it("rejects duplicate open capability values", () => {
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        profile: {
          ...capabilities.profile,
          extensions: ["vendor", "vendor"],
        },
      }),
    ).toThrow(/extension namespaces must be unique/);
    expect(() =>
      AgentEnvironmentCapabilitiesSchema.parse({
        ...capabilities,
        exactProcess: { egress: ["blocked", "blocked"] },
      }),
    ).toThrow(/egress modes must be unique/);
  });
});

describe("AgentNativeContextContinuationResultSchema", () => {
  const run = {
    runId: "run-before",
    provider: "cli-bridge",
    environmentId: "environment-1",
    sessionId: "session-1",
    executionId: "execution-before",
    requestDigest: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
  };
  const expectedBoundary = {
    runId: run.runId,
    provider: run.provider,
    environmentId: run.environmentId,
    sessionId: run.sessionId,
    executionId: run.executionId,
    requestDigest: run.requestDigest,
    boundary: { kind: "revision" as const, revision: "revision-before" },
    observedAt: "2026-08-01T20:00:00.000Z",
  };
  const material = {
    operationId: "continue-1",
    turnDigest: nativeContextContinuationTurnDigest({ prompt: "continue" }),
    run,
    expectedBoundary,
  };
  const request = {
    ...material,
    requestDigest: nativeContextContinuationRequestDigest(material),
  };
  const outcome = {
    acknowledgement: {
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      status: "accepted" as const,
      historyMessagesSent: 0,
      actualBoundary: expectedBoundary,
    },
    result: { text: "done", success: true, sessionId: run.sessionId },
    controlRef: {
      ...run,
      runId: "run-after",
      executionId: "execution-after",
      requestDigest: `sha256:${"b".repeat(64)}` as `sha256:${string}`,
    },
  };

  it("validates and exactly binds a successful continuation outcome", () => {
    const parsed = AgentNativeContextContinuationResultSchema.parse(outcome);
    expect("controlRef" in parsed).toBe(true);
    if (!("controlRef" in parsed)) throw new Error("expected successful outcome");
    expect(
      agentNativeContextContinuationResultMatchesRequest(request, parsed),
    ).toBe(true);
    expect(
      agentNativeContextContinuationResultMatchesRequest(request, {
        ...parsed,
        controlRef: { ...parsed.controlRef, sessionId: "wrong-session" },
      }),
    ).toBe(false);
  });

  it("requires current control coordinates only for successful outcomes", () => {
    expect(() =>
      AgentNativeContextContinuationResultSchema.parse({
        acknowledgement: outcome.acknowledgement,
        result: outcome.result,
      }),
    ).toThrow();
    expect(
      AgentNativeContextContinuationResultSchema.parse({
        acknowledgement: {
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          status: "unknown_session",
          historyMessagesSent: 0,
        },
      }),
    ).toMatchObject({ acknowledgement: { status: "unknown_session" } });
    expect(() =>
      AgentNativeContextContinuationResultSchema.parse({
        acknowledgement: {
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          status: "unknown_session",
          historyMessagesSent: 0,
        },
        result: outcome.result,
      }),
    ).toThrow();
    expect(() =>
      AgentNativeContextContinuationResultSchema.parse({
        acknowledgement: {
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          status: "transport_failure",
          historyMessagesSent: 0,
          message: "outcome unknown",
          retryable: false,
        },
      }),
    ).toThrow(/must be retryable/);
  });
});
