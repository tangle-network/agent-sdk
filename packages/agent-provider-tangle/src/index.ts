import type {
  BackendType,
  CreateSandboxOptions,
  ExecResult as SandboxExecResult,
  PromptOptions,
  PromptResult,
  SandboxEvent,
} from "@tangle-network/sandbox";
import { createHash, randomUUID } from "node:crypto";
import {
  AgentEnvironmentCapabilitiesSchema,
  type AgentEnvironment,
  type AgentEnvironmentCapabilities,
  type AgentEnvironmentEvent,
  type AgentEnvironmentProvider,
  type AgentEnvironmentQuery,
  type AgentEnvironmentStatus,
  type AgentEnvironmentSummary,
  type AgentProfileRef,
  type AgentSession,
  type AgentSessionRef,
  type AgentSessionStatus,
  type AgentTurnInput,
  type AgentTurnResult,
  type CheckpointRef,
  type CheckpointRequest,
  type CreateAgentEnvironmentInput,
  type ExecRequest,
  type ExecResult,
  type ForkRequest,
  type PlacementInfo,
  type ResourceRequest,
} from "@tangle-network/agent-interface/environment-provider";
import type {
  AgentRunControlRef,
  HarnessType,
  InputPart,
  TokenUsage,
} from "@tangle-network/agent-interface";
import {
  AgentRunControlRefSchema,
  ContextTransferReceiptSchema,
  harnessSystemPromptIntents,
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
}

