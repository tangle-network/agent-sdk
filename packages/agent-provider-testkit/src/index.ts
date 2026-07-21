import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentEnvironmentProvider,
  AgentExactProcessEnvironment,
  AgentExactProcessLaunch,
  CreateAgentEnvironmentInput,
  CreateAgentExactProcessEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";
import type { AgentCandidateTermination } from "@tangle-network/agent-interface";

export interface ProviderConformanceOptions {
  name: string;
  createProvider(): AgentEnvironmentProvider | Promise<AgentEnvironmentProvider>;
  createInput?: Partial<CreateAgentEnvironmentInput>;
  prompt?: string;
  requireUsage?: boolean;
  requireDispatch?: boolean;
}

export interface ProviderConformanceReport {
  provider: string;
  environmentId: string;
  capabilities: AgentEnvironmentCapabilities;
  events: number;
  checked: string[];
}

export interface ExactProcessProviderLifecycleOptions {
  createProvider(): AgentEnvironmentProvider | Promise<AgentEnvironmentProvider>;
  createInput: CreateAgentExactProcessEnvironmentInput;
  launch: AgentExactProcessLaunch;
  expectedStdout: string;
  expectedStderr: string;
  /** Overall wall-clock bound for one lifecycle check. Defaults to 30 seconds. */
  timeoutMs?: number;
}

export interface ExactProcessProviderLifecycleReport {
  provider: string;
  environmentId: string;
  pid: number;
  checked: string[];
}

export class ProviderConformanceError extends Error {
  constructor(
    message: string,
    readonly checked: string[],
  ) {
    super(message);
    this.name = "ProviderConformanceError";
  }
}

export async function runAgentEnvironmentProviderConformance(
  options: ProviderConformanceOptions,
): Promise<ProviderConformanceReport> {
  const checked: string[] = [];
  const provider = await options.createProvider();
  assert(provider.name, "provider.name must be non-empty", checked);
  assert(typeof provider.capabilities === "function", "provider.capabilities must be a function", checked);
  checked.push("provider-shape");

  const capabilities = await provider.capabilities();
  assert(capabilities.profile !== undefined, "capabilities.profile is required", checked);
  assert(capabilities.streaming !== undefined, "capabilities.streaming is required", checked);
  assert(capabilities.workspace !== undefined, "capabilities.workspace is required", checked);
  checked.push("capabilities");

  const environment = await provider.create({
    profile: { name: `${options.name}-profile` },
    backend: "test",
    name: `${options.name}-environment`,
    ...(options.createInput ?? {}),
  });
  assert(environment.id, "environment.id must be non-empty", checked);
  assert(environment.provider, "environment.provider must be non-empty", checked);
  checked.push("create");

  const events = await collect(
    environment.stream({
      prompt: options.prompt ?? "Return the word ok.",
      sessionId: `${options.name}-session`,
      turnId: `${options.name}-turn`,
    }),
  );
  assert(events.length > 0, "stream must emit at least one event", checked);
  assert(
    events.some(isTerminalEvent),
    "stream must emit a terminal result/done/status event",
    checked,
  );
  if (options.requireUsage || capabilities.usage) {
    assert(
      events.some((event) => Boolean(event.usage)),
      "provider declared usage support but emitted no usage",
      checked,
    );
  }
  checked.push("stream");

  if (options.requireDispatch || capabilities.streaming.detach) {
    assert(typeof environment.dispatch === "function", "detach support requires dispatch()", checked);
    const session = await environment.dispatch?.({
      prompt: options.prompt ?? "Return the word ok.",
      sessionId: `${options.name}-dispatch`,
    });
    assert(session?.id, "dispatch() must return a session id", checked);
    checked.push("dispatch");
  }

  await checkWorkspace(environment, capabilities, checked);

  await environment.destroy?.();
  checked.push("destroy");

  return {
    provider: provider.name,
    environmentId: environment.id,
    capabilities,
    events: events.length,
    checked,
  };
}

