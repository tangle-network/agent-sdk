import {
  commandTurnEvents,
  execOnlyEnvironmentCapabilities,
  execResultFromUnknown,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentEnvironmentProvider,
  AgentEnvironmentQuery,
  AgentEnvironmentStatus,
  AgentEnvironmentSummary,
  AgentTurnInput,
  CreateAgentEnvironmentInput,
  ExecRequest,
  ExecResult,
  PlacementInfo,
} from "@tangle-network/agent-interface/environment-provider";

export interface DaytonaLike {
  create(params?: unknown, options?: unknown): Promise<DaytonaSandboxLike>;
  get?(id: string): Promise<DaytonaSandboxLike>;
  list?(query?: unknown): AsyncIterable<DaytonaSandboxLike> | Promise<DaytonaSandboxLike[]>;
}

export interface DaytonaConstructor {
  new (config?: unknown): DaytonaLike;
}

export interface DaytonaSandboxLike {
  id?: string;
  sandboxId?: string;
  instance?: { id?: string };
  state?: string;
  refreshData?(): Promise<void>;
  waitUntilStarted?(timeout?: number): Promise<void>;
  process?: Record<string, unknown>;
  fs?: Record<string, unknown>;
  fileSystem?: Record<string, unknown>;
  delete?(): Promise<void>;
  remove?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface DaytonaProviderOptions {
  daytona?: DaytonaLike;
  Daytona?: DaytonaConstructor;
  config?: unknown;
  name?: string;
  capabilities?: AgentEnvironmentCapabilities;
  turnCommand?: (input: AgentTurnInput, environment: AgentEnvironment) => string | Promise<string>;
  mapCreateInput?: (input: CreateAgentEnvironmentInput) => unknown;
}

export function createDaytonaProvider(options: DaytonaProviderOptions = {}): AgentEnvironmentProvider {
  const name = options.name ?? "daytona";
  if (options.capabilities?.create?.workspaceSnapshot === true) {
    throw new Error("Daytona provider does not support portable workspace snapshots");
  }
  const createEnvironment = async (
    input: CreateAgentEnvironmentInput,
  ): Promise<AgentEnvironment> => {
    const daytona = await resolveDaytona(options);
    const sandbox = await daytona.create(
      options.mapCreateInput?.(input) ?? daytonaCreateParams(input),
    );
    const initialStatus = daytonaStatus(sandbox.state);
    if (initialStatus === "pending" || initialStatus === "provisioning") {
      await sandbox.waitUntilStarted?.();
    }
    if (daytonaStatus(sandbox.state) !== "running") {
      throw new Error(`Daytona create did not return a running sandbox: ${sandbox.state ?? "unknown"}`);
    }
    return { ...daytonaSandboxAsEnvironment(options, name, sandbox), creation: "created" };
  };
  return {
    name,
    capabilities: () => options.capabilities ?? defaultDaytonaCapabilities(),
    async create(input) {
      input.signal?.throwIfAborted();
      if (input.workspace?.snapshot !== undefined) {
        throw new Error("Daytona provider does not support portable workspace snapshots");
      }
      if (input.runtimeAttachments !== undefined) {
        throw new Error("Daytona provider does not support runtime MCP attachments");
      }
      if (input.idempotencyKey !== undefined) {
        throw new Error("Daytona provider does not support durable keyed creation");
      }
      return createEnvironment(input);
    },
    async get(id, request) {
      request?.signal?.throwIfAborted();
      const daytona = await resolveDaytona(options);
      if (!daytona.get) throw new Error("Daytona client does not expose a sandbox lookup API");
      try {
        const sandbox = await daytona.get(id);
        request?.signal?.throwIfAborted();
        // Daytona accepts a name as well as an ID. Recovery must never adopt
        // another sandbox after a name was reused or the source disappeared.
        assertSandboxIdentity(sandbox, id);
        return daytonaSandboxAsEnvironment(options, name, sandbox);
      } catch (error) {
        request?.signal?.throwIfAborted();
        if (isDaytonaNotFound(error)) return null;
        throw error;
      }
    },
    async list(query?: AgentEnvironmentQuery): Promise<AgentEnvironmentSummary[]> {
      const daytona = await resolveDaytona(options);
      if (!daytona.list) return [];
      const listed = await daytona.list(query?.providerOptions);
      const sandboxes = isAsyncIterable(listed) ? await collect(listed) : listed;
      return sandboxes.map((sandbox) => ({
        id: sandboxId(sandbox),
        provider: name,
        status: daytonaStatus(sandbox.state),
      }));
    },
  };
}

async function resolveDaytona(options: DaytonaProviderOptions): Promise<DaytonaLike> {
  if (options.daytona) return options.daytona;
  const Daytona = options.Daytona ?? (await loadDaytonaConstructor());
  return new Daytona(options.config);
}

async function loadDaytonaConstructor(): Promise<DaytonaConstructor> {
  const mod = (await import("@daytonaio/sdk")) as unknown as { Daytona?: DaytonaConstructor };
  if (!mod.Daytona) throw new Error("@daytonaio/sdk does not export Daytona");
  return mod.Daytona;
}

function daytonaSandboxAsEnvironment(
  options: DaytonaProviderOptions,
  providerName: string,
  sandbox: DaytonaSandboxLike,
): AgentEnvironment {
  const id = sandboxId(sandbox);
  const refresh = async (request?: { signal?: AbortSignal }): Promise<void> => {
    request?.signal?.throwIfAborted();
    await sandbox.refreshData?.();
    request?.signal?.throwIfAborted();
    assertSandboxIdentity(sandbox, id);
  };
  const environment: AgentEnvironment = {
    id,
    provider: providerName,
    async status(request) {
      try {
        await refresh(request);
        return daytonaStatus(sandbox.state);
      } catch (error) {
        request?.signal?.throwIfAborted();
        if (isDaytonaNotFound(error)) return "expired";
        throw error;
      }
    },
    refresh,
    stream(input: AgentTurnInput): AsyncIterable<AgentEnvironmentEvent> {
      return commandTurnEvents({
        input,
        environment,
        providerLabel: "Daytona",
        turnCommand: options.turnCommand,
      });
    },
    async read(path: string): Promise<string> {
      const fs = fileApi(sandbox);
      const value = await callFirst(fs, ["readFile", "downloadFile"], [path]);
      if (typeof value === "string") return value;
      if (value instanceof Uint8Array) return new TextDecoder().decode(value);
      return String(value ?? "");
    },
    async write(path: string, content: string): Promise<void> {
      const fs = fileApi(sandbox);
      await callFirst(fs, ["writeFile", "uploadFile"], [path, content], [content, path]);
    },
    async exec(command: string, request?: ExecRequest): Promise<ExecResult> {
      request?.signal?.throwIfAborted();
      assertSandboxIdentity(sandbox, id);
      const status = daytonaStatus(sandbox.state);
      if (status !== "running") {
        throw new Error(`Daytona sandbox cannot execute while ${status}; resume the recorded sandbox through Daytona`);
      }
      const proc = processApi(sandbox);
      const result = typeof proc.executeCommand === "function"
        ? await proc.executeCommand.call(proc, command, request?.cwd, request?.env, request?.timeoutMs === undefined ? undefined : request.timeoutMs / 1000)
        : await callFirst(proc, ["execute", "exec", "run"], [command, request]);
      // The published SDK returns captured output as `result`.
      const normalized = result && typeof result === "object" && "result" in result && typeof result.result === "string"
        ? { ...result, stdout: "stdout" in result ? result.stdout : result.result }
        : result;
      return execResultFromUnknown(normalized, "Daytona sandbox process execution");
    },
    placement: async (): Promise<PlacementInfo> => ({ kind: "provider", machineId: id, providerMetadata: { provider: "daytona" } }),
    async destroy(request): Promise<void> {
      request?.signal?.throwIfAborted();
      assertSandboxIdentity(sandbox, id);
      try {
        if (sandbox.delete) await sandbox.delete();
        else if (sandbox.remove) await sandbox.remove();
        else throw new Error("Daytona sandbox does not expose a delete API");
      } catch (error) {
        if (!isDaytonaNotFound(error)) throw error;
      }
    },
  };
  return environment;
}

function daytonaCreateParams(input: CreateAgentEnvironmentInput): Record<string, unknown> {
  return {
    ...(input.workspace?.environment ? { snapshot: input.workspace.environment } : {}),
    ...(input.workspace?.image ? { image: input.workspace.image } : {}),
    ...(input.workspace?.repoUrl ? { source: { repository: input.workspace.repoUrl, ref: input.workspace.gitRef } } : {}),
    ...(input.resources ? { resources: input.resources } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.metadata ? { labels: input.metadata } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.providerOptions ?? {}),
  };
}

function processApi(sandbox: DaytonaSandboxLike): Record<string, unknown> {
  if (sandbox.process && typeof sandbox.process === "object") return sandbox.process;
  throw new Error("Daytona sandbox does not expose a process API");
}

function fileApi(sandbox: DaytonaSandboxLike): Record<string, unknown> {
  const fs = sandbox.fs ?? sandbox.fileSystem;
  if (fs && typeof fs === "object") return fs;
  throw new Error("Daytona sandbox does not expose a filesystem API");
}

async function callFirst(
  target: Record<string, unknown>,
  methods: string[],
  args: unknown[],
  fallbackArgs?: unknown[],
): Promise<unknown> {
  for (const method of methods) {
    const fn = target[method];
    if (typeof fn !== "function") continue;
    try {
      return await fn.apply(target, args);
    } catch (error) {
      if (!fallbackArgs) throw error;
      return await fn.apply(target, fallbackArgs);
    }
  }
  throw new Error(`none of the Daytona methods are available: ${methods.join(", ")}`);
}

function sandboxId(sandbox: DaytonaSandboxLike): string {
  const id = sandbox.id ?? sandbox.sandboxId ?? sandbox.instance?.id;
  if (!id) throw new Error("Daytona sandbox returned no id");
  return id;
}

function assertSandboxIdentity(sandbox: DaytonaSandboxLike, expectedId: string): void {
  if (sandboxId(sandbox) !== expectedId) {
    throw new Error("Daytona sandbox identity does not match the recorded environment ID");
  }
}

function isDaytonaNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "statusCode" in error && error.statusCode === 404);
}

function daytonaStatus(state?: string): AgentEnvironmentStatus {
  switch (state) {
    case "started": return "running";
    case "stopped":
    case "paused":
    case "archived": return "stopped";
    case "error":
    case "build_failed": return "failed";
    case "destroyed": return "expired";
    case "pending_build": return "pending";
    case "creating":
    case "restoring":
    case "destroying":
    case "starting":
    case "stopping":
    case "building_snapshot":
    case "pulling_snapshot":
    case "archiving":
    case "resizing":
    case "snapshotting":
    case "forking":
    case "pausing":
    case "resuming": return "provisioning";
    default: return "unknown";
  }
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in value);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

export function defaultDaytonaCapabilities(): AgentEnvironmentCapabilities {
  return execOnlyEnvironmentCapabilities({
    read: true,
    write: true,
    exec: true,
    git: true,
    upload: true,
    download: true,
  });
}
