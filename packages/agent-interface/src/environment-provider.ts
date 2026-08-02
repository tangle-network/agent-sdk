import { z } from "zod";
import type {
  AgentProfile,
  AgentProfileCapabilities,
  AgentProfileValidationResult,
} from "./agent-profile.js";
import type { AgentCandidateTermination } from "./agent-candidate.js";
import type { InputPart, StreamEvent, TokenUsage } from "./index.js";
import {
  InteractionCapabilitiesSchema,
  type InteractionAcknowledgement,
  type InteractionCapabilities,
  type InteractionResponseCommand,
} from "./interaction.js";
/*
 * Keep the provider contract runtime-validatable. Provider capability data is
 * commonly read from a remote service or adapter configuration, so its static
 * TypeScript type is not a trust boundary.
 */
const AgentProfileCapabilitiesSchema = z.strictObject({
  namedProfiles: z.boolean(),
  systemPrompt: z.boolean(),
  instructions: z.boolean(),
  tools: z.boolean(),
  permissions: z.boolean(),
  mcp: z.boolean(),
  subagents: z.boolean(),
  resources: z.strictObject({
    files: z.boolean(),
    instructions: z.boolean(),
    tools: z.boolean().optional(),
    skills: z.boolean().optional(),
    agents: z.boolean().optional(),
    commands: z.boolean().optional(),
  }),
  hooks: z.boolean().optional(),
  modes: z.boolean().optional(),
  runtimeUpdate: z.boolean(),
  validation: z.boolean(),
  extensions: z.array(z.string().min(1)).optional(),
}) satisfies z.ZodType<AgentProfileCapabilities>;
import {
  ContextTransferReceiptSchema,
  NativeContextContinuationAcknowledgementSchema,
  NativeContextContinuationRequestSchema,
  nativeContextContinuationAcknowledgementMatches,
  type ContextTransferReceipt,
  type ContextTransferRequest,
  type NativeContextBoundaryProof,
  type NativeContextContinuationAcknowledgement,
  type NativeContextContinuationRequest,
  type NativeContextContinuationTurn,
} from "./portable-context.js";
import {
  type AgentRunCancellationAcknowledgement,
  type AgentRunCancellationRequest,
  AgentRunControlRefSchema,
  CanonicalStreamEventSchema,
  type AgentRunControlRef,
} from "./runtime-control.js";
import type { AgentWorkspaceBranching } from "./workspace-branching.js";

/** Portable profile reference: inline profile or provider catalog id. */
export type AgentProfileRef = AgentProfile | string;

export type AgentEnvironmentStatus =
  | "pending"
  | "provisioning"
  | "running"
  | "stopped"
  | "failed"
  | "expired"
  | "unknown";

export type AgentSessionStatus =
  | AgentEnvironmentStatus
  | "completed"
  | "cancelled";

export interface WorkspaceRequest {
  /** Provider-specific environment/template id, for example "universal". */
  environment?: string;
  /** Container image or image alias when the provider supports image-backed workspaces. */
  image?: string;
  /** Repository to clone or mount before the agent runs. */
  repoUrl?: string;
  /** Git ref for {@link repoUrl}. */
  gitRef?: string;
  /** Initial working directory inside the environment. */
  cwd?: string;
  /** Opaque provider-native workspace fields. */
  providerOptions?: Record<string, unknown>;
}

export interface ResourceRequest {
  cpu?: number;
  memoryMb?: number;
  diskMb?: number;
  gpu?: string;
  providerOptions?: Record<string, unknown>;
}

export interface AgentEnvironmentQuery {
  name?: string;
  metadata?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
}

export interface AgentEnvironmentSummary {
  id: string;
  provider: string;
  name?: string;
  status?: AgentEnvironmentStatus;
  metadata?: Record<string, unknown>;
}

