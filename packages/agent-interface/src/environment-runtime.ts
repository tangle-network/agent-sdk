import { z } from "zod";
import { canonicalCandidateDigest, canonicalCandidateJson } from "./agent-candidate-schema-common.js";
import type { Sha256Digest } from "./agent-candidate.js";
import type { AgentProfileCapabilities, AgentProfileValidationResult } from "./agent-profile.js";
import type { InputPart } from "./parts.js";
import type { StreamEvent } from "./stream-events.js";
import type { TokenUsage } from "./execution-types.js";
import { InteractionCapabilitiesSchema, RequestedInteractionsSchema, type InteractionAcknowledgement, type InteractionCapabilities, type InteractionResponseCommand, type RequestedInteractions } from "./interaction.js";
import { ContextTransferReceiptSchema, ContextTransferRequestSchema, NativeContextContinuationAcknowledgementSchema, NativeContextContinuationRequestSchema, nativeContextContinuationAcknowledgementMatches, type ContextTransferReceipt, type ContextTransferRequest, type NativeContextBoundaryProof, type NativeContextContinuationRequest, type NativeContextContinuationTurn } from "./portable-context.js";
import { AgentExactRunControlRefSchema, AgentRunControlRefSchema, CanonicalStreamEventSchema, type AgentRunCancellationAcknowledgement, type AgentRunCancellationRequest, type AgentRunControlRef } from "./runtime-control.js";
import type { AgentWorkspaceBranching } from "./workspace-branching.js";
import { AgentProfileCapabilitiesSchema } from "./environment-profile-capabilities.js";
import {
  assertBoundedJson,
  assertBoundedSerializedJson,
  boundedIdentifierSchema,
  boundedJsonRecordSchema,
  boundedJsonSchema,
  boundedStringSchema,
  CONTRACT_MAX_ARRAY_LENGTH,
  CONTRACT_MAX_MAP_ENTRIES,
} from "./contract-limits.js";
import { InputPartSchema } from "./portable-context-shared.js";
import type { AgentEnvironmentQuery, AgentEnvironmentStatus, AgentEnvironmentSummary, AgentProfileRef, AgentSessionStatus, CheckpointRef, CheckpointRequest, ExecRequest, ExecResult, ForkRequest, PlacementInfo, ResourceRequest, WorkspaceRequest } from "./environment-requests.js";
import type { AgentExactProcessEgressMode, AgentExactProcessProvider } from "./environment-exact-process.js";
import type { AgentEnvironmentObservation } from "./environment-observation.js";
import type {
  AgentInteractiveSession,
  AgentInteractiveSessionRef,
  AgentInteractiveSessionStart,
} from "./environment-interactive.js";
import type { AgentTerminalSession, TerminalAttachRequest, TerminalAttachResult } from "./environment-terminal.js";

export interface AgentTurnInput {
  prompt?: string;
  parts?: InputPart[];
  sessionId?: string;
  model?: string;
  timeoutMs?: number;
  executionId?: string;
  lastEventId?: string;
  turnId?: string;
  detach?: boolean;
  /** Stable coordinates for a retained run when one already exists. */
  controlRef?: AgentRunControlRef;
  /** Approved portable history for a fresh provider session. */
  contextTransfer?: ContextTransferRequest;
  /** Verified same-session continuation; never carries duplicate history. */
  nativeContinuation?: NativeContextContinuationRequest;
  context?: Record<string, unknown>;
  /** Interaction kinds the provider may originate for this turn. */
  interactions?: RequestedInteractions;
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
}

export const AgentTurnInputSchema = z.strictObject({
  prompt: boundedStringSchema.optional(),
  parts: z.array(InputPartSchema).max(CONTRACT_MAX_ARRAY_LENGTH).optional(),
  sessionId: boundedIdentifierSchema.optional(),
  model: boundedIdentifierSchema.optional(),
  timeoutMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  executionId: boundedIdentifierSchema.optional(),
  lastEventId: boundedIdentifierSchema.optional(),
  turnId: boundedIdentifierSchema.optional(),
  detach: z.boolean().optional(),
  controlRef: AgentRunControlRefSchema.optional(),
  contextTransfer: ContextTransferRequestSchema.optional(),
  nativeContinuation: NativeContextContinuationRequestSchema.optional(),
  context: boundedJsonRecordSchema.optional(),
  interactions: RequestedInteractionsSchema.optional(),
  signal: z.custom<AbortSignal>().optional(),
  providerOptions: boundedJsonRecordSchema.optional(),
}) satisfies z.ZodType<AgentTurnInput>;

