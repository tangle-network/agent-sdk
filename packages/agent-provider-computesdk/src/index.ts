import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentEnvironmentProvider,
  AgentEnvironmentQuery,
  AgentEnvironmentSummary,
  AgentTurnInput,
  CheckpointRef,
  CheckpointRequest,
  CreateAgentEnvironmentInput,
  ExecRequest,
  ExecResult,
  ForkRequest,
  PlacementInfo,
} from "@tangle-network/agent-interface/environment-provider";

export interface ComputeSdkLike {
  sandbox: {
    create(options?: Record<string, unknown>): Promise<ComputeSandboxLike>;
    getById?(id: string): Promise<ComputeSandboxLike | null>;
    list?(): Promise<ComputeSandboxLike[]>;
    destroy?(id: string): Promise<void>;
  };
  snapshot?: {
    create?(sandboxId: string, options?: Record<string, unknown>): Promise<{ id: string; metadata?: Record<string, unknown> }>;
  };
}

export interface ComputeSandboxLike {
  sandboxId?: string;
  id?: string;
  provider?: string;
  metadata?: Record<string, unknown>;
  runCommand(command: string, options?: Record<string, unknown>): Promise<unknown>;
  filesystem?: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
  };
}

export interface ComputeSdkProviderOptions {
  compute: ComputeSdkLike;
  name?: string;
  capabilities?: AgentEnvironmentCapabilities;
  turnCommand?: (input: AgentTurnInput, environment: AgentEnvironment) => string | Promise<string>;
  mapCreateInput?: (input: CreateAgentEnvironmentInput) => Record<string, unknown>;
}

export function createComputeSdkProvider(options: ComputeSdkProviderOptions): AgentEnvironmentProvider {
  const name = options.name ?? "computesdk";
  return {
    name,
    capabilities: () => options.capabilities ?? defaultComputeSdkCapabilities(),
    async create(input) {
      const sandbox = await options.compute.sandbox.create(
        options.mapCreateInput?.(input) ?? computeCreateOptions(input),
      );
      return computeSandboxAsEnvironment(options, name, sandbox);
    },
    ...(options.compute.sandbox.getById
      ? {
          async get(id: string): Promise<AgentEnvironment | null> {
            const sandbox = await options.compute.sandbox.getById?.(id);
            return sandbox ? computeSandboxAsEnvironment(options, name, sandbox) : null;
          },
        }
      : {}),
    ...(options.compute.sandbox.list
      ? {
          async list(_query?: AgentEnvironmentQuery): Promise<AgentEnvironmentSummary[]> {
            const sandboxes = await options.compute.sandbox.list?.();
            return (sandboxes ?? []).map((sandbox) => ({
              id: sandboxId(sandbox),
              provider: name,
              status: "running",
              metadata: sandbox.metadata,
            }));
          },
        }
      : {}),
  };
}

function computeSandboxAsEnvironment(
  options: ComputeSdkProviderOptions,
  providerName: string,
  sandbox: ComputeSandboxLike,
): AgentEnvironment {
  const id = sandboxId(sandbox);
  const environment: AgentEnvironment = {
    id,
    provider: providerName,
    status: async () => "running",
    async *stream(input: AgentTurnInput): AsyncIterable<AgentEnvironmentEvent> {
      const command =
        (await options.turnCommand?.(input, environment)) ??
        commandFromProviderOptions(input) ??
        input.prompt;
      if (!command) throw new Error("ComputeSDK provider requires turnCommand, providerOptions.command, or prompt");
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
    ...(sandbox.filesystem
      ? {
          read: sandbox.filesystem.readFile.bind(sandbox.filesystem),
          write: sandbox.filesystem.writeFile.bind(sandbox.filesystem),
        }
      : {}),
    async exec(command: string, request?: ExecRequest): Promise<ExecResult> {
      const result = await sandbox.runCommand(command, {
        ...(request?.cwd ? { cwd: request.cwd } : {}),
        ...(request?.env ? { env: request.env } : {}),
        ...(request?.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
        ...(request?.signal ? { signal: request.signal } : {}),
      });
      return execResultFromUnknown(result);
    },
    ...(options.compute.snapshot?.create
      ? {
          async checkpoint(request?: CheckpointRequest): Promise<CheckpointRef> {
            const checkpoint = await options.compute.snapshot?.create?.(id, {
              name: request?.name,
              metadata: request?.metadata,
            });
            if (!checkpoint?.id) throw new Error("ComputeSDK snapshot.create returned no id");
            return { id: checkpoint.id, provider: providerName, metadata: checkpoint.metadata };
          },
        }
      : {}),
    async placement(): Promise<PlacementInfo> {
      return {
        kind: "provider",
        machineId: id,
        providerMetadata: {
          provider: sandbox.provider,
          ...(sandbox.metadata ?? {}),
        },
      };
    },
    async destroy(): Promise<void> {
      await options.compute.sandbox.destroy?.(id);
    },
  };
  return {
    ...environment,
    ...(environment.checkpoint
      ? {
          async fork(checkpoint: CheckpointRef, request?: ForkRequest): Promise<AgentEnvironment> {
            const forked = await options.compute.sandbox.create({
              snapshot: checkpoint.id,
              ...(request?.metadata ? { metadata: request.metadata } : {}),
            });
            return computeSandboxAsEnvironment(options, providerName, forked);
          },
        }
      : {}),
  };
}

function computeCreateOptions(input: CreateAgentEnvironmentInput): Record<string, unknown> {
  return {
    ...(input.workspace?.environment ? { environment: input.workspace.environment } : {}),
    ...(input.workspace?.image ? { image: input.workspace.image } : {}),
    ...(input.workspace?.repoUrl ? { repoUrl: input.workspace.repoUrl } : {}),
    ...(input.workspace?.gitRef ? { gitRef: input.workspace.gitRef } : {}),
    ...(input.workspace?.cwd ? { cwd: input.workspace.cwd } : {}),
    ...(input.resources ? { resources: input.resources } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.providerOptions ?? {}),
  };
}

function commandFromProviderOptions(input: AgentTurnInput): string | undefined {
  return stringOption(input.providerOptions?.command) ?? stringOption(input.providerOptions?.agentCommand);
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sandboxId(sandbox: ComputeSandboxLike): string {
  const id = sandbox.sandboxId ?? sandbox.id;
  if (!id) throw new Error("ComputeSDK sandbox returned no id");
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

export function defaultComputeSdkCapabilities(): AgentEnvironmentCapabilities {
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
    workspace: { read: true, write: true, exec: true, git: false, upload: true, download: true },
    branching: { checkpoint: false, fork: false },
    placement: true,
    usage: false,
    confidential: false,
  };
}