export interface ExecRequest {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type AgentExactProcessEgressMode = "blocked" | "strict";

/**
 * Outbound network policy for an exact process environment. `blocked` denies
 * every protocol. `strict` permits only the named domains; direct-address,
 * alternate-protocol, and cross-environment bypasses must fail.
 */
export type AgentExactProcessEgressPolicy =
  | { mode: "blocked" }
  | { mode: "strict"; allowDomains: readonly string[] };

/** Explicit portable limits for an exact process environment. */
export interface AgentExactProcessResources {
  /** Positive CPU core count. */
  cpu: number;
  /** Positive integer mebibytes of memory. */
  memoryMb: number;
  /** Positive integer mebibytes of disk. */
  diskMb: number;
}

/** Terminal or running state reported by an exact process host. */
export interface AgentExactProcessStatus {
  pid: number;
  running: boolean;
  /** -1 while running; the exact process exit code after termination. */
  exitCode: number;
  exitSignal?: string;
  /** Required after termination; absent only while running. */
  termination?: AgentCandidateTermination;
}

/** Recoverable handle for one shell-free process. */
export interface AgentExactProcess {
  readonly pid: number;
  status(): Promise<AgentExactProcessStatus>;
  wait(): Promise<AgentCandidateTermination>;
  /** Force-stop the full process tree. Idempotent after the process exits. */
  kill(): Promise<void>;
  /** Each iteration replays buffered UTF-8 stdout, then continues until exit. */
  stdout(): AsyncIterable<string>;
  /** Each iteration replays buffered UTF-8 stderr, then continues until exit. */
  stderr(): AsyncIterable<string>;
}

/** Shell-free launch whose environment replaces, rather than extends, ambient variables. */
export interface AgentExactProcessLaunch {
  /** Absolute path unless {@link env} supplies an explicit `PATH`. */
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin?: string;
  /** Positive integer milliseconds, or zero to disable the process timeout. */
  timeoutMs: number;
}

export interface AgentExactProcessManager {
  list(): Promise<AgentExactProcessStatus[]>;
  get(pid: number): Promise<AgentExactProcess | null>;
  /** Providers must honor the abort signal when supplied. */
  spawn(
    input: AgentExactProcessLaunch,
    options?: { signal?: AbortSignal },
  ): Promise<AgentExactProcess>;
}

/**
 * Fresh environment with no provider-managed user workload.
 *
 * Authenticated provider control services may exist, but no customer workload
 * ingress or provider-managed user process may exist. The launched process
 * sees only its supplied environment variables, with no ambient or injected
 * secrets.
 */
export interface AgentExactProcessEnvironment {
  readonly id: string;
  readonly provider: string;
  readonly metadata?: Record<string, unknown>;
  readonly process: AgentExactProcessManager;
  /** Write exact bytes to an absolute path with a POSIX mode from 0 through 07777. Providers must honor the abort signal when supplied. */
  writeFile(
    path: string,
    bytes: Uint8Array,
    options: { mode: number; signal?: AbortSignal },
  ): Promise<void>;
  /** Read exact bytes or fail before content is loaded when the file exceeds maxBytes. */
  readFile(
    path: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<Uint8Array>;
  destroy(): Promise<void>;
}

export interface AgentExactProcessEnvironmentQuery {
  /** Every supplied key/value must match persisted environment metadata exactly. */
  metadata?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
}

/** Input for a fresh environment with no provider-managed agent process. */
export interface CreateAgentExactProcessEnvironmentInput {
  /** Provider-specific immutable image reference. */
  image: string;
  egress: AgentExactProcessEgressPolicy;
  /** Positive integer milliseconds. */
  maxLifetimeMs: number;
  /** Positive integer milliseconds when supplied. */
  provisionTimeoutMs?: number;
  /** Required limits; exact execution never inherits provider defaults. */
  resources: AgentExactProcessResources;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
  signal?: AbortSignal;
  /** Provider-native fields may narrow, but never weaken, the isolation contract. */
  providerOptions?: Record<string, unknown>;
}

/** Optional all-or-nothing exact process capability of an environment provider. */
export interface AgentExactProcessProvider {
  /**
   * Repeating the same idempotency key and input returns the same environment.
   * Reusing the key with any different create input must fail.
   * Unsupported egress modes must fail instead of weakening the policy.
   */
  create(input: CreateAgentExactProcessEnvironmentInput): Promise<AgentExactProcessEnvironment>;
  /** Ordinary environments must return null. */
  get(id: string): Promise<AgentExactProcessEnvironment | null>;
  /** Return every matching exact environment; providers own any native pagination. */
  list(query?: AgentExactProcessEnvironmentQuery): Promise<AgentExactProcessEnvironment[]>;
}

export interface CheckpointRequest {
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckpointRef {
  id: string;
  provider?: string;
  metadata?: Record<string, unknown>;
}

export interface ForkRequest {
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface PlacementInfo {
  kind: "local" | "sandbox" | "fleet" | "provider";
  sandboxId?: string;
  fleetId?: string;
  machineId?: string;
  region?: string;
  providerMetadata?: Record<string, unknown>;
}

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
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
}

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
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  id: z.string().min(1).optional(),
  normalized: CanonicalStreamEventSchema.optional(),
  usage: TokenUsageSchema.optional(),
  providerEvent: z.unknown().optional(),
}) satisfies z.ZodType<AgentEnvironmentEvent>;

/** Runtime validator for a provider turn returned from durable continuation. */
export const AgentTurnResultSchema = z.strictObject({
  text: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  sessionId: z.string().min(1).optional(),
  usage: TokenUsageSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  events: z.array(AgentEnvironmentEventSchema).optional(),
  contextTransferReceipt: ContextTransferReceiptSchema.optional(),
}) satisfies z.ZodType<AgentTurnResult>;

/** Durable provider result for one digest-bound native continuation operation. */
export const AgentNativeContextContinuationResultSchema = z.union([
  z
    .strictObject({
      acknowledgement: NativeContextContinuationAcknowledgementSchema.and(
        z.object({ status: z.enum(["accepted", "replayed"]) }),
      ),
      result: AgentTurnResultSchema,
      /** Exact provider coordinates after the continuation completed. */
      controlRef: AgentRunControlRefSchema,
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
          message:
            "a durable native continuation transport failure must be retryable",
        });
      }
    }),
]);
export type AgentNativeContextContinuationResult = z.infer<
  typeof AgentNativeContextContinuationResultSchema