export interface SandboxProcessLike {
  readonly pid: number;
  status(): Promise<SandboxProcessStatusLike>;
  wait(): Promise<number>;
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
  streamPrompt(message: string | InputPart[], options?: PromptOptions): AsyncIterable<SandboxEvent>;
  prompt?(message: string | InputPart[], options?: PromptOptions): Promise<PromptResult>;
  dispatchPrompt?(message: string | InputPart[], options?: PromptOptions): Promise<unknown>;
  session?(id: string): SandboxSessionLike;
  read?(path: string, options?: { sessionId?: string }): Promise<string>;
  write?(path: string, content: string, options?: { sessionId?: string }): Promise<unknown>;
  exec?(command: string, options?: unknown): Promise<SandboxExecResult>;
  fs?: {
    supportsWriteMode?: true;
    stat(path: string): Promise<{ size: number; isFile: boolean }>;
    readBatch(
      paths: string[],
      options?: { encoding?: "utf8" | "base64" },
    ): Promise<{
      files: Array<{
        path: string;
        content: string;
        encoding: "utf8" | "base64";
        size: number;
      }>;
      errors: Array<{ path: string; error: string; code?: string }>;
    }>;
    write(
      path: string,
      content: string,
      options: { encoding: "base64"; mode: number },
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
  events(options?: {
    since?: string;
    executionId?: string;
    signal?: AbortSignal;
  }): AsyncIterable<SandboxEvent>;
  result(options?: { executionId?: string }): Promise<PromptResult>;
  prompt(message: string | InputPart[], options?: PromptOptions): Promise<PromptResult>;
  interrupt(options?: { executionId?: string }): Promise<{ cancelled: boolean }>;
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
  const resolveCapabilities = async (): Promise<AgentEnvironmentCapabilities> => {
    const configured = options.capabilities
      ? typeof options.capabilities === "function"
        ? await options.capabilities()
        : options.capabilities
      : defaultTangleSandboxCapabilities();
    if (!exactProcess && configured.exactProcess) {
      throw new Error(
        "Tangle capabilities cannot advertise exactProcess without exactProcess configuration",
      );
    }
    return AgentEnvironmentCapabilitiesSchema.parse(
      exactProcess
        ? {
            ...configured,
            exactProcess: { egress: ["blocked", "strict"] },
          }
        : configured,
    );
  };
  return {
    name: providerName,
    ...(exactProcess ? { exactProcess } : {}),
    capabilities: resolveCapabilities,
    ...(options.validateProfile ? { validateProfile: options.validateProfile } : {}),
    async create(input) {
      const capabilities = await resolveCapabilities();
      const createOptions =
        options.mapCreateInput?.(input) ??
        sandboxOptionsFromCreateInput(input, options.defaultBackend ?? "opencode");
      const box = await options.client.create(
        createOptions,
        input.signal ? { signal: input.signal } : undefined,
      );
      return sandboxInstanceAsEnvironment(
        box,
        providerName,
        options.client,
        capabilities,
      );
    },
    ...(options.client.get
      ? {
          async get(id: string): Promise<AgentEnvironment | null> {
            const box = await options.client.get?.(id);
            return box
              ? sandboxInstanceAsEnvironment(
                  box,
                  providerName,
                  options.client,
                  await resolveCapabilities(),
                )
              : null;
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
  capabilities: AgentEnvironmentCapabilities,
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
      const expectedExecutionId = executionIdFromTurnInput(input);
      const expectedSessionId = input.sessionId ?? input.controlRef?.sessionId;
      for await (const event of box.streamPrompt(
        promptFromTurnInput(input),
        promptOptionsFromTurnInput(input, {
          provider: providerName,
          environmentId: String(box.id),
        }),
      )) {
        yield environmentEventFromSandboxEvent(event, {
          executionId: expectedExecutionId,
          sessionId: expectedSessionId,
        });
      }
    },
    ...(capabilities.streaming.detach && box.dispatchPrompt
      ? {
          async dispatch(input: AgentTurnInput): Promise<AgentSessionRef> {
            const dispatched = await box.dispatchPrompt?.(
              promptFromTurnInput(input),
              promptOptionsFromTurnInput(input, {
                provider: providerName,
                environmentId: String(box.id),
              }),
            );
            return sessionRefFromSandboxDispatch(
              dispatched,
              providerName,
              String(box.id),
              executionIdFromTurnInput(input),
            );
          },
        }
      : {}),
    ...((capabilities.sessions.continue ||
      capabilities.streaming.replay ||
      capabilities.streaming.detach) &&
    box.session
      ? {
          session(
            id: string,
            options?: { controlRef?: AgentRunControlRef },
          ): AgentSession {
            const session = box.session?.(id);
            if (!session) throw new Error("sandbox session(id) returned undefined");
            return sandboxSessionAsAgentSession(
              session,
              resolveRetainedSessionControlRef(
                options?.controlRef,
                session.id,
                providerName,
                String(box.id),
              ),
              providerName,
              String(box.id),
            );
          },
        }
      : {}),
    ...(capabilities.workspace.read && box.read
      ? { read: box.read.bind(box) }
      : {}),
    ...(capabilities.workspace.write && box.write
      ? {
          async write(path: string, content: string): Promise<void> {
            await box.write?.(path, content);
          },
        }
      : {}),
    ...(capabilities.workspace.exec && box.exec
      ? {
          async exec(command: string, options?: ExecRequest): Promise<ExecResult> {
            return execResultFromSandboxExecResult(await box.exec?.(command, options as never));
          },
        }
      : {}),
    ...(capabilities.branching.checkpoint && box.checkpoint
      ? {
          async checkpoint(options?: CheckpointRequest): Promise<CheckpointRef> {
            const result = await box.checkpoint?.(options as never);
            return { id: checkpointIdFromResult(result), provider: providerName };
          },
        }
      : {}),
    ...(capabilities.branching.fork && box.fork
      ? {
          async fork(checkpoint: CheckpointRef, options?: ForkRequest): Promise<AgentEnvironment> {
            const forked = await box.fork?.(checkpoint.id, options as never);
            if (!forked) throw new Error("sandbox fork returned no environment");
            return sandboxInstanceAsEnvironment(
              forked,
              providerName,
              client,
              capabilities,
            );
          },
        }
      : {}),
    ...(capabilities.placement
      ? {
          async placement(): Promise<PlacementInfo> {
            return placementInfoFromLoopPlacement(
              client.describePlacement?.(box),
              box,
            );
          },
        }
      : {}),
    async refresh(): Promise<void> {
      await box.refresh?.();
    },
    async destroy(): Promise<void> {
      await box.delete?.();
    },
  };
}

function sandboxSessionAsAgentSession(
  session: SandboxSessionLike,
  controlRef: AgentRunControlRef | undefined,
  provider: string,
  environmentId: string,
): AgentSession {
  let activeControlRef = controlRef;
  return {
    id: session.id,
    get controlRef(): AgentRunControlRef | undefined {
      return activeControlRef;
    },
    async status(): Promise<AgentSessionStatus | null> {
      const status = await session.status();
      if (!status) return null;
      return sessionStatusFromUnknown((status as { status?: unknown }).status);
    },
    async *events(options?: {
      since?: string;
      executionId?: string;
      signal?: AbortSignal;
    }): AsyncIterable<AgentEnvironmentEvent> {
      if (
        options?.executionId !== undefined &&
        activeControlRef?.executionId !== undefined &&
        options.executionId !== activeControlRef.executionId
      ) {
        throw new Error(
          "Tangle replay executionId conflicts with the control reference",
        );
      }
      const executionId = activeControlRef?.executionId ?? options?.executionId;
      if (options?.since !== undefined && executionId === undefined) {
        throw new Error(
          "Tangle cursor replay requires an exact executionId from its control reference",
        );
      }
      const seenEventIds = new Set<string>();
      for await (const event of session.events({
        ...(options?.since !== undefined ? { since: options.since } : {}),
        ...(executionId !== undefined ? { executionId } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      })) {
        if (options?.since !== undefined && event.id === options.since) continue;
        const converted = environmentEventFromSandboxEvent(event, {
          executionId,
          sessionId: session.id,
        });
        if (executionId !== undefined && converted.id === undefined) {
          throw new Error(
            "Tangle exact session replay received an event without a stable id",
          );
        }
        if (converted.id !== undefined) {
          if (seenEventIds.has(converted.id)) {
            throw new Error(
              `Tangle session replay repeated event id ${converted.id}`,
            );
          }
          seenEventIds.add(converted.id);
        }
        yield converted;
      }
    },
    async result(): Promise<AgentTurnResult> {
      const expectedExecutionId = activeControlRef?.executionId;
      if (expectedExecutionId === undefined) {
        throw new Error(
          "Tangle session result requires an exact executionId from its control reference",
        );
      }
      const result = await session.result(
        { executionId: expectedExecutionId },
      );
      const resultRecord = validatedSandboxPromptResult(result);
      if (
        resultRecord.executionId !== expectedExecutionId
      ) {
        throw new Error(
          "Tangle session result did not confirm its exact executionId",
        );
      }
      return agentTurnResultFromPromptRecord(resultRecord);
    },
    async prompt(input: AgentTurnInput): Promise<AgentTurnResult> {
      if (input.sessionId !== undefined && input.sessionId !== session.id) {
        throw new Error("Tangle sessionId conflicts with this session");
      }
      const requestedControlRef = resolveRetainedSessionControlRef(
        input.controlRef,
        session.id,
        provider,
        environmentId,
      );
      if (
        activeControlRef !== undefined &&
        requestedControlRef !== undefined &&
        !sameRunControlRef(activeControlRef, requestedControlRef)
      ) {
        throw new Error("Tangle prompt control reference conflicts with this session");
      }
      const sourceControlRef = requestedControlRef ?? activeControlRef;

      const replay = input.lastEventId !== undefined;
      if (
        replay &&
        sourceControlRef?.executionId !== undefined &&
        input.executionId !== undefined &&
        input.executionId !== sourceControlRef.executionId
      ) {
        throw new Error(
          "Tangle replay executionId conflicts with the control reference",
        );
      }
      const executionId = replay
        ? input.executionId ?? sourceControlRef?.executionId
        : input.executionId ??
          sessionPromptExecutionId(provider, environmentId, session.id, input.turnId);
      if (executionId === undefined) {
        throw new Error(
          "Tangle session replay requires the exact executionId from its control reference",
        );
      }
      const result = await session.prompt(
        promptFromTurnInput(input),
        promptOptionsFromTurnInput(
          {
            ...input,
            sessionId: session.id,
            executionId,
            controlRef: undefined,
          },
          {
            provider,
            environmentId,
            sessionId: session.id,
          },
        ),
      );
      const resultRecord = validatedSandboxPromptResult(result);

      if (resultRecord.executionId !== executionId) {
        throw new Error(
          "Tangle session prompt did not confirm its exact executionId",
        );
      }
      if (replay) {
        activeControlRef =
          sourceControlRef ??
          retainedSessionControlRef(
            session.id,
            executionId,
            provider,
            environmentId,
          );
        return agentTurnResultFromPromptRecord(resultRecord);
      }
      activeControlRef = retainedSessionControlRef(
        session.id,
        executionId,
        provider,
        environmentId,
      );
      return agentTurnResultFromPromptRecord(resultRecord);
    },
    async cancel(): Promise<void> {
      const executionId = activeControlRef?.executionId;
      if (executionId === undefined) {
        throw new Error(
          "Tangle session cancellation requires an exact executionId from its control reference",
        );
      }
      await session.interrupt({ executionId });
    },
  };
}

function sandboxOptionsFromCreateInput(
  input: CreateAgentEnvironmentInput,
  defaultBackend: BackendType,
): CreateSandboxOptions {
  const workspace = input.workspace ?? {};
  if (workspace.environment !== undefined && workspace.image !== undefined) {
    throw new Error("Tangle workspace cannot specify both environment and image");
  }
  const environment = workspace.image ?? workspace.environment;
  const providerOptions = input.providerOptions?.sandboxCreateOptions;
  const base =
    providerOptions && typeof providerOptions === "object"
      ? ({ ...(providerOptions as CreateSandboxOptions) } as CreateSandboxOptions)
      : ({} satisfies CreateSandboxOptions);
  return {
    ...base,
    ...(environment !== undefined ? { environment } : {}),
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
      profile: inlineAgentProfile(input.profile),
    },
  };
}

function inlineAgentProfile(profile: AgentProfileRef): Exclude<AgentProfileRef, string> {
  if (typeof profile === "string") {
    throw new Error("Tangle provider requires an inline AgentProfile, not a profile reference");
  }
  return profile;
}

function environmentEventFromSandboxEvent(
  event: SandboxEvent,
  expected: { executionId?: string; sessionId?: string } = {},
): AgentEnvironmentEvent {
  if (!event || typeof event !== "object") {
    throw new Error("Tangle Sandbox emitted a non-object event");
  }
  const record = event as unknown as Record<string, unknown>;
  if (typeof record.type !== "string" || record.type.length === 0) {
    throw new Error("Tangle Sandbox event omitted its type");
  }
  if (
    !record.data ||
    typeof record.data !== "object" ||
    Array.isArray(record.data)
  ) {
    throw new Error("Tangle Sandbox event omitted its object data");
  }
  if (
    record.id !== undefined &&
    (typeof record.id !== "string" || record.id.length === 0)
  ) {
    throw new Error("Tangle Sandbox event contained an invalid event id");
  }
  const data = record.data as Record<string, unknown>;
  const eventExecutionId = optionalNonEmptyString(
    data.executionId,
    "Tangle Sandbox event executionId",
  );
  const eventSessionId = optionalNonEmptyString(
    data.sessionId,
    "Tangle Sandbox event sessionId",
  );
  // Sandbox binds the stream with session.events({ executionId }). Individual
  // event variants do not all repeat that selector, so validate IDs when present.
  if (
    expected.executionId !== undefined &&
    eventExecutionId !== undefined &&
    eventExecutionId !== expected.executionId
  ) {
    throw new Error(
      "Tangle exact session event identified a different executionId",
    );
  }
  if (
    expected.sessionId !== undefined &&
    eventSessionId !== undefined &&
    eventSessionId !== expected.sessionId
  ) {
    throw new Error("Tangle exact session event identified a different sessionId");
  }
  return {
    type: record.type,
    data,
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    usage: tokenUsageFromData(data),
    providerEvent: event,
  };
}

function promptFromTurnInput(input: AgentTurnInput): string | InputPart[] {
  if (input.parts) return input.parts;
  return input.prompt ?? "";
}

function executionIdFromTurnInput(input: AgentTurnInput): string | undefined {
  return input.executionId ?? input.controlRef?.executionId;
}

function promptOptionsFromTurnInput(
  input: AgentTurnInput,
  target: {
    provider: string;
    environmentId: string;
    sessionId?: string;
  },
): PromptOptions {
  if (input.contextTransfer !== undefined) {
    throw new Error(
      "Tangle provider does not yet support portable context transfer",
    );
  }
  if (input.nativeContinuation !== undefined) {
    throw new Error(
      "Tangle provider does not yet support verified native continuation",
    );
  }

  const controlRef = input.controlRef
    ? AgentRunControlRefSchema.parse(input.controlRef)
    : undefined;
  if (controlRef) {
    if (
      controlRef.provider !== target.provider ||
      controlRef.environmentId !== target.environmentId ||
      (target.sessionId !== undefined &&
        controlRef.sessionId !== target.sessionId)
    ) {
      throw new Error("Tangle control reference does not match this target");
    }
    if (controlRef.sessionId === undefined || controlRef.executionId === undefined) {
      throw new Error(
        "Tangle control reference requires exact sessionId and executionId",
      );
    }
    if (controlRef.runId !== controlRef.executionId) {
      throw new Error(
        "Tangle control reference requires runId to equal executionId",
      );
    }
    if (
      input.sessionId !== undefined &&
      input.sessionId !== controlRef.sessionId
    ) {
      throw new Error("Tangle sessionId conflicts with the control reference");
    }
    if (
      input.executionId !== undefined &&
      input.executionId !== controlRef.executionId
    ) {
      throw new Error("Tangle executionId conflicts with the control reference");
    }
  }

  const sessionId = input.sessionId ?? controlRef?.sessionId;
  const executionId = input.executionId ?? controlRef?.executionId;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.context ? { context: input.context } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(executionId ? { executionId } : {}),
    ...(input.lastEventId ? { lastEventId: input.lastEventId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.detach !== undefined ? { detach: input.detach } : {}),
  };
}

type SandboxRunStatus =
  | "success"
  | "failed"
  | "blocked_on_approval"
  | "awaiting_question"
  | "awaiting_plan_decision";

type ValidatedSandboxPromptResult = Record<string, unknown> & {
  success: boolean;
  status: SandboxRunStatus;
  durationMs: number;
  executionId?: string;
};

function validatedSandboxPromptResult(
  result: PromptResult,
): ValidatedSandboxPromptResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Tangle prompt returned no result object");
  }
  const record = result as unknown as Record<string, unknown>;
  if (typeof record.success !== "boolean") {
    throw new Error("Tangle prompt result omitted its success status");
  }
  const statuses = new Set<SandboxRunStatus>([
    "success",
    "failed",
    "blocked_on_approval",
    "awaiting_question",
    "awaiting_plan_decision",
  ]);
  if (
    typeof record.status !== "string" ||
    !statuses.has(record.status as SandboxRunStatus)
  ) {
    throw new Error("Tangle prompt result contained an invalid run status");
  }
  if (record.success !== (record.status === "success")) {
    throw new Error(
      "Tangle prompt result success flag conflicts with its run status",
    );
  }
  if (
    typeof record.durationMs !== "number" ||
    !Number.isFinite(record.durationMs) ||
    record.durationMs < 0
  ) {
    throw new Error("Tangle prompt result contained an invalid duration");
  }
  for (const field of [
    "executionId",
    "response",
    "text",
    "finalText",
    "error",
    "errorCode",
    "traceId",
  ]) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      throw new Error(`Tangle prompt result contained an invalid ${field}`);
    }
  }
  if (record.executionId === "") {
    throw new Error("Tangle prompt result contained an empty executionId");
  }
  tokenUsageFromData(record);
  return record as ValidatedSandboxPromptResult;
}