export interface AgentTurnResult {
  text: string;
  success: boolean;
  error?: string;
  sessionId?: string;
  usage?: TokenUsage;
  metadata?: Record<string, unknown>;
  events?: AgentEnvironmentEvent[];
  contextTransferReceipt?: ContextTransferReceipt;
}

const TokenUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative().optional(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cost: z.number().finite().nonnegative().optional(),
}) satisfies z.ZodType<TokenUsage>;

const AgentEnvironmentEventSchema = z.strictObject({
  type: boundedIdentifierSchema,
  data: boundedJsonRecordSchema,
  id: boundedIdentifierSchema.optional(),
  normalized: CanonicalStreamEventSchema.optional(),
  usage: TokenUsageSchema.optional(),
  providerEvent: boundedJsonSchema.optional(),
}) satisfies z.ZodType<AgentEnvironmentEvent>;

/** Runtime validator for a provider turn returned from durable continuation. */
export const AgentTurnResultSchema = z.strictObject({
  text: boundedStringSchema,
  success: z.boolean(),
  error: boundedStringSchema.optional(),
  sessionId: boundedIdentifierSchema.optional(),
  usage: TokenUsageSchema.optional(),
  metadata: boundedJsonRecordSchema.optional(),
  events: z.array(AgentEnvironmentEventSchema).max(CONTRACT_MAX_ARRAY_LENGTH).optional(),
  contextTransferReceipt: ContextTransferReceiptSchema.optional(),
}) satisfies z.ZodType<AgentTurnResult>;

/** Durable provider result for one digest-bound native continuation. */
export const AgentNativeContextContinuationResultSchema = z.union([
  z
    .strictObject({
      acknowledgement: NativeContextContinuationAcknowledgementSchema.and(
        z.object({ status: z.enum(["accepted", "replayed"]) }),
      ),
      result: AgentTurnResultSchema,
      controlRef: AgentExactRunControlRefSchema,
    })
    .superRefine((outcome, refinement) => {
      if (outcome.result.contextTransferReceipt !== undefined) {
        refinement.addIssue({
          code: "custom",
          path: ["result", "contextTransferReceipt"],
          message: "native continuation cannot return a context transfer receipt",
        });
      }
    }),
  z
    .strictObject({
      acknowledgement: NativeContextContinuationAcknowledgementSchema.and(
        z.object({
          status: z.enum([
            "conflict",
            "boundary_mismatch",
            "unverified",
            "unknown_session",
            "transport_failure",
          ]),
        }),
      ),
    })
    .superRefine((outcome, refinement) => {
      if (
        outcome.acknowledgement.status === "transport_failure" &&
        outcome.acknowledgement.retryable !== true
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["acknowledgement", "retryable"],
          message: "a durable native continuation transport failure must be retryable",
        });
      }
    }),
]);
export type AgentNativeContextContinuationResult = z.infer<typeof AgentNativeContextContinuationResultSchema>;

