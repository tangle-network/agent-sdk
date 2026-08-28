import type {
  BackendRegistryEntry,
  BackendRegistryResponse,
  BackendType,
  CreateSandboxOptions,
  ExecResult as SandboxExecResult,
  PromptOptions,
  PromptResult,
  SandboxEvent,
} from "@tangle-network/sandbox";
import type {
  AgentRunCancellationAcknowledgement,
  AgentRunCancellationRequest,
  AgentExecutionPreparationReceipt,
  AgentInteractiveSessionControlClaim,
  AgentInteractiveSessionControlClaimAcknowledgement,
  AgentInteractiveSessionControlClaimRequest,
  AgentInteractiveSessionPromptAcknowledgement,
  AgentInteractiveSessionPromptCommand,
  AgentInteractiveSessionStopAcknowledgement,
  AgentInteractiveSessionStopCommand,
  AgentProfile,
  ConfidentialAttestation,
  ConfidentialExecutionEnvironment,
  InputPart,
  InteractionRequest,
  InteractionResponseCommand,
} from "@tangle-network/agent-interface";
import type {
  AgentEnvironmentCapabilities,
  AgentEnvironmentProvider,
  CreateAgentEnvironmentInput,
} from "@tangle-network/agent-interface/environment-provider";

/**
 * The platform verdict for the create call that returned a sandbox.
 * `created` means the call allocated the sandbox; `idempotent_replay` means an
 * earlier call with the same idempotency key allocated it; `unknown` means the
 * platform cannot prove either outcome.
 */
export interface SandboxCreateReceiptLike {
  outcome: "created" | "idempotent_replay" | "unknown";
  idempotencyKeyApplied: boolean;
}

export interface TangleExactProcessOptions {
  teamId?: string;
}