function agentTurnResultFromPromptRecord(
  record: ValidatedSandboxPromptResult,
): AgentTurnResult {
  const text =
    typeof record.response === "string"
      ? record.response
      : typeof record.text === "string"
        ? record.text
        : typeof record.finalText === "string"
          ? record.finalText
          : "";
  const contextTransferReceipt = ContextTransferReceiptSchema.safeParse(
    record.contextTransferReceipt,
  );
  if (
    record.contextTransferReceipt !== undefined &&
    !contextTransferReceipt.success
  ) {
    throw new Error("Tangle prompt result contained an invalid context receipt");
  }
  return {
    text,
    success: record.success,
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    usage: tokenUsageFromData(record),
    ...(contextTransferReceipt.success
      ? { contextTransferReceipt: contextTransferReceipt.data }
      : {}),
  };
}

function sessionRefFromSandboxDispatch(
  dispatched: unknown,
  providerName: string,
  environmentId: string,
  expectedExecutionId: string | undefined,
): AgentSessionRef {
  const record =
    dispatched && typeof dispatched === "object"
      ? (dispatched as Record<string, unknown>)
      : undefined;
  const id = record?.sessionId ?? record?.id;
  if (typeof id !== "string" || id.length === 0 || !record) {
    throw new Error("sandbox dispatch returned no session id");
  }
  const executionId = nonEmptyString(record.executionId);
  if (executionId === undefined) {
    throw new Error(
      "sandbox dispatch returned no exact execution id for durable replay",
    );
  }
  if (
    expectedExecutionId !== undefined &&
    executionId !== expectedExecutionId
  ) {
    throw new Error(
      "sandbox dispatch returned an execution id different from the requested run",
    );
  }
  return {
    id,
    provider: providerName,
    controlRef: retainedSessionControlRef(
      id,
      executionId,
      providerName,
      environmentId,
    ),
    metadata: {
      ...(record.status ? { status: record.status } : {}),
      ...(record.alreadyExisted !== undefined ? { alreadyExisted: record.alreadyExisted } : {}),
      ...(record.dispatched !== undefined ? { dispatched: record.dispatched } : {}),
    },
  };
}

