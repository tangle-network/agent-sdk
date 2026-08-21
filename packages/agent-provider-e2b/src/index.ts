import {
  commandTurnEvents,
  createAgentEnvironmentWithIdempotency,
  execOnlyEnvironmentCapabilities,
  execResultFromUnknown,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentEnvironmentCreateIdempotencyRecord,
  AgentEnvironmentProvider,
  AgentTurnInput,
  CreateAgentEnvironmentInput,
  ExecRequest,
  ExecResult,
  PlacementInfo,
} from "@tangle-network/agent-interface/environment-provider";

export interface E2BSandboxClass {
  create(options?: unknown, opts?: unknown): Promise<E2BSandboxLike>;
  connect?(id: string, options?: unknown): Promise<E2BSandboxLike>;
}

export interface E2BSandboxLike {
  sandboxId?: string;
  id?: string;
  commands?: {
    run(command: string, options?: Record<string, unknown>): Promise<unknown>;
  };
  files?: {
    read(path: string): Promise<string | Uint8Array>;
    write(path: string, content: string): Promise<void>;
  };
  kill?(): Promise<void>;
  close?(): Promise<void>;
}

export interface E2BProviderOptions {
  Sandbox?: E2BSandboxClass;
  name?: string;
  template?: string;
  apiKey?: string;
  capabilities?: AgentEnvironmentCapabilities;
  turnCommand?: (input: AgentTurnInput, environment: AgentEnvironment) => string | Promise<string>;
  mapCreateInput?: (input: CreateAgentEnvironmentInput) => unknown;
}

export function createE2BProvider(options: E2BProviderOptions = {}): AgentEnvironmentProvider {
  const name = options.name ?? "e2b";
  const createRecords = new Map<
    string,
    AgentEnvironmentCreateIdempotencyRecord<AgentEnvironment>
  >();
  const createEnvironment = async (
    input: CreateAgentEnvironmentInput,
  ): Promise<AgentEnvironment> => {
    const Sandbox = options.Sandbox ?? (await loadE2BSandbox());
    const createOptions =
      options.mapCreateInput?.(input) ??
      e2bCreateOptions(options, input);
    const sandbox = await Sandbox.create(createOptions);
    return e2bSandboxAsEnvironment(options, name, sandbox);
  };
  return {
    name,
    capabilities: () => options.capabilities ?? defaultE2BCapabilities(),
    create(input) {
      return createAgentEnvironmentWithIdempotency(
        createRecords,
        input,
        () => createEnvironment(input),
      );
    },
    async get(id) {
      const Sandbox = options.Sandbox ?? (await loadE2BSandbox());
      if (!Sandbox.connect) return null;
      const sandbox = await Sandbox.connect(id, options.apiKey ? { apiKey: options.apiKey } : undefined);
      return e2bSandboxAsEnvironment(options, name, sandbox);
    },
  };
}

async function loadE2BSandbox(): Promise<E2BSandboxClass> {
  const mod = (await import("e2b")) as { Sandbox?: E2BSandboxClass };
  if (!mod.Sandbox) throw new Error("e2b package does not export Sandbox");
  return mod.Sandbox;
}

function e2bSandboxAsEnvironment(
  options: E2BProviderOptions,
  providerName: string,
  sandbox: E2BSandboxLike,
): AgentEnvironment {
  const id = sandbox.sandboxId ?? sandbox.id;
  if (!id) throw new Error("E2B sandbox returned no id");
  const environment: AgentEnvironment = {
    id,
    provider: providerName,
    status: async () => "running",
    stream(input: AgentTurnInput): AsyncIterable<AgentEnvironmentEvent> {
      return commandTurnEvents({
        input,
        environment,
        providerLabel: "E2B",
        turnCommand: options.turnCommand,
      });
    },
    ...(sandbox.files
      ? {
          async read(path: string): Promise<string> {
            const value = await sandbox.files?.read(path);
            if (typeof value === "string") return value;
            return new TextDecoder().decode(value);
          },
          write: sandbox.files.write.bind(sandbox.files),
        }
      : {}),
    async exec(command: string, request?: ExecRequest): Promise<ExecResult> {
      if (!sandbox.commands?.run) throw new Error("E2B sandbox does not expose commands.run");
      const result = await sandbox.commands.run(command, {
        ...(request?.cwd ? { cwd: request.cwd } : {}),
        ...(request?.env ? { env: request.env } : {}),
        ...(request?.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
        ...(request?.signal ? { signal: request.signal } : {}),
      });
      return execResultFromUnknown(result, "E2B sandbox commands.run");
    },
    placement: async (): Promise<PlacementInfo> => ({ kind: "provider", machineId: id, providerMetadata: { provider: "e2b" } }),
    async destroy(): Promise<void> {
      if (sandbox.kill) await sandbox.kill();
      else await sandbox.close?.();
    },
  };
  return environment;
}

function e2bCreateOptions(options: E2BProviderOptions, input: CreateAgentEnvironmentInput): Record<string, unknown> {
  const template = options.template ?? input.workspace?.environment;
  return {
    ...(template ? { template } : {}),
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(input.env ? { envs: input.env } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.providerOptions ?? {}),
  };
}

export function defaultE2BCapabilities(): AgentEnvironmentCapabilities {
  return execOnlyEnvironmentCapabilities({
    read: true,
    write: true,
    exec: true,
    git: false,
    upload: true,
    download: true,
  });
}
