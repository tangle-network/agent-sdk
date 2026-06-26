import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentEnvironmentProvider,
  CreateAgentEnvironmentInput,
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

function isTerminalEvent(event: AgentEnvironmentEvent): boolean {
  if (event.type === "result" || event.type === "done" || event.type === "final") return true;
  if (event.type.endsWith(".completed") || event.type.endsWith(".failed")) return true;
  if (event.type === "status") {
    return event.data.status === "completed" || event.data.status === "failed" || event.data.status === "cancelled";
  }
  return false;
}