/** Runtime-only controls kept outside the digest-bound user turn. */
export interface AgentNativeContextContinuationOptions {
  turn: NativeContextContinuationTurn;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Cross-check a successful native continuation against its retained session. */
export function agentNativeContextContinuationResultMatchesRequest(
  request: NativeContextContinuationRequest,
  outcome: AgentNativeContextContinuationResult,
): boolean {
  const parsedRequest = NativeContextContinuationRequestSchema.safeParse(request);
  const parsedOutcome = AgentNativeContextContinuationResultSchema.safeParse(outcome);
  if (!parsedRequest.success || !parsedOutcome.success) return false;
  const exactOutcome = parsedOutcome.data;
  if (
    exactOutcome.acknowledgement.status !== "accepted" &&
    exactOutcome.acknowledgement.status !== "replayed"
  ) return false;
  if (!("result" in exactOutcome) || !("controlRef" in exactOutcome)) return false;
  if (
    !nativeContextContinuationAcknowledgementMatches(
      parsedRequest.data,
      exactOutcome.acknowledgement,
    )
  ) return false;
  const current = exactOutcome.controlRef;
  return (
    current.provider === request.run.provider &&
    current.environmentId === request.run.environmentId &&
    current.sessionId === request.run.sessionId &&
    (exactOutcome.result.sessionId === undefined ||
      exactOutcome.result.sessionId === current.sessionId)
  );
}

export interface AgentSessionRef {
  id: string;
  provider?: string;
  controlRef?: AgentRunControlRef;
  contextTransferReceipt?: ContextTransferReceipt;
  metadata?: Record<string, unknown>;
}

export interface AgentEnvironmentEvent {
  type: string;
  data: Record<string, unknown>;
  id?: string;
  normalized?: StreamEvent;
  usage?: TokenUsage;
  providerEvent?: unknown;
}

export interface AgentSession {
  readonly id: string;
  readonly controlRef?: AgentRunControlRef;
  status(options?: { signal?: AbortSignal }): Promise<AgentSessionStatus | null>;
  events(options?: {
    /** Exclusive stable event id previously emitted by this session. */
    since?: string;
    /** Provider execution selected by the durable control reference, when required. */
    executionId?: string;
    signal?: AbortSignal;
  }): AsyncIterable<AgentEnvironmentEvent>;
  result(options?: { signal?: AbortSignal }): Promise<AgentTurnResult>;
  prompt(input: AgentTurnInput): Promise<AgentTurnResult>;
  respondToInteraction?(
    command: InteractionResponseCommand,
    options?: { signal?: AbortSignal },
  ): Promise<InteractionAcknowledgement>;
  contextBoundary?(options?: {
    signal?: AbortSignal;
  }): Promise<NativeContextBoundaryProof | null>;
  continueNative?(
    request: NativeContextContinuationRequest,
    options: AgentNativeContextContinuationOptions,
  ): Promise<AgentNativeContextContinuationResult>;
  cancelRun?(
    request: AgentRunCancellationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<AgentRunCancellationAcknowledgement>;
  cancel(options?: { signal?: AbortSignal }): Promise<void>;
}

export interface AgentEnvironment {
  readonly id: string;
  readonly provider: string;
  readonly name?: string;
  /**
   * Detached metadata returned by the provider.
   * It can contain caller-authored annotations and is not authorization evidence.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * The capability document for THIS environment, and the document a caller
   * reads to decide which operation to offer against it.
   *
   * A capability the connected deployment decides is environment-scoped: one
   * provider reaches deployments of different ages, so
   * {@link AgentEnvironmentProvider.capabilities} can only state what holds
   * before an environment exists. A provider that measures a capability per
   * environment publishes the measured answer here, and the operations this
   * environment exposes match it exactly. Absent when the provider document
   * already describes every environment it creates.
   */
  readonly capabilities?: AgentEnvironmentCapabilities;
  status(options?: { signal?: AbortSignal }): Promise<AgentEnvironmentStatus>;
  stream(input: AgentTurnInput): AsyncIterable<AgentEnvironmentEvent>;
  dispatch?(input: AgentTurnInput): Promise<AgentSessionRef>;
  session?(
    id: string,
    options?: { controlRef?: AgentRunControlRef; signal?: AbortSignal },
  ): AgentSession;
  respondToInteraction?(
    command: InteractionResponseCommand,
    options?: { signal?: AbortSignal },
  ): Promise<InteractionAcknowledgement>;
  read?(path: string, options?: { sessionId?: string; signal?: AbortSignal }): Promise<string>;
  write?(
    path: string,
    content: string,
    options?: { sessionId?: string; signal?: AbortSignal },
  ): Promise<void>;
  exec?(command: string, options?: ExecRequest): Promise<ExecResult>;
  checkpoint?(options?: CheckpointRequest & { signal?: AbortSignal }): Promise<CheckpointRef>;
  fork?(
    checkpoint: CheckpointRef,
    options?: ForkRequest & { signal?: AbortSignal },
  ): Promise<AgentEnvironment>;
  /** Durable, retry-safe checkpoint and environment-fork operations. */
  readonly workspaceBranching?: AgentWorkspaceBranching;
  placement?(options?: { signal?: AbortSignal }): Promise<PlacementInfo>;
  /** Normalized, freshness-tagged observation of this environment. */
  observe?(options?: { signal?: AbortSignal }): Promise<AgentEnvironmentObservation>;
  /** Open or reattach an interactive terminal under a parent execution. */
  attachTerminal?(
    request: TerminalAttachRequest,
    options?: { signal?: AbortSignal },
  ): Promise<TerminalAttachResult>;
  /** Accessor for a live interactive terminal handle. */
  terminal?(
    terminalSessionId: string,
    options?: { signal?: AbortSignal },
  ): AgentTerminalSession;
  /** Start one native coding-agent TUI bound to an exact admitted run. */
  startInteractive?(
    request: AgentInteractiveSessionStart,
    options?: { signal?: AbortSignal },
  ): Promise<AgentInteractiveSessionRef>;
  /** Reconstruct the exact native coding-agent TUI named by a durable reference. */
  interactive?(ref: AgentInteractiveSessionRef): AgentInteractiveSession;
  refresh?(options?: { signal?: AbortSignal }): Promise<void>;
  destroy?(options?: { signal?: AbortSignal }): Promise<void>;
}

export interface AgentEnvironmentCapabilities {
  profile: AgentProfileCapabilities;
  streaming: {
    live: boolean;
    replay: boolean;
    detach: boolean;
    turnIdempotency: boolean;
  };
  sessions: {
    continue: boolean;
    list: boolean;
    messages: boolean;
  };
  /** Present only when durable keyed create and named secret references are backed. */
  environmentCreate?: {
    idempotency: "durable";
    secretReferences: boolean;
  };
  /** Present only when retained-run identity and cancellation are complete. */
  retainedControl?: {
    exactRunIdentity: boolean;
    resultIdentity: boolean;
    eventIdentity: boolean;
    cancellationIdempotency: boolean;
  };
  /** Present only when same-session continuation is atomic and retry-safe. */
  nativeContinuation?: {
    atomicBoundary: boolean;
    requestIdempotency: boolean;
  };
  /** Absent when the provider cannot originate or answer interactions. */
  interactions?: InteractionCapabilities;
  workspace: {
    read: boolean;
    write: boolean;
    exec: boolean;
    git: boolean;
    upload: boolean;
    download: boolean;
  };
  branching: {
    checkpoint: boolean;
    fork: boolean;
    /** True only when key + canonical request digest semantics are implemented. */
    retrySafe?: boolean;
    /** True only when operations can be recovered by idempotency key. */
    lookup?: boolean;
    /** True only when checkpoints and forked environments have confirmed cleanup. */
    cleanup?: boolean;
  };
  placement: boolean;
  usage: boolean;
  confidential: boolean;
  /** Present only when {@link AgentEnvironmentProvider.exactProcess} is implemented. */
  exactProcess?: {
    egress: readonly AgentExactProcessEgressMode[];
  };
  /** Per-surface flags for the normalized environment observation. */
  observation?: {
    identity: boolean;
    lifecycle: boolean;
    endpoint: boolean;
    placement: boolean;
    resources: boolean;
    resourceUse: boolean;
    modelUsage: boolean;
    computeBilling: boolean;
    accountUsage: boolean;
  };
  /** Present only when the provider serves an interactive terminal. */
  interactiveTerminal?: {
    attach: boolean;
    input: boolean;
    resize: boolean;
    reattach: boolean;
  };
  /** Present only when the provider can start and rediscover exact agent TUIs. */
  interactiveAgent?: {
    start: boolean;
    /** Provider-issued generation claims fence recovered coordinators. */
    control: boolean;
    status: boolean;
    attach: boolean;
    reattach: boolean;
    sendPrompt: boolean;
    input: boolean;
    resize: boolean;
    stop: boolean;
  };
}

/** Strict runtime validator for provider capability negotiation. */
export const AgentEnvironmentCapabilitiesSchema = z
  .strictObject({
    profile: AgentProfileCapabilitiesSchema,
    streaming: z.strictObject({
      live: z.boolean(),
      replay: z.boolean(),
      detach: z.boolean(),
      turnIdempotency: z.boolean(),
    }),
    sessions: z.strictObject({
      continue: z.boolean(),
      list: z.boolean(),
      messages: z.boolean(),
    }),
    environmentCreate: z
      .strictObject({
        idempotency: z.literal("durable"),
        secretReferences: z.boolean(),
      })
      .optional(),
    retainedControl: z
      .strictObject({
        exactRunIdentity: z.boolean(),
        resultIdentity: z.boolean(),
        eventIdentity: z.boolean(),
        cancellationIdempotency: z.boolean(),
      })
      .optional(),
    nativeContinuation: z
      .strictObject({
        atomicBoundary: z.boolean(),
        requestIdempotency: z.boolean(),
      })
      .optional(),
    interactions: InteractionCapabilitiesSchema.optional(),
    workspace: z.strictObject({
      read: z.boolean(),
      write: z.boolean(),
      exec: z.boolean(),
      git: z.boolean(),
      upload: z.boolean(),
      download: z.boolean(),
    }),
    branching: z.strictObject({
      checkpoint: z.boolean(),
      fork: z.boolean(),
      retrySafe: z.boolean().optional(),
      lookup: z.boolean().optional(),
      cleanup: z.boolean().optional(),
    }),
    placement: z.boolean(),
    usage: z.boolean(),
    confidential: z.boolean(),
    exactProcess: z
      .strictObject({
        egress: z
          .array(z.enum(["blocked", "strict"]))
          .min(1)
          .max(CONTRACT_MAX_ARRAY_LENGTH),
      })
      .optional(),
    observation: z
      .strictObject({
        identity: z.boolean(),
        lifecycle: z.boolean(),
        endpoint: z.boolean(),
        placement: z.boolean(),
        resources: z.boolean(),
        resourceUse: z.boolean(),
        modelUsage: z.boolean(),
        computeBilling: z.boolean(),
        accountUsage: z.boolean(),
      })
      .optional(),
    interactiveTerminal: z
      .strictObject({
        attach: z.boolean(),
        input: z.boolean(),
        resize: z.boolean(),
        reattach: z.boolean(),
      })
      .optional(),
    interactiveAgent: z
      .strictObject({
        start: z.boolean(),
        control: z.boolean(),
        status: z.boolean(),
        attach: z.boolean(),
        reattach: z.boolean(),
        sendPrompt: z.boolean(),
        input: z.boolean(),
        resize: z.boolean(),
        stop: z.boolean(),
      })
      .optional(),
  })
  .superRefine((capabilities, refinement) => {
    if (
      capabilities.retainedControl !== undefined &&
      (!capabilities.retainedControl.exactRunIdentity ||
        !capabilities.retainedControl.resultIdentity ||
        !capabilities.retainedControl.eventIdentity ||
        !capabilities.retainedControl.cancellationIdempotency ||
        !capabilities.streaming.replay ||
        !capabilities.streaming.detach ||
        !capabilities.streaming.turnIdempotency ||
        !capabilities.sessions.continue)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["retainedControl"],
        message:
          "retained control requires exact run, result, event, cancellation, replay, detach, turn, and session identity together",
      });
    }
    if (
      capabilities.nativeContinuation !== undefined &&
      (!capabilities.nativeContinuation.atomicBoundary ||
        !capabilities.nativeContinuation.requestIdempotency ||
        !capabilities.sessions.continue)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["nativeContinuation"],
        message:
          "native continuation requires session continuation, atomic boundary admission, and request idempotency together",
      });
    }
    const durableBranching = [
      capabilities.branching.retrySafe ?? false,
      capabilities.branching.lookup ?? false,
      capabilities.branching.cleanup ?? false,
    ];
    if (
      durableBranching.some(Boolean) &&
      (!durableBranching.every(Boolean) ||
        !capabilities.branching.checkpoint ||
        !capabilities.branching.fork)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["branching"],
        message:
          "retry-safe branching requires checkpoint, fork, lookup, and cleanup together",
      });
    }
    const egress = capabilities.exactProcess?.egress;
    if (egress && new Set(egress).size !== egress.length) {
      refinement.addIssue({
        code: "custom",
        path: ["exactProcess", "egress"],
        message: "exact process egress modes must be unique",
      });
    }
    const terminal = capabilities.interactiveTerminal;
    if (
      terminal !== undefined &&
      (terminal.input || terminal.resize || terminal.reattach) &&
      !terminal.attach
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["interactiveTerminal"],
        message:
          "interactive terminal input, resize, and reattach each require attach",
      });
    }
    const interactiveAgent = capabilities.interactiveAgent;
    if (
      interactiveAgent !== undefined &&
      (interactiveAgent.status ||
        interactiveAgent.attach ||
        interactiveAgent.reattach ||
        interactiveAgent.sendPrompt ||
        interactiveAgent.input ||
        interactiveAgent.resize ||
        interactiveAgent.stop) &&
      !interactiveAgent.start
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["interactiveAgent"],
        message:
          "interactive agent status, attach, reattach, sendPrompt, input, resize, and stop each require start",
      });
    }
    if (
      interactiveAgent !== undefined &&
      (interactiveAgent.attach ||
        interactiveAgent.sendPrompt ||
        interactiveAgent.input ||
        interactiveAgent.resize ||
        interactiveAgent.stop) &&
      !interactiveAgent.control
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["interactiveAgent", "control"],
        message:
          "interactive agent mutation requires provider-issued control claims",
      });
    }
    if (
      interactiveAgent !== undefined &&
      (interactiveAgent.reattach || interactiveAgent.input || interactiveAgent.resize) &&
      !interactiveAgent.attach
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["interactiveAgent"],
        message: "interactive agent reattach, input, and resize each require attach",
      });
    }
    const extensions = capabilities.profile.extensions;
    if (extensions && new Set(extensions).size !== extensions.length) {
      refinement.addIssue({
        code: "custom",
        path: ["profile", "extensions"],
        message: "profile extension namespaces must be unique",
      });
    }
  }) satisfies z.ZodType<AgentEnvironmentCapabilities>;

