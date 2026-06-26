import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentEnvironmentProvider,
  AgentEnvironmentQuery,
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
  return {
    name,
    capabilities: () => options.capabilities ?? defaultDaytonaCapabilities(),
    async create(input) {
      const daytona = await resolveDaytona(options);
      const sandbox = await daytona.create(
        options.mapCreateInput?.(input) ?? daytonaCreateParams(input),
      );
      return daytonaSandboxAsEnvironment(options, name, sandbox);
    },
    async get(id) {
      const daytona = await resolveDaytona(options);
      if (!daytona.get) return null;
      return daytonaSandboxAsEnvironment(options, name, await daytona.get(id));
    },
    async list(query?: AgentEnvironmentQuery): Promise<AgentEnvironmentSummary[]> {
      const daytona = await resolveDaytona(options);
      if (!daytona.list) return [];
      const listed = await daytona.list(query?.providerOptions);
      const sandboxes = isAsyncIterable(listed) ? await collect(listed) : listed;
      return sandboxes.map((sandbox) => ({
        id: sandboxId(sandbox),
        provider: name,
        status: sandbox.state === "stopped" ? "stopped" : "running",
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
  const environment: AgentEnvironment = {
    id,
    provider: providerName,
    status: async () => (sandbox.state === "stopped" ? "stopped" : "running"),
    async *stream(input: AgentTurnInput): AsyncIterable<AgentEnvironmentEvent> {
      const command =
        (await options.turnCommand?.(input, environment)) ??
        commandFromProviderOptions(input) ??
        input.prompt;
      if (!command) throw new Error("Daytona provider requires turnCommand, providerOptions.command, or prompt");
      const result = await environment.exec?.(command, {
        cwd: stringOption(input.providerOptions?.cwd),
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      });
      const text = result?.stdout ?? "";
      yield { type: "message.part.updated", data: { delta: text } };
      yield {
        type: "result",
        data: {
          finalText: text,
          status: result?.exitCode === 0 ? "completed" : "failed",
          exitCode: result?.exitCode ?? 1,
          stderr: result?.stderr ?? "",
        },
      };
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
      const proc = processApi(sandbox);
      const result = await callFirst(
        proc,
        ["executeCommand", "execute", "exec", "run"],
        [command, { cwd: request?.cwd, timeoutMs: request?.timeoutMs, env: request?.env, signal: request?.signal }],
      );
      return execResultFromUnknown(result);
    },
    placement: async (): Promise<PlacementInfo> => ({ kind: "provider", machineId: id, providerMetadata: { provider: "daytona" } }),
    async destroy(): Promise<void> {
      if (sandbox.delete) await sandbox.delete();
      else if (sandbox.remove) await sandbox.remove();
      else await sandbox.stop?.();
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

function commandFromProviderOptions(input: AgentTurnInput): string | undefined {
  return stringOption(input.providerOptions?.command) ?? stringOption(input.providerOptions?.agentCommand);
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sandboxId(sandbox: DaytonaSandboxLike): string {
  const id = sandbox.id ?? sandbox.sandboxId ?? sandbox.instance?.id;
  if (!id) throw new Error("Daytona sandbox returned no id");
  return id;
}

function execResultFromUnknown(value: unknown): ExecResult {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    exitCode: number(record.exitCode) ?? number(record.code) ?? 0,
    stdout: typeof record.stdout === "string" ? record.stdout : typeof record.output === "string" ? record.output : "",
    stderr: typeof record.stderr === "string" ? record.stderr : typeof record.error === "string" ? record.error : "",
  };
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  return {
    profile: {
      namedProfiles: false,
      systemPrompt: false,
      instructions: false,
      tools: false,
      permissions: false,
      mcp: false,
      subagents: false,
      resources: {
        files: true,
        instructions: false,
        tools: false,
        skills: false,
        agents: false,
        commands: false,
      },
      hooks: false,
      modes: false,
      runtimeUpdate: false,
      validation: false,
    },
    streaming: { live: false, replay: false, detach: false, turnIdempotency: false },
    sessions: { continue: false, list: false, messages: false },
    workspace: { read: true, write: true, exec: true, git: true, upload: true, download: true },
    branching: { checkpoint: false, fork: false },
    placement: true,
    usage: false,
    confidential: false,
  };
}
