import { describe, expect, it, vi } from "vitest";
import {
  runAgentEnvironmentProviderConformance,
  runAgentExactProcessProviderLifecycleChecks,
} from "@tangle-network/agent-provider-testkit";
import type {
  CreateSandboxOptions,
  Sandbox,
  SandboxEvent,
} from "@tangle-network/sandbox";
import {
  createTangleProvider,
  defaultTangleSandboxCapabilities,
  type SandboxClientLike,
  type SandboxInstanceLike,
  type SandboxSessionLike,
} from "./index.js";
import { tokenUsageFromData } from "./tangle-result-values.js";
import {
  controlRefForTurn,
  executionIdForTurn,
  retainedDeployment,
  retainedSessionHandle,
  TANGLE_PROVIDER,
} from "./retained-control-test-helpers.js";

const EXACT_IMAGE = `example/image@sha256:${"1".repeat(64)}`;
const EXACT_RESOURCES = { cpu: 1, memoryMb: 512, diskMb: 1024 } as const;
const TEST_REQUEST_DIGEST = `sha256:${"e".repeat(64)}` as `sha256:${string}`;

type ExactCreateOptions = CreateSandboxOptions & {
  agent?: boolean;
  driver?: { type: string; runtimeBackend?: string };
  egressPolicy?: {
    mode: string;
    allowDomains?: string[];
    includeImplicitDomains?: boolean;
  };
};

function acceptCurrentSandboxClient(client: Sandbox): SandboxClientLike {
  return client;
}

void acceptCurrentSandboxClient;

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}