export interface CreateAgentEnvironmentInput {
  profile: AgentProfileRef;
  /** Agent backend inside the provider, for example "opencode" or "codex". */
  backend?: string;
  workspace?: WorkspaceRequest;
  resources?: ResourceRequest;
  env?: Record<string, string>;
  secrets?: string[] | Record<string, string>;
  metadata?: Record<string, unknown>;
  name?: string;
  /**
   * Stable identity for one logical environment create.
   *
   * When present, a provider advertising `environmentCreate.idempotency` must
   * use this key as one durable operation. Other providers must reject it.
   * The same key with canonically equal create input must return or reconstruct
   * the same environment, while a different input must be rejected.
   * `signal` controls one attempt and is not part of create identity.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
}

/** Reject a capability claim that this adapter cannot implement. */
export function assertNoGenericEnvironmentCreateCapability(
  capabilities: AgentEnvironmentCapabilities,
  providerName: string,
): void {
  if (capabilities.environmentCreate !== undefined) {
    throw new Error(
      `${providerName} provider cannot advertise durable generic environment idempotency`,
    );
  }
}

/** Reject generic create fields that a non-durable adapter cannot carry safely. */
export function assertNoGenericEnvironmentCreateMappingFields(
  mapped: unknown,
  providerName: string,
): void {
  if (!mapped || typeof mapped !== "object" || Array.isArray(mapped)) return;
  for (const field of ["idempotencyKey", "secrets", "signal"] as const) {
    if (Object.hasOwn(mapped, field)) {
      throw new Error(
        `${providerName} create mapper must not map generic ${field}`,
      );
    }
  }
}

/**
 * Compute the canonical identity of a generic environment create request.
 *
 * The operation key names the request and the abort signal controls one
 * attempt, so neither belongs in the input identity. Every other field is
 * canonicalized with the shared RFC 8785 JSON representation.
 * @internal
 */
export function agentEnvironmentCreateInputDigest(
  input: CreateAgentEnvironmentInput,
): Sha256Digest {
  const material = canonicalCreateMaterial(input);
  return canonicalCandidateDigest({
    kind: "agent-environment-create.v1",
    input: material,
  });
}

/** A create attempt whose outcome is unsafe to retry without operator recovery. */
export class AgentEnvironmentCreateRetryBlockedError extends Error {
  readonly retryBlocked = true;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentEnvironmentCreateRetryBlockedError";
  }
}