>;

/** Runtime-only controls kept outside the digest-bound user turn. */
export interface AgentNativeContextContinuationOptions {
  turn: NativeContextContinuationTurn;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Cross-check a successful result against its exact request and retained session. */
export function agentNativeContextContinuationResultMatchesRequest(
  request: NativeContextContinuationRequest,
  outcome: AgentNativeContextContinuationResult,
): boolean {
  const parsedRequest =
    NativeContextContinuationRequestSchema.safeParse(request);
  const parsedOutcome =
    AgentNativeContextContinuationResultSchema.safeParse(outcome);
  if (!parsedRequest.success || !parsedOutcome.success) return false;
  const exactOutcome = parsedOutcome.data;
  if (
    exactOutcome.acknowledgement.status !== "accepted" &&
    exactOutcome.acknowledgement.status !== "replayed"
  ) {
    return false;
  }
  if (!("result" in exactOutcome) || !("controlRef" in exactOutcome)) {
    return false;
  }
  if (
    !nativeContextContinuationAcknowledgementMatches(
      parsedRequest.data,
      exactOutcome.acknowledgement,
    )
  ) {
    return false;
  }
  const source = parsedRequest.data.run;
  const current = exactOutcome.controlRef;
  return (
    current.provider === source.provider &&
    current.environmentId === source.environmentId &&
    current.sessionId === source.sessionId &&
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
  status(): Promise<AgentSessionStatus | null>;
  events(options?: {
    /** Exclusive stable event id previously emitted by this session. */
    since?: string;
    /** Provider execution selected by the durable control reference, when required. */
    executionId?: string;
    signal?: AbortSignal;
  }): AsyncIterable<AgentEnvironmentEvent>;
  result(): Promise<AgentTurnResult>;
  prompt(input: AgentTurnInput): Promise<AgentTurnResult>;
  respondToInteraction?(
    command: InteractionResponseCommand,
    options?: { signal?: AbortSignal },
  ): Promise<InteractionAcknowledgement>;
  contextBoundary?(options?: {
    signal?: AbortSignal;
  }): Promise<NativeContextBoundaryProof | null>;
  /**
   * Atomically verify the boundary and admit one digest-bound continuation.
   * Repeating an operation id with the same request returns the original result;
   * repeating it with a different request returns a conflict without dispatch.
   */
  continueNative?(
    request: NativeContextContinuationRequest,
    options: AgentNativeContextContinuationOptions,
  ): Promise<AgentNativeContextContinuationResult>;
  /** Retry-safe cancellation bound to one exact run and caller operation. */
  cancelRun?(
    request: AgentRunCancellationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<AgentRunCancellationAcknowledgement>;
  cancel(): Promise<void>;
}

export interface AgentEnvironment {
  readonly id: string;
  readonly provider: string;
  readonly name?: string;
  status(): Promise<AgentEnvironmentStatus>;
  stream(input: AgentTurnInput): AsyncIterable<AgentEnvironmentEvent>;
  dispatch?(input: AgentTurnInput): Promise<AgentSessionRef>;
  session?(
    id: string,
    options?: { controlRef?: AgentRunControlRef },
  ): AgentSession;
  respondToInteraction?(
    command: InteractionResponseCommand,
    options?: { signal?: AbortSignal },
  ): Promise<InteractionAcknowledgement>;
  read?(path: string, options?: { sessionId?: string }): Promise<string>;
  write?(
    path: string,
    content: string,
    options?: { sessionId?: string },
  ): Promise<void>;
  exec?(command: string, options?: ExecRequest): Promise<ExecResult>;
  checkpoint?(options?: CheckpointRequest): Promise<CheckpointRef>;
  fork?(
    checkpoint: CheckpointRef,
    options?: ForkRequest,
  ): Promise<AgentEnvironment>;
  /** Durable, retry-safe checkpoint and environment-fork operations. */
  readonly workspaceBranching?: AgentWorkspaceBranching;
  placement?(): Promise<PlacementInfo>;
  refresh?(): Promise<void>;
  destroy?(): Promise<void>;
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
  /** Present only when every retained-run identity and retry promise is implemented. */
  retainedControl?: {
    exactRunIdentity: boolean;
    resultIdentity: boolean;
    eventIdentity: boolean;
    cancellationIdempotency: boolean;
  };
  /** Absent when verified, retry-safe same-session continuation is unsupported. */
  nativeContinuation?: {
    /** Boundary comparison and operation admission are one atomic provider action. */
    atomicBoundary: boolean;
    /** Operation id + request digest recover retries and reject changed input. */
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
        egress: z.array(z.enum(["blocked", "strict"])).min(1),
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
  idempotencyKey?: string;
  signal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
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
  create(input: CreateAgentEnvironmentInput): Promise<AgentEnvironment>;
  get?(id: string): Promise<AgentEnvironment | null>;
  list?(query?: AgentEnvironmentQuery): Promise<AgentEnvironmentSummary[]>;
}
