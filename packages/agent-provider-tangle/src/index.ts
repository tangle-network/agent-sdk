import type {
  BackendType,
  CreateSandboxOptions,
  ExecResult as SandboxExecResult,
  PromptOptions,
  PromptResult,
  SandboxEvent,
} from "@tangle-network/sandbox";
import {
  AgentEnvironmentCapabilitiesSchema,
  AgentNativeContextContinuationResultSchema,
  AgentTurnResultSchema,
  CanonicalStreamEventSchema,
  ContextTransferRequestSchema,
  ContextTransferResultSchema,
  InteractionBindingSchema,
  InteractionRequestSchema,
  InteractionAcknowledgementSchema,
  InteractionResponseCommandSchema,
  NativeContextBoundaryProofSchema,
  NativeContextContinuationRequestSchema,
  agentNativeContextContinuationResultMatchesRequest,
  canonicalCandidateDigest,
  contextTransferResultMatchesRequest,
  canonicalAgentProfileDigest,
  nativeContextContinuationTurnDigest,
  snapshotAgentProfile,
  type AgentEnvironmentCapabilities,
  type AgentNativeContextContinuationOptions,
  type AgentNativeContextContinuationResult,
  type AgentProfile,
  type AgentProfileValidationResult,
  type AgentRunControlRef,
  type AgentWorkspaceBranching,
  type ContextTransferRequest,
  type ContextTransferResult,
  type InteractionAcknowledgement,
  type InteractionResponseCommand,
  type NativeContextBoundaryProof,
  type NativeContextContinuationRequest,
  type WorkspaceCheckpointLookupResult,
  type WorkspaceCheckpointResult,
  type WorkspaceCleanupAcknowledgement,
  type WorkspaceCleanupRequest,
  type WorkspaceForkLookupResult,
  type WorkspaceForkResult,
  type WorkspaceOperationLookupRequest,
} from "@tangle-network/agent-interface";
import type {
  AgentEnvironment,
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
  InputPart,
  TokenUsage,
} from "@tangle-network/agent-interface";
import {
  AgentRunControlRefSchema,
  ContextTransferReceiptSchema,
  WorkspaceCheckpointLookupResultSchema,
  WorkspaceCheckpointResultSchema,
  WorkspaceCleanupAcknowledgementSchema,
  WorkspaceCleanupRequestSchema,
  WorkspaceForkLookupResultSchema,
  WorkspaceForkResultSchema,
  WorkspaceOperationLookupRequestSchema,
  workspaceCheckpointResultMatchesRequest,
  workspaceCleanupAcknowledgementMatches,
  workspaceForkResultMatchesRequest,
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
  validateProfile?(profile: AgentProfile): Promise<unknown>;
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
  validateProfile?(profile: AgentProfile): Promise<unknown>;
  resourceUsage?(): Promise<unknown | null>;
  teeAttestation?(options?: unknown): Promise<unknown>;
  workspaceBranching?: AgentWorkspaceBranching;
  transferContext?(
    request: ContextTransferRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ContextTransferResult>;
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
  interrupt(options?: { executionId?: string }): Promise<unknown>;
  interactions?(): Promise<unknown>;
  respondToInteraction?(command: unknown): Promise<unknown>;
  contextBoundary?(options?: { signal?: AbortSignal }): Promise<unknown | null>;
  continueNative?(
    request: NativeContextContinuationRequest,
    options: AgentNativeContextContinuationOptions,
  ): Promise<unknown>;
  sendMessage?(request: unknown, options?: unknown): Promise<unknown>;
  steer?(input: AgentTurnInput): Promise<unknown>;
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

export interface TangleInterruptResult {
  cancelled: boolean;
  outcome?: string;
  reason?: string;
  sessionState?: string;
  reconnectable?: boolean;
  activeExecutionId?: string | null;
  lastTerminalReason?: string;
}

export interface TangleAgentSession extends AgentSession {
  /** The unmodified provider status record, when the provider supplies one. */
  statusSnapshot?(): Promise<unknown | null>;
  /** Exact cancellation receipt; this never destroys the environment. */
  cancelExecution?(): Promise<TangleInterruptResult>;
  /** Provider-native queued input, only when the sandbox exposes it. */
  steer?(input: AgentTurnInput): Promise<unknown>;
}

export interface TangleProfileReceipt {
  ok: boolean;
  issues: Array<{
    level: "error" | "warning" | "info";
    code: string;
    message: string;
    path?: string;
  }>;
  effectiveCapabilities: Record<string, boolean>;
  capabilities: AgentEnvironmentCapabilities;
  placement: {
    environmentId: string;
    requested: boolean;
    verified: false;
    reason: string;
  };
  session: {
    eventsReplay: boolean;
    terminalResult: boolean;
    exactExecutionCancel: boolean;
    interactions: boolean;
  };
  usage: { tokenUsage: boolean; cost: boolean };
  materialization?: {
    profileDigest: string;
    receiptId: string;
    resourceCounts: Record<string, number>;
    secretsMaterialized: false;
  };
  confidentiality: { requested: boolean; verified: false; evidence: null };
}

export interface TangleAgentEnvironment extends AgentEnvironment {
  readonly profileReceipt?: TangleProfileReceipt;
  readonly profileDigest?: string;
  evidence?(): Promise<{
    profile?: TangleProfileReceipt;
    placement?: PlacementInfo;
    usage?: unknown | null;
    confidentiality?: unknown;
  }>;
  attestation?(options?: unknown): Promise<unknown>;
  transferContext?(
    request: ContextTransferRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ContextTransferResult>;
  session?(id: string, options?: { controlRef?: AgentRunControlRef }): TangleAgentSession;
}

export interface TangleAgentEnvironmentProvider extends AgentEnvironmentProvider {
  create(input: CreateAgentEnvironmentInput): Promise<TangleAgentEnvironment>;
  get?(id: string): Promise<TangleAgentEnvironment | null>;
}

export function createTangleProvider(
  options: TangleProviderOptions,
): TangleAgentEnvironmentProvider {
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
    ...(options.validateProfile || options.client.validateProfile
      ? {
          async validateProfile(profile: AgentProfile): Promise<AgentProfileValidationResult> {
            const snapshot = snapshotAgentProfile(profile);
            const result = await (options.validateProfile
              ? options.validateProfile(snapshot)
              : options.client.validateProfile!(snapshot));
            return profileValidationResultFromUnknown(result);
          },
        }
      : {}),
    async create(input) {
      const capabilities = await resolveCapabilities();
      const profile = snapshotAgentProfile(inlineAgentProfile(input.profile));
      const createOptions =
        options.mapCreateInput?.({ ...input, profile }) ??
        sandboxOptionsFromCreateInput(
          { ...input, profile },
          options.defaultBackend ?? "opencode",
        );
      const box = await options.client.create(
        createOptions,
        input.signal ? { signal: input.signal } : undefined,
      );
      const profileReceipt = box.validateProfile
        ? validateProfileReceipt(await box.validateProfile(profile))
        : undefined;
      return sandboxInstanceAsEnvironment(
        box,
        providerName,
        options.client,
        capabilities,
        profileReceipt,
        canonicalAgentProfileDigest(profile),
      );
    },
    ...(options.client.get
      ? {
          async get(id: string): Promise<TangleAgentEnvironment | null> {
            const box = await options.client.get?.(id);
            return box
              ? sandboxInstanceAsEnvironment(
                  box,
                  providerName,
                  options.client,
                  await resolveCapabilities(),
                  undefined,
                  undefined,
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
  profileReceipt?: TangleProfileReceipt,
  profileDigest?: string,
): TangleAgentEnvironment {
  const environmentId = String(box.id);
  const durableBranching =
    capabilities.branching.checkpoint &&
    capabilities.branching.fork &&
    capabilities.branching.retrySafe === true &&
    capabilities.branching.lookup === true &&
    capabilities.branching.cleanup === true &&
    box.workspaceBranching !== undefined;
  return {
    id: environmentId,
    provider: providerName,
    ...(box.name ? { name: box.name } : {}),
    ...(profileReceipt ? { profileReceipt } : {}),
    ...(profileDigest ? { profileDigest } : {}),
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
          environmentId,
          supportsContextTransfer: box.transferContext !== undefined,
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
                environmentId,
                supportsContextTransfer: box.transferContext !== undefined,
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
              environmentId,
              capabilities,
              box,
            );
          },
        }
      : {}),
    ...(capabilities.interactions && box.session
      ? {
          async respondToInteraction(
            command: InteractionResponseCommand,
            options?: { signal?: AbortSignal },
          ): Promise<InteractionAcknowledgement> {
            const parsed = InteractionResponseCommandSchema.parse(command);
            if (parsed.binding.environmentId !== environmentId) {
              return interactionAcknowledgement(parsed, "binding_mismatch");
            }
            if (!parsed.binding.sessionId) {
              throw new Error(
                "Tangle interaction response requires an exact sessionId",
              );
            }
            const interactionSession = box.session?.(parsed.binding.sessionId);
            if (!interactionSession) {
              throw new Error("sandbox session(id) returned undefined");
            }
            return respondToSandboxInteraction(
              interactionSession,
              parsed,
              providerName,
              environmentId,
              options,
            );
          },
        }
      : {}),
    ...(box.transferContext
      ? {
          async transferContext(
            request: ContextTransferRequest,
            transferOptions?: { signal?: AbortSignal },
          ): Promise<ContextTransferResult> {
            const parsedRequest = ContextTransferRequestSchema.parse(request);
            const result = ContextTransferResultSchema.parse(
              await box.transferContext!(parsedRequest, transferOptions),
            );
            if (!contextTransferResultMatchesRequest(parsedRequest, result)) {
              throw new Error("Tangle context transfer result does not match its request");
            }
            return result;
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
    ...(durableBranching
      ? { workspaceBranching: validatedWorkspaceBranching(box.workspaceBranching!) }
      : {}),
    ...(capabilities.placement
      ? {
          async placement(): Promise<PlacementInfo> {
            return placementInfoFromLoopPlacement(
              client.describePlacement
                ? await client.describePlacement(box)
                : undefined,
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
    ...(capabilities.confidential && box.teeAttestation
      ? {
          async attestation(attestationOptions?: unknown): Promise<unknown> {
            return immutableUnknown(
              await box.teeAttestation!(attestationOptions),
              "Tangle attestation evidence",
            );
          },
        }
      : {}),
    ...(profileReceipt || box.resourceUsage || client.describePlacement
      ? {
          async evidence() {
            return {
              ...(profileReceipt ? { profile: profileReceipt } : {}),
              ...(client.describePlacement
                ? {
                    placement: placementInfoFromLoopPlacement(
                      await client.describePlacement(box),
                    ),
                  }
                : {}),
              ...(box.resourceUsage
                ? {
                    usage: immutableUnknown(
                      await box.resourceUsage(),
                      "Tangle usage evidence",
                    ),
                  }
                : {}),
              ...(capabilities.confidential && box.teeAttestation
                ? {
                    confidentiality: {
                      requested: true,
                      verified: false,
                      evidence: null,
                    },
                  }
                : {}),
            };
          },
        }
      : {}),
  };
}

function sandboxSessionAsAgentSession(
  session: SandboxSessionLike,
  controlRef: AgentRunControlRef | undefined,
  provider: string,
  environmentId: string,
  capabilities: AgentEnvironmentCapabilities,
  box: SandboxInstanceLike,
): TangleAgentSession {
  let activeControlRef = controlRef;
  const cancelExecution = async (): Promise<TangleInterruptResult> => {
    const executionId = activeControlRef?.executionId;
    if (executionId === undefined) {
      throw new Error(
        "Tangle session cancellation requires an exact executionId from its control reference",
      );
    }
    return interruptResultFromUnknown(
      await session.interrupt({ executionId }),
    );
  };
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
    async statusSnapshot(): Promise<unknown | null> {
      return session.status();
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
      return agentTurnResultFromPromptRecord(resultRecord, session.id);
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
      const requestedExecutionId = replay
        ? input.executionId ?? sourceControlRef?.executionId
        : input.executionId;
      if (replay && requestedExecutionId === undefined) {
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
            ...(requestedExecutionId
              ? { executionId: requestedExecutionId }
              : {}),
            controlRef: undefined,
          },
          {
            provider,
            environmentId,
            sessionId: session.id,
            supportsContextTransfer: box.transferContext !== undefined,
          },
        ),
      );
      const resultRecord = validatedSandboxPromptResult(result);

      const admittedExecutionId = nonEmptyString(resultRecord.executionId);
      if (admittedExecutionId === undefined) {
        throw new Error(
          "Tangle session prompt returned no exact executionId",
        );
      }
      if (
        requestedExecutionId !== undefined &&
        admittedExecutionId !== requestedExecutionId
      ) {
        throw new Error(
          "Tangle session prompt did not confirm its exact executionId",
        );
      }
      if (replay) {
        activeControlRef =
          sourceControlRef ??
          retainedSessionControlRef(
            session.id,
            admittedExecutionId,
            provider,
            environmentId,
          );
        return agentTurnResultFromPromptRecord(resultRecord, session.id);
      }
      activeControlRef = retainedSessionControlRef(
        session.id,
        admittedExecutionId,
        provider,
        environmentId,
      );
      return agentTurnResultFromPromptRecord(resultRecord, session.id);
    },
    ...(capabilities.interactions && session.respondToInteraction
      ? {
          async respondToInteraction(
            command: InteractionResponseCommand,
            options?: { signal?: AbortSignal },
          ): Promise<InteractionAcknowledgement> {
            return respondToSandboxInteraction(
              session,
              command,
              provider,
              environmentId,
              options,
            );
          },
        }
      : {}),
    ...(capabilities.nativeContinuation && session.contextBoundary
      ? {
          async contextBoundary(options?: { signal?: AbortSignal }) {
            const proof = await session.contextBoundary?.(options);
            if (proof === null || proof === undefined) return null;
            return exactBoundaryProof(
              NativeContextBoundaryProofSchema.parse(proof),
              activeControlRef,
              provider,
              environmentId,
              session.id,
            );
          },
        }
      : {}),
    ...(capabilities.nativeContinuation && session.continueNative
      ? {
          async continueNative(
            request: NativeContextContinuationRequest,
            options: AgentNativeContextContinuationOptions,
          ): Promise<AgentNativeContextContinuationResult> {
            const parsedRequest = NativeContextContinuationRequestSchema.parse(request);
            if (
              nativeContextContinuationTurnDigest(options.turn) !==
              parsedRequest.turnDigest
            ) {
              throw new Error(
                "Tangle native continuation turn does not match its request digest",
              );
            }
            exactRunForTarget(
              parsedRequest.run,
              provider,
              environmentId,
              session.id,
              activeControlRef,
            );
            const outcome = AgentNativeContextContinuationResultSchema.parse(
              await session.continueNative?.(parsedRequest, options),
            );
            if (
              "controlRef" in outcome &&
              (outcome.acknowledgement.status === "accepted" ||
                outcome.acknowledgement.status === "replayed") &&
              !agentNativeContextContinuationResultMatchesRequest(
                parsedRequest,
                outcome,
              )
            ) {
              throw new Error(
                "Tangle native continuation returned a mismatched acknowledgement",
              );
            }
            if (
              "controlRef" in outcome &&
              (outcome.acknowledgement.status === "accepted" ||
                outcome.acknowledgement.status === "replayed") &&
              (outcome.controlRef.runId !== parsedRequest.run.runId ||
                outcome.controlRef.executionId !== parsedRequest.run.executionId)
            ) {
              throw new Error(
                "Tangle native continuation returned a different execution control reference",
              );
            }
            return outcome;
          },
        }
      : {}),
    ...(capabilities.sessions.messages && (session.steer || session.sendMessage)
      ? {
          async steer(input: AgentTurnInput): Promise<unknown> {
            if (input.executionId !== undefined) {
              exactRunForTarget(
                {
                  runId: input.executionId,
                  provider,
                  environmentId,
                  sessionId: session.id,
                  executionId: input.executionId,
                },
                provider,
                environmentId,
                session.id,
                activeControlRef,
              );
            }
            if (session.steer) return session.steer(input);
            const parts = input.parts ??
              (input.prompt !== undefined
                ? [{ type: "text" as const, text: input.prompt }]
                : []);
            if (parts.length === 0) {
              throw new Error("Tangle steer requires prompt or input parts");
            }
            return session.sendMessage!({
              parts,
              ...(input.model
                ? { model: { providerId: provider, modelId: input.model } }
                : {}),
              ...(input.turnId ? { turnId: input.turnId } : {}),
            }, {
              ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
              ...(input.signal ? { signal: input.signal } : {}),
            });
          },
        }
      : {}),
    cancelExecution,
    async cancel(): Promise<void> {
      await cancelExecution();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function immutableUnknown(value: unknown, label: string): unknown {
  try {
    return deepFreeze(structuredClone(value));
  } catch (error) {
    throw new Error(`${label} is not immutable JSON evidence`, { cause: error });
  }
}

function profileValidationResultFromUnknown(
  value: unknown,
): AgentProfileValidationResult {
  if (!isRecord(value) || typeof value.ok !== "boolean" || !Array.isArray(value.issues)) {
    throw new Error("Tangle profile validation returned an invalid result");
  }
  const issues = value.issues.map((issue) => {
    if (!isRecord(issue)) throw new Error("Tangle profile issue is invalid");
    if (
      (issue.level !== "error" &&
        issue.level !== "warning" &&
        issue.level !== "info") ||
      typeof issue.code !== "string" ||
      typeof issue.message !== "string" ||
      (issue.path !== undefined && typeof issue.path !== "string")
    ) {
      throw new Error("Tangle profile issue is invalid");
    }
    return {
      level: issue.level,
      code: issue.code,
      message: issue.message,
      ...(typeof issue.path === "string" ? { path: issue.path } : {}),
    } as const;
  });
  const normalizedProfile =
    value.normalizedProfile === undefined
      ? undefined
      : snapshotAgentProfile(value.normalizedProfile);
  return deepFreeze({
    ok: value.ok,
    issues,
    ...(normalizedProfile ? { normalizedProfile } : {}),
  });
}

function validateProfileReceipt(value: unknown): TangleProfileReceipt {
  if (!isRecord(value)) throw new Error("Tangle profile receipt is invalid");
  const capabilities = AgentEnvironmentCapabilitiesSchema.parse(value.capabilities);
  if (
    typeof value.ok !== "boolean" ||
    !Array.isArray(value.issues) ||
    !isRecord(value.effectiveCapabilities) ||
    !isRecord(value.placement) ||
    !isRecord(value.session) ||
    !isRecord(value.usage) ||
    !isRecord(value.confidentiality)
  ) {
    throw new Error("Tangle profile receipt is incomplete");
  }
  const issues = value.issues.map((issue) => {
    if (!isRecord(issue)) throw new Error("Tangle profile receipt issue is invalid");
    if (
      (issue.level !== "error" &&
        issue.level !== "warning" &&
        issue.level !== "info") ||
      typeof issue.code !== "string" ||
      typeof issue.message !== "string" ||
      (issue.path !== undefined && typeof issue.path !== "string")
    ) {
      throw new Error("Tangle profile receipt issue is invalid");
    }
    return {
      level: issue.level,
      code: issue.code,
      message: issue.message,
      ...(typeof issue.path === "string" ? { path: issue.path } : {}),
    } as const;
  });
  const effectiveCapabilities: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(value.effectiveCapabilities)) {
    if (typeof enabled !== "boolean") {
      throw new Error("Tangle effective capability is invalid");
    }
    effectiveCapabilities[key] = enabled;
  }
  const placement = value.placement;
  const session = value.session;
  const usage = value.usage;
  const confidentiality = value.confidentiality;
  if (
    typeof placement.environmentId !== "string" ||
    typeof placement.requested !== "boolean" ||
    placement.verified !== false ||
    typeof placement.reason !== "string" ||
    typeof session.eventsReplay !== "boolean" ||
    typeof session.terminalResult !== "boolean" ||
    typeof session.exactExecutionCancel !== "boolean" ||
    typeof session.interactions !== "boolean" ||
    typeof usage.tokenUsage !== "boolean" ||
    typeof usage.cost !== "boolean" ||
    typeof confidentiality.requested !== "boolean" ||
    confidentiality.verified !== false ||
    confidentiality.evidence !== null
  ) {
    throw new Error("Tangle profile receipt contains invalid evidence");
  }
  let materialization: TangleProfileReceipt["materialization"];
  if (value.materialization !== undefined) {
    if (!isRecord(value.materialization)) {
      throw new Error("Tangle profile materialization evidence is invalid");
    }
    const material = value.materialization;
    if (
      typeof material.profileDigest !== "string" ||
      typeof material.receiptId !== "string" ||
      !isRecord(material.resourceCounts) ||
      material.secretsMaterialized !== false
    ) {
      throw new Error("Tangle profile materialization evidence is invalid");
    }
    const resourceCounts: Record<string, number> = {};
    for (const [key, count] of Object.entries(material.resourceCounts)) {
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        throw new Error("Tangle profile resource count is invalid");
      }
      resourceCounts[key] = count;
    }
    materialization = {
      profileDigest: material.profileDigest,
      receiptId: material.receiptId,
      resourceCounts,
      secretsMaterialized: false,
    };
  }
  return deepFreeze({
    ok: value.ok,
    issues,
    effectiveCapabilities,
    capabilities,
    placement: {
      environmentId: placement.environmentId,
      requested: placement.requested,
      verified: false,
      reason: placement.reason,
    },
    session: {
      eventsReplay: session.eventsReplay,
      terminalResult: session.terminalResult,
      exactExecutionCancel: session.exactExecutionCancel,
      interactions: session.interactions,
    },
    usage: { tokenUsage: usage.tokenUsage, cost: usage.cost },
    ...(materialization ? { materialization } : {}),
    confidentiality: { requested: confidentiality.requested, verified: false, evidence: null },
  });
}

function validatedWorkspaceBranching(
  branching: AgentWorkspaceBranching,
): AgentWorkspaceBranching {
  return {
    async checkpoint(request, options) {
      const parsed = WorkspaceCheckpointResultSchema.parse(
        await branching.checkpoint(request, options),
      );
      if (
        (parsed.status === "created" || parsed.status === "replayed") &&
        !workspaceCheckpointResultMatchesRequest(request, parsed)
      ) {
        throw new Error("Tangle checkpoint result does not match its request");
      }
      return parsed;
    },
    async lookupCheckpoint(request, options) {
      const parsedRequest = WorkspaceOperationLookupRequestSchema.parse(request);
      const result = WorkspaceCheckpointLookupResultSchema.parse(
        await branching.lookupCheckpoint(parsedRequest, options),
      );
      if (
        result.status === "found" &&
        (result.idempotencyKey !== parsedRequest.idempotencyKey ||
          result.requestDigest !== parsedRequest.requestDigest ||
          result.checkpoint.idempotencyKey !== parsedRequest.idempotencyKey ||
          result.checkpoint.requestDigest !== parsedRequest.requestDigest)
      ) {
        throw new Error("Tangle checkpoint lookup does not match its request");
      }
      return result;
    },
    async deleteCheckpoint(request, options) {
      const parsedRequest = WorkspaceCleanupRequestSchema.parse(request);
      const acknowledgement = WorkspaceCleanupAcknowledgementSchema.parse(
        await branching.deleteCheckpoint(parsedRequest, options),
      );
      if (
        (acknowledgement.status === "deleted" ||
          acknowledgement.status === "already_absent") &&
        !workspaceCleanupAcknowledgementMatches(parsedRequest, acknowledgement)
      ) {
        throw new Error("Tangle checkpoint cleanup does not match its request");
      }
      return acknowledgement;
    },
    async fork(request, options) {
      const parsed = WorkspaceForkResultSchema.parse(
        await branching.fork(request, options),
      );
      if (
        (parsed.status === "created" || parsed.status === "replayed") &&
        !workspaceForkResultMatchesRequest(request, parsed)
      ) {
        throw new Error("Tangle fork result does not match its request");
      }
      return parsed;
    },
    async lookupFork(request, options) {
      const parsedRequest = WorkspaceOperationLookupRequestSchema.parse(request);
      const result = WorkspaceForkLookupResultSchema.parse(
        await branching.lookupFork(parsedRequest, options),
      );
      if (
        result.status === "found" &&
        (result.idempotencyKey !== parsedRequest.idempotencyKey ||
          result.requestDigest !== parsedRequest.requestDigest ||
          result.environment.idempotencyKey !== parsedRequest.idempotencyKey ||
          result.environment.requestDigest !== parsedRequest.requestDigest)
      ) {
        throw new Error("Tangle fork lookup does not match its request");
      }
      return result;
    },
    async destroyFork(request, options) {
      const parsedRequest = WorkspaceCleanupRequestSchema.parse(request);
      const acknowledgement = WorkspaceCleanupAcknowledgementSchema.parse(
        await branching.destroyFork(parsedRequest, options),
      );
      if (
        (acknowledgement.status === "deleted" ||
          acknowledgement.status === "already_absent") &&
        !workspaceCleanupAcknowledgementMatches(parsedRequest, acknowledgement)
      ) {
        throw new Error("Tangle fork cleanup does not match its request");
      }
      return acknowledgement;
    },
  };
}

function interactionAcknowledgement(
  command: InteractionResponseCommand,
  status: InteractionAcknowledgement["status"],
  message?: string,
): InteractionAcknowledgement {
  return InteractionAcknowledgementSchema.parse({
    operationId: command.operationId,
    binding: command.binding,
    status,
    ...(message ? { message } : {}),
  });
}

async function respondToSandboxInteraction(
  session: SandboxSessionLike,
  command: InteractionResponseCommand,
  provider: string,
  environmentId: string,
  options?: { signal?: AbortSignal },
): Promise<InteractionAcknowledgement> {
  const parsed = InteractionResponseCommandSchema.parse(command);
  if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (parsed.binding.environmentId !== environmentId) {
    return interactionAcknowledgement(parsed, "binding_mismatch");
  }
  if (!parsed.binding.sessionId) {
    throw new Error("Tangle interaction response requires an exact sessionId");
  }
  if (!session.respondToInteraction) {
    throw new Error("Tangle runtime does not support interaction responses");
  }

  let wireCommand: unknown = parsed;
  if (session.interactions) {
    const rawList = await session.interactions();
    if (!isRecord(rawList) || !Array.isArray(rawList.interactions)) {
      throw new Error("Tangle interaction list is invalid");
    }
    const requestValue = rawList.interactions.find(
      (candidate) => isRecord(candidate) && candidate.id === parsed.binding.interactionId,
    );
    const bindings = isRecord(rawList.bindings) ? rawList.bindings : undefined;
    const resolved = Array.isArray(rawList.resolved)
      ? rawList.resolved.find(
          (candidate) =>
            isRecord(candidate) &&
            isRecord(candidate.binding) &&
            candidate.binding.interactionId === parsed.binding.interactionId,
        )
      : undefined;
    const request = requestValue
      ? InteractionRequestSchema.parse(requestValue)
      : undefined;
    const bindingValue = request
      ? bindings?.[request.id]
      : isRecord(resolved) && isRecord(resolved.binding)
        ? resolved.binding
        : undefined;
    if (!request && !resolved) {
      return interactionAcknowledgement(parsed, "unknown_interaction");
    }
    if (!isRecord(bindingValue)) {
      throw new Error("Tangle interaction list omitted its exact binding");
    }
    const executionId = nonEmptyString(bindingValue.executionId);
    if (executionId === undefined) {
      throw new Error("Tangle interaction binding omitted its executionId");
    }
    if (executionId !== parsed.binding.runId) {
      return interactionAcknowledgement(parsed, "unknown_run");
    }
    const listedBinding = InteractionBindingSchema.parse({
      runId: executionId,
      environmentId: bindingValue.environmentId,
      sessionId: bindingValue.sessionId,
      interactionId: bindingValue.interactionId,
    });
    if (
      listedBinding.environmentId !== parsed.binding.environmentId ||
      listedBinding.sessionId !== parsed.binding.sessionId ||
      listedBinding.interactionId !== parsed.binding.interactionId
    ) {
      return interactionAcknowledgement(parsed, "binding_mismatch");
    }
    const requestDigest = request
      ? canonicalCandidateDigest(request)
      : isRecord(resolved) && typeof resolved.requestDigest === "string"
        ? resolved.requestDigest
        : undefined;
    if (requestDigest === undefined) {
      throw new Error("Tangle interaction replay omitted its request digest");
    }
    wireCommand = {
      ...parsed,
      binding: { ...parsed.binding, executionId },
      requestDigest,
    };
  }
  const rawAcknowledgement = await session.respondToInteraction(wireCommand);
  if (!isRecord(rawAcknowledgement)) {
    throw new Error("Tangle interaction response returned no acknowledgement");
  }
  const rawBinding = isRecord(rawAcknowledgement.binding)
    ? rawAcknowledgement.binding
    : undefined;
  const acknowledgement = InteractionAcknowledgementSchema.parse({
    operationId: rawAcknowledgement.operationId,
    binding: {
      runId: rawBinding?.runId ?? parsed.binding.runId,
      environmentId: rawBinding?.environmentId ?? parsed.binding.environmentId,
      ...(rawBinding?.sessionId
        ? { sessionId: rawBinding.sessionId }
        : parsed.binding.sessionId
          ? { sessionId: parsed.binding.sessionId }
          : {}),
      interactionId: rawBinding?.interactionId ?? parsed.binding.interactionId,
    },
    status: rawAcknowledgement.status,
    ...(typeof rawAcknowledgement.message === "string"
      ? { message: rawAcknowledgement.message }
      : {}),
    ...(typeof rawAcknowledgement.retryable === "boolean"
      ? { retryable: rawAcknowledgement.retryable }
      : {}),
  });
  if (
    acknowledgement.operationId !== parsed.operationId ||
    acknowledgement.binding.runId !== parsed.binding.runId ||
    acknowledgement.binding.environmentId !== parsed.binding.environmentId ||
    acknowledgement.binding.sessionId !== parsed.binding.sessionId ||
    acknowledgement.binding.interactionId !== parsed.binding.interactionId
  ) {
    throw new Error("Tangle interaction acknowledgement is bound to another operation");
  }
  return acknowledgement;
}

function exactRunForTarget(
  run: AgentRunControlRef,
  provider: string,
  environmentId: string,
  sessionId: string,
  activeControlRef?: AgentRunControlRef,
): AgentRunControlRef {
  const parsed = AgentRunControlRefSchema.parse(run);
  if (
    parsed.provider !== provider ||
    parsed.environmentId !== environmentId ||
    parsed.sessionId !== sessionId ||
    parsed.executionId === undefined ||
    parsed.runId !== parsed.executionId
  ) {
    throw new Error("Tangle operation is not bound to this exact session run");
  }
  if (activeControlRef && !sameRunControlRef(activeControlRef, parsed)) {
    throw new Error("Tangle operation conflicts with the retained run");
  }
  return parsed;
}

function exactBoundaryProof(
  proof: NativeContextBoundaryProof,
  activeControlRef: AgentRunControlRef | undefined,
  provider: string,
  environmentId: string,
  sessionId: string,
): NativeContextBoundaryProof {
  exactRunForTarget(
    {
      runId: proof.runId,
      provider: proof.provider,
      environmentId: proof.environmentId,
      sessionId: proof.sessionId,
      executionId: proof.runId,
    },
    provider,
    environmentId,
    sessionId,
    activeControlRef,
  );
  return proof;
}

function interruptResultFromUnknown(value: unknown): TangleInterruptResult {
  if (!isRecord(value) || typeof value.cancelled !== "boolean") {
    throw new Error("Tangle cancellation returned an invalid result");
  }
  const result: TangleInterruptResult = { cancelled: value.cancelled };
  for (const field of ["outcome", "reason", "sessionState", "lastTerminalReason"] as const) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== "string") {
        throw new Error(`Tangle cancellation returned an invalid ${field}`);
      }
      result[field] = value[field];
    }
  }
  if (value.reconnectable !== undefined) {
    if (typeof value.reconnectable !== "boolean") {
      throw new Error("Tangle cancellation returned an invalid reconnectable flag");
    }
    result.reconnectable = value.reconnectable;
  }
  if (value.activeExecutionId !== undefined) {
    if (
      value.activeExecutionId !== null &&
      typeof value.activeExecutionId !== "string"
    ) {
      throw new Error("Tangle cancellation returned an invalid active execution id");
    }
    result.activeExecutionId = value.activeExecutionId as string | null;
  }
  return result;
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
  const normalizedCandidate = { ...data, type: record.type };
  const normalized = CanonicalStreamEventSchema.safeParse(normalizedCandidate);
  return {
    type: record.type,
    data,
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(normalized.success ? { normalized: normalized.data } : {}),
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
    supportsContextTransfer?: boolean;
  },
): PromptOptions {
  if (input.contextTransfer !== undefined) {
    if (!target.supportsContextTransfer) {
      throw new Error(
        "Tangle provider does not yet support portable context transfer",
      );
    }
    ContextTransferRequestSchema.parse(input.contextTransfer);
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
    ...(input.contextTransfer
      ? { contextTransfer: input.contextTransfer }
      : {}),
    ...(input.providerOptions
      ? { providerOptions: input.providerOptions }
      : {}),
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
  sessionId?: string,
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
  const result = {
    text,
    success: record.success,
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(tokenUsageFromData(record)
      ? { usage: tokenUsageFromData(record) }
      : {}),
    ...(record.metadata && isRecord(record.metadata)
      ? { metadata: record.metadata }
      : {}),
    ...(contextTransferReceipt.success
      ? { contextTransferReceipt: contextTransferReceipt.data }
      : {}),
  };
  return AgentTurnResultSchema.parse(result);
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
): PlacementInfo {
  if (!placement || typeof placement !== "object") {
    throw new Error("Tangle placement evidence is unavailable");
  }
  const record = placement as Record<string, unknown>;
  const kind =
    record.kind === "sibling" && typeof record.sandboxId === "string"
      ? "sandbox"
      : record.kind;
  if (
    kind !== "local" &&
    kind !== "sandbox" &&
    kind !== "fleet" &&
    kind !== "provider"
  ) {
    throw new Error("Tangle placement evidence contained an invalid kind");
  }
  const fields = ["sandboxId", "fleetId", "machineId", "region"] as const;
  for (const field of fields) {
    if (
      record[field] !== undefined &&
      (typeof record[field] !== "string" || record[field].length === 0)
    ) {
      throw new Error(`Tangle placement evidence contained an invalid ${field}`);
    }
  }
  if (
    record.providerMetadata !== undefined &&
    !isRecord(record.providerMetadata)
  ) {
    throw new Error("Tangle placement evidence contained invalid metadata");
  }
  return {
    kind,
    ...(typeof record.sandboxId === "string" ? { sandboxId: record.sandboxId } : {}),
    ...(typeof record.fleetId === "string" ? { fleetId: record.fleetId } : {}),
    ...(typeof record.machineId === "string" ? { machineId: record.machineId } : {}),
    ...(typeof record.region === "string" ? { region: record.region } : {}),
    ...(isRecord(record.providerMetadata)
      ? { providerMetadata: record.providerMetadata }
      : {}),
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
  if (inputTokens === undefined || outputTokens === undefined) {
    throw new Error("Tangle usage is incomplete; provider did not report both token counts");
  }
  const totalTokens = firstValidatedNumber(
    usageRecord,
    ["totalTokens", "tokensTotal"],
    "total token count",
    true,
  );
  const cacheReadInputTokens = firstValidatedNumber(
    usageRecord,
    ["cacheReadInputTokens", "cache_read_input_tokens"],
    "cache-read token count",
    true,
  );
  const cacheCreationInputTokens = firstValidatedNumber(
    usageRecord,
    ["cacheCreationInputTokens", "cache_creation_input_tokens"],
    "cache-creation token count",
    true,
  );
  const reasoningTokens = firstValidatedNumber(
    usageRecord,
    ["reasoningTokens", "reasoning_tokens"],
    "reasoning token count",
    true,
  );
  return {
    inputTokens,
    outputTokens,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens }
      : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
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
    branching: { checkpoint: false, fork: false },
    placement: true,
    usage: true,
    confidential: true,
  };
}