/** @internal State held by one provider adapter for keyed create retries. */
export interface AgentEnvironmentCreateIdempotencyRecord<T> {
  readonly digest: Sha256Digest;
  readonly pending: Promise<T>;
  readonly createdAt: number;
  lastUsedAt: number;
  state: "pending" | "fulfilled" | "blocked";
  environment?: T;
  failure?: unknown;
}

/** The local retention bound before a durable provider must reconstruct remotely. */
export const AGENT_ENVIRONMENT_CREATE_MAX_RECORDS = CONTRACT_MAX_MAP_ENTRIES;

/**
 * Return an immutable canonical copy of the create input.
 *
 * The attempt signal remains a top-level reference and never enters the frozen
 * JSON material. Every provider receives this copy instead of caller-owned
 * objects, so mutation cannot change a recorded identity after admission.
 */
export function snapshotAgentEnvironmentCreateInput(
  input: CreateAgentEnvironmentInput,
): CreateAgentEnvironmentInput {
  const { material, idempotencyKey, signal } = readCanonicalCreateInput(input);
  const snapshot = {
    ...material,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(signal === undefined ? {} : { signal }),
  } as CreateAgentEnvironmentInput;
  return Object.freeze(snapshot);
}

/** Remove the caller-only signal before starting a shared keyed attempt. */
export function withoutAgentEnvironmentCreateSignal(
  input: CreateAgentEnvironmentInput,
): CreateAgentEnvironmentInput {
  if (input.signal === undefined) return input;
  const { signal: _signal, ...withoutSignal } = input;
  return withoutSignal;
}