export interface SandboxClientLike {
  create(
    options?: CreateSandboxOptions,
    requestOptions?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<SandboxInstanceLike>;
  /**
   * SDK HttpClient transport, present on `Sandbox` and `TangleSandboxClient`.
   * Retained control requires it: the provider mints a lazy probe instance
   * over this surface to read the linked SDK's method surface before any
   * sandbox exists. An object-spread wrapper (`{ ...client }`) drops class
   * prototype methods including this one, so such a wrapper never claims
   * retained control; pass the SDK client itself or delegate its methods.
   */
  fetch?(
    path: string,
    options?: RequestInit,
    fetchOptions?: { timeoutMs?: number },
  ): Promise<Response>;
  /** Canonical backend catalog served by authenticated `/v1/backends`. */
  listBackends?(): Promise<BackendRegistryResponse>;
  /** Lookup over the same canonical backend catalog, when the SDK provides it. */
  getBackend?(type: string): Promise<BackendRegistryEntry | undefined>;
  get?(id: string, requestOptions?: { signal?: AbortSignal }): Promise<SandboxInstanceLike | null>;
  list?(options?: {
    scope?: string;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<SandboxInstanceLike[]>;
  describePlacement?(box: SandboxInstanceLike): unknown;
  /** Account usage counters for the credential behind this client. */
  usage?(): Promise<SandboxAccountUsageLike>;
  /** Plan, credit balance, and concurrency ceiling for the account. */
  subscription?(): Promise<SandboxSubscriptionLike>;
}

/** The account usage counters the observation reads. */
export interface SandboxAccountUsageLike {
  activeSandboxes: number;
  periodStart: Date | string;
  periodEnd: Date | string;
}

/**
 * The subscription fields the observation reads.
 *
 * `creditsAvailableUsd` can be negative on an overage plan, and
 * `maxConcurrentSandboxes` is 0 when the account has no ceiling. Neither value
 * fits the contract's non-negative credit and quota shapes, so the observation
 * reports those two cases as unavailable instead of clamping them.
 */
export interface SandboxSubscriptionLike {
  plan: string;
  creditsAvailableUsd: number;
  maxConcurrentSandboxes: number;
}

/**
 * The `GET /capabilities` document as this adapter reads it: what the DEPLOYED
 * sidecar image compiled in, not which methods the linked SDK class carries.
 *
 * Every capability flag this shape declares gates a claim the adapter makes,
 * and the wire document's other flags are absent here because the adapter does
 * not act on them yet. Every field is optional, and the document's own
 * convention is that a missing flag means "unknown to that image", never
 * false. The linked SDK parses a v1 wire body strictly, but this adapter reads
 * any `SandboxInstanceLike`, so it never assumes a flag was validated: an
 * absent field reaches the claim as unknown instead of being coerced. The
 * SDK's `SandboxRuntimeCapabilities` is assignable to this shape;
 * `deployment-capabilities.test.ts` pins that against the published type.
 */
export interface SandboxRuntimeCapabilityDocument {
  schema?: number;
  agentInterface?: string;
  sidecarVersion?: string;
  image?: string;
  dispatch?: {
    /** Run requests accept a caller-supplied exact `runControlRef`. */
    runControlRef?: boolean;
    /** Admission echoes the executionId the request named. */
    executionIdOnAdmission?: boolean;
  };
  cancel?: {
    /** Cancellation accepts the canonical digest-bound request. */
    canonicalRunCancellation?: boolean;
    /** Cancellation binds to the run's request digest. */
    digestBound?: boolean;
    /** Replaying an operation id returns the stored acknowledgement. */
    idempotent?: boolean;
  };
  runs?: {
    /** Status and results select one execution of a session. */
    executionScopedStatus?: boolean;
    /** Buffered run events replay by execution. */
    eventReplay?: boolean;
  };
  interactions?: {
    /**
     * The interaction route records every acknowledged resolution durably:
     * repeating a response replays the recorded resolution, a different answer
     * for a recorded resolution raises a conflict, and the deployment refuses
     * rather than acknowledge a resolution it cannot record. Absent on an
     * image that predates the flag, which is unknown and never a claim.
     */
    responseDedupe?: boolean;
  };
  interactiveAgent?: {
    /** Start binds one native TUI to the requested session id. */
    start?: boolean;
    /** Status returns durable running, exited, stopped, or lost state. */
    status?: boolean;
    /** Attach reaches the existing TUI and never creates a shell. */
    attach?: boolean;
    /** The deployment owns exact control claims and generation fencing. */
    control?: boolean;
    /** Prompt input is sent to that existing TUI. */
    sendPrompt?: boolean;
    /** Stop reaps the exact TUI and records its terminal state. */
    stop?: boolean;
  };
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

/**
 * The connection fields this adapter reads.
 *
 * The Sandbox connection object also carries a bearer token and its expiry.
 * Neither is declared here, so no code path can copy a credential into an
 * observation: the adapter reads the runtime URL and nothing else.
 */
export interface SandboxConnectionLike {
  runtimeUrl?: string;
}

/** The keyed snapshot acknowledgement exposed by the Sandbox SDK. */
export interface SandboxSnapshotResultLike {
  snapshotId: string;
  createdAt: Date | string;
  sizeBytes?: number;
  tags: string[];
  idempotency?: {
    outcome: "created" | "replayed";
    requestDigest: string;
  };
}

/** Snapshot metadata returned by the managed Sandbox storage service. */
export interface SandboxSnapshotInfoLike {
  snapshotId: string;
  sandboxId: string;
  createdAt: Date | string;
  tags: string[];
  paths?: string[];
  sizeBytes?: number;
}

/** A deletion result must state what the platform actually did. */
export interface SandboxSnapshotDeleteAcknowledgementLike {
  snapshotId: string;
  outcome: "deleted" | "already_absent" | "unknown";
}

/** Result returned by the SDK's durable operation lookup route. */
export interface SandboxWorkspaceOperationLookupLike {
  outcome: "found" | "not_found" | "conflict" | "unknown";
  kind: "checkpoint" | "fork";
  state?: "pending" | "succeeded" | "failed";
  requestDigest?: string;
  existingRequestDigest?: string;
  result?: Record<string, unknown>;
  failure?: { status: number; error: string; code?: string };
}

/** The branch options supported by the managed Sandbox route. */
export interface SandboxForkOptionsLike {
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

/** Fan-out acknowledgement returned by SandboxInstance.fork(). */
export interface SandboxForkAcknowledgementLike {
  children: SandboxInstanceLike[];
  requestedCount: number;
  materializedCount: number;
  complete: boolean;
  idempotency?: {
    outcome: "created" | "replayed";
    requestDigest: string;
  };
}

/** A forked Sandbox child can be destroyed with an explicit outcome. */
export interface SandboxDeleteAcknowledgementLike {
  sandboxId: string;
  outcome: "destroyed" | "already_absent" | "unknown";
}

/** Raw TEE evidence returned by Sandbox, before provider-key verification. */
export interface SandboxTeeAttestationReportLike {
  tee_type: string;
  evidence: number[];
  measurement: number[];
  timestamp: number;
}

export interface SandboxTeeAttestationResponseLike {
  sandbox_id: string;
  attestation: SandboxTeeAttestationReportLike;
  attestationNonce?: string;
}

/**
 * Evidence returned by an external TEE verifier after it checks the raw quote.
 * The provider never derives these fields from request metadata or the quote.
 */
export interface TangleConfidentialAttestationVerification {
  providerKeyId: string;
  providerSignature: string;
  /** Optional verifier-normalized measurement, checked against raw evidence. */
  measurement?: `sha256:${string}`;
}

/**
 * Provider-owned trust boundary for TEE evidence.
 * Return `null` when the quote, nonce, key, or policy is not trusted.
 */
export type TangleConfidentialAttestationVerifier = (input: {
  report: SandboxTeeAttestationReportLike;
  expected: ConfidentialExecutionEnvironment;
  attestation: ConfidentialAttestation;
}) =>
  | TangleConfidentialAttestationVerification
  | null
  | Promise<TangleConfidentialAttestationVerification | null>;

/** Live cgroup sample for one sandbox. `null` fields mean the host reported none. */
export interface SandboxResourceUsageLike {
  memoryCurrentMb: number;
  memoryPeakMb: number | null;
  memoryLimitMb: number | null;
  cpuUsageUsec: number;
  sampledAtMs: number;
}

/**
 * The GPU lease fields the observation reads: the accelerator actually
 * attached, and the compute cost charged for it. `billing` exists after the
 * lease stops; `estimatedCustomerCostUsd` is the running estimate before that.
 */
export interface SandboxGpuLeaseLike {
  accelerator: { kind: string; count: number; memoryMB?: number };
  region?: string;
  billing?: { customerCostUsd: number };
  estimatedCustomerCostUsd?: number;
}

/** Interactive terminal metadata the runtime reports for one PTY. */
export interface SandboxTerminalInfoLike {
  sessionId: string;
  connectionId?: string;
  name?: string;
  shell?: string;
  command?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  createdAt?: string;
  lastActivityAt?: string;
  isRunning?: boolean;
  exitCode?: number;
  exitSignal?: string;
}

/** The `ready` acknowledgement the terminal WebSocket returns on attach. */
export interface SandboxTerminalReadyLike {
  connectionId: string;
  sessionId: string;
  /** True when the runtime reattached an existing PTY and replays its history. */
  restored: boolean;
  /** How long the runtime keeps the PTY alive after this socket closes. */
  detachTimeoutMs: number;
}

/** Callbacks bound before the terminal socket opens. */
export interface SandboxTerminalHandlersLike {
  onData?: (data: Uint8Array) => void;
  onReady?: (info: SandboxTerminalReadyLike) => void;
  onExit?: (info: { exitCode?: number; exitSignal?: string }) => void;
  onError?: (error: Error) => void;
  onClose?: (code: number, reason: string) => void;
}

/** One live terminal WebSocket. */
export interface SandboxTerminalStreamLike {
  readonly connectionId: string;
  readonly ready: SandboxTerminalReadyLike;
  readonly isOpen: boolean;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): Promise<void>;
}

/**
 * The terminal surface this adapter binds: metadata lookup plus the live PTY
 * attach. Reusing a connection id reattaches an existing PTY and replays its
 * buffered output; a new id starts a shell or the requested command.
 */
export interface SandboxTerminalsLike {
  get(sessionId: string): Promise<SandboxTerminalInfoLike | null>;
  attach(
    connectionId: string,
    options?: {
      cols?: number;
      rows?: number;
      command?: string;
      cwd?: string;
      handlers?: SandboxTerminalHandlersLike;
    },
  ): Promise<SandboxTerminalStreamLike>;
}

/** Identity returned by the Sandbox exact interactive-session route. */
export interface SandboxInteractiveSessionIdentityLike {
  sessionId: string;
  harness: BackendType;
  startedAt: string;
  /** Provider-issued process incarnation. Replays return this exact value. */
  incarnationId: string;
  /** Canonical provider admission receipt for the effective route. */
  preparationReceipt: AgentExecutionPreparationReceipt;
}

/** Start acknowledgement from the canonical Sandbox interactive API. */
export interface SandboxInteractiveSessionInfoLike
  extends SandboxInteractiveSessionIdentityLike {
  streamUrl: string;
}

/** Lifecycle returned by the Sandbox exact interactive-session route. */
export type SandboxInteractiveSessionStatusLike =
  | (SandboxInteractiveSessionInfoLike & { state: "running" })
  | (SandboxInteractiveSessionIdentityLike & {
      state: "exited";
      endedAt: string;
      exitCode?: number;
      exitSignal?: string;
      reason: "exited" | "stopped" | "lost";
    });

/** Existing Sandbox SDK handle for one coding harness's native TUI. */
export interface SandboxInteractiveSessionLike {
  start(options: {
    harness: BackendType;
    model?: string;
    cwd?: string;
    cols?: number;
    rows?: number;
    profile: AgentProfile;
    initialPrompt?: string;
    /** Derived from the exact run; owned by the Sandbox creation ledger. */
    idempotencyKey: string;
    /** Exact request digest paired with the idempotency key. */
    requestDigest: `sha256:${string}`;
  }): Promise<SandboxInteractiveSessionInfoLike>;
  claimControl(
    request: AgentInteractiveSessionControlClaimRequest,
  ): Promise<AgentInteractiveSessionControlClaimAcknowledgement>;
  status(): Promise<SandboxInteractiveSessionStatusLike | null>;
  attach(options: {
    control: AgentInteractiveSessionControlClaim;
    cols?: number;
    rows?: number;
    handlers?: SandboxTerminalHandlersLike;
  }): Promise<SandboxTerminalStreamLike>;
  /** Validate the current generation before each PTY mutation. */
  validateControl(control: AgentInteractiveSessionControlClaim): Promise<void>;
  sendPrompt(
    command: AgentInteractiveSessionPromptCommand,
  ): Promise<AgentInteractiveSessionPromptAcknowledgement>;
  stop(
    command: AgentInteractiveSessionStopCommand,
  ): Promise<AgentInteractiveSessionStopAcknowledgement>;
}

export interface SandboxInstanceLike {
  id: string;
  name?: string;
  status?: unknown;
  metadata?: Record<string, unknown>;
  /** Network location of the sandbox runtime, without its bearer. */
  connection?: SandboxConnectionLike;
  /** When the platform retires this sandbox, when it set a lifetime. */
  expiresAt?: Date | string;
  /** Stable platform creation time, returned by branch child descriptions. */
  createdAt?: Date | string;
  /** GPU lease attached at create time, when one was requested. */
  gpuLease?: SandboxGpuLeaseLike;
  streamPrompt(message: string | InputPart[], options?: PromptOptions): AsyncIterable<SandboxEvent>;
  prompt?(message: string | InputPart[], options?: PromptOptions): Promise<PromptResult>;
  dispatchPrompt?(message: string | InputPart[], options?: PromptOptions): Promise<unknown>;
  session?(id: string, options?: { signal?: AbortSignal }): SandboxSessionLike;
  read?(path: string, options?: { sessionId?: string; signal?: AbortSignal }): Promise<string>;
  write?(path: string, content: string, options?: { sessionId?: string; signal?: AbortSignal }): Promise<unknown>;
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
  /**
   * Capability discovery against the deployment behind this sandbox. Absent
   * on a Sandbox SDK older than 0.22.0, which is why every call site feature-
   * detects it: an older SDK cannot read deployment truth, so the adapter
   * claims no retained control rather than trusting its own method surface.
   * Resolves to null when the deployment cannot disclose a document this SDK
   * reads; a malformed document throws.
   */
  capabilities?(): Promise<SandboxRuntimeCapabilityDocument | null>;
  /**
   * Live cgroup sample for the whole sandbox. Resolves to null when the host
   * collects no cgroup statistics, which the observation reports as an absent
   * measurement rather than a zero.
   */
  resourceUsage?(): Promise<SandboxResourceUsageLike | null>;
  /** Interactive terminal transport. Absent on a client that cannot serve a PTY. */
  terminals?: SandboxTerminalsLike;
  /**
   * The platform verdict for the create call that returned this instance.
   * Absent on a Sandbox SDK older than 0.30.1; null for an instance resolved
   * by id or when the platform reported no receipt.
   */
  createReceipt?(): SandboxCreateReceiptLike | null;
  /** Refresh accepts either the current SDK signal or no argument. */
  refresh?(signal?: AbortSignal): Promise<void>;
  delete?(options?: { signal?: AbortSignal }): Promise<unknown>;
  /** Managed whole-workspace checkpoint operation. */
  snapshot?(options?: {
    tags?: string[];
    idempotencyKey?: string;
  }): Promise<SandboxSnapshotResultLike>;
  /** Recover checkpoint metadata after a provider process restart. */
  listSnapshots?(): Promise<SandboxSnapshotInfoLike[]>;
  /** Delete one managed checkpoint. */
  deleteSnapshot?(
    snapshotId: string,
    options?: { timeoutMs?: number },
  ): Promise<SandboxSnapshotDeleteAcknowledgementLike>;
  /** Ask the service for the state of a keyed checkpoint operation. */
  getSnapshotOperation?(
    idempotencyKey: string,
    options?: { tags?: string[] },
  ): Promise<SandboxWorkspaceOperationLookupLike>;
  /** Managed copy-on-write fork operation. */
  fork?(
    count: number,
    options?: SandboxForkOptionsLike,
  ): Promise<SandboxForkAcknowledgementLike>;
  /** Recover fork state after a provider process restart. */
  getForkOperation?(
    idempotencyKey: string,
    options: {
      count: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<SandboxWorkspaceOperationLookupLike>;
  /** Raw TEE quote and measurement; verification stays outside Sandbox. */
  getTeeAttestation?(options?: {
    attestationNonce?: string;
  }): Promise<SandboxTeeAttestationResponseLike>;
}

export interface SandboxSessionLike {
  readonly id: string;
  /** Exact native coding-agent TUI bound to this session id. */
  interactive?(): unknown;
  status(options?: { signal?: AbortSignal }): Promise<unknown | null>;
  events(options?: {
    since?: string;
    executionId?: string;
    signal?: AbortSignal;
  }): AsyncIterable<SandboxEvent>;
  result(options?: { executionId?: string; signal?: AbortSignal }): Promise<PromptResult>;
  prompt(message: string | InputPart[], options?: PromptOptions): Promise<PromptResult>;
  interrupt(options?: { executionId?: string; signal?: AbortSignal }): Promise<{ cancelled: boolean }>;
  cancelRun?(
    request: AgentRunCancellationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<AgentRunCancellationAcknowledgement>;
  /**
   * Every ask still awaiting a response on this session. The adapter reads the
   * answer spec from here to refuse an answer the ask does not accept, so an
   * ask that has already left the outstanding set is absent rather than an
   * error. Absent on a Sandbox SDK that cannot list the outstanding set.
   */
  interactions?(options?: {
    signal?: AbortSignal;
  }): Promise<readonly InteractionRequest[]>;
  /**
   * Deliver one digest-bound response to the exact ask its binding names.
   *
   * The result carries the acknowledgement the deployment's durable record
   * produced, and `serverResult` carries that record itself. Absent on a
   * Sandbox SDK older than 0.23.0, whose response path selected an ask by
   * position rather than by id.
   */
  respondToInteraction?(
    command: InteractionResponseCommand,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxInteractionCommandResultLike>;
}

/**
 * The Sandbox SDK's reply to one response command.
 *
 * Both members are read as unvalidated wire content: the acknowledgement
 * reaches the canonical schema before this adapter returns it, and the
 * resolution is read only for the two facts the acknowledgement cannot
 * carry — whether the deployment confirmed delivery, and the digest of the
 * response a conflicting resolution already holds.
 */
export interface SandboxInteractionCommandResultLike {
  acknowledgement: unknown;
  serverResult?: {
    status?: unknown;
    delivered?: unknown;
    existingResponseDigest?: unknown;
    [key: string]: unknown;
  };
}

export interface TangleProviderOptions {
  client: SandboxClientLike;
  name?: string;
  defaultBackend?: BackendType;
  capabilities?: AgentEnvironmentCapabilities | (() => AgentEnvironmentCapabilities | Promise<AgentEnvironmentCapabilities>);
  validateProfile?: AgentEnvironmentProvider["validateProfile"];
  mapCreateInput?: (input: CreateAgentEnvironmentInput) => CreateSandboxOptions;
  exactProcess?: TangleExactProcessOptions;
  /** External provider-key and measurement verifier for confidential forks. */
  confidentialAttestationVerifier?: TangleConfidentialAttestationVerifier;
}