/** Check exact launch, output, recovery, lookup, and deletion behavior. */
export async function runAgentExactProcessProviderLifecycleChecks(
  options: ExactProcessProviderLifecycleOptions,
): Promise<ExactProcessProviderLifecycleReport> {
  const checked: string[] = [];
  const provider = await options.createProvider();
  const capabilities = await provider.capabilities();
  assert(provider.exactProcess, "provider.exactProcess is required", checked);
  assert(capabilities.exactProcess, "capabilities.exactProcess is required", checked);
  assert(
    capabilities.exactProcess.egress.includes(options.createInput.egress.mode),
    `provider does not declare ${options.createInput.egress.mode} egress support`,
    checked,
  );
  checked.push("exact-process-capability");

  const processKey = options.launch.idempotencyKey;
  assert(
    typeof processKey === "string" && processKey.trim().length > 0,
    "exact process lifecycle recovery requires launch.idempotencyKey",
    checked,
  );
  const retentionMs = options.launch.retentionMs;
  assert(
    typeof retentionMs === "number" &&
      Number.isSafeInteger(retentionMs) &&
      retentionMs > 0,
    "exact process lifecycle recovery requires a positive launch.retentionMs",
    checked,
  );

  const operation = new AbortController();
  const timeout = setTimeout(
    () => operation.abort(new Error("exact process lifecycle check timed out")),
    options.timeoutMs ?? 30_000,
  );
  const signal = options.createInput.signal
    ? AbortSignal.any([options.createInput.signal, operation.signal])
    : operation.signal;
  let environment: AgentExactProcessEnvironment;
  try {
    environment = await abortable(
      provider.exactProcess.create({ ...options.createInput, signal }),
      signal,
    );
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
  let destroyAttempted = false;
  try {
    const repeated = await abortable(
      provider.exactProcess.create({ ...options.createInput, signal }),
      signal,
    );
    assert(
      repeated.id === environment.id,
      "repeated exact create must recover the same environment",
      checked,
    );
    checked.push("exact-process-idempotency");

    let collisionRejected = false;
    let collisionEnvironment: AgentExactProcessEnvironment | undefined;
    try {
      collisionEnvironment = await abortable(
        provider.exactProcess.create({
          ...options.createInput,
          maxLifetimeMs: options.createInput.maxLifetimeMs + 1_000,
          signal,
        }),
        signal,
      );
    } catch {
      collisionRejected = true;
    } finally {
      if (
        collisionEnvironment?.id &&
        collisionEnvironment.id !== environment.id
      ) {
        await abortable(
          collisionEnvironment.destroy(),
          signal,
        );
      }
    }
    assert(
      collisionRejected,
      "reusing an exact idempotency key with different input must fail",
      checked,
    );
    checked.push("exact-process-idempotency-collision");

    assert((await environment.process.list()).length === 0, "exact environment must start empty", checked);
    checked.push("fresh-environment");

    const expectedFile = Uint8Array.of(0, 1, 2, 255);
    await environment.writeFile("/tmp/agent-provider-testkit.bin", expectedFile, {
      mode: 0o640,
      signal,
    });
    const actualFile = await environment.readFile(
      "/tmp/agent-provider-testkit.bin",
      { maxBytes: expectedFile.byteLength, signal },
    );
    assert(
      bytesEqual(actualFile, expectedFile),
      "exact file read must return the bytes that were written",
      checked,
    );
    let boundedReadRejected = false;
    try {
      await environment.readFile("/tmp/agent-provider-testkit.bin", {
        maxBytes: expectedFile.byteLength - 1,
        signal,
      });
    } catch {
      boundedReadRejected = true;
    }
    assert(
      boundedReadRejected,
      "exact file read must reject content above maxBytes",
      checked,
    );
    checked.push("exact-file-roundtrip");

    const process = await environment.process.spawn(options.launch, {
      signal,
    });
    assert(
      (await environment.process.list()).some((entry) => entry.pid === process.pid),
      "spawned exact process must appear in process.list()",
      checked,
    );
    const keyed = await environment.process.list({ idempotencyKey: processKey });
    assert(
      keyed.length === 1 && keyed[0]?.pid === process.pid,
      "exact process lookup by idempotency key must return only the launched process",
      checked,
    );
    assert(
      keyed[0]?.idempotencyKey === processKey,
      "exact process lookup must preserve the idempotency key",
      checked,
    );
    const repeatedProcess = await environment.process.spawn(options.launch, {
      signal,
    });
    assert(
      repeatedProcess.pid === process.pid,
      "repeated exact process launch must return the existing process",
      checked,
    );
    let launchCollisionRejected = false;
    try {
      await environment.process.spawn(
        {
          ...options.launch,
          args: [...options.launch.args, "--different-launch"],
        },
        { signal },
      );
    } catch {
      launchCollisionRejected = true;
    }
    assert(
      launchCollisionRejected,
      "reusing a process idempotency key with a different launch must fail",
      checked,
    );
    const stdout = (await collect(process.stdout())).join("");
    const stderr = (await collect(process.stderr())).join("");
    const termination = await abortable(process.wait(), signal);
    const status = await process.status();
    assert(!status.running, "exact process must reach a terminal status", checked);
    assert(
      status.idempotencyKey === processKey,
      "terminal exact process status must preserve its idempotency key",
      checked,
    );
    assert(status.termination, "terminal exact process status requires a reason", checked);
    assert(
      terminationEqual(status.termination, termination),
      "wait() and status() termination reasons must match",
      checked,
    );
    assert(stdout === options.expectedStdout, "exact process stdout differs", checked);
    assert(stderr === options.expectedStderr, "exact process stderr differs", checked);
    await process.kill();
    checked.push("exact-process-launch-idempotency");
    checked.push("exact-process-run");

    const recovered = await provider.exactProcess.get(environment.id);
    assert(recovered, "exact environment must be recoverable by id", checked);
    const recoveredProcess = await recovered.process.get(process.pid);
    assert(recoveredProcess, "exact process must be recoverable by pid", checked);
    const recoveredByKey = await recovered.process.list({
      idempotencyKey: processKey,
    });
    assert(
      recoveredByKey.length === 1 && recoveredByKey[0]?.pid === process.pid,
      "recovered environment must retain its exact process lookup by idempotency key",
      checked,
    );
    assert(
      (await collect(recoveredProcess.stdout())).join("") === options.expectedStdout,
      "recovered exact process stdout differs",
      checked,
    );
    assert(
      (await collect(recoveredProcess.stderr())).join("") === options.expectedStderr,
      "recovered exact process stderr differs",
      checked,
    );
    checked.push("exact-process-recovery");

    const listed = await provider.exactProcess.list({ metadata: options.createInput.metadata });
    assert(
      listed.filter((candidate) => candidate.id === environment.id).length === 1,
      "exact environment metadata lookup must return one matching id",
      checked,
    );
    checked.push("exact-process-list");

    destroyAttempted = true;
    await abortable(environment.destroy(), signal);
    assert(
      (await provider.exactProcess.get(environment.id)) === null,
      "destroyed exact environment must not be recoverable",
      checked,
    );
    assert(
      !(await provider.exactProcess.list({
        metadata: options.createInput.metadata,
      })).some((candidate) => candidate.id === environment.id),
      "destroyed exact environment must disappear from list()",
      checked,
    );
    checked.push("exact-process-destroy");

    return {
      provider: provider.name,
      environmentId: environment.id,
      pid: process.pid,
      checked,
    };
  } finally {
    clearTimeout(timeout);
    if (!destroyAttempted) await environment.destroy();
  }
}

async function checkWorkspace(
  environment: AgentEnvironment,
  capabilities: AgentEnvironmentCapabilities,
  checked: string[],
): Promise<void> {
  if (capabilities.workspace.write) {
    assert(typeof environment.write === "function", "workspace.write requires write()", checked);
    await environment.write?.("agent-provider-testkit.txt", "ok");
    checked.push("workspace-write");
  }

  if (capabilities.workspace.read) {
    assert(typeof environment.read === "function", "workspace.read requires read()", checked);
    await environment.read?.("agent-provider-testkit.txt");
    checked.push("workspace-read");
  }

  if (capabilities.workspace.exec) {
    assert(typeof environment.exec === "function", "workspace.exec requires exec()", checked);
    const result = await environment.exec?.("echo ok");
    assert(result?.exitCode !== undefined, "exec() must return an exit code", checked);
    checked.push("workspace-exec");
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

function assert(value: unknown, message: string, checked: string[]): asserts value {
  if (!value) throw new ProviderConformanceError(message, checked);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function terminationEqual(
  left: AgentCandidateTermination,
  right: AgentCandidateTermination,
): boolean {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "exit":
      return a.exitCode === b.exitCode;
    case "timeout":
      return a.timeoutMs === b.timeoutMs;
    case "signal":
      return a.signal === b.signal;
    case "cancelled":
      return true;
    default:
      return false;
  }
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new Error("operation aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function isTerminalEvent(event: AgentEnvironmentEvent): boolean {
  if (event.type === "result" || event.type === "done" || event.type === "final") return true;
  if (event.type.endsWith(".completed") || event.type.endsWith(".failed")) return true;
  if (event.type === "status") {
    return event.data.status === "completed" || event.data.status === "failed" || event.data.status === "cancelled";
  }
  return false;
}
