import { describe, expect, it, vi } from "vitest";
import type {
  AgentExactProcessLaunch,
} from "@tangle-network/agent-interface/environment-provider";
import {
  capabilitiesForClient,
  capabilitiesForSandbox,
  defaultTangleSandboxCapabilities,
  sandboxCapabilitySupport,
} from "./tangle-capabilities.js";
import {
  assertBoundedJson,
  awaitWithSignal,
  boundedIdentifier,
  exactProcessRequestDigest,
  isBoundedJson,
  MAX_LIST_RESULTS,
} from "./tangle-contract-safety.js";
import {
  assertMappedSecretNames,
  assertNoInlineSecretValues,
  sandboxOptionsFromCreateInput,
} from "./tangle-create-options.js";
import {
  executionBoundSessionStatus,
  nonEmptyString,
  placementInfoFromLoopPlacement,
  sessionStatusFromUnknown,
  statusFromUnknown,
} from "./tangle-environment-values.js";
import { sandboxInstanceAsEnvironment } from "./tangle-environment.js";
import {
  hasReplayPayload,
  sessionPromptRequestDigest,
} from "./tangle-environment-control.js";
import {
  assertOptionKeys,
  assertRecord,
} from "./tangle-environment-validation.js";
import { environmentEventFromSandboxEvent } from "./tangle-events.js";
import {
  exactProcessStatusFromSandbox,
  sandboxProcessAsExactProcess,
  validateExactProcessLaunch,
} from "./tangle-exact-process-runtime.js";
import {
  assertAbsoluteFilePath,
  EXACT_PROCESS_METADATA_KEY,
  assertSignalOptions,
  isExactProcessSandbox,
} from "./tangle-exact-process-validation.js";
import { sandboxInstanceAsExactProcessEnvironment } from "./tangle-exact-process-environment.js";
import { createTangleExactProcessProvider } from "./exact-process.js";
import {
  agentTurnResultFromPromptRecord,
  executionIdFromTurnInput,
  promptFromTurnInput,
  promptOptionsFromTurnInput,
  validatedSandboxPromptResult,
} from "./tangle-prompt.js";
import { createTangleProvider } from "./tangle-provider.js";
import {
  execResultFromSandboxExecResult,
  tokenUsageFromData,
} from "./tangle-result-values.js";
import {
  retainedSessionControlRef,
  sameRunControlRef,
  sessionPromptExecutionId,
  sessionRefFromSandboxDispatch,
} from "./tangle-session-control.js";
import type {
  SandboxClientLike,
  SandboxInstanceLike,
  SandboxProcessLike,
  SandboxSessionLike,
} from "./tangle-types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  return (async () => {
    const result: T[] = [];
    for await (const value of values) result.push(value);
    return result;
  })();
}

function pendingAsyncIterable<T>() {
  const returned = vi.fn(async (): Promise<IteratorResult<T>> => ({
    done: true,
    value: undefined as T,
  }));
  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<T>>(() => {}),
        return: returned,
      };
    },
  };
  return { iterable, returned };
}

const capabilities = defaultTangleSandboxCapabilities();
const minimalClient: SandboxClientLike = {
  create: async () => ({ id: "client", async *streamPrompt() {} }),
};

const exactInput = {
  image: `sha256:${"a".repeat(64)}`,
  egress: { mode: "strict" as const, allowDomains: ["model.example"] },
  maxLifetimeMs: 10_000,
  provisionTimeoutMs: 2_000,
  resources: { cpu: 1, memoryMb: 512, diskMb: 1_024 },
  metadata: { owner: "leaf-test" },
  idempotencyKey: "exact-operation",
};

function promptResult(executionId = "execution-1") {
  return {
    success: true,
    status: "success",
    durationMs: 1,
    executionId,
    response: "done",
  } as never;
}

