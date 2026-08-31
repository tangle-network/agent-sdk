import { z } from "zod";
import { canonicalCandidateDigest } from "./agent-candidate-schema-common.js";
import type { Sha256Digest } from "./agent-candidate.js";
import type { AgentProfileCapabilities, AgentProfileValidationResult } from "./agent-profile.js";
import type { InputPart } from "./parts.js";
import type { StreamEvent } from "./stream-events.js";
import type { TokenUsage } from "./execution-types.js";
import { InteractionCapabilitiesSchema, RequestedInteractionsSchema, type InteractionAcknowledgement, type InteractionCapabilities, type InteractionResponseCommand, type RequestedInteractions } from "./interaction.js";
import { ContextTransferReceiptSchema, ContextTransferRequestSchema, NativeContextBoundaryProofSchema, NativeContextContinuationAcknowledgementSchema, NativeContextContinuationRequestSchema, nativeContextContinuationAcknowledgementMatches, type ContextTransferReceipt, type ContextTransferRequest, type ContextTransferResult, type NativeContextBoundaryProof, type NativeContextContinuationRequest, type NativeContextContinuationTurn } from "./portable-context.js";
import { AgentExactRunControlRefSchema, AgentRunControlRefSchema, CanonicalStreamEventSchema, type AgentExactRunControlRef, type AgentRunCancellationAcknowledgement, type AgentRunCancellationRequest, type AgentRunControlRef } from "./runtime-control.js";
import type {
  AgentWorkspaceBranching,
  AgentWorkspaceBranchingProvider,
} from "./workspace-branching.js";
import { AgentProfileCapabilitiesSchema } from "./environment-profile-capabilities.js";
import { boundedIdentifierSchema, boundedJsonRecordSchema, boundedJsonSchema, boundedStringSchema, CONTRACT_MAX_ARRAY_LENGTH } from "./contract-limits.js";
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

/** Exact continued-run identity returned after durable admission. */
export const AgentNativeContextContinuationAdmissionSchema = z
  .strictObject({
    phase: z.literal("admitted"),
    acknowledgement: z.strictObject({
      operationId: boundedIdentifierSchema,
      requestDigest: AgentExactRunControlRefSchema.shape.requestDigest,
      historyMessagesSent: z.literal(0),
      actualBoundary: NativeContextBoundaryProofSchema,
    }),
    controlRef: AgentExactRunControlRefSchema,
  })
  .superRefine((admission, refinement) => {
    const source = admission.acknowledgement.actualBoundary;
    const current = admission.controlRef;
    if (
      source.provider !== current.provider ||
      source.environmentId !== current.environmentId ||
      source.sessionId !== current.sessionId
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["controlRef"],
        message: "native continuation admission must stay in the retained session",
      });
    }
  });
export type AgentNativeContextContinuationAdmission = z.infer<
  typeof AgentNativeContextContinuationAdmissionSchema
>;

/** Cross-check one early admission against its exact continuation request. */
export function agentNativeContextContinuationAdmissionMatchesRequest(
  request: NativeContextContinuationRequest,
  admission: AgentNativeContextContinuationAdmission,
): boolean {
  const parsedRequest = NativeContextContinuationRequestSchema.safeParse(request);
  const parsedAdmission = AgentNativeContextContinuationAdmissionSchema.safeParse(admission);
  if (!parsedRequest.success || !parsedAdmission.success) return false;
  const expected = parsedRequest.data;
  const actual = parsedAdmission.data;
  const boundary = actual.acknowledgement.actualBoundary;
  return (
    actual.acknowledgement.operationId === expected.operationId &&
    actual.acknowledgement.requestDigest === expected.requestDigest &&
    boundary.runId === expected.run.runId &&
    boundary.provider === expected.run.provider &&
    boundary.environmentId === expected.run.environmentId &&
    boundary.sessionId === expected.run.sessionId &&
    boundary.executionId === expected.run.executionId &&
    boundary.requestDigest === expected.run.requestDigest
  );
}

/** Runtime-only controls kept outside the digest-bound user turn. */
export interface AgentNativeContextContinuationOptions {
  turn: NativeContextContinuationTurn;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Receives the exact new run identity after durable admission and before the
   * provider waits for terminal output. Providers call this once only when
   * `nativeContinuation.admissionControl` is true.
   */
  onAdmission?: (controlRef: AgentExactRunControlRef) => void;
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

/**
 * What one {@link AgentEnvironmentProvider.create} call did for the
 * environment it returned.
 *
 * - `created`: this call provisioned the environment.
 * - `replayed`: an existing environment that matched the idempotency key was
 *   returned. This call provisioned nothing.
 *
 * Absent when the provider cannot distinguish the two. A consumer treats an
 * absent value as unknown and fails closed: it never destroys an environment
 * whose creation it cannot prove, because another caller can hold it.
 */
export type AgentEnvironmentCreation = "created" | "replayed";

export const AgentEnvironmentCreationSchema = z.enum([
  "created",
  "replayed",
]) satisfies z.ZodType<AgentEnvironmentCreation>;

export interface AgentEnvironment {
  readonly id: string;
  readonly provider: string;
  readonly name?: string;
  /**
   * The verdict of the create call that returned this object. It is a
   * per-call fact: a same-key replay returns a view of the same environment
   * with `creation: "replayed"`. Absent on `get()` results and when the
   * provider cannot prove which outcome happened.
   */
  readonly creation?: AgentEnvironmentCreation;
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
    /** The provider exposes the exact continued run before terminal output. */
    admissionControl?: boolean;
  };
  /** Present only when fresh-session portable context transfer is durable. */
  contextTransfer?: {
    freshSession: boolean;
    requestIdempotency: boolean;
    lookup: boolean;
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
    /** Path bases accepted by the provider's workspace create contract. */
    cwdBases?: {
      repository: boolean;
      host: boolean;
    };
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
        admissionControl: z.boolean().optional(),
      })
      .optional(),
    contextTransfer: z
      .strictObject({
        freshSession: z.boolean(),
        requestIdempotency: z.boolean(),
        lookup: z.boolean(),
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
      cwdBases: z
        .strictObject({
          repository: z.boolean(),
          host: z.boolean(),
        })
        .optional(),
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
    if (
      capabilities.nativeContinuation?.admissionControl === true &&
      capabilities.retainedControl === undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["nativeContinuation", "admissionControl"],
        message: "native continuation requires retained control for early admission",
      });
    }
    if (
      capabilities.contextTransfer !== undefined &&
      (!capabilities.contextTransfer.freshSession ||
        !capabilities.contextTransfer.requestIdempotency ||
        !capabilities.contextTransfer.lookup)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["contextTransfer"],
        message:
          "context transfer requires fresh-session admission, request idempotency, and lookup together",
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
  /** Exact caller-owned id required by an accepted destination contract. */
  requestedId?: string;
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
   * When present, the provider must use this key as one idempotent operation:
   * the same key with canonically equal create input must return or reconstruct
   * the same environment, while a different input must be rejected.
   * `signal` controls one attempt and is not part of create identity.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
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
  const { idempotencyKey: _idempotencyKey, signal: _signal, ...material } = input;
  return canonicalCandidateDigest({
    kind: "agent-environment-create.v1",
    input: material,
  });
}