/** Wait for one caller without cancelling the shared create operation. */
export async function awaitAgentEnvironmentWithSignal<T>(
  operation: Promise<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return await operation;
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<T>((_, reject) => {
        listener = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        signal.addEventListener("abort", listener, { once: true });
      }),
    ]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

/**
 * Create from an allocated provider resource and clean it on every failed map.
 *
 * The returned promise waits for late allocation and cleanup after an abort.
 * The shared idempotency helper can therefore retain the record until no late
 * callback can delete a resource adopted by a later retry.
 */
export async function createAgentEnvironmentResource<TResource, TEnvironment>(
  operation: Promise<TResource>,
  signal: AbortSignal | undefined,
  map: (resource: TResource) => TEnvironment | Promise<TEnvironment>,
  cleanup: (resource: TResource) => void | Promise<void>,
): Promise<TEnvironment> {
  let resource: TResource;
  try {
    resource = await awaitAgentEnvironmentWithSignal(operation, signal);
  } catch (error) {
    if (!signal?.aborted) throw error;
    try {
      const lateResource = await operation;
      await cleanup(lateResource);
    } catch (lateError) {
      if (lateError === signal.reason || isAbortError(lateError)) throw error;
      throw new AgentEnvironmentCreateRetryBlockedError(
        `environment create aborted without a confirmed cleanup outcome: ${errorMessage(error)}`,
        lateError,
      );
    }
    throw error;
  }

  try {
    signal?.throwIfAborted();
    const environment = await map(resource);
    signal?.throwIfAborted();
    return environment;
  } catch (error) {
    try {
      await cleanup(resource);
    } catch (cleanupError) {
      throw new AgentEnvironmentCreateRetryBlockedError(
        `environment create mapping failed and cleanup did not complete: ${errorMessage(error)}`,
        cleanupError,
      );
    }
    throw error;
  }
}