function retainedSessionControlRef(
  sessionId: string,
  executionId: string,
  provider: string,
  environmentId: string,
): AgentRunControlRef {
  return AgentRunControlRefSchema.parse({
    runId: executionId,
    provider,
    environmentId,
    sessionId,
    executionId,
  });
}

function sessionPromptExecutionId(
  provider: string,
  environmentId: string,
  sessionId: string,
  turnId: string | undefined,
): string {
  if (turnId === undefined) return randomUUID();
  const digest = createHash("sha256")
    .update(`${provider}\0${environmentId}\0${sessionId}\0${turnId}`)
    .digest("hex");
  return `session-turn-${digest}`;
}

function sameRunControlRef(
  left: AgentRunControlRef,
  right: AgentRunControlRef,
): boolean {
  return (
    left.runId === right.runId &&
    left.provider === right.provider &&
    left.environmentId === right.environmentId &&
    left.sessionId === right.sessionId &&
    left.executionId === right.executionId
  );
}

function resolveRetainedSessionControlRef(
  candidate: AgentRunControlRef | undefined,
  sessionId: string,
  provider: string,
  environmentId: string,
): AgentRunControlRef | undefined {
  if (candidate === undefined) return undefined;
  const controlRef = AgentRunControlRefSchema.parse(candidate);
  if (
    controlRef.provider !== provider ||
    controlRef.environmentId !== environmentId ||
    controlRef.sessionId !== sessionId
  ) {
    throw new Error("Tangle control reference does not match this session");
  }
  if (
    controlRef.executionId === undefined ||
    controlRef.runId !== controlRef.executionId
  ) {
    throw new Error(
      "Tangle session control reference requires runId to equal executionId",
    );
  }
  return controlRef;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNonEmptyString(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function execResultFromSandboxExecResult(result: SandboxExecResult | undefined): ExecResult {
  if (!result || typeof result !== "object") {
    throw new Error("Tangle Sandbox exec returned no result");
  }
  const record = result as unknown as Record<string, unknown>;
  if (
    typeof record.exitCode !== "number" ||
    !Number.isSafeInteger(record.exitCode)
  ) {
    throw new Error("Tangle Sandbox exec returned an invalid exit code");
  }
  if (typeof record.stdout !== "string" || typeof record.stderr !== "string") {
    throw new Error("Tangle Sandbox exec returned invalid output streams");
  }
  return {
    exitCode: record.exitCode,
    stdout: record.stdout,
    stderr: record.stderr,
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
  if (
    data.usage !== undefined &&
    (!data.usage || typeof data.usage !== "object" || Array.isArray(data.usage))
  ) {
    throw new Error("Tangle usage must be an object");
  }
  if (
    data.tokenUsage !== undefined &&
    (!data.tokenUsage ||
      typeof data.tokenUsage !== "object" ||
      Array.isArray(data.tokenUsage))
  ) {
    throw new Error("Tangle token usage must be an object");
  }
  const usageRecord =
    data.usage && typeof data.usage === "object"
      ? (data.usage as Record<string, unknown>)
      : data.tokenUsage && typeof data.tokenUsage === "object"
        ? (data.tokenUsage as Record<string, unknown>)
        : data;
  const inputTokens = firstValidatedNumber(
    usageRecord,
    ["inputTokens", "tokensIn", "prompt_tokens"],
    "input token count",
    true,
  );
  const outputTokens = firstValidatedNumber(
    usageRecord,
    ["outputTokens", "tokensOut", "completion_tokens"],
    "output token count",
    true,
  );
  const nestedCost = firstValidatedNumber(
    usageRecord,
    ["cost", "costUsd", "totalCostUsd"],
    "usage cost",
    false,
  );
  const topLevelCost = firstValidatedNumber(
    data,
    ["costUsd", "totalCostUsd"],
    "result cost",
    false,
  );
  const cost = nestedCost ?? topLevelCost;
  if (inputTokens === undefined && outputTokens === undefined && cost === undefined) return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cost !== undefined ? { cost } : {}),
  };
}

function firstValidatedNumber(
  record: Record<string, unknown>,
  fields: readonly string[],
  label: string,
  integer: boolean,
): number | undefined {
  let selected: number | undefined;
  for (const field of fields) {
    const value = record[field];
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (integer && !Number.isSafeInteger(value))
    ) {
      throw new Error(`Tangle ${label} is invalid`);
    }
    selected ??= value;
  }
  return selected;
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

/**
 * @param harness The harness the sandbox will materialize the profile with. The prompt intents are
 * that harness's, not this adapter's: forwarding the whole profile on the wire makes both fields
 * *expressible*, but the sandbox's materializer refuses the intent its harness has no control for
 * (opencode has no replacement, codex and gemini no addition). Omit it and both intents declare
 * `false` — an adapter that cannot name its harness cannot promise either one.
 */
export function defaultTangleSandboxCapabilities(
  harness?: HarnessType,
): AgentEnvironmentCapabilities {
  return {
    profile: {
      namedProfiles: true,
      systemPrompt: harnessSystemPromptIntents(harness),
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
    branching: { checkpoint: false, fork: false },
    placement: true,
    usage: true,
    confidential: true,
  };
}
