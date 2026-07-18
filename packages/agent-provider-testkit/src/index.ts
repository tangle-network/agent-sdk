import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentEnvironmentProvider,
  AgentExactProcessLaunch,
  CreateAgentEnvironmentInput,
  CreateAgentExactProcessEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";

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

  const environment = await provider.exactProcess.create(options.createInput);
  let destroyed = false;
  try {
    const repeated = await provider.exactProcess.create(options.createInput);
    assert(
      repeated.id === environment.id,
      "repeated exact create must recover the same environment",
      checked,
    );
    checked.push("exact-process-idempotency");

    let collisionRejected = false;
    try {
      await provider.exactProcess.create({
        ...options.createInput,
        maxLifetimeMs: options.createInput.maxLifetimeMs + 1_000,
      });
    } catch {
      collisionRejected = true;
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
    const operation = new AbortController();
    await environment.writeFile("/tmp/agent-provider-testkit.bin", expectedFile, {
      mode: 0o640,
      signal: operation.signal,
    });
    const actualFile = await environment.readFile(
      "/tmp/agent-provider-testkit.bin",
      { maxBytes: expectedFile.byteLength, signal: operation.signal },
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
        signal: operation.signal,
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
      signal: operation.signal,
    });
    const stdout = (await collect(process.stdout())).join("");
    const stderr = (await collect(process.stderr())).join("");
    const termination = await process.wait();
    const status = await process.status();
    assert(!status.running, "exact process must reach a terminal status", checked);
    assert(status.termination, "terminal exact process status requires a reason", checked);
    assert(
      JSON.stringify(status.termination) === JSON.stringify(termination),
      "wait() and status() termination reasons must match",
      checked,
    );
    assert(stdout === options.expectedStdout, "exact process stdout differs", checked);
    assert(stderr === options.expectedStderr, "exact process stderr differs", checked);
    await process.kill();
    checked.push("exact-process-run");

    const recovered = await provider.exactProcess.get(environment.id);
    assert(recovered, "exact environment must be recoverable by id", checked);
    const recoveredProcess = await recovered.process.get(process.pid);
    assert(recoveredProcess, "exact process must be recoverable by pid", checked);
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

    await environment.destroy();
    destroyed = true;
    assert(
      (await provider.exactProcess.get(environment.id)) === null,
      "destroyed exact environment must not be recoverable",
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
    if (!destroyed) await environment.destroy();
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

function isTerminalEvent(event: AgentEnvironmentEvent): boolean {
  if (event.type === "result" || event.type === "done" || event.type === "final") return true;
  if (event.type.endsWith(".completed") || event.type.endsWith(".failed")) return true;
  if (event.type === "status") {
    return event.data.status === "completed" || event.data.status === "failed" || event.data.status === "cancelled";
  }
  return false;
}