/** Remove a settled local record after its environment is destroyed. */
export function releaseAgentEnvironmentCreateRecord<T>(
  records: Map<string, AgentEnvironmentCreateIdempotencyRecord<T>>,
  idempotencyKey: string | undefined,
  environment: T,
): void {
  if (idempotencyKey === undefined) return;
  const record = records.get(idempotencyKey);
  if (record?.state === "fulfilled" && record.environment === environment) {
    records.delete(idempotencyKey);
  }
}

/** Add record release to an environment without changing its provider methods. */
export function attachAgentEnvironmentCreateRetention<T extends AgentEnvironment>(
  environment: T,
  records: Map<string, AgentEnvironmentCreateIdempotencyRecord<T>>,
  idempotencyKey: string | undefined,
): T {
  if (idempotencyKey === undefined || environment.destroy === undefined) {
    return environment;
  }
  const destroy = environment.destroy;
  let retained: T;
  let destroyPromise: Promise<void> | undefined;
  retained = {
    ...environment,
    async destroy(options) {
      if (destroyPromise !== undefined) return await destroyPromise;
      const record = records.get(idempotencyKey);
      if (record?.state !== "fulfilled" || record.environment !== retained) {
        throw new AgentEnvironmentCreateRetryBlockedError(
          "keyed environment destroy is no longer owned by its retained create record",
        );
      }
      destroyPromise = (async () => {
        await destroy.call(environment, options);
        releaseAgentEnvironmentCreateRecord(records, idempotencyKey, retained);
      })();
      try {
        await destroyPromise;
      } catch (error) {
        destroyPromise = undefined;
        throw error;
      }
    },
  } as T;
  return retained;
}

/**
 * Apply the generic create contract to one provider adapter's keyed requests.
 *
 * The provider's backing service remains responsible for retaining the key
 * across adapter reconstruction. This helper coalesces concurrent retries and
 * rejects collisions before the provider performs another create effect.
 * @internal
 */
export async function createAgentEnvironmentWithIdempotency<T>(
  records: Map<string, AgentEnvironmentCreateIdempotencyRecord<T>>,
  input: CreateAgentEnvironmentInput,
  create: (input: CreateAgentEnvironmentInput) => Promise<T>,
): Promise<T> {
  const snapshot = snapshotAgentEnvironmentCreateInput(input);
  const key = snapshot.idempotencyKey;
  const digest = agentEnvironmentCreateInputDigest(snapshot);
  if (key === undefined) {
    const operation = Promise.resolve().then(() => create(snapshot));
    return await awaitAgentEnvironmentWithSignal(operation, snapshot.signal);
  }

  const existing = records.get(key);
  if (existing !== undefined) {
    if (existing.digest !== digest) {
      throw new Error(
        "agent environment create idempotency key conflicts with a different create input",
      );
    }
    existing.lastUsedAt = Date.now();
    if (existing.state === "blocked") throw existing.failure;
    return await awaitAgentEnvironmentWithSignal(existing.pending, snapshot.signal);
  }

  evictCreateRecords(records);
  let record!: AgentEnvironmentCreateIdempotencyRecord<T>;
  const operationInput = withoutAgentEnvironmentCreateSignal(snapshot);
  const pending = Promise.resolve()
    .then(() => create(operationInput))
    .then(
      (environment) => {
        const immutable = freezeReplayValue(environment);
        if (records.get(key) === record) {
          record.environment = immutable;
          record.state = "fulfilled";
          record.lastUsedAt = Date.now();
        }
        return immutable;
      },
      (error: unknown) => {
        if (records.get(key) === record) {
          if (isRetryBlocked(error)) {
            record.state = "blocked";
            record.failure = error;
            record.lastUsedAt = Date.now();
          } else {
            records.delete(key);
          }
        }
        throw error;
      },
    );
  record = {
    digest,
    pending,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    state: "pending",
  };
  records.set(key, record);
  void pending.catch(() => undefined);
  return await awaitAgentEnvironmentWithSignal(pending, snapshot.signal);
}

