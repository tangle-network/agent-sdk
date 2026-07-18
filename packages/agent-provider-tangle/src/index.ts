import type {
  BackendType,
  CreateSandboxOptions,
  ExactProcessAttestation,
  ExecResult as SandboxExecResult,
  PromptOptions,
  PromptResult,
  SandboxEvent,
} from "@tangle-network/sandbox";
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentEvent,
  AgentEnvironmentProvider,
  AgentEnvironmentQuery,
  AgentEnvironmentStatus,
  AgentEnvironmentSummary,
  AgentProfileRef,
  AgentSession,
  AgentSessionRef,
  AgentSessionStatus,
  AgentTurnInput,
  AgentTurnResult,
  CheckpointRef,
  CheckpointRequest,
  CreateAgentEnvironmentInput,
  ExecRequest,
  ExecResult,
  ForkRequest,
  PlacementInfo,
  ResourceRequest,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentCandidateTermination,
  InputPart,
  TokenUsage,
} from "@tangle-network/agent-interface";
import {
  createTangleExactProcessProvider,
  type TangleExactProcessOptions,
} from "./exact-process.js";

export type { TangleExactProcessOptions } from "./exact-process.js";

export interface SandboxClientLike {
  create(
    options?: CreateSandboxOptions,
    requestOptions?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<SandboxInstanceLike>;
  get?(id: string): Promise<SandboxInstanceLike | null>;
  list?(options?: unknown): Promise<SandboxInstanceLike[]>;
  describePlacement?(box: SandboxInstanceLike): unknown;
}

export interface SandboxProcessStatusLike {
  pid: number;
  running: boolean;
  exitCode: number;
  exitSignal?: string;
  termination?: AgentCandidateTermination;
}

export interface SandboxProcessLike {
  readonly pid: number;
  status(): Promise<SandboxProcessStatusLike>;
  wait(): Promise<number>;
  waitForTermination(): Promise<AgentCandidateTermination>;
  kill(signal?: "SIGKILL", options?: { tree?: boolean }): Promise<void>;
  stdout(): AsyncIterable<string>;
  stderr(): AsyncIterable<string>;
}

export interface SandboxProcessManagerLike {
  list(): Promise<SandboxProcessStatusLike[]>;
  get(pid: number): Promise<SandboxProcessLike | null>;
  spawnExact(
    executable: string,
    args: readonly string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      inheritEnv?: boolean;
      stdin?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<SandboxProcessLike>;
}

export interface SandboxInstanceLike {
  id: string;
  name?: string;
  status?: unknown;
  metadata?: Record<string, unknown>;
  exactProcess?: ExactProcessAttestation;
  teamId?: string;
  streamPrompt(message: string | InputPart[], options?: PromptOptions): AsyncIterable<SandboxEvent>;
  prompt?(message: string | InputPart[], options?: PromptOptions): Promise<PromptResult>;
  dispatchPrompt?(message: string | InputPart[], options?: PromptOptions): Promise<unknown>;
  session?(id: string): SandboxSessionLike;
  read?(path: string, options?: { sessionId?: string }): Promise<string>;
  write?(path: string, content: string, options?: { sessionId?: string }): Promise<void>;
  exec?(command: string, options?: unknown): Promise<SandboxExecResult>;
  fs?: {
    supportsWriteMode?: true;
    readBytes(
      path: string,
      options: { maxBytes: number; signal?: AbortSignal },
    ): Promise<Uint8Array>;
    write(
      path: string,
      content: string,
      options: { encoding: "base64"; mode: number; signal?: AbortSignal },
    ): Promise<unknown>;
  };
  process?: SandboxProcessManagerLike;
  checkpoint?(options?: unknown): Promise<unknown>;
  fork?(checkpointId: string, options?: unknown): Promise<SandboxInstanceLike>;
  refresh?(): Promise<void>;
  delete?(): Promise<void>;
}

export interface SandboxSessionLike {
  readonly id: string;
  status(): Promise<unknown | null>;
  events(options?: { since?: string; signal?: AbortSignal }): AsyncIterable<SandboxEvent>;
  result(): Promise<PromptResult>;
  prompt(message: string | InputPart[], options?: PromptOptions): Promise<PromptResult>;
  cancel(): Promise<void>;
}

export interface TangleProviderOptions {
  client: SandboxClientLike;
  name?: string;
  defaultBackend?: BackendType;
  capabilities?: AgentEnvironmentCapabilities | (() => AgentEnvironmentCapabilities | Promise<AgentEnvironmentCapabilities>);
  validateProfile?: AgentEnvironmentProvider["validateProfile"];
  mapCreateInput?: (input: CreateAgentEnvironmentInput) => CreateSandboxOptions;
  exactProcess?: TangleExactProcessOptions;
}

export function createTangleProvider(
  options: TangleProviderOptions,
): AgentEnvironmentProvider {
  const providerName = options.name ?? "tangle-sandbox";
  const exactProcess = options.exactProcess
    ? createTangleExactProcessProvider({
        client: options.client,
        options: options.exactProcess,
        providerName,
      })
    : undefined;
  return {
    name: providerName,
    ...(exactProcess ? { exactProcess } : {}),
    capabilities: async () => {
      const capabilities = options.capabilities
        ? typeof options.capabilities === "function"
          ? await options.capabilities()
          : options.capabilities
        : defaultTangleSandboxCapabilities();
      if (!exactProcess && capabilities.exactProcess) {
        throw new Error(
          "Tangle capabilities cannot advertise exactProcess without exactProcess configuration",
        );
      }
      return exactProcess
        ? { ...capabilities, exactProcess: { egress: ["blocked", "strict"] } }
        : capabilities;
    },
    ...(options.validateProfile ? { validateProfile: options.validateProfile } : {}),
    async create(input) {
      const createOptions =
        options.mapCreateInput?.(input) ??
        sandboxOptionsFromCreateInput(input, options.defaultBackend ?? "opencode");
      const box = await options.client.create(createOptions);
      return sandboxInstanceAsEnvironment(box, providerName, options.client);
    },
    ...(options.client.get
      ? {
          async get(id: string): Promise<AgentEnvironment | null> {
            const box = await options.client.get?.(id);
            return box ? sandboxInstanceAsEnvironment(box, providerName, options.client) : null;
          },
        }
      : {}),
    ...(options.client.list
      ? {
          async list(query?: AgentEnvironmentQuery): Promise<AgentEnvironmentSummary[]> {
            const boxes = await options.client.list?.(query?.providerOptions);
            return (boxes ?? []).map((box) => ({
              id: String(box.id),
              provider: providerName,
              ...(box.name ? { name: box.name } : {}),
              status: statusFromUnknown(box.status),
              ...(box.metadata ? { metadata: box.metadata } : {}),
            }));
          },
        }
      : {}),
  };
}

function sandboxInstanceAsEnvironment(
  box: SandboxInstanceLike,
  providerName: string,
  client: SandboxClientLike,
): AgentEnvironment {
  return {
    id: String(box.id),
    provider: providerName,
    ...(box.name ? { name: box.name } : {}),
    async status(): Promise<AgentEnvironmentStatus> {
      await box.refresh?.();
      return statusFromUnknown(box.status);
    },
    async *stream(input: AgentTurnInput): AsyncIterable<AgentEnvironmentEvent> {
      for await (const event of box.streamPrompt(promptFromTurnInput(input), promptOptionsFromTurnInput(input))) {
        yield environmentEventFromSandboxEvent(event);
      }
    },
    ...(box.dispatchPrompt
      ? {
          async dispatch(input: AgentTurnInput): Promise<AgentSessionRef> {
            const dispatched = await box.dispatchPrompt?.(
              promptFromTurnInput(input),
              promptOptionsFromTurnInput(input),
            );
            return sessionRefFromSandboxDispatch(dispatched, providerName);
          },
        }
      : {}),
    ...(box.session
      ? {
          session(id: string): AgentSession {
            const session = box.session?.(id);
            if (!session) throw new Error("sandbox session(id) returned undefined");
            return sandboxSessionAsAgentSession(session);
          },
        }
      : {}),
    ...(box.read ? { read: box.read.bind(box) } : {}),
    ...(box.write ? { write: box.write.bind(box) } : {}),
    ...(box.exec
      ? {
          async exec(command: string, options?: ExecRequest): Promise<ExecResult> {
            return execResultFromSandboxExecResult(await box.exec?.(command, options as never));
          },
        }
      : {}),
    ...(box.checkpoint
      ? {
          async checkpoint(options?: CheckpointRequest): Promise<CheckpointRef> {
            const result = await box.checkpoint?.(options as never);
            return { id: checkpointIdFromResult(result), provider: providerName };
          },
        }
      : {}),
    ...(box.fork
      ? {
          async fork(checkpoint: CheckpointRef, options?: ForkRequest): Promise<AgentEnvironment> {
            const forked = await box.fork?.(checkpoint.id, options as never);
            if (!forked) throw new Error("sandbox fork returned no environment");
            return sandboxInstanceAsEnvironment(forked, providerName, client);
          },
        }
      : {}),
    async placement(): Promise<PlacementInfo> {
      return placementInfoFromLoopPlacement(client.describePlacement?.(box), box);
    },
    async refresh(): Promise<void> {
      await box.refresh?.();
    },
    async destroy(): Promise<void> {
      await box.delete?.();
    },
  };
}

function sandboxSessionAsAgentSession(session: SandboxSessionLike): AgentSession {
  return {
    id: session.id,
    async status(): Promise<AgentSessionStatus | null> {
      const status = await session.status();
      if (!status) return null;
      return sessionStatusFromUnknown((status as { status?: unknown }).status);
    },
    async *events(options?: {
      since?: string;
      signal?: AbortSignal;
    }): AsyncIterable<AgentEnvironmentEvent> {
      for await (const event of session.events(options)) yield environmentEventFromSandboxEvent(event);
    },
    async result(): Promise<AgentTurnResult> {
      return agentTurnResultFromPromptResult(await session.result());
    },
    async prompt(input: AgentTurnInput): Promise<AgentTurnResult> {
      return agentTurnResultFromPromptResult(
        await session.prompt(promptFromTurnInput(input), promptOptionsFromTurnInput(input)),
      );
    },
    cancel: session.cancel.bind(session),
  };
}

function sandboxOptionsFromCreateInput(
  input: CreateAgentEnvironmentInput,
  defaultBackend: BackendType,
): CreateSandboxOptions {
  const workspace = input.workspace ?? {};
  const providerOptions = input.providerOptions?.sandboxCreateOptions;
  const base =
    providerOptions && typeof providerOptions === "object"
      ? ({ ...(providerOptions as CreateSandboxOptions) } as CreateSandboxOptions)
      : ({} satisfies CreateSandboxOptions);
  return {
    ...base,
    ...(workspace.environment ? { environment: workspace.environment } : {}),
    ...(workspace.image ? { image: workspace.image } : {}),
    ...(workspace.repoUrl ? { git: { url: workspace.repoUrl, ref: workspace.gitRef } } : {}),
    ...(input.resources ? { resources: input.resources as unknown as CreateSandboxOptions["resources"] } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(Array.isArray(input.secrets) ? { secrets: input.secrets } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    backend: {
      ...(base.backend ?? {}),
      type: (input.backend ?? defaultBackend) as BackendType,
      profile: input.profile,
    },
  };
}

function environmentEventFromSandboxEvent(event: SandboxEvent): AgentEnvironmentEvent {
  const data =
    event.data && typeof event.data === "object"
      ? (event.data as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  return {
    type: String(event.type),
    data,
    ...(event.id ? { id: event.id } : {}),
    usage: tokenUsageFromData(data),
    providerEvent: event,
  };
}

function promptFromTurnInput(input: AgentTurnInput): string | InputPart[] {
  if (input.parts) return input.parts;
  return input.prompt ?? "";
}

function promptOptionsFromTurnInput(input: AgentTurnInput): PromptOptions {
  return {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.lastEventId ? { lastEventId: input.lastEventId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.detach !== undefined ? { detach: input.detach } : {}),
  };
}

function agentTurnResultFromPromptResult(result: PromptResult): AgentTurnResult {
  const record = result as unknown as Record<string, unknown>;
  const text =
    typeof record.response === "string"
      ? record.response
      : typeof record.text === "string"
        ? record.text
        : typeof record.finalText === "string"
          ? record.finalText
          : "";
  const success = typeof record.success === "boolean" ? record.success : true;
  return {
    text,
    success,
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    usage: tokenUsageFromData(record),
  };
}

function sessionRefFromSandboxDispatch(dispatched: unknown, providerName: string): AgentSessionRef {
  const record =
    dispatched && typeof dispatched === "object"
      ? (dispatched as Record<string, unknown>)
      : undefined;
  const id = record?.sessionId ?? record?.id;
  if (typeof id !== "string" || id.length === 0 || !record) {
    throw new Error("sandbox dispatch returned no session id");
  }
  return {
    id,
    provider: providerName,
    metadata: {
      ...(record.status ? { status: record.status } : {}),
      ...(record.alreadyExisted !== undefined ? { alreadyExisted: record.alreadyExisted } : {}),
    },
  };
}

function execResultFromSandboxExecResult(result: SandboxExecResult | undefined): ExecResult {
  const record = (result ?? {}) as unknown as Record<string, unknown>;
  return {
    exitCode: finiteNumber(record.exitCode) ?? finiteNumber(record.code) ?? 0,
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: typeof record.stderr === "string" ? record.stderr : "",
  };
}

function checkpointIdFromResult(result: unknown): string {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const id = record.checkpointId ?? record.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("sandbox checkpoint returned no checkpoint id");
  }
  return id;
}

function placementInfoFromLoopPlacement(
  placement: unknown,
  box: SandboxInstanceLike,
): PlacementInfo {
  if (!placement || typeof placement !== "object") return { kind: "sandbox", sandboxId: String(box.id) };
  const record = placement as Record<string, unknown>;
  return {
    kind: record.kind === "fleet" ? "fleet" : "sandbox",
    sandboxId: typeof record.sandboxId === "string" ? record.sandboxId : String(box.id),
    ...(typeof record.fleetId === "string" ? { fleetId: record.fleetId } : {}),
    ...(typeof record.machineId === "string" ? { machineId: record.machineId } : {}),
  };
}

function tokenUsageFromData(data: Record<string, unknown>): TokenUsage | undefined {
  const usageRecord =
    data.usage && typeof data.usage === "object"
      ? (data.usage as Record<string, unknown>)
      : data.tokenUsage && typeof data.tokenUsage === "object"
        ? (data.tokenUsage as Record<string, unknown>)
        : data;
  const inputTokens =
    finiteNumber(usageRecord.inputTokens) ??
    finiteNumber(usageRecord.tokensIn) ??
    finiteNumber(usageRecord.prompt_tokens);
  const outputTokens =
    finiteNumber(usageRecord.outputTokens) ??
    finiteNumber(usageRecord.tokensOut) ??
    finiteNumber(usageRecord.completion_tokens);
  const cost =
    finiteNumber(usageRecord.cost) ??
    finiteNumber(usageRecord.costUsd) ??
    finiteNumber(usageRecord.totalCostUsd) ??
    finiteNumber(data.costUsd) ??
    finiteNumber(data.totalCostUsd);
  if (inputTokens === undefined && outputTokens === undefined && cost === undefined) return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cost !== undefined ? { cost } : {}),
  };
}

function statusFromUnknown(status: unknown): AgentEnvironmentStatus {
  if (status === "pending" || status === "provisioning" || status === "running") return status;
  if (status === "stopped" || status === "failed" || status === "expired") return status;
  if (status === "completed" || status === "cancelled") return "stopped";
  return "unknown";
}

function sessionStatusFromUnknown(status: unknown): AgentSessionStatus {
  if (status === "completed" || status === "cancelled") return status;
  return statusFromUnknown(status);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function defaultTangleSandboxCapabilities(): AgentEnvironmentCapabilities {
  return {
    profile: {
      namedProfiles: true,
      systemPrompt: true,
      instructions: true,
      tools: true,
      permissions: true,
      mcp: true,
      subagents: true,
      resources: {
        files: true,
        instructions: true,
        tools: true,
        skills: true,
        agents: true,
        commands: true,
      },
      hooks: true,
      modes: true,
      runtimeUpdate: true,
      validation: true,
    },
    streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
    sessions: { continue: true, list: true, messages: true },
    workspace: { read: true, write: true, exec: true, git: true, upload: true, download: true },
    branching: { checkpoint: true, fork: true },
    placement: true,
    usage: true,
    confidential: true,
  };
}