describe("Tangle split leaf modules", () => {
  it("bounds JSON, maps create fields, and projects only supported capabilities", () => {
    expect(isBoundedJson({ shared: { value: true } })).toBe(true);
    expect(() => assertBoundedJson("x".repeat(16_385))).toThrow();
    expect(nonEmptyString("bounded")).toBe("bounded");
    expect(nonEmptyString(" ")).toBeUndefined();
    expect(statusFromUnknown("completed")).toBe("stopped");
    expect(statusFromUnknown("queued")).toBe("pending");
    expect(sessionStatusFromUnknown("cancelled")).toBe("cancelled");
    expect(sessionStatusFromUnknown("queued")).toBe("pending");
    expect(
      placementInfoFromLoopPlacement({ kind: "sandbox", sandboxId: "sbx-1" }, { id: "sbx-1", async *streamPrompt() {} }),
    ).toEqual({ kind: "sandbox", sandboxId: "sbx-1" });
    expect(
      sandboxOptionsFromCreateInput({ profile: { name: "worker" }, backend: "codex", env: { MODE: "safe" } }, "opencode"),
    ).toMatchObject({ backend: { type: "codex" }, env: { MODE: "safe" } });
    expect(() =>
      sandboxOptionsFromCreateInput({ profile: { name: "worker" }, workspace: { providerOptions: { ignored: true } } }, "opencode"),
    ).toThrow(/providerOptions are not supported/);
    expect(() =>
      assertNoInlineSecretValues({ profile: { name: "worker" }, secrets: { TOKEN: "raw" } }),
    ).toThrow(/inline secret values/);
    expect(() => assertMappedSecretNames({ secrets: { TOKEN: "raw" } } as never)).toThrow(/mapped secrets/);
    const support = sandboxCapabilitySupport(
      { id: "sbx-1", async *streamPrompt() {}, read: async () => "", write: async () => undefined },
      minimalClient,
    );
    expect(support.read).toBe(true);
    expect(support.reconstruct).toBe(false);
    expect(capabilitiesForClient(capabilities, minimalClient).placement).toBe(false);
    // The default document declares retained-control intent; every narrowing
    // pass strips it until deployment facts prove it.
    expect(capabilities.sessions.continue).toBe(true);
    expect(capabilities.retainedControl).toBeDefined();
    expect(capabilitiesForSandbox(capabilities, support).workspace.read).toBe(true);
    const retainedSupport = {
      ...support,
      reconstruct: true,
      dispatchPrompt: true,
      session: true,
      cancelRun: true,
    };
    expect(
      capabilitiesForClient(capabilities, minimalClient),
    ).toMatchObject({ sessions: { continue: false } });
    expect(
      capabilitiesForClient(capabilities, minimalClient),
    ).not.toHaveProperty("retainedControl");
    expect(
      capabilitiesForSandbox(capabilities, retainedSupport),
    ).toMatchObject({
      sessions: { continue: true },
      retainedControl: capabilities.retainedControl,
    });
    for (const clearedFact of ["cancelRun", "reconstruct"] as const) {
      const narrowed = capabilitiesForSandbox(capabilities, {
        ...retainedSupport,
        [clearedFact]: false,
      });
      expect(narrowed).toMatchObject({ sessions: { continue: false } });
      expect(narrowed).not.toHaveProperty("retainedControl");
    }
    const overDeclaredBranching = {
      ...capabilities,
      branching: {
        checkpoint: true,
        fork: true,
        retrySafe: true,
        lookup: true,
        cleanup: true,
      },
    };
    expect(capabilitiesForClient(overDeclaredBranching, minimalClient).branching).toMatchObject({
      checkpoint: false,
      fork: false,
      retrySafe: false,
      lookup: false,
      cleanup: false,
    });
    expect(capabilitiesForSandbox(overDeclaredBranching, retainedSupport).branching).toMatchObject({
      checkpoint: false,
      fork: false,
      retrySafe: false,
      lookup: false,
      cleanup: false,
    });
    expect(() => assertOptionKeys({ unsupported: true }, [], "leaf options")).toThrow();
    expect(() => assertRecord({ value: "ok" }, "leaf record")).not.toThrow();
  });

  it("attributes session status to an exact execution only with binding evidence", () => {
    const executionId = "execution-bound";
    // The live execution owns the current state.
    expect(
      executionBoundSessionStatus(
        { status: "running", activeExecutionId: executionId },
        executionId,
      ),
    ).toBe("running");
    // A different live execution proves nothing about the bound run.
    expect(
      executionBoundSessionStatus(
        { status: "running", activeExecutionId: "execution-other" },
        executionId,
      ),
    ).toBe("unknown");
    // With nothing live, the newest execution owns the terminal state.
    expect(
      executionBoundSessionStatus(
        { status: "completed", latestExecutionId: executionId },
        executionId,
      ),
    ).toBe("completed");
    expect(
      executionBoundSessionStatus(
        { status: "completed", latestExecutionId: "execution-other" },
        executionId,
      ),
    ).toBe("unknown");
    // The admitted-run reference binds only when no newer execution is named.
    expect(
      executionBoundSessionStatus(
        { status: "cancelled", runControlRef: { executionId } },
        executionId,
      ),
    ).toBe("cancelled");
    expect(
      executionBoundSessionStatus(
        {
          status: "completed",
          latestExecutionId: "execution-other",
          runControlRef: { executionId },
        },
        executionId,
      ),
    ).toBe("unknown");
    // A failure that names the bound execution is exact evidence on its own,
    // even when a contradictory payload also marks this execution live.
    expect(
      executionBoundSessionStatus(
        {
          status: "failed",
          latestExecutionId: "execution-other",
          failureReason: { message: "boom", executionId },
        },
        executionId,
      ),
    ).toBe("failed");
    expect(
      executionBoundSessionStatus(
        {
          status: "failed",
          activeExecutionId: "execution-other",
          failureReason: { message: "boom", executionId },
        },
        executionId,
      ),
    ).toBe("failed");
    // A failure attributed to another execution never leaks to the bound run,
    // even when the payload also marks the bound run live.
    expect(
      executionBoundSessionStatus(
        {
          status: "failed",
          activeExecutionId: executionId,
          failureReason: { message: "boom", executionId: "execution-other" },
        },
        executionId,
      ),
    ).toBe("unknown");
    // An unattributed failure follows the generic liveness binding.
    expect(
      executionBoundSessionStatus(
        { status: "failed", activeExecutionId: executionId },
        executionId,
      ),
    ).toBe("failed");
    // A queued execution is pending work, distinct from an unbindable payload.
    expect(
      executionBoundSessionStatus(
        { status: "queued", activeExecutionId: executionId },
        executionId,
      ),
    ).toBe("pending");
    // No identity fields at all: the payload cannot be bound.
    expect(
      executionBoundSessionStatus({ status: "completed" }, executionId),
    ).toBe("unknown");
  });

  it("binds direct event, result, prompt, and session leaves to exact identity", async () => {
    const event = environmentEventFromSandboxEvent(
      { type: "status", id: "event-1", data: { executionId: "execution-1", sessionId: "session-1", status: "running" } } as never,
      { executionId: "execution-1", sessionId: "session-1" },
    );
    expect(event.id).toBe("event-1");
    expect(event.normalized).toEqual({
      type: "status",
      status: "processing",
    });
    expect(() => environmentEventFromSandboxEvent(
      {
        type: "status",
        data: {
          executionId: "execution-1",
          sessionId: "session-1",
          status: "processing",
          normalized: { type: "warning", code: "bad", message: "bad" },
        },
      } as never,
      { executionId: "execution-1", sessionId: "session-1" },
    )).toThrow(/normalized event type/);
    expect(() => environmentEventFromSandboxEvent(
      { type: "status", data: { executionId: "wrong", sessionId: "session-1" } } as never,
      { executionId: "execution-1", sessionId: "session-1" },
    )).toThrow(/executionId/);
    const nativeSessionEvent = environmentEventFromSandboxEvent(
      {
        type: "session.updated",
        id: "event-native-session",
        data: {
          sessionId: "opencode-native-session",
          sessionID: "opencode-native-session",
          title: "Native harness session",
        },
      } as never,
      {
        executionId: "execution-1",
        sessionId: "runtime-session-1",
        streamBound: true,
      },
    );
    expect(nativeSessionEvent.normalized).toEqual({
      type: "session.updated",
      sessionId: "opencode-native-session",
      title: "Native harness session",
    });
    expect(() => environmentEventFromSandboxEvent(
      {
        type: "session.updated",
        data: {
          executionId: "execution-other",
          sessionId: "opencode-native-session",
        },
      } as never,
      {
        executionId: "execution-1",
        sessionId: "runtime-session-1",
        streamBound: true,
      },
    )).toThrow(/executionId/);
    expect(() => environmentEventFromSandboxEvent(
      {
        type: "execution.started",
        data: {
          executionId: "execution-other",
          sessionId: "runtime-session-1",
        },
      } as never,
      {
        executionId: "execution-1",
        sessionId: "runtime-session-1",
        streamBound: true,
      },
    )).toThrow(/executionId/);
    expect(tokenUsageFromData({ usage: { inputTokens: 2, outputTokens: 3 } })).toEqual({ inputTokens: 2, outputTokens: 3 });
    expect(execResultFromSandboxExecResult({ exitCode: 0, stdout: "ok", stderr: "" } as never)).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(validatedSandboxPromptResult(promptResult())).toMatchObject({ success: true, status: "success" });
    expect(validatedSandboxPromptResult({
      success: true,
      status: "success",
      durationMs: 1,
      executionId: "execution-1",
      response: "done",
      error: undefined,
      approval: undefined,
      question: undefined,
      plan: undefined,
      traceId: undefined,
      usage: undefined,
      costUsd: undefined,
      toolInvocations: undefined,
    } as never)).toEqual(promptResult());
    expect(() => validatedSandboxPromptResult({
      ...(promptResult() as unknown as Record<string, unknown>),
      unsupported: undefined,
    } as never)).toThrow(/JSON bound/);
    expect(agentTurnResultFromPromptRecord(validatedSandboxPromptResult(promptResult()), { sessionId: "session-1" })).toMatchObject({ text: "done", success: true });
    const semanticInput = { prompt: "hello", turnId: "turn-1" } as never;
    const baseRequestDigest = sessionPromptRequestDigest(
      semanticInput,
      "tangle-sandbox",
      "sbx-1",
      "session-1",
    );
    const executionId = sessionPromptExecutionId(baseRequestDigest);
    const requestDigest = sessionPromptRequestDigest(
      semanticInput,
      "tangle-sandbox",
      "sbx-1",
      "session-1",
      { executionId },
    );
    const controlRef = retainedSessionControlRef(
      "session-1",
      executionId,
      "tangle-sandbox",
      "sbx-1",
      requestDigest,
    );
    expect(executionIdFromTurnInput({ controlRef })).toBe(executionId);
    expect(promptFromTurnInput({ prompt: "hello" })).toBe("hello");
    expect(promptOptionsFromTurnInput({ prompt: "hello", sessionId: "session-1", executionId }, { provider: "tangle-sandbox", environmentId: "sbx-1", sessionId: "session-1" })).toMatchObject({ executionId, sessionId: "session-1" });
    const dispatchRef = sessionRefFromSandboxDispatch({
      sessionId: "session-1",
      executionId,
      runControlRef: controlRef,
    }, "tangle-sandbox", "sbx-1", executionId, requestDigest, "session-1");
    expect(dispatchRef.controlRef).toMatchObject({ sessionId: "session-1", executionId, requestDigest });
    expect(() => sessionRefFromSandboxDispatch(
      { sessionId: "other-session", executionId },
      "tangle-sandbox",
      "sbx-1",
      executionId,
      requestDigest,
      "session-1",
    )).toThrow(/different from the requested session/);
    const retained = retainedSessionControlRef("session-1", executionId, "tangle-sandbox", "sbx-1", dispatchRef.controlRef?.requestDigest);
    expect(sameRunControlRef(retained, dispatchRef.controlRef!)).toBe(true);
    expect(sessionPromptExecutionId(baseRequestDigest)).toBe(executionId);
    expect(() => boundedIdentifier(" bad", "id")).toThrow();
    await expect(awaitWithSignal(Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("honors pre-abort and mid-flight abort on environment methods", async () => {
    const readPending = deferred<string>();
    const execPending = deferred<unknown>();
    const refreshPending = deferred<void>();
    const interruptPending = deferred<{ cancelled: boolean }>();
    const session: SandboxSessionLike = {
      id: "session-1",
      status: async () => ({ status: "running" }),
      async *events() {},
      result: async () => promptResult(),
      prompt: async () => promptResult(),
      interrupt: async () => interruptPending.promise,
    };
    const box: SandboxInstanceLike = {
      id: "sbx-1",
      status: "running",
      async *streamPrompt() {},
      session: () => session,
      read: async () => readPending.promise,
      exec: async () => execPending.promise as never,
      refresh: async () => refreshPending.promise,
    };
    const environment = sandboxInstanceAsEnvironment(box, "tangle-sandbox", minimalClient, capabilities);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(environment.read?.("/tmp/file", { signal: alreadyAborted.signal })).rejects.toThrow();
    const readAbort = new AbortController();
    const readCall = environment.read?.("/tmp/file", { signal: readAbort.signal });
    readAbort.abort();
    await expect(readCall).rejects.toThrow();
    const execAbort = new AbortController();
    const execCall = environment.exec?.("true", { signal: execAbort.signal });
    execAbort.abort();
    await expect(execCall).rejects.toThrow();
    const statusAbort = new AbortController();
    const statusCall = environment.status({ signal: statusAbort.signal });
    statusAbort.abort();
    await expect(statusCall).rejects.toThrow();
    const sessionAbort = new AbortController();
    const sessionCall = environment.session!("session-1")!.cancel({ signal: sessionAbort.signal });
    sessionAbort.abort();
    await expect(sessionCall).rejects.toThrow();
    const streamAbort = new AbortController();
    streamAbort.abort();
    await expect(collect(environment.stream({ prompt: "x", signal: streamAbort.signal }))).rejects.toThrow();
    refreshPending.resolve();
    readPending.resolve("ok");
    execPending.resolve({ exitCode: 0, stdout: "", stderr: "" });
    interruptPending.resolve({ cancelled: true });
  });

  it("closes a pending session event iterator when replay is aborted", async () => {
    const pendingEvents = pendingAsyncIterable<never>();
    const session: SandboxSessionLike = {
      id: "session-1",
      status: async () => ({ status: "running" }),
      events: () => pendingEvents.iterable,
      result: async () => promptResult(),
      prompt: async () => promptResult(),
      interrupt: async () => ({ cancelled: true }),
    };
    const box: SandboxInstanceLike = {
      id: "replay-environment",
      async *streamPrompt() {},
      session: () => session,
    };
    const environment = sandboxInstanceAsEnvironment(
      box,
      "tangle-sandbox",
      minimalClient,
      {
        ...capabilities,
        streaming: { ...capabilities.streaming, replay: true },
      },
    );
    const abort = new AbortController();
    const events = collect(environment.session!("session-1")!.events({ signal: abort.signal }));
    abort.abort();
    await expect(events).rejects.toThrow();
    expect(pendingEvents.returned).toHaveBeenCalledOnce();
  });

  it("proves exact-process identity, pagination, cleanup, file bounds, and process abort", async () => {
    let exactBox!: SandboxInstanceLike;
    const deleted = vi.fn(async () => undefined);
    const processStatus = { pid: 9, running: false, exitCode: 0 };
    const processHandle: SandboxProcessLike = {
      pid: 9,
      status: async () => processStatus,
      wait: async () => 0,
      kill: vi.fn(async () => undefined),
      async *stdout() { yield "out"; },
      async *stderr() { yield "err"; },
    };
    exactBox = {
      id: "exact-environment",
      metadata: {},
      async *streamPrompt() {},
      delete: deleted,
      fs: {
        supportsWriteMode: true,
        stat: async () => ({ size: 2, isFile: true }),
        readBatch: async () => ({ files: [{ path: "/tmp/file", content: "b2s=", encoding: "base64" as const, size: 2 }], errors: [] }),
        write: async () => undefined,
      },
      process: {
        list: async () => [processStatus],
        get: async (pid) => pid === 9 ? processHandle : null,
        spawnExact: async () => processHandle,
      },
    };
    const listCalls: Array<{ offset?: number; limit?: number }> = [];
    const client: SandboxClientLike = {
      async create(options) {
        exactBox.metadata = { ...(options?.metadata ?? {}), runtimeMode: "control" };
        return exactBox;
      },
      async get(id) { return id === exactBox.id ? exactBox : { ...exactBox, id: "unrelated" }; },
      async list(options) {
        listCalls.push(options ?? {});
        if ((options?.offset ?? 0) === 0) return [exactBox, { ...exactBox, id: "ordinary", metadata: { runtimeMode: "agent" } }];
        return [];
      },
    };
    const provider = createTangleExactProcessProvider({ client, options: { teamId: "team-1" }, providerName: "tangle-sandbox" });
    const environment = await provider.create(exactInput);
    expect(environment.id).toBe(exactBox.id);
    expect(sandboxInstanceAsExactProcessEnvironment(exactBox, "tangle-sandbox").id).toBe(exactBox.id);
    expect((await provider.get("requested-but-unrelated"))).toBeNull();
    expect((await provider.list({ metadata: { owner: "leaf-test" } })).map((entry) => entry.id)).toEqual([exactBox.id]);
    expect(listCalls).toEqual([{ scope: "team:team-1", limit: 1_000, offset: 0 }]);
    expect(await environment.process.list()).toHaveLength(1);
    expect(await environment.process.get(9)).not.toBeNull();
    await environment.process.get(9)!.then((process) => process!.kill());
    expect(processHandle.kill).toHaveBeenCalledWith("SIGKILL", { tree: true });
    expect(await environment.readFile("/tmp/file", { maxBytes: 2 })).toEqual(Uint8Array.from([0x6f, 0x6b]));
    await environment.writeFile("/tmp/file", Uint8Array.from([1]), { mode: 0o600 });
    await environment.destroy();
    expect(deleted).toHaveBeenCalledOnce();
    expect(exactProcessRequestDigest(exactInput, "tangle-sandbox", { teamId: "team-1" })).toMatch(/^sha256:/);
    expect(() => validateExactProcessLaunch({ executable: "/bin/echo", args: [], cwd: "/tmp", env: {}, timeoutMs: 1 })).not.toThrow();
    expect(() => validateExactProcessLaunch({ executable: "/tmp/../bin/echo", args: [], cwd: "/tmp", env: {}, timeoutMs: 1 })).toThrow();
    expect(() => validateExactProcessLaunch({ executable: "/bin/echo", args: [], cwd: "/tmp/../workspace", env: {}, timeoutMs: 1 })).toThrow();
    expect(() => validateExactProcessLaunch({ executable: "echo\0blocked", args: [], cwd: "/tmp", env: { PATH: "/bin" }, timeoutMs: 1 })).toThrow(/NUL/);
    expect(() => validateExactProcessLaunch({ executable: "/bin/echo", args: ["ok\0blocked"], cwd: "/tmp", env: {}, timeoutMs: 1 })).toThrow(/NUL/);
    expect(() => assertAbsoluteFilePath("/tmp/../secret")).toThrow();
    expect(() => assertAbsoluteFilePath("/tmp/secret\0file")).toThrow();
    expect(() => exactProcessStatusFromSandbox({ pid: 9, running: true, exitCode: 0 })).toThrow(/exit state/);
    await expect(provider.list([] as never)).rejects.toThrow(/plain object/);
    expect(exactProcessStatusFromSandbox(processStatus)).toMatchObject({ pid: 9, termination: { kind: "exit", exitCode: 0 } });
    expect(isExactProcessSandbox(exactBox, "tangle-sandbox", "team-1")).toBe(true);
    expect(isExactProcessSandbox(exactBox, "other-provider", "team-1")).toBe(false);
    expect(() => assertSignalOptions({ extra: true } as never, "leaf-test")).toThrow();
    const wrapped = sandboxProcessAsExactProcess(processHandle);
    const processAbort = new AbortController();
    const statusCall = wrapped.status({ signal: processAbort.signal });
    processAbort.abort();
    await expect(statusCall).rejects.toThrow();
    await expect(collect(wrapped.stdout())).resolves.toEqual(["out"]);
    const blockedStdout = pendingAsyncIterable<string>();
    const blockedStderr = pendingAsyncIterable<string>();
    const blockedProcess = {
      ...processHandle,
      stdout: () => blockedStdout.iterable,
      stderr: () => blockedStderr.iterable,
    } satisfies SandboxProcessLike;
    const stdoutAbort = new AbortController();
    const stdoutCall = collect(
      sandboxProcessAsExactProcess(blockedProcess).stdout({ signal: stdoutAbort.signal }),
    );
    stdoutAbort.abort();
    await expect(stdoutCall).rejects.toThrow();
    expect(blockedStdout.returned).toHaveBeenCalledOnce();
    const stderrAbort = new AbortController();
    const stderrCall = collect(
      sandboxProcessAsExactProcess(blockedProcess).stderr({ signal: stderrAbort.signal }),
    );
    stderrAbort.abort();
    await expect(stderrCall).rejects.toThrow();
    expect(blockedStderr.returned).toHaveBeenCalledOnce();
    const launch: AgentExactProcessLaunch = { executable: "/bin/echo", args: [], cwd: "/tmp", env: {}, timeoutMs: 1 };
    expect(launch.cwd).toBe("/tmp");
    const preAbort = new AbortController();
    preAbort.abort();
    await expect(provider.create({ ...exactInput, signal: preAbort.signal })).rejects.toThrow();
    expect(MAX_LIST_RESULTS).toBeGreaterThan(1);
  });

  it("does not delete the original exact process on a changed idempotent request", async () => {
    const originalDigest = exactProcessRequestDigest(exactInput, "tangle-sandbox", { teamId: "team-1" });
    const deleted = vi.fn(async () => undefined);
    const existing: SandboxInstanceLike = {
      id: "existing-exact-process",
      metadata: {
        runtimeMode: "control",
        [EXACT_PROCESS_METADATA_KEY]: {
          version: 1,
          provider: "tangle-sandbox",
          teamId: "team-1",
          idempotencyKey: exactInput.idempotencyKey,
          requestDigest: originalDigest,
        },
      },
      async *streamPrompt() {},
      delete: deleted,
    };
    const provider = createTangleExactProcessProvider({
      client: {
        async create() {
          return existing;
        },
        async get() {
          return existing;
        },
        async list() {
          return [existing];
        },
      },
      options: { teamId: "team-1" },
      providerName: "tangle-sandbox",
    });

    await expect(
      provider.create({ ...exactInput, metadata: { owner: "changed" } }),
    ).rejects.toThrow(/idempotency key conflicts/);
    expect(deleted).not.toHaveBeenCalled();
  });

  it("does not delete a same-key exact process owned by another provider", async () => {
    const deleted = vi.fn(async () => undefined);
    const existing: SandboxInstanceLike = {
      id: "foreign-exact-process",
      metadata: {
        runtimeMode: "control",
        [EXACT_PROCESS_METADATA_KEY]: {
          version: 1,
          provider: "other-provider",
          teamId: "other-team",
          idempotencyKey: exactInput.idempotencyKey,
          requestDigest: exactProcessRequestDigest(exactInput, "other-provider", {
            teamId: "other-team",
          }),
        },
      },
      async *streamPrompt() {},
      delete: deleted,
    };
    const provider = createTangleExactProcessProvider({
      client: {
        async create() {
          return existing;
        },
        async get() {
          return existing;
        },
        async list() {
          return [existing];
        },
      },
      options: { teamId: "team-1" },
      providerName: "tangle-sandbox",
    });

    await expect(provider.create(exactInput)).rejects.toThrow();
    expect(deleted).not.toHaveBeenCalled();
  });

  it("binds direct environment control helpers to exact replay data", () => {
    const input = { prompt: "resume", turnId: "turn-1" } as never;
    expect(hasReplayPayload(input)).toBe(true);
    expect(
      sessionPromptRequestDigest(
        input,
        "tangle-sandbox",
        "env-1",
        "session-1",
        { executionId: "execution-1" },
      ),
    ).toMatch(/^sha256:/);
  });

  it("cleans failed provider creation and rejects unrelated provider options", async () => {
    const deleted = vi.fn(async () => undefined);
    const invalidBox: SandboxInstanceLike = { id: "", async *streamPrompt() {}, delete: deleted };
    const provider = createTangleProvider({ client: { create: async () => invalidBox } });
    await expect(provider.create({ profile: { name: "worker" } })).rejects.toThrow();
    expect(deleted).toHaveBeenCalledOnce();
    const create = vi.fn(async () => invalidBox);
    const mappedProvider = createTangleProvider({ client: { create }, mapCreateInput: () => ({}) });
    await expect(mappedProvider.create({ profile: { name: "worker" }, providerOptions: { arbitrary: true } })).rejects.toThrow(/providerOptions/);
    expect(create).not.toHaveBeenCalled();
    const oversizedList = createTangleProvider({
      client: { create: async () => invalidBox, list: async () => new Array(MAX_LIST_RESULTS + 1).fill(invalidBox) },
    });
    await expect(oversizedList.list?.()).rejects.toThrow(/result bound/);
  });
});