function canonicalCreateMaterial(
  input: CreateAgentEnvironmentInput,
): Record<string, unknown> {
  return readCanonicalCreateInput(input).material;
}

function readCanonicalCreateInput(input: CreateAgentEnvironmentInput): {
  material: Record<string, unknown>;
  idempotencyKey?: string;
  signal?: AbortSignal;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("agent environment create input must be an object");
  }
  const allowed = new Set([
    "profile",
    "backend",
    "workspace",
    "resources",
    "env",
    "secrets",
    "metadata",
    "name",
    "idempotencyKey",
    "signal",
    "providerOptions",
  ]);
  const entries = Object.entries(input);
  if (entries.length > CONTRACT_MAX_MAP_ENTRIES) {
    throw new Error("agent environment create input exceeds its field bound");
  }
  if (entries.some(([key]) => !allowed.has(key))) {
    throw new Error("agent environment create input contains unsupported fields");
  }
  const values = Object.fromEntries(entries) as Record<string, unknown>;
  const idempotencyKey = values.idempotencyKey;
  if (idempotencyKey !== undefined) boundedIdentifierSchema.parse(idempotencyKey);
  const material = Object.fromEntries(
    entries.filter(([key, value]) =>
      key !== "idempotencyKey" && key !== "signal" && value !== undefined,
    ),
  );
  assertBoundedJson(material);
  const canonical = canonicalCandidateJson(material);
  assertBoundedSerializedJson(canonical);
  return {
    material: freezeReplayValue(JSON.parse(canonical) as Record<string, unknown>),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey: idempotencyKey as string }),
    ...(values.signal === undefined ? {} : { signal: values.signal as AbortSignal }),
  };
}

function evictCreateRecords<T>(
  records: Map<string, AgentEnvironmentCreateIdempotencyRecord<T>>,
): void {
  while (records.size >= AGENT_ENVIRONMENT_CREATE_MAX_RECORDS) {
    let oldestKey: string | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [key, record] of records) {
      if (record.state !== "fulfilled" || record.lastUsedAt >= oldestTime) continue;
      oldestKey = key;
      oldestTime = record.lastUsedAt;
    }
    if (oldestKey === undefined) {
      throw new Error("agent environment create idempotency retention is full");
    }
    records.delete(oldestKey);
  }
}

function isRetryBlocked(error: unknown): boolean {
  return (
    ((typeof error === "object" && error !== null) || typeof error === "function") &&
    (error as { retryBlocked?: unknown }).retryBlocked === true
  );
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function freezeReplayValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const pending: object[] = [value as object];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const prototype = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) continue;
    for (const entry of Object.values(current)) {
      if (entry !== null && typeof entry === "object") pending.push(entry);
    }
    Object.freeze(current);
  }
  return value;
}

export interface AgentEnvironmentProvider {
  readonly name: string;
  readonly exactProcess?: AgentExactProcessProvider;
  capabilities():
    | AgentEnvironmentCapabilities
    | Promise<AgentEnvironmentCapabilities>;
  validateProfile?(
    profile: AgentProfileRef,
  ): AgentProfileValidationResult | Promise<AgentProfileValidationResult>;
  /**
   * Create or reconstruct one environment.
   *
   * With `input.idempotencyKey`, the provider must advertise durable
   * `environmentCreate.idempotency` or reject the request before creating.
   * Without a key, each call may create a fresh environment.
   */
  create(input: CreateAgentEnvironmentInput): Promise<AgentEnvironment>;
  get?(id: string, options?: { signal?: AbortSignal }): Promise<AgentEnvironment | null>;
  list?(query?: AgentEnvironmentQuery, options?: { signal?: AbortSignal }): Promise<AgentEnvironmentSummary[]>;
}