/** @internal State held by one provider adapter for keyed create retries. */
export interface AgentEnvironmentCreateIdempotencyRecord<T> {
  readonly digest: Sha256Digest;
  readonly pending: Promise<T>;
  environment?: T;
}

/**
 * Return the per-call view of an environment that a same-key create replayed.
 *
 * The view shares every member of the environment, so operations act on the
 * one environment, and it states `creation: "replayed"` because this call
 * provisioned nothing. The copy is shallow, so the environment must be a plain
 * object whose members do not read `this`; a class instance loses its
 * prototype members in a copy and is rejected.
 * @internal
 */
export function replayedAgentEnvironmentView<T extends object>(
  environment: T,
): T {
  const prototype = Object.getPrototypeOf(environment) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      "a replayed agent environment view requires a plain object environment",
    );
  }
  return { ...environment, creation: "replayed" };
}

/**
 * Apply the generic create contract to one provider adapter's keyed requests.
 *
 * The provider's backing service remains responsible for retaining the key
 * across adapter reconstruction. This helper coalesces concurrent retries and
 * rejects collisions before the provider performs another create effect.
 *
 * The call that runs `create` receives the environment the provider built,
 * with the creation verdict the provider could prove. Every same-key call
 * after it, including one that awaited the same pending create, receives
 * {@link replayedAgentEnvironmentView} of that environment.
 * @internal
 */
export async function createAgentEnvironmentWithIdempotency<T extends object>(
  records: Map<string, AgentEnvironmentCreateIdempotencyRecord<T>>,
  input: CreateAgentEnvironmentInput,
  create: () => Promise<T>,
): Promise<T> {
  input.signal?.throwIfAborted();
  const key = input.idempotencyKey;
  if (key === undefined) return create();

  const digest = agentEnvironmentCreateInputDigest(input);
  const existing = records.get(key);
  if (existing !== undefined) {
    if (existing.digest !== digest) {
      throw new Error(
        "agent environment create idempotency key conflicts with a different create input",
      );
    }
    return replayedAgentEnvironmentView(
      existing.environment ?? (await existing.pending),
    );
  }

  const pending = Promise.resolve().then(create);
  const record: AgentEnvironmentCreateIdempotencyRecord<T> = {
    digest,
    pending,
  };
  records.set(key, record);
  try {
    const environment = await pending;
    if (records.get(key) === record) record.environment = environment;
    return environment;
  } catch (error) {
    if (records.get(key) === record) records.delete(key);
    throw error;
  }
}

export interface AgentEnvironmentProvider {
  readonly name: string;
  readonly exactProcess?: AgentExactProcessProvider;
  /** Durable fresh-session portable context admission, when supported. */
  readonly contextTransfer?: AgentContextTransferProvider;
  /**
   * Reconstruct a source-scoped branching handle after a coordinator restart.
   *
   * This surface is intentionally separate from an environment-owned handle:
   * lookup and cleanup requests identify operations, not their source. The
   * provider owns source resolution and the underlying platform calls. A
   * returned handle is bound to that source and must reject other scopes.
   */
  readonly workspaceBranching?: AgentWorkspaceBranchingProvider;
  capabilities():
    | AgentEnvironmentCapabilities
    | Promise<AgentEnvironmentCapabilities>;
  validateProfile?(
    profile: AgentProfileRef,
  ): AgentProfileValidationResult | Promise<AgentProfileValidationResult>;
  /**
   * Create or reconstruct one environment.
   *
   * With `input.idempotencyKey`, the provider must return the same environment
   * for the same canonical input and reject any changed input before creating.
   * Without a key, each call may create a fresh environment.
   */
  create(input: CreateAgentEnvironmentInput): Promise<AgentEnvironment>;
  get?(id: string, options?: { signal?: AbortSignal }): Promise<AgentEnvironment | null>;
  list?(query?: AgentEnvironmentQuery, options?: { signal?: AbortSignal }): Promise<AgentEnvironmentSummary[]>;
}

/** Provider-owned portable context admission with retry-safe lookup. */
export interface AgentContextTransferProvider {
  transfer(
    request: ContextTransferRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ContextTransferResult>;
  lookup(
    request: ContextTransferRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ContextTransferResult | undefined>;
}