describe("createTangleProvider", () => {
  it("refuses to advertise exact processes without the exact adapter", async () => {
    const provider = createTangleProvider({
      client: {
        async create() {
          throw new Error("not called");
        },
      },
      capabilities: {
        ...defaultTangleSandboxCapabilities(),
        exactProcess: { egress: ["blocked"] },
      },
    });

    await expect(provider.capabilities()).rejects.toThrow(
      "cannot advertise exactProcess",
    );
    expect(defaultTangleSandboxCapabilities()).not.toHaveProperty(
      "exactProcess",
    );
    expect(defaultTangleSandboxCapabilities().workspace.cwdBases).toEqual({
      repository: true,
      host: false,
    });
  });

  it("declares the prompt intents of the sandbox's harness, and neither without one", async () => {
    // Forwarding the whole profile makes both fields expressible on the wire, which is NOT the same
    // as honoring them: the sandbox materializer refuses the intent its harness has no control for.
    // Declaring `{ replace: true, append: true }` unconditionally would tell a caller running an
    // opencode sandbox that a replacement lands, and it is refused there.
    expect(defaultTangleSandboxCapabilities("claude-code").profile.systemPrompt).toEqual({
      replace: true,
      append: true,
    });
    expect(defaultTangleSandboxCapabilities("opencode").profile.systemPrompt).toEqual({
      replace: false,
      append: true,
    });
    expect(defaultTangleSandboxCapabilities("codex").profile.systemPrompt).toEqual({
      replace: true,
      append: false,
    });
    expect(defaultTangleSandboxCapabilities("gemini").profile.systemPrompt).toEqual({
      replace: true,
      append: false,
    });
    expect(defaultTangleSandboxCapabilities().profile.systemPrompt).toEqual({
      replace: false,
      append: false,
    });

    // Whatever it declares still has to pass the capability schema at the provider boundary.
    const provider = createTangleProvider({
      client: {
        async create() {
          throw new Error("not called");
        },
      },
      capabilities: defaultTangleSandboxCapabilities("opencode"),
    });
    await expect(provider.capabilities()).resolves.toMatchObject({
      profile: { systemPrompt: { replace: false, append: true } },
    });
  });

  it("reuses a keyed generic create and rejects changed input", async () => {
    const box: SandboxInstanceLike = {
      id: "sbx-generic-idempotency",
      status: "running",
      async *streamPrompt() {},
    };
    const create = vi.fn(async (_options?: CreateSandboxOptions) => box);
    const provider = createTangleProvider({ client: { create } });
    const input = {
      profile: { name: "worker" },
      metadata: { z: "last", a: "first" },
      name: "environment",
      idempotencyKey: "environment-create-1",
    };

    const first = await provider.create(input);
    const replay = await provider.create({
      idempotencyKey: input.idempotencyKey,
      name: input.name,
      metadata: { a: "first", z: "last" },
      profile: { name: "worker" },
    });

    expect(first.creation).toBeUndefined();
    expect(replay.creation).toBe("replayed");
    expect(replay.id).toBe(first.id);
    expect(replay.stream).toBe(first.stream);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: input.idempotencyKey,
    });
    await expect(
      provider.create({ ...input, name: "different-environment" }),
    ).rejects.toThrow(/conflicts with a different create input/);
    expect(create).toHaveBeenCalledOnce();
  });

  it("retries a failed keyed create with the same workspace material", async () => {
    const box: SandboxInstanceLike = {
      id: "sbx-workspace-retry",
      status: "running",
      async *streamPrompt() {},
    };
    const createOptions: CreateSandboxOptions[] = [];
    let attempts = 0;
    const create = vi.fn(async (options?: CreateSandboxOptions) => {
      createOptions.push(options ?? {});
      attempts += 1;
      if (attempts === 1) throw new Error("transient create failure");
      return box;
    });
    const provider = createTangleProvider({ client: { create } });
    const input = {
      profile: { name: "worker" },
      workspace: {
        environment: "universal",
        repoUrl: "https://github.com/tangle-network/agent-sdk.git",
        gitRef: "main",
        cwd: {
          base: "repository" as const,
          path: "packages/agent-provider-tangle",
        },
      },
      idempotencyKey: "workspace-retry",
    };

    await expect(provider.create(input)).rejects.toThrow("transient create failure");
    await provider.create(input);

    expect(create).toHaveBeenCalledTimes(2);
    expect(createOptions[1]).toEqual(createOptions[0]);
    expect(createOptions[1]).toMatchObject({
      environment: "universal",
      cwd: "packages/agent-provider-tangle",
      git: {
        url: "https://github.com/tangle-network/agent-sdk.git",
        ref: "main",
      },
    });
  });

  it("maps the platform create receipt to the environment creation verdict", async () => {
    const boxWithReceipt = (
      id: string,
      receipt: { outcome: "created" | "idempotent_replay" | "unknown"; idempotencyKeyApplied: boolean } | null,
    ): SandboxInstanceLike => ({
      id,
      status: "running",
      async *streamPrompt() {},
      createReceipt: () => receipt,
    });
    const environmentFor = async (box: SandboxInstanceLike) => {
      const provider = createTangleProvider({ client: { create: async () => box } });
      return provider.create({ profile: { name: "worker" } });
    };

    const created = await environmentFor(
      boxWithReceipt("sbx-created", { outcome: "created", idempotencyKeyApplied: true }),
    );
    expect(created.creation).toBe("created");

    const replayed = await environmentFor(
      boxWithReceipt("sbx-replayed", { outcome: "idempotent_replay", idempotencyKeyApplied: true }),
    );
    expect(replayed.creation).toBe("replayed");

    const unknown = await environmentFor(
      boxWithReceipt("sbx-unknown", { outcome: "unknown", idempotencyKeyApplied: false }),
    );
    expect(unknown.creation).toBeUndefined();

    const noReceipt = await environmentFor(
      boxWithReceipt("sbx-no-receipt", null),
    );
    expect(noReceipt.creation).toBeUndefined();

    const oldSdk = await environmentFor({
      id: "sbx-old-sdk",
      status: "running",
      async *streamPrompt() {},
    });
    expect(oldSdk.creation).toBeUndefined();
  });

  it("does not let a custom mapper drop the generic create key", async () => {
    const create = vi.fn(async () => {
      throw new Error("not called");
    });
    const provider = createTangleProvider({
      client: { create },
      mapCreateInput: () => ({}),
    });

    await expect(
      provider.create({
        profile: { name: "worker" },
        idempotencyKey: "environment-create-1",
      }),
    ).rejects.toThrow("must preserve input idempotencyKey");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects malformed configured capabilities at the provider boundary", async () => {
    const provider = createTangleProvider({
      client: {
        async create() {
          throw new Error("not called");
        },
      },
      capabilities: {
        ...defaultTangleSandboxCapabilities(),
        workspace: {
          ...defaultTangleSandboxCapabilities().workspace,
          read: "yes",
        },
      } as never,
    });

    await expect(provider.capabilities()).rejects.toThrow();
  });

  it("derives provider placement capability from the client", async () => {
    const withoutPlacement = createTangleProvider({
      client: { create: async () => ({ id: "sbx-no-placement", async *streamPrompt() {} }) },
    });
    await expect(withoutPlacement.capabilities()).resolves.toMatchObject({
      placement: false,
    });

    const withPlacement = createTangleProvider({
      client: {
        create: async () => ({ id: "sbx-placement", async *streamPrompt() {} }),
        describePlacement: () => ({ kind: "local" }),
      },
    });
    await expect(withPlacement.capabilities()).resolves.toMatchObject({
      placement: true,
    });
  });

  it("does not expose operations whose capabilities are disabled", async () => {
    const box: SandboxInstanceLike = {
      id: "sbx-disabled",
      status: "running",
      async *streamPrompt() {},
      dispatchPrompt: async () => ({
        sessionId: "session-disabled",
        executionId: "execution-disabled",
      }),
      session: (id) => ({
        id,
        status: async () => ({ status: "completed" }),
        async *events() {},
        result: async () => ({
          success: true,
          status: "success",
          durationMs: 1,
        }),
        prompt: async () => ({
          success: true,
          status: "success",
          durationMs: 1,
        }),
        interrupt: async () => ({ cancelled: true }),
      }),
      read: async () => "",
      write: async () => ({ path: "ignored", written: true }),
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    };
    const baseline = defaultTangleSandboxCapabilities();
    const provider = createTangleProvider({
      client: { create: async () => box },
      capabilities: {
        ...baseline,
        streaming: { ...baseline.streaming, detach: false, replay: false },
        sessions: { ...baseline.sessions, continue: false },
        workspace: {
          ...baseline.workspace,
          read: false,
          write: false,
          exec: false,
        },
        branching: { checkpoint: false, fork: false },
        placement: false,
      },
    });

    const environment = await provider.create({ profile: { name: "worker" } });
    for (const operation of [
      "dispatch",
      "session",
      "read",
      "write",
      "exec",
      "checkpoint",
      "fork",
      "placement",
      "destroy",
    ] as const) {
      expect(environment[operation]).toBeUndefined();
    }
  });

  it("exposes destroy only when the sandbox delete operation exists", async () => {
    const deleted = vi.fn(async () => {});
    const box: SandboxInstanceLike = {
      id: "sbx-delete",
      status: "running",
      async *streamPrompt() {},
      delete: deleted,
    };
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    expect(environment.destroy).toBeDefined();
    await environment.destroy?.();
    expect(deleted).toHaveBeenCalledOnce();
  });

  it("checks abort signals after provider effects return", async () => {
    const createAbort = new AbortController();
    const box: SandboxInstanceLike = {
      id: "sbx-abort-create",
      status: "running",
      async *streamPrompt() {},
      exec: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    };
    const provider = createTangleProvider({
      client: {
        create: async () => {
          createAbort.abort(new Error("create finished after abort"));
          return box;
        },
      },
    });
    await expect(
      provider.create({
        profile: { name: "worker" },
        signal: createAbort.signal,
      }),
    ).rejects.toThrow("create finished after abort");

    const environment = await createTangleProvider({
      client: { create: async () => box },
    }).create({ profile: { name: "worker" } });
    const execAbort = new AbortController();
    box.exec = async () => {
      execAbort.abort(new Error("exec finished after abort"));
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    await expect(
      environment.exec?.("true", { signal: execAbort.signal }),
    ).rejects.toThrow("exec finished after abort");
  });

  it("preserves an awaiting interaction as non-terminal session state", async () => {
    const environmentId = "sbx-awaiting";
    const sessionId = "session-awaiting";
    const controlRef = controlRefForTurn(
      { prompt: "awaiting question", turnId: "awaiting-turn" },
      environmentId,
      sessionId,
    );
    const sandboxSession: SandboxSessionLike = {
      id: sessionId,
      status: async () => ({ status: "awaiting_question" }),
      async *events() {},
      result: async () => ({
        success: false,
        status: "awaiting_question",
        executionId: controlRef.executionId,
        response: "What should I do?",
        durationMs: 1,
      }),
      prompt: async () => {
        throw new Error("not called");
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
    const session = environment.session!(sandboxSession.id, {
      controlRef,
    });

    await expect(session.result()).resolves.toMatchObject({
      text: "What should I do?",
      success: false,
      metadata: {
        status: "awaiting_question",
        awaitingInteraction: true,
        terminal: false,
      },
    });
  });

  it("reports only explicit usage and never sums duplicate aliases", () => {
    expect(
      tokenUsageFromData({ inputTokens: 11, outputTokens: 7 }),
    ).toBeUndefined();
    expect(
      tokenUsageFromData({
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadInputTokens: 2,
          reasoningTokens: 3,
        },
        inputTokens: 100,
        outputTokens: 100,
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadInputTokens: 2,
      reasoningTokens: 3,
    });
  });

  it("maps ordinary agent environments", async () => {
    let createOptions: CreateSandboxOptions | undefined;
    let createRequestOptions: { signal?: AbortSignal; timeoutMs?: number } | undefined;
    const controller = new AbortController();
    const files = new Map<string, string>();
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-1",
      name: "sandbox-one",
      status: "running",
      metadata: {
        retainedIdempotencyKey: "environment-key",
        labels: { tenant: "acme" },
      },
      async *streamPrompt(prompt: string): AsyncIterable<SandboxEvent> {
        yield {
          type: "result",
          data: {
            finalText: `ok:${prompt}`,
            sessionId: "sandbox-session",
            usage: {
              inputTokens: 2,
              outputTokens: 3,
              totalCostUsd: 0.01,
            },
          },
        } as SandboxEvent;
      },
      dispatchPrompt: async (_prompt, options) => ({
        sessionId: (options as { sessionId?: string } | undefined)?.sessionId ?? "sess-1",
        executionId: options?.executionId,
        runControlRef: options?.runControlRef,
        status: "running",
        alreadyExisted: true,
      }),
      session: (id) => ({
        id,
        status: async () => ({ status: "completed" }),
        async *events() {},
        result: async (options) => ({
          success: true,
          status: "success",
          executionId: options?.executionId,
          durationMs: 1,
        }),
        prompt: async (_message, options) => ({
          success: true,
          status: "success",
          executionId: options?.executionId,
          durationMs: 1,
        }),
        interrupt: async () => ({ cancelled: true }),
      }),
      read: async (path) => files.get(path) ?? "",
      write: async (path, content) => {
        files.set(path, content);
        return { path, written: true };
      },
      exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }),
      delete: async () => {},
    });
    const client: SandboxClientLike = {
      async create(options, requestOptions) {
        createOptions = options;
        createRequestOptions = requestOptions;
        return box;
      },
      async get(id) {
        return id === box.id ? box : null;
      },
      describePlacement: () => ({ kind: "sibling", sandboxId: "sbx-1" }),
    };
    const provider = createTangleProvider({ client });

    await expect(
      runAgentEnvironmentProviderConformance({
        name: "sandbox",
        createProvider: () => provider,
        createInput: {
          profile: { name: "worker" },
          backend: "codex",
          workspace: { image: EXACT_IMAGE },
          signal: controller.signal,
        },
      }),
    ).resolves.toMatchObject({ provider: "tangle-sandbox" });

    expect(createOptions).toMatchObject({
      environment: EXACT_IMAGE,
      backend: { type: "codex", profile: { name: "worker" } },
    });
    expect(createRequestOptions?.signal).toBe(controller.signal);
    const environment = await provider.create({ profile: { name: "worker" } });
    expect(environment.metadata).toEqual({
      retainedIdempotencyKey: "environment-key",
      labels: { tenant: "acme" },
    });
    expect(Object.isFrozen(environment.metadata)).toBe(true);
    expect(Object.isFrozen(environment.metadata?.labels)).toBe(true);
    (box.metadata?.labels as { tenant: string }).tenant = "changed-at-source";
    expect(environment.metadata?.labels).toEqual({ tenant: "acme" });

    const reconstructed = await provider.get?.("sbx-1");
    expect(reconstructed?.metadata?.labels).toEqual({ tenant: "changed-at-source" });
    expect(Object.isFrozen(reconstructed?.metadata?.labels)).toBe(true);
    (box.metadata?.labels as { tenant: string }).tenant = "changed-after-reconstruction";
    expect(reconstructed?.metadata?.labels).toEqual({ tenant: "changed-at-source" });
  });

  it("rejects malformed Sandbox events and exec results", async () => {
    const box: SandboxInstanceLike = {
      id: "sbx-malformed",
      status: "running",
      async *streamPrompt() {
        yield { type: "result", data: "not-an-object" } as never;
      },
      exec: async () => ({}) as never,
    };
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(collect(environment.stream({ prompt: "hello" }))).rejects.toThrow(
      /event omitted its object data/,
    );
    await expect(environment.exec?.("true")).rejects.toThrow(
      /invalid exit code/,
    );

    const receiptProvider = createTangleProvider({
      client: {
        create: async () => ({
          id: "sbx-unsolicited-event",
          status: "running",
          async *streamPrompt() {
            yield {
              type: "result",
              data: { contextTransferReceipt: null },
            } as never;
          },
        }),
      },
    });
    const receiptEnvironment = await receiptProvider.create({
      profile: { name: "worker" },
    });
    await expect(
      collect(receiptEnvironment.stream({ prompt: "hello" })),
    ).rejects.toThrow(/unsolicited context transfer receipt/);
  });

  it("maps Sandbox session interruption to agent session cancellation", async () => {
    const interrupt = vi.fn(async () => ({ cancelled: true }));
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-session",
      async *streamPrompt(): AsyncIterable<SandboxEvent> {},
      dispatchPrompt: async (_prompt, options) => ({
        sessionId: options?.sessionId ?? "session-1",
        executionId: options?.executionId,
        runControlRef: options?.runControlRef,
      }),
      session: (id) => ({
        id,
        status: async () => ({
          status: "running",
          latestExecutionId: "execution-from-another-caller",
        }),
        async *events(): AsyncIterable<SandboxEvent> {},
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
    const dispatched = await environment.dispatch?.({
      prompt: "continue",
      sessionId: "session-1",
    });
    const session = environment.session?.("session-1", {
      controlRef: dispatched?.controlRef,
    });
    expect(session).toBeDefined();
    expect(dispatched?.controlRef).toMatchObject({
      runId: expect.stringMatching(/^session-turn-[a-f0-9]{64}$/),
      provider: TANGLE_PROVIDER,
      environmentId: "sbx-session",
      sessionId: "session-1",
      executionId: expect.stringMatching(/^session-turn-[a-f0-9]{64}$/),
      requestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(session?.controlRef).toEqual(dispatched?.controlRef);
    await session?.cancel();

    expect(interrupt).toHaveBeenCalledWith({
      executionId: dispatched?.controlRef?.executionId,
    });
  });

  it("advances a retained session to the exact execution started by prompt", async () => {
    let promptExecutionId: string | undefined;
    let resultExecutionId: string | undefined;
    let admitDifferentExecution = false;
    const sandboxSession: SandboxSessionLike = {
      id: "session-advance",
      status: async () => ({
        status: "completed",
        latestExecutionId: "execution-from-another-caller",
      }),
      async *events(): AsyncIterable<SandboxEvent> {},
      result: async (options) => {
        resultExecutionId = options?.executionId;
        return {
          success: true,
          status: "success",
          executionId: options?.executionId,
          response: "current result",
          durationMs: 1,
        };
      },
      prompt: async (_message, options) => {
        promptExecutionId = options?.executionId;
        return {
          success: true,
          status: "success",
          executionId: admitDifferentExecution
            ? "execution-from-another-caller"
            : promptExecutionId,
          response: "next result",
          durationMs: 1,
        };
      },
      interrupt: async () => ({ cancelled: true }),
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-session-advance",
      async *streamPrompt(): AsyncIterable<SandboxEvent> {},
      session: () => sandboxSession,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const initialControlRef = controlRefForTurn(
      { prompt: "initial turn", turnId: "initial-turn" },
      box.id,
      sandboxSession.id,
    );
    const session = environment.session!(sandboxSession.id, {
      controlRef: initialControlRef,
    });

    await expect(session.prompt({ prompt: 123 } as never)).rejects.toThrow();
    await expect(
      session.prompt({ prompt: "next", turnId: "turn-2" }),
    ).resolves.toMatchObject({ text: "next result", success: true });
    expect(promptExecutionId).toMatch(/^session-turn-[a-f0-9]{64}$/);
    expect(session.controlRef).toMatchObject({
      runId: promptExecutionId,
      executionId: promptExecutionId,
    });
    await expect(session.result()).resolves.toMatchObject({
      text: "current result",
      success: true,
    });
    expect(resultExecutionId).toBe(promptExecutionId);

    const resultMethod = sandboxSession.result;
    sandboxSession.result = async () => ({
      success: true,
      status: "success",
      executionId: "execution-from-another-caller",
      response: "wrong result",
      durationMs: 1,
    });
    await expect(session.result()).rejects.toThrow(
      /result did not confirm its exact executionId/,
    );
    sandboxSession.result = resultMethod;

    const advancedControlRef = session.controlRef;
    await expect(
      session.prompt({ prompt: "next", turnId: "turn-2", lastEventId: "event-1" }),
    ).resolves.toMatchObject({ text: "next result", success: true });
    expect(promptExecutionId).toBe(advancedControlRef?.executionId);
    expect(session.controlRef).toEqual(advancedControlRef);

    admitDifferentExecution = true;
    await expect(
      session.prompt({ prompt: "mismatched replay", lastEventId: "event-2" }),
    ).rejects.toThrow(/request digest conflicts/);
    expect(session.controlRef).toEqual(advancedControlRef);
    await expect(
      session.prompt({ prompt: "racing turn", turnId: "turn-3" }),
    ).rejects.toThrow(/did not confirm its exact executionId/);
    expect(session.controlRef).toEqual(advancedControlRef);
  });

  it("uses turnId, not prompt text, as the retry identity", async () => {
    const executionIds: string[] = [];
    const sandboxSession: SandboxSessionLike = {
      id: "session-turn-identity",
      status: async () => ({ status: "running" }),
      async *events() {},
      result: async () => ({
        success: true,
        status: "success",
        executionId: executionIds.at(-1),
        durationMs: 1,
      }),
      prompt: async (_message, options) => {
        executionIds.push(options!.executionId!);
        return {
          success: true,
          status: "success",
          executionId: options!.executionId,
          durationMs: 1,
        };
      },
      interrupt: async () => ({ cancelled: true }),
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-turn-identity",
      async *streamPrompt() {},
      session: () => sandboxSession,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const session = environment.session!(sandboxSession.id);

    await session.prompt({ prompt: "same text", turnId: "logical-turn" });
    await session.prompt({ prompt: "same text", turnId: "logical-turn" });
    await session.prompt({ prompt: "same text" });
    await session.prompt({ prompt: "same text" });

    expect(executionIds[0]).toBe(executionIds[1]);
    expect(executionIds[2]).not.toBe(executionIds[3]);
  });

  it("rejects dispatch without an immutable execution receipt", async () => {
    let statusCalls = 0;
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-delayed-execution",
      async *streamPrompt(): AsyncIterable<SandboxEvent> {},
      dispatchPrompt: async (_prompt, options) => ({
        sessionId: options?.sessionId,
      }),
      session: (id) => ({
        id,
        status: async () => ({
          status: "running",
          ...(statusCalls++ > 0
            ? { latestExecutionId: "execution-delayed" }
            : {}),
        }),
        async *events(): AsyncIterable<SandboxEvent> {},
        result: async () => {
          throw new Error("not called");
        },
        prompt: async () => {
          throw new Error("not called");
        },
        interrupt: async () => ({ cancelled: false }),
      }),
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(
      environment.dispatch?.({
        prompt: "continue",
        turnId: "delayed-turn",
        detach: true,
      }),
    ).rejects.toThrow(/no exact execution id/);
    expect(statusCalls).toBe(0);
  });

  it("rejects a dispatch receipt for a different requested execution", async () => {
    const sessionId = "session-wrong-execution";
    const turnId = "requested-turn";
    const requestedExecutionId = executionIdForTurn(
      { prompt: "continue", sessionId, turnId },
      "sbx-wrong-execution",
      sessionId,
    );
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-wrong-execution",
      async *streamPrompt(): AsyncIterable<SandboxEvent> {},
      dispatchPrompt: async (_prompt, options) => ({
        sessionId: options?.sessionId,
        executionId: "execution-from-server",
      }),
      session: retainedSessionHandle,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    await expect(
      environment.dispatch?.({
        prompt: "continue",
        sessionId,
        turnId,
        executionId: requestedExecutionId,
      }),
    ).rejects.toThrow(/different from the requested run/);
  });

  it("rejects an unbound dispatch receipt without interrupting unknown work", async () => {
    const interrupt = vi.fn(async () => ({ cancelled: true }));
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-wrong-session",
      async *streamPrompt(): AsyncIterable<SandboxEvent> {},
      dispatchPrompt: async () => ({
        sessionId: "session-from-server",
        executionId: "execution-from-server",
        status: "running",
        alreadyExisted: false,
        dispatched: true,
      }),
      session: (id) => ({
        id,
        status: async () => ({ status: "running" }),
        async *events(): AsyncIterable<SandboxEvent> {},
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

    await expect(
      environment.dispatch?.({
        prompt: "continue",
        sessionId: "requested-session",
      }),
    ).rejects.toThrow(/different from the requested session/);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("maps exact control references and rejects unsupported context inputs", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    let streamCalls = 0;
    const box: SandboxInstanceLike = {
      id: "sbx-control",
      status: "running",
      async *streamPrompt(_prompt, options): AsyncIterable<SandboxEvent> {
        streamCalls += 1;
        capturedOptions = options as Record<string, unknown>;
        yield {
          type: "result",
          data: {
            finalText: "ok",
            sessionId: "session-3",
            executionId: "execution-7",
          },
        } as SandboxEvent;
      },
    };
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const capabilities = await provider.capabilities();
    expect(capabilities.interactions).toBeUndefined();
    expect(capabilities.branching).toEqual({
      checkpoint: false,
      fork: false,
      retrySafe: false,
      lookup: false,
      cleanup: false,
    });
    expect(environment.checkpoint).toBeUndefined();
    expect(environment.fork).toBeUndefined();
    expect(environment.workspaceBranching).toBeUndefined();
    const controlRef = {
      runId: "execution-7",
      provider: "tangle-sandbox",
      environmentId: box.id,
      sessionId: "session-3",
      executionId: "execution-7",
      requestDigest: TEST_REQUEST_DIGEST,
    };

    await collect(
      environment.stream({ prompt: "resume", controlRef }),
    );
    expect(capturedOptions).toMatchObject({
      sessionId: "session-3",
      executionId: "execution-7",
    });

    await expect(
      collect(
        environment.stream({
          prompt: "transfer",
          contextTransfer: {} as never,
        }),
      ),
    ).rejects.toThrow(/does not yet support portable context transfer|Invalid input/);
    await expect(
      collect(
        environment.stream({
          prompt: "continue",
          nativeContinuation: {} as never,
        }),
      ),
    ).rejects.toThrow(/does not yet support verified native continuation|Invalid input/);
    expect(streamCalls).toBe(1);
  });

  it("requires exact replay and follows the Sandbox exclusive cursor", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    let replayExecutionId: string | undefined;
    const upstreamEvents = [
      {
        id: "event-1",
        type: "status",
        data: {
          status: "processing",
          sessionId: "session-1",
          executionId: undefined,
        },
      },
      {
        id: "event-2",
        type: "result",
        data: {
          finalText: "ok",
          sessionId: "session-1",
          executionId: undefined,
        },
      },
    ] as SandboxEvent[];
    const sandboxSession: SandboxSessionLike = {
      id: "session-1",
      status: async () => ({
        status: "success",
        latestExecutionId: "execution-2",
      }),
      async *events(options) {
        capturedOptions = options as Record<string, unknown> | undefined;
        const start = options?.since === "event-1" ? 1 : 0;
        for (const event of upstreamEvents.slice(start)) yield event;
      },
      result: async () => ({
        success: true,
        status: "success",
        response: "ok",
        durationMs: 1,
      }),
      prompt: async () => ({
        success: true,
        status: "success",
        response: "ok",
        durationMs: 1,
      }),
      interrupt: async () => ({ cancelled: true }),
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-replay",
      async *streamPrompt(_message, options) {
        capturedOptions = options as Record<string, unknown> | undefined;
        const start = options?.lastEventId === "event-1" ? 1 : 0;
        for (const event of upstreamEvents.slice(start)) yield event;
      },
      dispatchPrompt: async (_prompt, options) => {
        replayExecutionId = options?.executionId;
        for (const event of upstreamEvents) {
          (event.data as Record<string, unknown>).executionId = replayExecutionId;
        }
        return {
          sessionId: options?.sessionId,
          executionId: replayExecutionId,
          runControlRef: options?.runControlRef,
        };
      },
      session: () => sandboxSession,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const reference = await environment.dispatch?.({
      prompt: "second turn",
      sessionId: sandboxSession.id,
      turnId: "second-turn",
      detach: true,
    });
    await expect(
      collect(
        environment.session!(sandboxSession.id).events({ since: "event-1" }),
      ),
    ).rejects.toThrow(/cursor replay requires an exact executionId/);
    expect(capturedOptions).toBeUndefined();
    const session = environment.session?.(sandboxSession.id, {
      controlRef: reference?.controlRef,
    });

    const replay = await collect(session!.events({ since: "event-1" }));
    expect(reference?.controlRef).toMatchObject({
      runId: expect.stringMatching(/^session-turn-[a-f0-9]{64}$/),
      executionId: replayExecutionId,
      sessionId: "session-1",
    });
    expect(capturedOptions).toMatchObject({
      lastEventId: "event-1",
      executionId: replayExecutionId,
    });
    expect(replay.map((event) => event.id)).toEqual(["event-2"]);
    await expect(
      collect(
        session!.events({
          since: "event-1",
          executionId: "execution-wrong",
        }),
      ),
    ).rejects.toThrow(/executionId conflicts with the control reference/);
    expect(capturedOptions).toMatchObject({
      lastEventId: "event-1",
      executionId: replayExecutionId,
    });
  });

  it("rejects unstable event identities on an exact retained session", async () => {
    let executionId: string | undefined;
    const sandboxSession: SandboxSessionLike = {
      id: "session-unstable-events",
      status: async () => ({ status: "running" }),
      async *events() {
        yield {
          type: "status",
          data: {
            status: "processing",
            sessionId: "session-unstable-events",
            executionId,
          },
        } as SandboxEvent;
      },
      result: async () => ({
        success: true,
        status: "success",
        executionId,
        durationMs: 1,
      }),
      prompt: async () => ({
        success: true,
        status: "success",
        executionId,
        durationMs: 1,
      }),
      interrupt: async () => ({ cancelled: true }),
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-unstable-events",
      async *streamPrompt() {
        yield {
          type: "status",
          data: {
            status: "processing",
            sessionId: "session-unstable-events",
            executionId,
          },
        } as SandboxEvent;
      },
      dispatchPrompt: async (_prompt, options) => {
        executionId = options?.executionId;
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
    const dispatched = await environment.dispatch!({
      prompt: "run",
      sessionId: sandboxSession.id,
    });

    await expect(
      collect(
        environment
          .session!(sandboxSession.id, { controlRef: dispatched.controlRef })
          .events(),
      ),
    ).rejects.toThrow(/without a stable id/);
  });

  it("rejects events from a competing execution on an exact session", async () => {
    const sandboxSession: SandboxSessionLike = {
      id: "session-competing-event",
      status: async () => ({ status: "running" }),
      async *events() {
        yield {
          id: "event-competing",
          type: "result",
          data: {
            executionId: "execution-competing",
            sessionId: "session-competing-event",
            finalText: "wrong",
          },
        } as SandboxEvent;
      },
      result: async () => ({
        success: true,
        status: "success",
        executionId: "execution-exact",
        durationMs: 1,
      }),
      prompt: async () => ({
        success: true,
        status: "success",
        executionId: "execution-exact",
        durationMs: 1,
      }),
      interrupt: async () => ({ cancelled: true }),
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-competing-event",
      async *streamPrompt() {
        yield {
          id: "event-competing",
          type: "result",
          data: {
            executionId: "execution-competing",
            sessionId: "session-competing-event",
            finalText: "wrong",
          },
        } as SandboxEvent;
      },
      session: () => sandboxSession,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const controlRef = controlRefForTurn(
      { prompt: "competing event", turnId: "competing-turn" },
      box.id,
      sandboxSession.id,
    );

    await expect(
      collect(
        environment
          .session!(sandboxSession.id, { controlRef })
          .events(),
      ),
    ).rejects.toThrow(/different executionId/);
  });

  it("fails closed for unbound result and cancellation", async () => {
    const result = vi.fn(async () => ({
      success: true,
      status: "success" as const,
      executionId: "execution-latest",
      durationMs: 1,
    }));
    const interrupt = vi.fn(async () => ({ cancelled: true }));
    const sandboxSession: SandboxSessionLike = {
      id: "session-unbound",
      status: async () => ({ status: "completed" }),
      async *events() {},
      result,
      prompt: async () => ({
        success: true,
        status: "success",
        executionId: "execution-new",
        durationMs: 1,
      }),
      interrupt,
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: "sbx-unbound",
      async *streamPrompt() {},
      session: () => sandboxSession,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });
    const unbound = environment.session!(sandboxSession.id);

    await expect(unbound.result()).rejects.toThrow(
      /result requires an exact executionId/,
    );
    await expect(unbound.cancel()).rejects.toThrow(
      /cancellation requires an exact executionId/,
    );
    expect(result).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("rejects inconsistent and malformed Sandbox prompt results", async () => {
    const environmentId = "sbx-strict-result";
    const sessionId = "session-strict-result";
    const strictControlRef = controlRefForTurn(
      { prompt: "strict result", turnId: "strict-turn" },
      environmentId,
      sessionId,
    );
    let result = {
      success: true,
      status: "failed",
      executionId: strictControlRef.executionId,
      durationMs: 1,
    } as never;
    const sandboxSession: SandboxSessionLike = {
      id: sessionId,
      status: async () => ({ status: "completed" }),
      async *events() {},
      result: async () => result,
      prompt: async () => result,
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
    const exact = environment.session!(sandboxSession.id, {
      controlRef: strictControlRef,
    });

    await expect(exact.result()).rejects.toThrow(/success flag conflicts/);
    result = {
      success: true,
      status: "success",
      executionId: strictControlRef.executionId,
      durationMs: -1,
    } as never;
    await expect(exact.result()).rejects.toThrow(/invalid duration/);
    result = {
      success: true,
      status: "success",
      executionId: strictControlRef.executionId,
      durationMs: 1,
      usage: { inputTokens: -1, outputTokens: 2 },
    } as never;
    await expect(exact.result()).rejects.toThrow(/input token count is invalid/);
  });

  it("rejects an unsolicited context transfer receipt", async () => {
    const environmentId = "sbx-receipt";
    const sessionId = "session-new";
    const receiptControlRef = controlRefForTurn(
      { prompt: "receipt result", turnId: "receipt-turn" },
      environmentId,
      sessionId,
    );
    const receipt = {
      status: "accepted" as const,
      operationId: "transfer-1",
      requestDigest: `sha256:${"1".repeat(64)}` as const,
      planDigest: `sha256:${"2".repeat(64)}` as const,
      contextDigest: `sha256:${"3".repeat(64)}` as const,
      destination: { runner: "codex", provider: "tangle-sandbox" },
      provider: "tangle-sandbox",
      environmentId: "sbx-receipt",
      sessionId: "session-new",
      sessionCreatedForOperationId: "transfer-1",
      sessionCreatedAt: "2026-08-01T20:01:00.000Z",
      transferredMessageIds: ["message-1"],
      omittedMessageIds: [],
      admittedAt: "2026-08-01T20:01:01.000Z",
    };
    const sandboxSession: SandboxSessionLike = {
      id: sessionId,
      status: async () => ({ status: "completed" }),
      async *events() {},
      result: async () => ({
        success: true,
        status: "success",
        executionId: receiptControlRef.executionId,
        response: "ok",
        durationMs: 1,
        contextTransferReceipt: receipt,
      }),
      prompt: async () => ({
        success: true,
        status: "success",
        response: "ok",
        durationMs: 1,
      }),
      interrupt: async () => ({ cancelled: true }),
    };
    const box: SandboxInstanceLike = retainedDeployment({
      id: environmentId,
      async *streamPrompt(): AsyncIterable<SandboxEvent> {},
      session: () => sandboxSession,
    });
    const provider = createTangleProvider({
      client: { create: async () => box },
    });
    const environment = await provider.create({ profile: { name: "worker" } });

    const exactSession = environment.session!(sandboxSession.id, {
      controlRef: receiptControlRef,
    });

    await expect(exactSession.result()).rejects.toThrow(
      /context receipt for a turn that requested no transfer/,
    );

    sandboxSession.result = async () => ({
      success: true,
      status: "success",
      executionId: receiptControlRef.executionId,
      response: "undefined receipt",
      durationMs: 1,
      contextTransferReceipt: undefined,
    });
    await expect(exactSession.result()).rejects.toThrow(
      /context receipt for a turn that requested no transfer/,
    );

    sandboxSession.result = async () => ({
      status: "success",
      response: "missing success",
      durationMs: 1,
    }) as never;
    await expect(exactSession.result()).rejects.toThrow(
      /omitted its success status/,
    );

    sandboxSession.result = async () => ({
      success: true,
      status: "success",
      executionId: receiptControlRef.executionId,
      response: "invalid receipt",
      durationMs: 1,
      contextTransferReceipt: { status: "accepted" },
    }) as never;
    await expect(exactSession.result()).rejects.toThrow(
      /context receipt for a turn that requested no transfer/,
    );
  });

  it("rejects record-form secrets before a mapper can silently drop them", async () => {
    const create = vi.fn(async () => {
      throw new Error("not called");
    });
    const provider = createTangleProvider({
      client: { create },
      mapCreateInput: () => ({ secrets: { TOKEN: "value" } }) as never,
    });

    await expect(
      provider.create({
        profile: { name: "worker" },
        secrets: { TOKEN: "value" },
      }),
    ).rejects.toThrow(/inline secret values are not accepted/);
    expect(create).not.toHaveBeenCalled();

    const mappedOnlyProvider = createTangleProvider({
      client: { create },
      mapCreateInput: () => ({ secrets: { TOKEN: "value" } }) as never,
    });
    await expect(
      mappedOnlyProvider.create({ profile: { name: "worker" } }),
    ).rejects.toThrow(/mapped secrets must be an array/);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects unresolved profile references before creating a sandbox", async () => {
    const create = vi.fn(async () => {
      throw new Error("not called");
    });
    const provider = createTangleProvider({ client: { create } });

    await expect(provider.create({ profile: "profile-1" })).rejects.toThrow(
      "requires an inline AgentProfile",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects conflicting workspace environment inputs", async () => {
    const create = vi.fn(async () => {
      throw new Error("not called");
    });
    const provider = createTangleProvider({ client: { create } });

    await expect(
      provider.create({
        profile: { name: "worker" },
        workspace: { environment: "env-a", image: "env-b" },
      }),
    ).rejects.toThrow("cannot specify both environment and image");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a workspace gitRef without repoUrl before a custom mapper can drop it", async () => {
    const create = vi.fn(async () => {
      throw new Error("not called");
    });
    const mapCreateInput = vi.fn(() => ({
      backend: { type: "opencode" as const, profile: { name: "worker" } },
    }));
    const provider = createTangleProvider({
      client: { create },
      mapCreateInput,
    });

    await expect(
      provider.create({
        profile: { name: "worker" },
        workspace: { gitRef: "main" },
      }),
    ).rejects.toThrow("workspace gitRef requires repoUrl");
    expect(mapCreateInput).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a host cwd before a custom mapper can bypass the Tangle base", async () => {
    const create = vi.fn(async () => {
      throw new Error("not called");
    });
    const mapCreateInput = vi.fn(() => ({
      backend: { type: "opencode" as const, profile: { name: "worker" } },
    }));
    const provider = createTangleProvider({
      client: { create },
      mapCreateInput,
    });

    await expect(
      provider.create({
        profile: { name: "worker" },
        workspace: { cwd: { base: "host", path: "/workspace" } },
      }),
    ).rejects.toThrow('Tangle supports workspace cwd base "repository", not "host"');
    expect(mapCreateInput).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("runs the exact-process lifecycle through process-only sandboxes", async () => {
    let firstCreateOptions: ExactCreateOptions | undefined;
    let createRequestOptions:
      | { signal?: AbortSignal; timeoutMs?: number }
      | undefined;
    let listOptions: Record<string, unknown> | undefined;
    let writeOptions: Record<string, unknown> | undefined;
    let launchOptions: Record<string, unknown> | undefined;
    let readBatchCalls = 0;
    let killCalls = 0;
    let nextId = 1;
    const records = new Map<
      string,
      {
        signature: string;
        box: SandboxInstanceLike;
        deleted: boolean;
      }
    >();

    const client: SandboxClientLike = {
      async create(rawOptions, requestOptions) {
        const options = rawOptions as ExactCreateOptions;
        const key = options.idempotencyKey ?? `unkeyed-${nextId}`;
        const signature = JSON.stringify(options);
        const existing = records.get(key);
        if (existing) {
          if (existing.signature !== signature) {
            throw new Error("idempotency collision");
          }
          existing.deleted = false;
          return existing.box;
        }

        firstCreateOptions ??= options;
        createRequestOptions ??= requestOptions;
        const files = new Map<string, Uint8Array>();
        let spawned = false;
        const status = {
          pid: 73,
          running: false,
          exitCode: 0,
        };
        const process = {
          pid: status.pid,
          status: async () => status,
          wait: async () => status.exitCode,
          kill: async () => {
            killCalls += 1;
          },
          async *stdout() {
            yield "ok";
          },
          async *stderr() {},
        };
        const id = `exact-${nextId++}`;
        const record = {
          signature,
          deleted: false,
          box: undefined as unknown as SandboxInstanceLike,
        };
        const box: SandboxInstanceLike = {
          id,
          status: "running",
          metadata: {
            ...(options.metadata ?? {}),
            runtimeMode: options.agent === false ? "control" : "agent",
          },
          async *streamPrompt(): AsyncIterable<SandboxEvent> {},
          fs: {
            supportsWriteMode: true,
            async stat(path) {
              const bytes = files.get(path);
              if (!bytes) throw new Error("not found");
              return { size: bytes.byteLength, isFile: true };
            },
            async readBatch(paths, _readOptions) {
              readBatchCalls += 1;
              const found = paths.flatMap((path) => {
                const bytes = files.get(path);
                return bytes
                  ? [
                      {
                        path,
                        content: Buffer.from(bytes).toString("base64"),
                        encoding: "base64" as const,
                        size: bytes.byteLength,
                      },
                    ]
                  : [];
              });
              return {
                files: found,
                errors: paths
                  .filter((path) => !files.has(path))
                  .map((path) => ({ path, error: "not found" })),
              };
            },
            async write(path, content, options) {
              writeOptions = options;
              files.set(path, Uint8Array.from(Buffer.from(content, "base64")));
            },
          },
          process: {
            list: async () => (spawned ? [status] : []),
            get: async (pid) =>
              spawned && pid === process.pid ? process : null,
            async spawnExact(_executable, _args, options) {
              spawned = true;
              launchOptions = options;
              return process;
            },
          },
          async delete() {
            record.deleted = true;
          },
        };
        record.box = box;
        records.set(key, record);
        return box;
      },
      async get(id) {
        for (const record of records.values()) {
          if (record.box.id === id && !record.deleted) return record.box;
        }
        return null;
      },
      async list(options) {
        listOptions = options as Record<string, unknown>;
        const visible = [...records.values()]
          .filter((record) => !record.deleted)
          .map((record) => record.box);
        const offset = Number(listOptions.offset ?? 0);
        const limit = Number(listOptions.limit ?? 1_000);
        return visible.slice(offset, offset + limit);
      },
    };
    const provider = createTangleProvider({
      client,
      exactProcess: { teamId: "team-1" },
    });

    await expect(
      runAgentExactProcessProviderLifecycleChecks({
        createProvider: () => provider,
        createInput: {
          image: EXACT_IMAGE,
          egress: { mode: "strict", allowDomains: ["model.example"] },
          maxLifetimeMs: 61_000,
          provisionTimeoutMs: 3_000,
          resources: EXACT_RESOURCES,
          metadata: { executionId: "execution-1" },
          idempotencyKey: "candidate-1",
        },
        launch: {
          executable: "/usr/bin/agent",
          args: ["--prompt", "hello world"],
          cwd: "/workspace",
          env: { MODEL_URL: "http://model.internal" },
          stdin: "input",
          timeoutMs: 2_000,
        },
        expectedStdout: "ok",
        expectedStderr: "",
      }),
    ).resolves.toMatchObject({
      provider: "tangle-sandbox",
      environmentId: "exact-1",
    });

    expect(firstCreateOptions).toEqual({
      environment: EXACT_IMAGE,
      agent: false,
      driver: { type: "host-agent", runtimeBackend: "docker" },
      ephemeral: true,
      sshEnabled: false,
      webTerminalEnabled: false,
      secrets: [],
      capabilities: [],
      egressPolicy: {
        mode: "strict",
        allowDomains: ["model.example"],
        includeImplicitDomains: false,
      },
      maxLifetimeSeconds: 61,
      idempotencyKey: "candidate-1",
      metadata: {
        executionId: "execution-1",
        "tangle.exactProcess": {
          version: 1,
          provider: "tangle-sandbox",
          teamId: "team-1",
          idempotencyKey: "candidate-1",
          requestDigest: expect.any(String),
        },
      },
      teamId: "team-1",
      resources: { cpuCores: 1, memoryMB: 512, diskGB: 1 },
    });
    expect(createRequestOptions?.timeoutMs).toBe(3_000);
    expect(writeOptions).toEqual({ encoding: "base64", mode: 0o640 });
    expect(launchOptions).toMatchObject({
      cwd: "/workspace",
      env: { MODEL_URL: "http://model.internal" },
      inheritEnv: false,
      stdin: "input",
      timeoutMs: 2_000,
      signal: expect.any(AbortSignal),
    });
    expect(listOptions).toMatchObject({
      scope: "team:team-1",
      limit: 1_000,
      offset: 0,
    });
    expect(readBatchCalls).toBe(1);
    expect(killCalls).toBe(1);
  });

  it("deletes a sandbox when the API cannot prove process-only mode", async () => {
    const deleted = vi.fn(async () => undefined);
    const box: SandboxInstanceLike = {
      id: "unproven",
      metadata: { "tangle.exactProcess": true },
      async *streamPrompt(): AsyncIterable<SandboxEvent> {},
      delete: deleted,
    };
    const provider = createTangleProvider({
      client: {
        async create() {
          return box;
        },
        async get() {
          return box;
        },
        async list() {
          return [box];
        },
      },
      exactProcess: {},
    });

    await expect(
      provider.exactProcess?.create({
        image: EXACT_IMAGE,
        egress: { mode: "blocked" },
        maxLifetimeMs: 10_000,
        resources: EXACT_RESOURCES,
        metadata: { executionId: "unproven" },
        idempotencyKey: "candidate-unproven",
      }),
    ).rejects.toThrow("did not create the requested process-only runtime");
    expect(deleted).toHaveBeenCalledOnce();
    await expect(provider.exactProcess?.get(box.id)).resolves.toBeNull();
  });

  it("rejects caller ownership markers", async () => {
    const provider = createTangleProvider({
      client: {
        async create() {
          throw new Error("not called");
        },
        async get() {
          return null;
        },
        async list() {
          return [];
        },
      },
      exactProcess: {},
    });

    await expect(
      provider.exactProcess?.create({
        image: EXACT_IMAGE,
        egress: { mode: "blocked" },
        maxLifetimeMs: 10_000,
        resources: EXACT_RESOURCES,
        metadata: { runtimeMode: "control" },
        idempotencyKey: "candidate-reserved",
      }),
    ).rejects.toThrow("metadata is reserved");
  });
});
